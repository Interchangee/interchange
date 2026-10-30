/* src/App.jsx */
import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import Game from './Game'
import UserManagement from './UserManagement'
import TeamManagement from './TeamManagement'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  // login form state
  const [loginMode, setLoginMode] = useState('player') // 'player' | 'staff'
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [gmName, setGmName]       = useState('')
  const [playerName, setPlayerName] = useState('')

  // tabs
  const [activeTab, setActiveTab] = useState('game')

  // Placeholder game – replace with real source later
  const game = { id: 'test-game-123', name: 'Swiss Transit Challenge' }

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
    })
    return () => {
      mounted = false
      subscription.unsubscribe()
    }
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
        setError('Could not find that player under that gamemaster.')
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

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>

  if (!session) {
    return (
      <div style={{ maxWidth: 400, margin: '2rem auto' }}>
        <h2>Interchange Login</h2>
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => setLoginMode('player')}
            style={{ fontWeight: loginMode === 'player' ? 'bold' : 'normal', marginRight: 10 }}
          >
            Player
          </button>
          <button
            onClick={() => setLoginMode('staff')}
            style={{ fontWeight: loginMode === 'staff' ? 'bold' : 'normal' }}
          >
            Staff
          </button>
        </div>

        {error && <p style={{ color: 'crimson' }}>{error}</p>}

        <form onSubmit={handleLogin}>
          {loginMode === 'player' ? (
            <>
              <input
                placeholder="Gamemaster name"
                value={gmName}
                onChange={(e) => setGmName(e.target.value)}
                required
                style={{ display: 'block', width: '100%', marginBottom: 8 }}
              />
              <input
                placeholder="Player name"
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
          <button type="submit" style={{ width: '100%' }}>Log in</button>
        </form>
      </div>
    )
  }

  const tabStyle = (key) => ({
    fontWeight: activeTab === key ? 'bold' : 'normal',
    padding: '6px 12px',
  })

  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
        <button style={tabStyle('game')}  onClick={() => setActiveTab('game')}>Game</button>
        <button style={tabStyle('users')} onClick={() => setActiveTab('users')}>Users</button>
        <button style={tabStyle('teams')} onClick={() => setActiveTab('teams')}>Teams</button>
        <button onClick={() => supabase.auth.signOut()} style={{ marginLeft: 'auto' }}>
          Sign out
        </button>
      </header>

      {activeTab === 'game' && <Game session={session} game={game} />}
      {activeTab === 'users' && <UserManagement session={session} />}
      {activeTab === 'teams' && <TeamManagement session={session} />}
    </div>
  )
}