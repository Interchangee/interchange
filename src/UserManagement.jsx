/* src/UserManagement.jsx */
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export default function UserManagement({ session }) {
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Form state
  const [editingId, setEditingId] = useState(null)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('player')
  const [gamemasterId, setGamemasterId] = useState('')
  const [gameId, setGameId] = useState('')

  // Current user role
  const [currentRole, setCurrentRole] = useState('')
  const [currentGmId, setCurrentGmId] = useState('')

  useEffect(() => {
    const fetchRoleAndProfiles = async () => {
      setLoading(true)
      // Fetch current user's profile
      const { data: myProfile, error: myErr } = await supabase
        .from('profiles')
        .select('role, gamemaster_id')
        .eq('id', session.user.id)
        .single()

      if (myErr) {
        setError(myErr.message)
        setLoading(false)
        return
      }

      setCurrentRole(myProfile.role)
      setCurrentGmId(myProfile.gamemaster_id)

      // Fetch profiles according to RLS (the DB will filter)
      const { data, error: fetchErr } = await supabase
        .from('profiles')
        .select('*')
        .order('username', { ascending: true })

      if (fetchErr) {
        setError(fetchErr.message)
      } else {
        setProfiles(data)
      }
      setLoading(false)
    }

    fetchRoleAndProfiles()
  }, [session])

  const canManage = (targetRole) => {
    if (currentRole === 'admin') return true
    if (currentRole === 'manager' && ['gamemaster', 'player'].includes(targetRole)) return true
    if (currentRole === 'gamemaster' && targetRole === 'player') return true
    return false
  }

  const resetForm = () => {
    setEditingId(null)
    setUsername('')
    setEmail('')
    setRole('player')
    setGamemasterId(currentRole === 'gamemaster' ? session.user.id : '')
    setGameId('')
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    setError('')

    const newProfile = {
      username,
      email,
      role,
      gamemaster_id: gamemasterId || null,
      game_id: gameId || null,
    }

    const { error: insErr } = await supabase.from('profiles').insert([newProfile])
    if (insErr) {
      setError(insErr.message)
      return
    }
    resetForm()
    // Refresh list
    const { data } = await supabase.from('profiles').select('*').order('username')
    setProfiles(data)
  }

  const handleEdit = (profile) => {
    setEditingId(profile.id)
    setUsername(profile.username)
    setEmail(profile.email)
    setRole(profile.role)
    setGamemasterId(profile.gamemaster_id || '')
    setGameId(profile.game_id || '')
  }

  const handleUpdate = async (e) => {
    e.preventDefault()
    setError('')

    const updates = {
      username,
      email,
      role,
      gamemaster_id: gamemasterId || null,
      game_id: gameId || null,
    }

    const { error: upErr } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', editingId)

    if (upErr) {
      setError(upErr.message)
      return
    }
    resetForm()
    const { data } = await supabase.from('profiles').select('*').order('username')
    setProfiles(data)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this user?')) return
    const { error: delErr } = await supabase.from('profiles').delete().eq('id', id)
    if (delErr) {
      setError(delErr.message)
      return
    }
    setProfiles(profiles.filter((p) => p.id !== id))
  }

  if (loading) return <p>Loading users…</p>

  return (
    <div>
      <h2>User Management</h2>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {/* Form */}
      <form onSubmit={editingId ? handleUpdate : handleCreate} style={{ marginBottom: 24 }}>
        <h3>{editingId ? 'Edit User' : 'Create User'}</h3>
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          style={{ display: 'block', marginBottom: 6, width: '100%' }}
        />
        <input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ display: 'block', marginBottom: 6, width: '100%' }}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          style={{ display: 'block', marginBottom: 6, width: '100%' }}
        >
          <option value="player">Player</option>
          <option value="gamemaster">Gamemaster</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </select>
        <input
          placeholder="Gamemaster ID (UUID)"
          value={gamemasterId}
          onChange={(e) => setGamemasterId(e.target.value)}
          style={{ display: 'block', marginBottom: 6, width: '100%' }}
        />
        <input
          placeholder="Game ID (UUID)"
          value={gameId}
          onChange={(e) => setGameId(e.target.value)}
          style={{ display: 'block', marginBottom: 6, width: '100%' }}
        />
        <button type="submit">{editingId ? 'Update' : 'Create'}</button>
        {editingId && (
          <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>
            Cancel
          </button>
        )}
      </form>

      {/* Table */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Role</th>
            <th>Gamemaster ID</th>
            <th>Game ID</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => (
            <tr key={p.id}>
              <td>{p.username}</td>
              <td>{p.email}</td>
              <td>{p.role}</td>
              <td>{p.gamemaster_id || '—'}</td>
              <td>{p.game_id || '—'}</td>
              <td>
                {canManage(p.role) && (
                  <>
                    <button onClick={() => handleEdit(p)}>Edit</button>
                    <button onClick={() => handleDelete(p.id)} style={{ marginLeft: 4 }}>
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}