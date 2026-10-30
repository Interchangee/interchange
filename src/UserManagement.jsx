/* src/UserManagement.jsx */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

const STAFF_ROLES = ['admin', 'manager', 'gamemaster']
const ROLE_ORDER  = { admin: 0, manager: 1, gamemaster: 2, player: 3 }

export default function UserManagement({ session }) {
  const [profiles, setProfiles] = useState([])
  const [gamemasters, setGamemasters] = useState([]) // for dropdown when admin/manager
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [noProfile, setNoProfile] = useState(false)

  const [currentRole, setCurrentRole] = useState('')
  const myUserId = session.user.id

  // form state
  const [editingId, setEditingId] = useState(null)
  const [username, setUsername] = useState('')
  const [email, setEmail]       = useState('')
  const [role, setRole]         = useState('player')
  const [gamemasterId, setGamemasterId] = useState('')

  /* ---------- data load ---------- */
  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('role, gamemaster_id')
      .eq('id', myUserId)
      .maybeSingle()

    if (meErr) { setError(meErr.message); setLoading(false); return }
    if (!me)   { setNoProfile(true);  setLoading(false); return }
    setNoProfile(false)
    setCurrentRole(me.role)

    const { data: rows, error: listErr } = await supabase
      .from('profiles')
      .select('*')
      .order('username', { ascending: true })

    if (listErr) { setError(listErr.message); setLoading(false); return }
    setProfiles(rows ?? [])

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
  const canManageRow = (target) => {
    if (!target) return false
    if (currentRole === 'admin')   return true
    if (currentRole === 'manager') return ['gamemaster', 'player'].includes(target.role)
    if (currentRole === 'gamemaster') return target.role === 'player' && target.gamemaster_id === myUserId
    return false
  }

  const creatableRoles = useMemo(() => {
    if (currentRole === 'admin')      return ['admin', 'manager', 'gamemaster', 'player']
    if (currentRole === 'manager')    return ['gamemaster', 'player']
    if (currentRole === 'gamemaster') return ['player']
    return []
  }, [currentRole])

  const canCreate = creatableRoles.length > 0

  /* ---------- form helpers ---------- */
  const resetForm = () => {
    setEditingId(null)
    setUsername('')
    setEmail('')
    const defaultRole = creatableRoles.includes('player') ? 'player' : creatableRoles[0] ?? 'player'
    setRole(defaultRole)
    setGamemasterId(currentRole === 'gamemaster' ? myUserId : '')
  }

  useEffect(() => {
    // keep role valid when creatableRoles changes
    if (creatableRoles.length && !creatableRoles.includes(role)) {
      setRole(creatableRoles[0])
    }
  }, [creatableRoles, role])

  /* ---------- create / update ---------- */
  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    const payload = {
      username: username.trim(),
      email: email.trim(),
      role,
    }

    if (role === 'player') {
      const gmId = currentRole === 'gamemaster' ? myUserId : gamemasterId
      if (!gmId) { setError('A player must be assigned to a gamemaster.'); return }
      payload.gamemaster_id = gmId
    } else {
      payload.gamemaster_id = null
    }

    if (!payload.username) { setError('Username is required.'); return }

    if (editingId) {
      const { error: upErr } = await supabase
        .from('profiles').update(payload).eq('id', editingId)
      if (upErr) { setError(upErr.message); return }
    } else {
      const { error: insErr } = await supabase.from('profiles').insert(payload)
      if (insErr) { setError(insErr.message); return }
    }

    resetForm()
    await load()
  }

  const handleEdit = (p) => {
    setEditingId(p.id)
    setUsername(p.username ?? '')
    setEmail(p.email ?? '')
    setRole(p.role)
    setGamemasterId(p.gamemaster_id ?? '')
  }

  const handleDelete = async (p) => {
    if (!window.confirm(`Delete "${p.username}"?`)) return
    const { error: delErr } = await supabase.from('profiles').delete().eq('id', p.id)
    if (delErr) { setError(delErr.message); return }
    await load()
  }

  /* ---------- render ---------- */
  if (loading)     return <p>Loading users…</p>
  if (noProfile)   return <p>Your account has no profile yet. Ask an admin to assign you a role.</p>

  const sorted = [...profiles].sort((a, b) => {
    const ra = ROLE_ORDER[a.role] ?? 99
    const rb = ROLE_ORDER[b.role] ?? 99
    if (ra !== rb) return ra - rb
    return (a.username ?? '').localeCompare(b.username ?? '')
  })

  return (
    <div>
      <h2>Users</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {canCreate && (
        <form onSubmit={handleSubmit} style={{ marginBottom: 24, maxWidth: 420 }}>
          <h3>{editingId ? 'Edit user' : 'Create user'}</h3>
          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            style={{ display: 'block', width: '100%', marginBottom: 6 }}
          />
          <input
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ display: 'block', width: '100%', marginBottom: 6 }}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: 6 }}
          >
            {creatableRoles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>

          {role === 'player' && currentRole !== 'gamemaster' && (
            <select
              value={gamemasterId}
              onChange={(e) => setGamemasterId(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginBottom: 6 }}
            >
              <option value="">— Select gamemaster —</option>
              {gamemasters.map((g) => (
                <option key={g.id} value={g.id}>{g.username}</option>
              ))}
            </select>
          )}

          <button type="submit">{editingId ? 'Save changes' : 'Create'}</button>
          {editingId && (
            <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>
              Cancel
            </button>
          )}
        </form>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Username</th>
            <th style={{ textAlign: 'left' }}>Email</th>
            <th style={{ textAlign: 'left' }}>Role</th>
            <th style={{ textAlign: 'left' }}>Gamemaster</th>
            <th style={{ textAlign: 'left' }}>Team</th>
            <th style={{ textAlign: 'left' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const gm = profiles.find((x) => x.id === p.gamemaster_id)
            return (
              <tr key={p.id} style={{ borderTop: '1px solid #eee' }}>
                <td>{p.username}</td>
                <td>{p.email}</td>
                <td>{p.role}</td>
                <td>{gm ? gm.username : '—'}</td>
                <td>{p.team_id ? p.team_id.slice(0, 8) : '—'}</td>
                <td>
                  {canManageRow(p) && (
                    <>
                      <button onClick={() => handleEdit(p)}>Edit</button>
                      <button onClick={() => handleDelete(p)} style={{ marginLeft: 4 }}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}