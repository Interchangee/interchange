/*
 * FILE: src/TripStatusBanner.jsx
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js
 * │   ├── App.jsx
 * │   ├── Game.jsx
 * │   ├── Map.jsx
 * │   ├── useGpsTracker.js
 * │   ├── TripStatusBanner.jsx  <-- YOU ARE HERE
 * │   ├── AlightPrompt.jsx
 * │   └── Scoreboard.jsx
 */

export default function TripStatusBanner({ status = "on_time", delay = 0 }) {
  const getStyle = () => {
    if (status === "cancelled") return { background: "#d32f2f", color: "white" };
    if (status === "late" || delay > 120) return { background: "#f57c00", color: "white" };
    return { background: "#388e3c", color: "white" };
  };

  const getMessage = () => {
    if (status === "cancelled") return "⚠️ Trip Cancelled - Please Alight";
    if (delay > 120) return `⏱️ Delayed by ${Math.round(delay / 60)} min`;
    return "✅ On Time";
  };

  return (
    <div style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      padding: "10px",
      textAlign: "center",
      fontWeight: "bold",
      zIndex: 1000,
      ...getStyle()
    }}>
      {getMessage()}
    </div>
  );
}