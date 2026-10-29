/*
 * FILE: supabase/functions/poll-gtfs-rt/index.ts
 * 
 * FILE TREE:
 * interchange/
 * ├── supabase/
 * │   ├── migrations/
 * │   └── functions/
 * │       ├── _shared/
 * │       └── poll-gtfs-rt/
 * │           └── index.ts  <-- YOU ARE HERE
 */

import { admin } from "../_shared/supabase.ts";
import GtfsRealtimeBindings from "https://esm.sh/gtfs-realtime-bindings@1.1.1";

const KEY = Deno.env.get("GTFS_API_KEY");
const TRIP_URL = Deno.env.get("GTFS_RT_TRIP_UPDATES_URL");

Deno.serve(async () => {
  const db = admin();

  // Prototype fallback: if no API key is set, simulate a cancelled trip
  if (!KEY || !TRIP_URL) {
    console.log("No GTFS keys provided. Simulating live data for prototype...");
    await db.from("trip_realtime_state").upsert({
      trip_id: "mock-trip-123",
      delay_seconds: 180,
      cancelled: true, // Simulate a cancellation to test UI
      observed_at: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ simulated: true }));
  }

  try {
    const res = await fetch(TRIP_URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const buffer = await res.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const rows = feed.entity
      .filter((e) => e.tripUpdate)
      .map((e) => {
        const tu = e.tripUpdate!;
        return {
          trip_id: tu.trip.tripId,
          delay_seconds: tu.delay ?? 0,
          cancelled: tu.trip.scheduleRelationship === 3, // CANCELED
          skipped_stop_ids: tu.stopTimeUpdate?.filter((s) => s.scheduleRelationship === 1).map((s) => s.stopId) ?? [],
          observed_at: new Date().toISOString(),
        };
      });

    if (rows.length) {
      await db.from("trip_realtime_state").upsert(rows, { onConflict: "trip_id" });
    }

    return new Response(JSON.stringify({ updated: rows.length }));
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});