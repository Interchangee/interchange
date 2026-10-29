/*
 * FILE: src/Map.jsx
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js
 * │   ├── App.jsx
 * │   ├── Game.jsx
 * │   ├── Map.jsx  <-- YOU ARE HERE
 * │   ├── useGpsTracker.js
 * │   ├── TripStatusBanner.jsx
 * │   ├── AlightPrompt.jsx
 * │   └── Scoreboard.jsx
 */

import { MapContainer, TileLayer, Marker, Popup, CircleMarker } from "react-leaflet";
import { useEffect, useState } from "react";
import "leaflet/dist/leaflet.css";

export default function Map({ position, channel, playerId }) {
  const [others, setOthers] = useState({});

  useEffect(() => {
    if (!channel) return;
    channel.on("broadcast", { event: "location" }, ({ payload }) => {
      if (payload.player_id !== playerId) {
        setOthers((prev) => ({ ...prev, [payload.player_id]: payload }));
      }
    });
  }, [channel, playerId]);

  return (
    <MapContainer center={[46.8, 8.2]} zoom={8} style={{ height: "100vh", width: "100%" }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {position && (
        <CircleMarker center={[position.lat, position.lon]} radius={8} color="blue">
          <Popup>You</Popup>
        </CircleMarker>
      )}
      {Object.entries(others).map(([id, p]) => (
        <Marker key={id} position={[p.lat, p.lon]}>
          <Popup>Player {id.slice(0, 4)}</Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}