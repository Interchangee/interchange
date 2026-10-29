/*
 * FILE: src/useGpsTracker.js
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js
 * │   ├── App.jsx
 * │   ├── Game.jsx
 * │   ├── Map.jsx
 * │   ├── useGpsTracker.js  <-- YOU ARE HERE
 * │   ├── TripStatusBanner.jsx
 * │   ├── AlightPrompt.jsx
 * │   └── Scoreboard.jsx
 * 
 * DO NOT CREATE: src/hooks/, src/utils/
 */

import { useEffect, useRef, useState } from "react";

export function useGpsTracker({ channel, playerId }) {
  const [position, setPosition] = useState(null);
  const lastSentRef = useRef(0);
  const watchIdRef = useRef(null);
  const channelRef = useRef(channel);

  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  const sendPosition = (pos) => {
    if (!pos || !channelRef.current) return;
    const payload = {
      player_id: playerId,
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      ts: Date.now(),
    };
    setPosition(payload);
    channelRef.current.send({ type: "broadcast", event: "location", payload });
    lastSentRef.current = Date.now();
  };

  useEffect(() => {
    if (!navigator.geolocation) return;

    // 1. Watch position, throttle broadcast to 15 seconds
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - lastSentRef.current >= 15000) {
          sendPosition(pos);
        }
      },
      (err) => console.error(err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    // 2. Force send on tab visibility change
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        navigator.geolocation.getCurrentPosition(
          (pos) => sendPosition(pos),
          (err) => console.error(err),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
        );
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [playerId]);

  return { position };
}