/*
 * FILE: src/App.jsx
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── App.jsx  <-- YOU ARE HERE
 */

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import Game from "./Game";

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  
  // Login states
  const [loginMode, setLoginMode] = useState("player"); // 'player' or 'standard'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [gmName, setGmName] = useState("");
  const [playerName, setPlayerName] = useState("");

  // Mock game for prototype
  const game = { id: "test-game-123", name: "Swiss Transit Challenge" };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    
    let targetEmail = email;

    // If player login, look up their fake email using the RPC
    if (loginMode === "player") {
      const { data: fetchedEmail, error: rpcError } = await supabase.rpc('get_player_email', {
        p_gamemaster_name: gmName,
        p_player_name: playerName
      });
      
      if (rpcError || !fetchedEmail) {
        setError("Could not find this player under that Gamemaster.");
        return;
      }
      targetEmail = fetchedEmail;
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: targetEmail,
      password: password,
    });

    if (authError) setError(authError.message);
  };

  if (loading) return <div>Loading...</div>;
  if (session) return <Game session={session} game={game} />;

  return (
    <div style={{ padding: "40px", maxWidth: "400px", margin: "0 auto" }}>
      <h2>Interchange Login</h2>
      
      <div style={{ marginBottom: "20px" }}>
        <button onClick={() => setLoginMode("player")} style={{ fontWeight: loginMode === "player" ? "bold" : "normal", marginRight: "10px" }}>Player Login</button>
        <button onClick={() => setLoginMode("standard")} style={{ fontWeight: loginMode === "standard" ? "bold" : "normal" }}>Staff Login</button>
      </div>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {loginMode === "player" ? (
          <>
            <input placeholder="Gamemaster Name" value={gmName} onChange={e => setGmName(e.target.value)} required />
            <input placeholder="Your Player Name" value={playerName} onChange={e => setPlayerName(e.target.value)} required />
          </>
        ) : (
          <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        )}
        <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button type="submit" style={{ padding: "10px" }}>Log In</button>
      </form>
    </div>
  );
}