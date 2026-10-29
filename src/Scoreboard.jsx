import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export default function Scoreboard({ gameId, mySessionId }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!gameId) return;
    const load = async () => {
      const { data } = await supabase.from('leaderboard')
        .select('player_session_id, score')
        .eq('game_id', gameId)
        .order('score', { ascending: false })
        .limit(10);
      setRows(data ?? []);
    };
    load();
    const ch = supabase.channel(`scoreboard:${gameId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'score_ledger', filter: `game_id=eq.${gameId}` },
        load)
      .subscribe();
    return () => ch.unsubscribe();
  }, [gameId]);

  return (
    <div className="scoreboard">
      <h3>Leaderboard</h3>
      <ol>
        {rows.map((r, i) => (
          <li key={r.player_session_id}
              className={r.player_session_id === mySessionId ? 'is-me' : ''}>
            #{i + 1} — {r.score} pts
          </li>
        ))}
        {rows.length === 0 && <li>No scores yet.</li>}
      </ol>
    </div>
  );
}