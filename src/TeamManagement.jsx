/* src/TeamManagement.jsx */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/* ---------- SortablePlayer ---------- */
function SortablePlayer({ player, disabled }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: player.id, data: { player }, disabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    padding: '6px 10px',
    marginBottom: 4,
    background: isDragging ? '#e0e0e0' : '#f7f7f7',
    border: '1px solid #ddd',
    borderRadius: 4,
    cursor: disabled ? 'default' : 'grab',
    opacity: isDragging ? 0.4 : 1,
    userSelect: 'none',
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {player.username}
    </div>
  )
}

/* ---------- DroppableContainer ---------- */
function DroppableContainer({ id, title, players, disabled }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled })

  return (
    <div
      ref={setNodeRef}
      style={{
        background: isOver && !disabled ? '#e6f3ff' : '#fff',
        border: '1px dashed #bbb',
        borderRadius: 6,
        padding: 8,
        minHeight: 140,
      }}
    >
      <h4 style={{ margin: '0 0 8px' }}>{title}</h4>
      {players.length === 0 ? (
        <p style={{ color: '#aaa', margin: 0 }}>Drop players here</p>
      ) : (
        <SortableContext items={players.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          {players.map((p) => (
            <SortablePlayer key={p.id} player={p} disabled={disabled} />
          ))}
        </SortableContext>
      )}
    </div>
  )
}

