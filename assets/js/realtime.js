/* ==========================================================================
   GTFS-Realtime (free, keyless protobuf feeds).
   When an agency publishes vehicle positions we can name the actual vehicle
   ("bus 4213 on route 12") instead of guessing from the schedule.
   ========================================================================== */

import { decodeFeedMessage } from './protobuf.js';

const DEFAULT_TTL_MS = 25000;
const cache = new Map(); // url -> {at, data, error}

function headersFor(agency) {
  const h = { Accept: 'application/x-protobuf, application/octet-stream, */*' };
  const extra = agency?.rt_headers || {};
  for (const [k, v] of Object.entries(extra)) if (v) h[k] = v;
  return h;
}

async function fetchFeed(url, agency, { signal } = {}) {
  const res = await fetch(url, { headers: headersFor(agency), signal });
  if (!res.ok) throw new Error(`Realtime feed HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return decodeFeedMessage(new Uint8Array(buf));
}

/**
 * Live vehicle positions, cached for a few seconds so a screen refresh does
 * not hammer the feed (and so we stay low-bandwidth).
 */
export async function vehiclePositions(agency, { signal, ttlMs = DEFAULT_TTL_MS, force = false } = {}) {
  const url = agency?.rt_vehicle_positions_url;
  if (!url) return { data: [], error: null, cached: false };
  const hit = cache.get(url);
  if (!force && hit && Date.now() - hit.at < ttlMs) return { data: hit.data, error: hit.error, cached: true };
  try {
    const feed = await fetchFeed(url, agency, { signal });
    const data = feed.entity
      .filter((e) => e.vehicle)
      .map((e) => ({
        id: e.id,
        vehicle_id: e.vehicle.vehicle?.id || null,
        label: e.vehicle.vehicle?.label || e.vehicle.vehicle?.id || null,
        trip_id: e.vehicle.trip?.tripId || null,
        route_id: e.vehicle.trip?.routeId || null,
        direction_id: e.vehicle.trip?.directionId ?? null,
        start_date: e.vehicle.trip?.startDate || null,
        lat: e.vehicle.position?.latitude ?? null,
        lon: e.vehicle.position?.longitude ?? null,
        bearing: e.vehicle.position?.bearing ?? null,
        speed_mps: e.vehicle.position?.speed ?? null,
        odometer: e.vehicle.position?.odometer ?? null,
        stop_id: e.vehicle.stopId || null,
        current_status: e.vehicle.currentStatus ?? null,
        congestion: e.vehicle.congestionLevel ?? null,
        occupancy: e.vehicle.occupancyStatus ?? null,
        timestamp: e.vehicle.timestamp || feed.header.timestamp || null,
      }));
    cache.set(url, { at: Date.now(), data, error: null });
    return { data, error: null, cached: false };
  } catch (err) {
    cache.set(url, { at: Date.now(), data: [], error: err.message });
    return { data: [], error: err.message, cached: false };
  }
}

/** Trip updates (delays + predicted arrivals) - used to refine the guess. */
export async function tripUpdates(agency, { signal, ttlMs = DEFAULT_TTL_MS } = {}) {
  const url = agency?.rt_trip_updates_url;
  if (!url) return { data: [], error: null };
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return { data: hit.data, error: hit.error, cached: true };
  try {
    const feed = await fetchFeed(url, agency, { signal });
    const data = feed.entity
      .filter((e) => e.tripUpdate)
      .map((e) => ({
        id: e.id,
        trip_id: e.tripUpdate.trip?.tripId || null,
        route_id: e.tripUpdate.trip?.routeId || null,
        vehicle_id: e.tripUpdate.vehicle?.id || null,
        delay_sec: e.tripUpdate.delay ?? null,
        stops: (e.tripUpdate.stopTimeUpdate || []).map((s) => ({
          stop_id: s.stopId || null,
          stop_sequence: s.stopSequence ?? null,
          arrival_delay: s.arrival?.delay ?? s.departure?.delay ?? null,
          arrival_time: s.arrival?.time ?? s.departure?.time ?? null,
        })),
      }));
    cache.set(url, { at: Date.now(), data, error: null });
    return { data, error: null, cached: false };
  } catch (err) {
    cache.set(url, { at: Date.now(), data: [], error: err.message });
    return { data: [], error: err.message, cached: false };
  }
}

/** {trip_id -> delay seconds} convenience map. */
export function delayMap(updates) {
  const m = new Map();
  for (const u of updates || []) {
    if (u.trip_id) m.set(u.trip_id, u.delay_sec ?? u.stops?.[0]?.arrival_delay ?? 0);
  }
  return m;
}

export const realtime = { vehiclePositions, tripUpdates, delayMap };
export default realtime;
