/*
 * FILE: src/Game.jsx
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js
 * │   ├── App.jsx
 * │   ├── Game.jsx  <-- YOU ARE HERE
 * │   ├── Map.jsx
 * │   ├── useGpsTracker.js
 * │   ├── TripStatusBanner.jsx
 * │   ├── AlightPrompt.jsx
 * │   └── Scoreboard.jsx
 */

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useGpsTracker } from "./useGpsTracker";
import Map from "./Map";
import TripStatusBanner from "./TripStatusBanner";
import Scoreboard from "./Scoreboard";
import AlightPrompt from "./AlightPrompt";

export default function Game({ session, game }) {
  const [channel, setChannel] = useState(null);
  const [alightPrompt, setAlightPrompt] = useState(null);

  // 1. Setup Broadcast Channel
  useEffect(() => {
    const ch = supabase.channel(`game:${game.id}`, {
      config: { broadcast: { self: false } },
    });
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") setChannel(ch);
    });
    return () => supabase.removeChannel(ch);
  }, [game.id]);

  // 2. GPS Tracking (15s + visibility)
  const { position } = useGpsTracker({ channel, playerId: session.user.id });

  // 3. Listen for cancellation/skips (Mocked for prototype)
  useEffect(() => {
    // In a real scenario, this listens to postgres_changes on trip_realtime_state
    // For the prototype, we just leave the hook open
  }, [game.id]);

  return (
    <div style={{ position: "relative", height: "100vh" }}>
      <TripStatusBanner status="on_time" delay={0} />
      
      {channel && (
        <Map position={position} channel={channel} playerId={session.user.id} />
      )}

      <Scoreboard gameId={game.id} playerId={session.user.id} />
      
      {alightPrompt && (
        <AlightPrompt
          prompt={alightPrompt}
          onConfirm={() => setAlightPrompt(null)}
          onDismiss={() => setAlightPrompt(null)}
        />
      )}
    </div>
  );
}