/* ---------- TeamManagement ---------- */
export default function TeamManagement({ session }) {
  const [teams, setTeams]     = useState([])
  const [players, setPlayers] = useState([])
  const [gamemasters, setGamemasters] = useState([]) // only for admin/manager
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [noProfile, setNoProfile] = useState(false)

  const [currentRole, setCurrentRole] = useState('')
  const [activePlayer, setActivePlayer] = useState(null)

  const [newTeamName, setNewTeamName]       = useState('')
  const [newTeamGmId, setNewTeamGmId]       = useState('')

  const myUserId = session.user.id

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  /* ---------- load ---------- */
  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', myUserId)
      .maybeSingle()

    if (meErr) { setError(meErr.message); setLoading(false); return }
    if (!me)   { setNoProfile(true);  setLoading(false); return }
    setNoProfile(false)
    setCurrentRole(me.role)

    const [teamsRes, playersRes] = await Promise.all([
      supabase.from('teams').select('*').order('name'),
      supabase.from('profiles').select('*').eq('role', 'player').order('username'),
    ])

    if (teamsRes.error)   { setError(teamsRes.error.message);   setLoading(false); return }
    if (playersRes.error) { setError(playersRes.error.message); setLoading(false); return }

    setTeams(teamsRes.data ?? [])
    setPlayers(playersRes.data ?? [])

    if (me.role === 'admin' || me.role === 'manager') {
      const { data: gms, error: gmErr } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('role', 'gamemaster')
        .order('username')
      if (!gmErr) setGamemasters(gms ?? [])
    } else {
      setGamemasters([])
    }

    setLoading(false)
  }, [myUserId])

  useEffect(() => { load() }, [load])

  /* ---------- permissions ---------- */
  const canModifyTeam = (team) => {
    if (currentRole === 'admin' || currentRole === 'manager') return true
    if (currentRole === 'gamemaster' && team.gamemaster_id === myUserId) return true
    return false
  }

  const canMovePlayer = (player) => {
    if (currentRole === 'admin' || currentRole === 'manager') return true
    if (currentRole === 'gamemaster' && player.gamemaster_id === myUserId) return true
    return false
  }

  const canCreateTeam = currentRole === 'admin' || currentRole === 'manager' || currentRole === 'gamemaster'

  /* ---------- team CRUD ---------- */
  const createTeam = async (e) => {
    e.preventDefault()
    setError('')
    const name = newTeamName.trim()
    if (!name) return

    const gmId = currentRole === 'gamemaster' ? myUserId : newTeamGmId
    if (!gmId) { setError('Please select which gamemaster owns this team.'); return }

    const { error: insErr } = await supabase
      .from('teams')
      .insert([{ name, gamemaster_id: gmId }])

    if (insErr) { setError(insErr.message); return }
    setNewTeamName('')
    setNewTeamGmId('')
    await load()
  }

  const deleteTeam = async (team) => {
    if (!window.confirm(`Delete team "${team.name}"?`)) return
    const { error: delErr } = await supabase.from('teams').delete().eq('id', team.id)
    if (delErr) { setError(delErr.message); return }
    await load()
  }

  /* ---------- drag & drop ---------- */
  const findTeamOfPlayer = (playerId) => {
    const p = players.find((x) => x.id === playerId)
    return p ? (p.team_id || null) : undefined
  }

  const handleDragStart = (event) => {
    const p = players.find((x) => x.id === event.active.id)
    setActivePlayer(p ?? null)
  }

  const handleDragEnd = async (event) => {
    const { active, over } = event
    setActivePlayer(null)
    if (!over) return

    const playerId = active.id
    const overId   = over.id
    if (playerId === overId) return

    const player = players.find((p) => p.id === playerId)
    if (!player || !canMovePlayer(player)) return

    // Resolve target team (over.id may be a container OR a player)
    let newTeamId
    if (overId === 'unassigned') {
      newTeamId = null
    } else if (teams.some((t) => t.id === overId)) {
      newTeamId = overId
    } else {
      // dropped onto another player
      newTeamId = findTeamOfPlayer(overId)
      if (newTeamId === undefined) return // over was neither container nor player
    }

    const prevTeamId = player.team_id ?? null
    if (prevTeamId === newTeamId) return

    // Optimistic update
    setPlayers((prev) =>
      prev.map((p) => (p.id === playerId ? { ...p, team_id: newTeamId } : p))
    )

    const { error: upErr } = await supabase
      .from('profiles')
      .update({ team_id: newTeamId })
      .eq('id', playerId)

    if (upErr) {
      setError(upErr.message)
      // Revert
      setPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, team_id: prevTeamId } : p))
      )
    }
  }

  /* ---------- render ---------- */
  if (loading)   return <p>Loading teams…</p>
  if (noProfile) return <p>Your account has no profile yet. Ask an admin to assign you a role.</p>

  // Group teams by gamemaster for display
  const teamsByGm = useMemo(() => {
    const map = new Map()
    for (const t of teams) {
      if (!map.has(t.gamemaster_id)) map.set(t.gamemaster_id, [])
      map.get(t.gamemaster_id).push(t)
    }
    return map
  }, [teams])

  const unassigned = players.filter((p) => !p.team_id)

  return (
    <div>
      <h2>Teams</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {canCreateTeam && (
        <form onSubmit={createTeam} style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            placeholder="New team name"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            required
          />
          {(currentRole === 'admin' || currentRole === 'manager') && (
            <select
              value={newTeamGmId}
              onChange={(e) => setNewTeamGmId(e.target.value)}
              required
            >
              <option value="">— Gamemaster —</option>
              {gamemasters.map((g) => (
                <option key={g.id} value={g.id}>{g.username}</option>
              ))}
            </select>
          )}
          <button type="submit">Create team</button>
        </form>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {/* Unassigned pool */}
          <div style={{ minWidth: 240, flex: '0 0 240px' }}>
            <DroppableContainer id="unassigned" title="Unassigned players" players={unassigned}>
              {/* children rendered internally */}
            </DroppableContainer>
          </div>

          {/* Teams grouped by gamemaster */}
          {[...teamsByGm.entries()].map(([gmId, gmTeams]) => {
            const gm = gamemasters.find((g) => g.id === gmId)
            return (
              <div key={gmId} style={{ flex: 1, minWidth: 260 }}>
                <h3 style={{ marginTop: 0 }}>
                  {gm ? gm.username : 'Your teams'}
                </h3>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {gmTeams.map((team) => {
                    const teamPlayers = players.filter((p) => p.team_id === team.id)
                    const editable = canModifyTeam(team)
                    return (
                      <div key={team.id} style={{ flex: '1 1 200px', minWidth: 200 }}>
                        <DroppableContainer
                          id={team.id}
                          title={team.name}
                          players={teamPlayers}
                          disabled={!editable}
                        />
                        {editable && (
                          <button
                            onClick={() => deleteTeam(team)}
                            style={{ marginTop: 4, color: 'crimson' }}
                          >
                            Delete team
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <DragOverlay>
          {activePlayer ? (
            <div style={{ padding: '6px 10px', background: '#fff', border: '1px solid #ccc' }}>
              {activePlayer.username}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}