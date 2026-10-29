import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export default function Scoreboard({ gameId, playerId }) {
  const [score, setScore] = useState(0);

  useEffect(() => {
    const fetchScore = async () => {
      const { data } = await supabase
        .from("score_ledger")
        .select("points_delta")
        .eq("player_id", playerId)
        .eq("game_id", gameId);
      
      if (data) {
        const total = data.reduce((sum, row) => sum + row.points_delta, 0);
        setScore(total);
      }
    };
    
    fetchScore();

    const channel = supabase
      .channel('score_updates')
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'score_ledger',
        filter: `player_id=eq.${playerId}`
      }, (payload) => {
        setScore((prev) => prev + payload.new.points_delta);
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [gameId, playerId]);

  return (
    <div style={{
      position: "absolute",
      top: "60px",
      right: "16px",
      background: "rgba(255, 255, 255, 0.9)",
      padding: "12px 20px",
      borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      zIndex: 1000,
      textAlign: "center"
    }}>
      <div style={{ fontSize: "12px", color: "#666", textTransform: "uppercase", letterSpacing: "1px" }}>Score</div>
      <div style={{ fontSize: "24px", fontWeight: "bold", color: "#1976d2" }}>{score}</div>
    </div>
  );
}