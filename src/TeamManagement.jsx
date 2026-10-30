/* src/TeamManagement.jsx */
import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/* ---------- Sortable Player ---------- */
function SortablePlayer({ player }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
    data: { player },
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    padding: '6px 10px',
    marginBottom: 4,
    background: isDragging ? '#ddd' : '#f9f9f9',
    borderRadius: 4,
    cursor: 'grab',
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {player.username}
    </div>
  )
}

/* ---------- Droppable Container ---------- */
function DroppableContainer({ id, title, players, children }) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      style={{
        background: isOver ? '#e0f0ff' : '#fff',
        border: '1px dashed #ccc',
        borderRadius: 6,
        padding: 8,
        minHeight: 120,
      }}
    >
      <h4>{title}</h4>
      {players.length === 0 ? (
        <p style={{ color: '#aaa' }}>Drop players here</p>
      ) : (
        <SortableContext items={players.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      )}
    </div>
  )
}

/* ---------- Main TeamManagement ---------- */
export default function TeamManagement({ session }) {
  const [teams, setTeams] = useState([])
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activePlayer, setActivePlayer] = useState(null)

  const [currentRole, setCurrentRole] = useState('')
  const [currentGmId, setCurrentGmId] = useState('')

  // Form for new team
  const [newTeamName, setNewTeamName] = useState('')

  const sensors = useSensors(useSensor(PointerSensor))

  /* ---------- Data loading ---------- */
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      // current user
      const { data: me } = await supabase
        .from('profiles')
        .select('role, gamemaster_id')
        .eq('id', session.user.id)
        .single()

      if (!me) {
        setError('Profile not found')
        setLoading(false)
        return
      }
      setCurrentRole(me.role)
      setCurrentGmId(me.gamemaster_id)

      // teams (RLS will filter)
      const { data: teamData, error: teamErr } = await supabase
        .from('teams')
        .select('*')
        .order('name')

      // players (RLS will filter – only players in the relevant scope)
      const { data: playerData, error: playerErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'player')
        .order('username')

      if (teamErr || playerErr) {
        setError((teamErr || playerErr).message)
      } else {
        setTeams(teamData)
        setPlayers(playerData)
      }
      setLoading(false)
    }

    load()
  }, [session])

  /* ---------- Permission helpers ---------- */
  const canModifyTeam = (team) => {
    if (currentRole === 'admin' || currentRole === 'manager') return true
    if (currentRole === 'gamemaster' && team.gamemaster_id === currentGmId) return true
    return false
  }

  const canMovePlayer = (player) => {
    if (currentRole === 'admin' || currentRole === 'manager') return true
    if (currentRole === 'gamemaster' && player.gamemaster_id === currentGmId) return true
    return false
  }

  /* ---------- Team CRUD ---------- */
  const createTeam = async (e) => {
    e.preventDefault()
    if (!newTeamName.trim()) return

    const gamemasterId =
      currentRole === 'gamemaster' ? session.user.id : currentGmId || null

    const { data, error: insErr } = await supabase
      .from('teams')
      .insert([{ name: newTeamName.trim(), gamemaster_id: gamemasterId }])
      .select()

    if (insErr) {
      setError(insErr.message)
      return
    }
    setTeams([...teams, ...data])
    setNewTeamName('')
  }

  const deleteTeam = async (teamId) => {
    if (!window.confirm('Delete this team?')) return
    const { error: delErr } = await supabase.from('teams').delete().eq('id', teamId)
    if (delErr) {
      setError(delErr.message)
      return
    }
    setTeams(teams.filter((t) => t.id !== teamId))
    // unassign players that belonged to this team
    setPlayers(players.map((p) => (p.team_id === teamId ? { ...p, team_id: null } : p)))
  }

  /* ---------- Drag & drop ---------- */
  const findContainer = (id) => {
    if (id === 'unassigned') return 'unassigned'
    const team = teams.find((t) => t.id === id)
    return team ? team.id : null
  }

  const handleDragStart = (event) => {
    const playerId = event.active.id
    const player = players.find((p) => p.id === playerId)
    setActivePlayer(player)
  }

  const handleDragEnd = async (event) => {
    const { active, over } = event
    setActivePlayer(null)

    if (!over) return

    const playerId = active.id
    const overId = over.id

    const player = players.find((p) => p.id === playerId)
    if (!player || !canMovePlayer(player)) return

    let newTeamId = null
    if (overId !== 'unassigned') {
      const targetTeam = teams.find((t) => t.id === overId)
      if (!targetTeam) return
      newTeamId = targetTeam.id
    }

    if (player.team_id === newTeamId) return

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
      // revert
      setPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, team_id: player.team_id } : p))
      )
    }
  }

  /* ---------- Render ---------- */
  if (loading) return <p>Loading teams…</p>

  const unassignedPlayers = players.filter((p) => !p.team_id)

  return (
    <div>
      <h2>Team Management</h2>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {/* Create team form */}
      {['admin', 'manager', 'gamemaster'].includes(currentRole) && (
        <form onSubmit={createTeam} style={{ marginBottom: 16 }}>
          <input
            placeholder="New team name"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            style={{ marginRight: 8 }}
          />
          <button type="submit">Create Team</button>
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
          <div style={{ flex: 1, minWidth: 220 }}>
            <DroppableContainer id="unassigned" title="Unassigned Players" players={unassignedPlayers}>
              {unassignedPlayers.map((p) => (
                <SortablePlayer key={p.id} player={p} />
              ))}
            </DroppableContainer>
          </div>

          {/* Teams */}
          {teams.map((team) => {
            const teamPlayers = players.filter((p) => p.team_id === team.id)
            return (
              <div key={team.id} style={{ flex: 1, minWidth: 220 }}>
                <DroppableContainer id={team.id} title={team.name} players={teamPlayers}>
                  {teamPlayers.map((p) => (
                    <SortablePlayer key={p.id} player={p} />
                  ))}
                </DroppableContainer>
                {canModifyTeam(team) && (
                  <button
                    onClick={() => deleteTeam(team.id)}
                    style={{ marginTop: 4, color: 'red' }}
                  >
                    Delete Team
                  </button>
                )}
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