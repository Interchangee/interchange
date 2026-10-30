/* src/App.jsx */
import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import Game from './Game'
import UserManagement from './UserManagement'
import TeamManagement from './TeamManagement'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Login states
  const [loginMode, setLoginMode] = useState('player') // 'player' | 'standard'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [gmName, setGmName] = useState('')
  const [playerName, setPlayerName] = useState('')

  // Active tab
  const [activeTab, setActiveTab] = useState('game') // 'game' | 'users' | 'teams'

  // Mock game for prototype
  const game = { id: 'test-game-123', name: 'Swiss Transit Challenge' }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    let targetEmail = email

    if (loginMode === 'player') {
      const { data: fetchedEmail, error: rpcError } = await supabase.rpc(
        'get_player_email',
        { p_gamemaster_name: gmName, p_player_name: playerName }
      )
      if (rpcError || !fetchedEmail) {
        setError('Could not find this player under that Gamemaster.')
        return
      }
      targetEmail = fetchedEmail
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: targetEmail,
      password,
    })
    if (authError) setError(authError.message)
  }

  if (loading) return <div>Loading...</div>

  if (!session) {
    return (
      <div style={{ maxWidth: 400, margin: '2rem auto' }}>
        <h2>Interchange Login</h2>
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => setLoginMode('player')}
            style={{ fontWeight: loginMode === 'player' ? 'bold' : 'normal', marginRight: 10 }}
          >
            Player Login
          </button>
          <button
            onClick={() => setLoginMode('standard')}
            style={{ fontWeight: loginMode === 'standard' ? 'bold' : 'normal' }}
          >
            Staff Login
          </button>
        </div>

        {error && <p style={{ color: 'red' }}>{error}</p>}

        <form onSubmit={handleLogin}>
          {loginMode === 'player' ? (
            <>
              <input
                placeholder="Gamemaster Name"
                value={gmName}
                onChange={(e) => setGmName(e.target.value)}
                required
                style={{ display: 'block', width: '100%', marginBottom: 8 }}
              />
              <input
                placeholder="Player Name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                required
                style={{ display: 'block', width: '100%', marginBottom: 8 }}
              />
            </>
          ) : (
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginBottom: 8 }}
            />
          )}
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ display: 'block', width: '100%', marginBottom: 8 }}
          />
          <button type="submit" style={{ width: '100%' }}>
            Log In
          </button>
        </form>
      </div>
    )
  }

  // Authenticated – show tab navigation
  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setActiveTab('game')}
          style={{ fontWeight: activeTab === 'game' ? 'bold' : 'normal' }}
        >
          Game
        </button>
        <button
          onClick={() => setActiveTab('users')}
          style={{ fontWeight: activeTab === 'users' ? 'bold' : 'normal' }}
        >
          Users
        </button>
        <button
          onClick={() => setActiveTab('teams')}
          style={{ fontWeight: activeTab === 'teams' ? 'bold' : 'normal' }}
        >
          Teams
        </button>
        <button onClick={() => supabase.auth.signOut()} style={{ marginLeft: 'auto' }}>
          Sign Out
        </button>
      </header>

      {activeTab === 'game' && <Game session={session} game={game} />}
      {activeTab === 'users' && <UserManagement session={session} />}
      {activeTab === 'teams' && <TeamManagement session={session} />}
    </div>
  )
}