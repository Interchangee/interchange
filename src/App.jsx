/*
 * FILE: src/App.jsx
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js
 * │   ├── App.jsx  <-- YOU ARE HERE
 * │   ├── Game.jsx
 * │   ├── Map.jsx
 * │   ├── useGpsTracker.js
 * │   ├── TripStatusBanner.jsx
 * │   ├── AlightPrompt.jsx
 * │   └── Scoreboard.jsx
 */

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import Game from "./Game";

export default function App() {
  const [session, setSession] = useState(null);
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Get mock session for prototype testing
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSession(session);
      } else {
        // Mock a player if no auth is set up yet
        setSession({ user: { id: "test-player-123" } });
      }
      setGame({ id: "test-game-123", name: "Swiss Transit Challenge" });
      setLoading(false);
    });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {session && game ? (
        <Game session={session} game={game} />
      ) : (
        <div>Please log in.</div>
      )}
    </div>
  );
}