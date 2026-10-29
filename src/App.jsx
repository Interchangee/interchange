import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import Game from './Game';

export default function App() {
  const [session, setSession]   = useState(undefined);
  const [games, setGames]       = useState([]);
  const [activeGame, setActive] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('games')
      .select('id, name, status, starts_at, ends_at')
      .in('status', ['open', 'running'])
      .order('starts_at')
      .then(({ data }) => setGames(data ?? []));
  }, [session]);

  if (session === undefined) return <div className="loading">Loading…</div>;

  if (!session) {
    return (
      <div className="auth-screen">
        <h1>Interchange</h1>
        <p>Sign in to play.</p>
        <button
          onClick={() =>
            supabase.auth.signInWithOAuth({
              provider: 'google',
              options: { redirectTo: window.location.origin },
            })
          }
        >
          Continue with Google
        </button>
        <button
          onClick={async () => {
            const email = window.prompt('Email:');
            if (!email) return;
            const { error } = await supabase.auth.signInWithOtp({ email });
            if (error) window.alert(error.message);
            else window.alert('Check your email for the magic link.');
          }}
        >
          Email magic link
        </button>
      </div>
    );
  }

  if (!activeGame) {
    return (
      <div className="game-select">
        <h1>Choose a game</h1>
        {games.length === 0 && <p>No open games right now.</p>}
        <ul>
          {games.map(g => (
            <li key={g.id}>
              <button onClick={() => setActive(g)}>
                {g.name} <small>({g.status})</small>
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    );
  }

  return <Game game={activeGame} authUser={session.user} onExit={() => setActive(null)} />;
}