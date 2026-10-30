/* src/App.jsx */
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import Game from "./Game";
import UserManagement from "./UserManagement";

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Login states
  const [loginMode, setLoginMode] = useState("player"); // 'player' or 'standard'
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [gmName, setGmName] = useState("");
  const [playerName, setPlayerName] = useState("");

  // Current user profile & active tab
  const [profile, setProfile] = useState(null);
  const [activeTab, setActiveTab] = useState("game");

  const game = { id: "test-game-123", name: "Swiss Transit Challenge" };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchProfile(session.user.id);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
        if (session) fetchProfile(session.user.id);
        else setProfile(null);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const fetchProfile = async (userId) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    setProfile(data);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    let targetEmail = "";

    if (loginMode === "player") {
      // Player login: gamemaster name + player name
      const { data: fetchedEmail, error: rpcError } = await supabase.rpc(
        "get_player_email",
        { p_gamemaster_name: gmName, p_player_name: playerName }
      );
      if (rpcError || !fetchedEmail) {
        setError("Could not find this player under that Gamemaster.");
        return;
      }
      targetEmail = fetchedEmail;
    } else {
      // Staff login: globally unique name
      const { data: fetchedEmail, error: rpcError } = await supabase.rpc(
        "get_staff_email",
        { p_name: name }
      );
      if (rpcError || !fetchedEmail) {
        setError("Staff member not found.");
        return;
      }
      targetEmail = fetchedEmail;
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: targetEmail,
      password,
    });
    if (authError) setError(authError.message);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setActiveTab("game");
  };

  if (loading) return <div>Loading...</div>;

  if (!session) {
    return (
      <div style={{ maxWidth: 400, margin: "80px auto" }}>
        <h2>Interchange Login</h2>
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setLoginMode("player")}
            style={{ fontWeight: loginMode === "player" ? "bold" : "normal", marginRight: 10 }}
          >
            Player Login
          </button>
          <button
            onClick={() => setLoginMode("standard")}
            style={{ fontWeight: loginMode === "standard" ? "bold" : "normal" }}
          >
            Staff Login
          </button>
        </div>

        {error && <p style={{ color: "red" }}>{error}</p>}

        <form onSubmit={handleLogin}>
          {loginMode === "player" ? (
            <>
              <input
                placeholder="Gamemaster Name"
                value={gmName}
                onChange={(e) => setGmName(e.target.value)}
                required
                style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
              />
              <input
                placeholder="Player Name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                required
                style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
              />
            </>
          ) : (
            <input
              placeholder="Your Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
            />
          )}
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
          />
          <button type="submit" style={{ width: "100%", padding: 10 }}>
            Log In
          </button>
        </form>
      </div>
    );
  }

  // Logged in – render tabs
  const canManageUsers =
    profile?.role === "admin" ||
    profile?.role === "manager" ||
    profile?.role === "gamemaster";

  return (
    <div>
      <nav style={{ display: "flex", gap: 8, padding: 12, borderBottom: "1px solid #ccc" }}>
        <button
          onClick={() => setActiveTab("game")}
          style={{ fontWeight: activeTab === "game" ? "bold" : "normal" }}
        >
          Game
        </button>
        <button
          onClick={() => setActiveTab("users")}
          style={{ fontWeight: activeTab === "users" ? "bold" : "normal" }}
        >
          Users
        </button>
        <span style={{ marginLeft: "auto" }}>
          {profile?.name} ({profile?.role}){" "}
          <button onClick={handleLogout}>Logout</button>
        </span>
      </nav>

      {activeTab === "game" && <Game session={session} game={game} />}
      {activeTab === "users" && (
        <UserManagement session={session} profile={profile} canManage={canManageUsers} />
      )}
    </div>
  );
}