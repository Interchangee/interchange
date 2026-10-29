/*
 * FILE: src/AlightPrompt.jsx
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js
 * │   ├── App.jsx
 * │   ├── Game.jsx
 * │   ├── Map.jsx
 * │   ├── useGpsTracker.js
 * │   ├── TripStatusBanner.jsx
 * │   ├── AlightPrompt.jsx  <-- YOU ARE HERE
 * │   └── Scoreboard.jsx
 */

export default function AlightPrompt({ prompt, onConfirm, onDismiss }) {
  if (!prompt) return null;

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      background: "white",
      padding: "20px",
      borderTopLeftRadius: "16px",
      borderTopRightRadius: "16px",
      boxShadow: "0 -4px 12px rgba(0,0,0,0.15)",
      zIndex: 1000
    }}>
      <h3 style={{ margin: "0 0 10px 0" }}>
        {prompt.reason === "cancelled" ? "Trip Cancelled" : "Stop Skipped"}
      </h3>
      <p style={{ margin: "0 0 20px 0", color: "#555" }}>
        {prompt.reason === "cancelled" 
          ? "This train was cancelled. We've inferred your location based on your last GPS point. Is this correct?"
          : "The train skipped your declared stop. Please confirm where you actually got off."}
      </p>
      <div style={{ display: "flex", gap: "10px" }}>
        <button 
          onClick={onConfirm}
          style={{ flex: 1, padding: "12px", background: "#1976d2", color: "white", border: "none", borderRadius: "8px", fontWeight: "bold" }}
        >
          Confirm
        </button>
        <button 
          onClick={onDismiss}
          style={{ flex: 1, padding: "12px", background: "#e0e0e0", color: "#333", border: "none", borderRadius: "8px", fontWeight: "bold" }}
        >
          Correct
        </button>
      </div>
    </div>
  );
}