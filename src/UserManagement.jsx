/* src/UserManagement.jsx */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "./supabase";

const ROLE_LABELS = {
  admin: "Admin",
  manager: "Manager",
  gamemaster: "Gamemaster",
  player: "Player",
};

export default function UserManagement({ session, profile, canManage }) {
  const [users, setUsers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Form state
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "player",
    gamemaster_id: "",
    team_id: "",
  });
  const [teamForm, setTeamForm] = useState({ name: "" });
  const [editingTeam, setEditingTeam] = useState(null);

  const currentUserId = session.user.id;
  const currentRole = profile?.role;

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");

    let userQuery = supabase.from("profiles").select("*");

    if (currentRole === "gamemaster") {
      userQuery = userQuery.eq("gamemaster_id", currentUserId);
    } else if (currentRole === "player") {
      const { data: self } = await supabase
        .from("profiles")
        .select("gamemaster_id")
        .eq("id", currentUserId)
        .single();
      if (self?.gamemaster_id) {
        userQuery = userQuery.eq("gamemaster_id", self.gamemaster_id);
      } else {
        userQuery = userQuery.eq("id", currentUserId); // fallback: only self
      }
    }
    // admin & manager see all

    const { data: usersData, error: usersError } = await userQuery;
    if (usersError) {
      setError(usersError.message);
      setLoading(false);
      return;
    }

    let teamQuery = supabase.from("teams").select("*");
    if (currentRole === "gamemaster") {
      teamQuery = teamQuery.eq("gamemaster_id", currentUserId);
    } else if (currentRole === "player") {
      const { data: self } = await supabase
        .from("profiles")
        .select("gamemaster_id")
        .eq("id", currentUserId)
        .single();
      if (self?.gamemaster_id) {
        teamQuery = teamQuery.eq("gamemaster_id", self.gamemaster_id);
      }
    }

    const { data: teamsData, error: teamsError } = await teamQuery;
    if (teamsError) {
      setError(teamsError.message);
      setLoading(false);
      return;
    }

    setUsers(usersData || []);
    setTeams(teamsData || []);
    setLoading(false);
  }, [currentUserId, currentRole]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ---------------------------------------------------------------------------
  // Permission helpers
  // ---------------------------------------------------------------------------
  const canEditUser = (targetUser) => {
    if (currentRole === "admin") return true;
    if (currentRole === "manager") {
      return targetUser.role === "gamemaster" || targetUser.role === "player";
    }
    if (currentRole === "gamemaster") {
      return targetUser.role === "player" && targetUser.gamemaster_id === currentUserId;
    }
    return false;
  };

  const canDeleteUser = (targetUser) => {
    // Same as edit, but you cannot delete yourself
    if (targetUser.id === currentUserId) return false;
    return canEditUser(targetUser);
  };

  const canManageTeams = () => {
    return currentRole === "admin" || currentRole === "manager" || currentRole === "gamemaster";
  };

  const canEditTeam = (team) => {
    if (currentRole === "admin" || currentRole === "manager") return true;
    if (currentRole === "gamemaster") return team.gamemaster_id === currentUserId;
    return false;
  };

  // ---------------------------------------------------------------------------
  // User CRUD
  // ---------------------------------------------------------------------------
  const resetUserForm = () => {
    setEditingUser(null);
    setUserForm({
      name: "",
      email: "",
      password: "",
      role: "player",
      gamemaster_id: "",
      team_id: "",
    });
  };

  const handleUserSubmit = async (e) => {
    e.preventDefault();
    setError("");

    const payload = {
      name: userForm.name,
      role: userForm.role,
      gamemaster_id: userForm.gamemaster_id || null,
      team_id: userForm.team_id || null,
    };

    if (editingUser) {
      // Update
      const { error } = await supabase
        .from("profiles")
        .update(payload)
        .eq("id", editingUser.id);
      if (error) setError(error.message);
      else {
        resetUserForm();
        fetchData();
      }
    } else {
      // Create
      if (!userForm.email || !userForm.password) {
        setError("Email and password are required for new users.");
        return;
      }

      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: userForm.email,
        password: userForm.password,
        email_confirm: true,
        user_metadata: { name: userForm.name },
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      const newUserId = authData.user.id;
      const { error: profileError } = await supabase.from("profiles").insert({
        id: newUserId,
        ...payload,
      });

      if (profileError) setError(profileError.message);
      else {
        resetUserForm();
        fetchData();
      }
    }
  };

  const handleDeleteUser = async (user) => {
    if (!window.confirm(`Delete user "${user.name}"?`)) return;
    setError("");

    if (user.role === "player") {
      // For players, deleting the profile is usually sufficient (auth user may remain).
      const { error } = await supabase.from("profiles").delete().eq("id", user.id);
      if (error) setError(error.message);
      else fetchData();
    } else {
      // For staff, delete the auth user as well (requires service role).
      const { error: authError } = await supabase.auth.admin.deleteUser(user.id);
      if (authError) setError(authError.message);
      else fetchData();
    }
  };

  const startEditUser = (user) => {
    setEditingUser(user);
    setUserForm({
      name: user.name,
      email: user.email || "",
      password: "",
      role: user.role,
      gamemaster_id: user.gamemaster_id || "",
      team_id: user.team_id || "",
    });
  };

  // ---------------------------------------------------------------------------
  // Team CRUD
  // ---------------------------------------------------------------------------
  const handleTeamSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (editingTeam) {
      const { error } = await supabase
        .from("teams")
        .update({ name: teamForm.name })
        .eq("id", editingTeam.id);
      if (error) setError(error.message);
      else {
        setEditingTeam(null);
        setTeamForm({ name: "" });
        fetchData();
      }
    } else {
      // For gamemaster, force gamemaster_id to self.
      const gamemasterId =
        currentRole === "gamemaster" ? currentUserId : userForm.gamemaster_id || currentUserId;

      const { error } = await supabase.from("teams").insert({
        name: teamForm.name,
        gamemaster_id: gamemasterId,
      });
      if (error) setError(error.message);
      else {
        setTeamForm({ name: "" });
        fetchData();
      }
    }
  };

  const handleDeleteTeam = async (team) => {
    if (!window.confirm(`Delete team "${team.name}"? Players will be unassigned.`)) return;
    const { error } = await supabase.from("teams").delete().eq("id", team.id);
    if (error) setError(error.message);
    else fetchData();
  };

  const startEditTeam = (team) => {
    setEditingTeam(team);
    setTeamForm({ name: team.name });
  };

  // ---------------------------------------------------------------------------
  // Drag & drop
  // ---------------------------------------------------------------------------
  const handleDragStart = (e, player) => {
    e.dataTransfer.setData("text/plain", player.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDropOnTeam = async (e, teamId) => {
    e.preventDefault();
    const playerId = e.dataTransfer.getData("text/plain");
    if (!playerId) return;

    if (!canManage) {
      setError("You do not have permission to move players.");
      return;
    }

    const { error } = await supabase
      .from("profiles")
      .update({ team_id: teamId })
      .eq("id", playerId);
    if (error) setError(error.message);
    else fetchData();
  };

  const handleDropOutside = async (e) => {
    e.preventDefault();
    const playerId = e.dataTransfer.getData("text/plain");
    if (!playerId) return;

    if (!canManage) {
      setError("You do not have permission to move players.");
      return;
    }

    const { error } = await supabase
      .from("profiles")
      .update({ team_id: null })
      .eq("id", playerId);
    if (error) setError(error.message);
    else fetchData();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) return <p>Loading users…</p>;

  const players = users.filter((u) => u.role === "player");
  const unassignedPlayers = players.filter((p) => !p.team_id);
  const staffUsers = users.filter((u) => u.role !== "player");

  return (
    <div style={{ padding: 16 }}>
      <h2>User Management</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}

      {/* ===== USER LIST ===== */}
      <section style={{ marginBottom: 32 }}>
        <h3>Users</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Name</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Role</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Gamemaster</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Team</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{ROLE_LABELS[u.role] || u.role}</td>
                <td>{users.find((x) => x.id === u.gamemaster_id)?.name || "—"}</td>
                <td>{teams.find((t) => t.id === u.team_id)?.name || "—"}</td>
                <td>
                  {canEditUser(u) && (
                    <button onClick={() => startEditUser(u)}>Edit</button>
                  )}{" "}
                  {canDeleteUser(u) && (
                    <button onClick={() => handleDeleteUser(u)} style={{ color: "red" }}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: 12 }}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ===== USER FORM (only if can manage) ===== */}
      {canManage && (
        <section style={{ marginBottom: 32, padding: 16, border: "1px solid #ccc" }}>
          <h3>{editingUser ? "Edit User" : "Create User"}</h3>
          <form onSubmit={handleUserSubmit}>
            <input
              placeholder="Name"
              value={userForm.name}
              onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
              required
              style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
            />
            {!editingUser && (
              <>
                <input
                  type="email"
                  placeholder="Email"
                  value={userForm.email}
                  onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                  required
                  style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={userForm.password}
                  onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                  required
                  style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
                />
              </>
            )}
            <select
              value={userForm.role}
              onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
              style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
            >
              <option value="player">Player</option>
              <option value="gamemaster">Gamemaster</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>

            {(userForm.role === "player") && (
              <select
                value={userForm.gamemaster_id}
                onChange={(e) => setUserForm({ ...userForm, gamemaster_id: e.target.value })}
                style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
              >
                <option value="">Select Gamemaster</option>
                {users
                  .filter((u) => u.role === "gamemaster")
                  .map((gm) => (
                    <option key={gm.id} value={gm.id}>
                      {gm.name}
                    </option>
                  ))}
              </select>
            )}

            {(userForm.role === "player") && (
              <select
                value={userForm.team_id}
                onChange={(e) => setUserForm({ ...userForm, team_id: e.target.value })}
                style={{ display: "block", width: "100%", marginBottom: 8, padding: 8 }}
              >
                <option value="">No Team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            <button type="submit">{editingUser ? "Update" : "Create"}</button>
            {editingUser && (
              <button type="button" onClick={resetUserForm} style={{ marginLeft: 8 }}>
                Cancel
              </button>
            )}
          </form>
        </section>
      )}

      {/* ===== TEAMS SECTION ===== */}
      {canManageTeams() && (
        <section style={{ marginBottom: 32, padding: 16, border: "1px solid #ccc" }}>
          <h3>Teams</h3>
          <form onSubmit={handleTeamSubmit} style={{ marginBottom: 16 }}>
            <input
              placeholder="Team name"
              value={teamForm.name}
              onChange={(e) => setTeamForm({ name: e.target.value })}
              required
              style={{ marginRight: 8, padding: 8 }}
            />
            <button type="submit">{editingTeam ? "Update Team" : "Create Team"}</button>
            {editingTeam && (
              <button
                type="button"
                onClick={() => {
                  setEditingTeam(null);
                  setTeamForm({ name: "" });
                }}
                style={{ marginLeft: 8 }}
              >
                Cancel
              </button>
            )}
          </form>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDropOutside}
            style={{ padding: 12, border: "1px dashed #999", marginBottom: 16 }}
          >
            <strong>Unassigned players</strong> (drop here to remove from team)
            <ul style={{ listStyle: "none", padding: 0 }}>
              {unassignedPlayers.map((p) => (
                <li
                  key={p.id}
                  draggable={canManage}
                  onDragStart={(e) => handleDragStart(e, p)}
                  style={{
                    padding: 8,
                    margin: 4,
                    background: "#f0f0f0",
                    cursor: canManage ? "grab" : "default",
                  }}
                >
                  {p.name}
                </li>
              ))}
              {unassignedPlayers.length === 0 && (
                <li style={{ color: "#888" }}>All players are assigned.</li>
              )}
            </ul>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {teams.map((team) => {
              const teamPlayers = players.filter((p) => p.team_id === team.id);
              return (
                <div
                  key={team.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDropOnTeam(e, team.id)}
                  style={{
                    flex: "1 1 240px",
                    minHeight: 160,
                    padding: 12,
                    border: "1px solid #ccc",
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <strong>{team.name}</strong>
                    {canEditTeam(team) && (
                      <span>
                        <button onClick={() => startEditTeam(team)}>✏️</button>{" "}
                        <button onClick={() => handleDeleteTeam(team)} style={{ color: "red" }}>
                          🗑️
                        </button>
                      </span>
                    )}
                  </div>
                  <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
                    {teamPlayers.map((p) => (
                      <li
                        key={p.id}
                        draggable={canManage}
                        onDragStart={(e) => handleDragStart(e, p)}
                        style={{
                          padding: 8,
                          margin: 4,
                          background: "#e8f0fe",
                          cursor: canManage ? "grab" : "default",
                        }}
                      >
                        {p.name}
                      </li>
                    ))}
                    {teamPlayers.length === 0 && (
                      <li style={{ color: "#888" }}>Drop players here</li>
                    )}
                  </ul>
                </div>
              );
            })}
            {teams.length === 0 && <p>No teams yet.</p>}
          </div>
        </section>
      )}

      {/* ===== STAFF LIST (optional, for clarity) ===== */}
      {staffUsers.length > 0 && (
        <section>
          <h3>Staff</h3>
          <ul>
            {staffUsers.map((u) => (
              <li key={u.id}>
                {u.name} — {ROLE_LABELS[u.role]}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}