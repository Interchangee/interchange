/* ==========================================================================
   The matcher: "which transit am I on?"

   Pipeline (all free / keyless):
     1. GPS fix
     2. Overpass  -> physical stops within ~350 m (geography + names)
     3. GTFS static (cached zip) -> scheduled departures at those stops now
     4. GTFS-Realtime (if published) -> the actual vehicle, when available
     5. Score + rank, return the best guess plus runner-up options
   ========================================================================== */

import { haversine, localTimeParts, modeFor, nearest, snapToPolyline } from './geo.js';
import { findNearbyStops, toMatcherStops } from './overpass.js';
import {
  loadBundle, nearestGtfsStops, scheduledDepartures, shapePoints,
  tripStops, progressOnTrip, activeServiceIds,
} from './gtfs.js';
import { vehiclePositions, tripUpdates, delayMap } from './realtime.js';
import idb from './idb.js';

const CACHE_KEY = (key) => `gtfsmeta:${key}`;

/* ------------------------------------------------------------- name match */

const NOISE = /\((?:[^)]*)\)|\[[^\]]*\]|\bplatform\b|\bstand\b|\bstop\b|\bbay\b|\bside\b/gi;

export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9äöüßéèêàçñ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameSimilarity(a, b) {
  const A = normalizeName(a), B = normalizeName(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const shorter = A.length <= B.length ? A : B;
  const longer = A.length <= B.length ? B : A;
  if (longer.includes(shorter) && shorter.length >= 4) return 0.85;
  const ta = new Set(A.split(' '));
  const tb = new Set(B.split(' '));
  let common = 0;
  ta.forEach((t) => { if (tb.has(t) && t.length > 2) common++; });
  return common / Math.max(ta.size, tb.size);
}

/* ---------------------------------------------------------- bundle loading */

const loading = new Map(); // key -> promise (dedupe concurrent loads)

export async function ensureBundle(agency, { force = false, onProgress } = {}) {
  if (!agency?.static_gtfs_url) return { bundle: null, error: 'No GTFS feed configured for this agency.' };
  const key = agency.agency_key || agency.id;
  if (!force && loading.has(key)) return loading.get(key);
  const p = (async () => {
    try {
      const { bundle, fromCache, savedAt } = await loadBundle(agency, { force, onProgress });
      await idb.set(CACHE_KEY(key), {
        savedAt, stops: bundle.stops.length, trips: bundle.trips.length,
        routes: bundle.routes.length, hasShapes: bundle.shapes.length > 0,
      });
      return { bundle, fromCache, savedAt };
    } catch (err) {
      return { bundle: null, error: err.message };
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, p);
  return p;
}

export async function bundleMeta(agency) {
  if (!agency) return null;
  return (await idb.get(CACHE_KEY(agency.agency_key || agency.id))) || null;
}

/* --------------------------------------------------------------- scoring */

function scoreCandidate(c, ctx) {
  const reasons = [];
  let score = 0;

  // 1. how close is the stop the rider is standing at?
  const d = c.stop_distance_m ?? 999;
  if (d < 40) { score += 30; reasons.push('stop right beside you'); }
  else if (d < 90) { score += 24; reasons.push('stop ~' + Math.round(d) + ' m away'); }
  else if (d < 160) { score += 16; reasons.push('stop ~' + Math.round(d) + ' m away'); }
  else if (d < 300) { score += 8; }
  else if (d < 450) { score += 3; }
  else { score -= 6; }

  // 2. timing: a departure that already happened in the last few minutes is
  //    exactly what "I just got on" looks like.
  const eta = c.eta_sec;
  if (Number.isFinite(eta)) {
    const late = eta <= 0 ? -eta : 0;
    if (eta <= 0 && late <= 120) { score += 28; reasons.push(`left ${Math.round(late / 60) || 1} min ago`); }
    else if (eta > 0 && eta <= 180) { score += 22; reasons.push(`departs in ${Math.max(1, Math.round(eta / 60))} min`); }
    else if (eta > 180 && eta <= 480) { score += 12; reasons.push(`departs in ${Math.round(eta / 60)} min`); }
    else if (eta > 480 && eta <= 1200) { score += 4; }
    else if (eta < -420) { score -= 10; }
  }

  // 3. realtime beats schedule, every time
  if (c.realtime) {
    score += 45; reasons.push('live vehicle position');
    if (c.vehicle_distance_m < 120) score += 20;
    else if (c.vehicle_distance_m < 300) score += 10;
    else if (c.vehicle_distance_m > 900) score -= 15;
    if (c.current_status === 1) { score += 8; reasons.push('stopped at a stop'); }
  } else if (c.trip_update) {
    score += 10; reasons.push('live trip update');
  }

  // 4. OSM <-> GTFS stop agreement
  if (c.name_match >= 0.8) { score += 14; reasons.push('stop name matches the map'); }
  else if (c.name_match >= 0.5) score += 7;
  else if (c.name_match === 0 && c.osm_stop) score -= 4;

  // 5. does the rider's recent movement line up with the route shape?
  if (c.shape_alignment !== null && c.shape_alignment !== undefined) {
    if (c.shape_alignment > 0.75) { score += 18; reasons.push('your track follows this route'); }
    else if (c.shape_alignment > 0.4) score += 8;
    else if (c.shape_alignment < 0.1) score -= 8;
  }
  if (c.moving && c.realtime) score += 4;

  // 6. OSM route_ref / network hints, when GTFS ids are missing on the map
  if (c.route_ref_hit) { score += 12; reasons.push('route number shown on the stop'); }

  if (c.source === 'osm-only') { score -= 12; }         // no schedule behind it
  if (c.source === 'manual') { score = 55; }

  return { score, reasons };
}

function confidenceFrom(best, runnerUp, ctx) {
  if (!best) return 'low';
  if (best.realtime && best.score >= 70) return 'realtime';
  const gap = best.score - (runnerUp?.score ?? 0);
  if (best.score >= 70 && gap >= 12) return 'high';
  if (best.score >= 45 || gap >= 20) return 'medium';
  return 'low';
}

/* ------------------------------------------------------------- public API */

/**
 * Rank what the rider is most likely on.
 *
 * @param {object} args
 * @param {{lat:number,lon:number,accuracy?:number}} args.position
 * @param {object} [args.agency]     row from transit_agencies
 * @param {Array}  [args.track]      recent GPS samples for shape alignment
 * @param {number} [args.radius]     stop search radius, metres
 * @param {number} [args.windowMin]  schedule look-ahead window
 * @returns {Promise<{candidates:Array, nearbyStops:Array, best:object|null, confidence:string, warnings:string[], meta:object}>}
 */
export async function suggestVehicles({
  position, agency = null, track = [], radius = 350, windowMin = 25, onProgress = () => {}, force = false,
}) {
  const warnings = [];
  const meta = { overpass: null, gtfs: null, realtime: null, started_at: new Date().toISOString() };

  /* 1. physical stops from OpenStreetMap ---------------------------------- */
  onProgress({ phase: 'overpass', message: 'Finding stops near you…' });
  let osmStops = [];
  try {
    const res = await findNearbyStops(position.lat, position.lon, { radius });
    osmStops = toMatcherStops(res.stops).map((s) => ({ ...s, distance_m: haversine(position, s) }));
    osmStops.sort((a, b) => a.distance_m - b.distance_m);
    meta.overpass = { count: osmStops.length, source: res.source, error: res.error || null };
    if (res.error) warnings.push('Stop map unavailable, using the GTFS feed only.');
  } catch (err) {
    warnings.push('Could not reach OpenStreetMap stops: ' + err.message);
    meta.overpass = { count: 0, error: err.message };
  }
  // collapse duplicate platforms of the same station into one entry
  osmStops = dedupeStops(osmStops, 60);

  /* 2. schedule + realtime ------------------------------------------------ */
  const gtfsResult = await ensureBundle(agency, { force, onProgress });
  if (gtfsResult.error) warnings.push('GTFS: ' + gtfsResult.error);
  const bundle = gtfsResult.bundle;
  meta.gtfs = gtfsResult.error
    ? { ok: false, error: gtfsResult.error }
    : { ok: true, cached: gtfsResult.fromCache, savedAt: gtfsResult.savedAt, stops: bundle.stops.length };

  const candidates = [];

  if (bundle) {
    const tz = bundle.feed?.timezone || agency?.timezone || 'UTC';
    const t = localTimeParts(new Date(), tz);
    const gtfsNear = nearestGtfsStops(bundle, position, { radius: Math.max(radius, 400), limit: 12 });

    // map each GTFS stop to the closest OSM stop so we can borrow its name
    const linked = gtfsNear.map((g) => {
      const osm = osmStops.length ? nearest(osmStops, g, (x) => x) : null;
      return {
        ...g,
        name: osm && osm.distance < 90 ? (osm.item.name || g.name) : g.name,
        osm_stop: osm && osm.distance < 90 ? osm.item : null,
        name_match: osm ? nameSimilarity(osm.item.name, g.name) : 0,
      };
    });

    onProgress({ phase: 'schedule', message: 'Checking scheduled departures…' });
    const departures = scheduledDepartures({
      bundle, stops: linked, seconds: t.seconds, serviceDate: t.date,
      windowSec: windowMin * 60, maxPerStop: 12,
    });

    for (const dep of departures) {
      candidates.push({
        ...dep,
        source: 'schedule',
        realtime: false,
        key: `sched:${dep.trip_id}:${dep.stop_id}`,
        shape_alignment: null,
        moving: isMoving(track),
      });
    }

    // GTFS stops the rider is standing at but which have no upcoming departure
    if (!departures.length && linked.length) {
      warnings.push('No scheduled departure matched within the time window. Pick the line yourself, or use live data if your agency publishes it.');
    }
  }

  /* 3. realtime vehicle positions ---------------------------------------- */
  if (agency?.rt_vehicle_positions_url) {
    onProgress({ phase: 'realtime', message: 'Checking live vehicles…' });
    const { data: vehicles, error } = await vehiclePositions(agency, { force });
    if (error) warnings.push('Live vehicle feed: ' + error);
    meta.realtime = { count: vehicles.length, error: error || null };
    for (const v of vehicles) {
      if (v.lat === null || v.lon === null) continue;
      const d = haversine(position, { lat: v.lat, lon: v.lon });
      if (d > Math.max(radius * 3, 1200)) continue;
      const trip = bundle?.index?.tripsById?.[v.trip_id] || null;
      const route = bundle?.index?.routeById?.[v.route_id] || null;
      const stop = nearest(gtfsOrOsmStops(bundle, osmStops), { lat: v.lat, lon: v.lon });
      const stopDist = stop ? haversine(position, stop) : null;
      candidates.push({
        source: 'realtime',
        realtime: true,
        key: `rt:${v.trip_id || v.vehicle_id || v.id}`,
        trip_id: v.trip_id,
        route_id: v.route_id || trip?.route_id || null,
        route_short_name: route?.short_name || trip?.short_name || v.route_id || '?',
        route_long_name: route?.long_name || trip?.long_name || null,
        route_mode: route?.mode || trip?.mode || 'bus',
        route_mode_label: route?.mode_label || trip?.mode_label || 'Transit',
        headsign: trip?.headsign || null,
        direction_id: v.direction_id ?? trip?.direction_id ?? null,
        shape_id: trip?.shape_id || null,
        vehicle_id: v.vehicle_id,
        vehicle_label: v.label,
        lat: v.lat, lon: v.lon,
        vehicle_distance_m: d,
        current_status: v.current_status,
        stop_id: v.stop_id || null,
        stop_name: stop?.name || trip?.headsign || null,
        stop_lat: stop?.lat,
        stop_lon: stop?.lon,
        stop_distance_m: stopDist,
        eta_sec: null,
        eta_min: null,
        observed_at: v.timestamp ? new Date(v.timestamp * 1000).toISOString() : null,
        name_match: 1,
        shape_alignment: null,
        moving: v.speed_mps ? v.speed_mps > 1 : isMoving(track),
      });
    }
  }

  /* 4. trip updates add a "live" badge to scheduled guesses -------------- */
  if (agency?.rt_trip_updates_url && bundle) {
    const { data: updates } = await tripUpdates(agency, { force });
    const delays = delayMap(updates);
    if (delays.size) {
      for (const c of candidates) {
        if (c.source !== 'schedule' || !c.trip_id) continue;
        if (delays.has(c.trip_id)) {
          c.trip_update = true;
          c.delay_sec = delays.get(c.trip_id);
          c.eta_sec = c.eta_sec + (c.delay_sec || 0);
          c.eta_min = Math.round(c.eta_sec / 60);
        }
      }
    }
  }

  /* 5. OSM-only fallback: the map told us about routes the feed did not --- */
  if (!candidates.length && osmStops.length) {
    for (const s of osmStops.slice(0, 6)) {
      for (const ref of s.route_ref || []) {
        candidates.push({
          source: 'osm-only',
          realtime: false,
          key: `osm:${s.key}:${ref}`,
          route_short_name: ref,
          route_long_name: null,
          route_mode: (s.modes && s.modes[0]) || 'bus',
          route_mode_label: modeFor(0).label,
          headsign: null,
          stop_id: null,
          stop_name: s.name,
          stop_lat: s.lat, stop_lon: s.lon,
          stop_distance_m: s.distance_m,
          eta_sec: null,
          name_match: 1,
          route_ref_hit: true,
          shape_alignment: null,
          moving: isMoving(track),
        });
      }
    }
  }

  /* 6. score, dedupe, rank ------------------------------------------------ */
  const moving = isMoving(track);
  for (const c of candidates) {
    const { score, reasons } = scoreCandidate(c, { moving });
    c.score = Math.round(score);
    c.reasons = reasons;
  }

  // keep only the best entry per (route, headsign, direction) so the list is
  // human-sized: "Route 12 -> Airport" should appear once, not five times.
  const bestByRoute = new Map();
  for (const c of candidates) {
    const k = `${c.route_short_name}|${normalizeName(c.headsign || '')}|${c.direction_id ?? ''}`;
    const prev = bestByRoute.get(k);
    if (!prev || c.score > prev.score) bestByRoute.set(k, c);
  }
  let ranked = Array.from(bestByRoute.values()).sort((a, b) => b.score - a.score);

  // Shape alignment is the expensive test, so only run it on the contenders
  // and then re-score them.
  const contenders = ranked.slice(0, 14);
  if (bundle && track && track.length >= 3) {
    for (const c of contenders) {
      c.shape_alignment = alignWithShape(bundle, c.shape_id, track);
      if (c.shape_alignment !== null) {
        const { score, reasons } = scoreCandidate(c, { moving });
        c.score = Math.round(score);
        c.reasons = reasons;
      }
    }
    ranked = ranked.sort((a, b) => b.score - a.score);
  }
  ranked = ranked.slice(0, 12);

  // mark alternatives that share the same physical stop as the winner
  const best = ranked[0] || null;
  const confidence = confidenceFrom(best, ranked[1], { moving });

  onProgress({ phase: 'done', message: '' });
  return {
    candidates: ranked,
    nearbyStops: osmStops.slice(0, 12),
    gtfsStops: bundle ? nearestGtfsStops(bundle, position, { radius: 700, limit: 12 }) : [],
    best,
    confidence,
    warnings,
    meta: { ...meta, bundle_key: agency ? (agency.agency_key || agency.id) : null },
    bundle,
  };
}

/* ------------------------------------------------- ride reconstruction */

/**
 * On exit, decide where they got off and how far they rode.
 * Combines the recorded track with the trip's shape and stop list.
 */
export function resolveAlighting({ bundle, tripId, boarding, position, track }) {
  const points = (track || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const distanceM = pathDistance(points);
  const result = { distance_m: distanceM, stops_travelled: null, stop: null, method: 'gps-only' };

  const trip = bundle?.index?.tripsById?.[tripId];
  const line = shapePoints(bundle, trip?.shape_id);
  if (!trip || !line) {
    if (bundle) {
      const near = nearestGtfsStops(bundle, position, { radius: 250, limit: 1 })[0];
      if (near) { result.stop = near; result.method = 'nearest-gtfs-stop'; }
    }
    return result;
  }

  const stops = tripStops(bundle, tripId)
    .map((r) => {
      const s = bundle.index?.stopById?.[r.stop_id];
      return s ? { ...s, seq: r.seq, sec: r.sec } : null;
    })
    .filter(Boolean);

  const endProg = progressOnTrip(bundle, tripId, position);
  if (endProg) {
    const withProg = stops
      .map((s) => ({ s, prog: progressOnTrip(bundle, tripId, s)?.snap?.progressM ?? null }))
      .filter((x) => x.prog !== null);
    const passed = withProg.filter((x) => x.prog <= endProg.snap.progressM + 60);
    result.stops_travelled = Math.max(0, passed.length - 1);
    const last = passed[passed.length - 1];
    if (last) {
      result.stop = { stop_id: last.s.stop_id, name: last.s.stop_name, lat: last.s.lat, lon: last.s.lon, distance_m: haversine(position, last.s) };
      result.method = 'shape-progress';
      result.trip_complete = endProg.snap.progressM >= (endProg.snap.lengthM || 0) - 150;
    }
  }
  if (!result.stop) {
    const near = nearestGtfsStops(bundle, position, { radius: 250, limit: 1 })[0];
    if (near) { result.stop = near; result.method = 'nearest-gtfs-stop'; }
  }
  return result;
}

/**
 * Live guesses while riding: nearest upcoming stop, how far through the trip,
 * and progress toward the destination headsign.
 */
export function liveProgress({ bundle, tripId, position, boardProgressM }) {
  if (!bundle || !tripId) return null;
  const prog = progressOnTrip(bundle, tripId, position);
  if (!prog) return null;
  const stops = prog.stops.filter((s) => s.snap);
  const next = stops.find((s) => s.snap.progressM > prog.snap.progressM + 30) || null;
  const remaining = prog.snap.lengthM ? Math.max(0, prog.snap.lengthM - prog.snap.progressM) : null;
  return {
    next_stop: next ? { name: next.stop_name, in_m: next.snap.progressM - prog.snap.progressM } : null,
    travelled_m: boardProgressM ? Math.max(0, prog.snap.progressM - boardProgressM) : prog.snap.progressM,
    route_progress: prog.snap.lengthM ? prog.snap.progressM / prog.snap.lengthM : null,
    remaining_m: remaining,
    snap_distance_m: prog.snap.distance,
    stops_remaining: next ? stops.filter((s) => s.snap.progressM >= next.snap.progressM).length : 0,
  };
}

/* ------------------------------------------------------------- helpers */

function pathDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

function isMoving(track) {
  if (!track || track.length < 2) return false;
  const a = track[0], b = track[track.length - 1];
  const dt = (new Date(b.recorded_at || b.ts) - new Date(a.recorded_at || a.ts)) / 1000;
  if (dt < 20) return false;
  return haversine(a, b) / dt > 1.5; // > 5 km/h
}

/** 0..1: how well the recent track lies on the route shape. */
function alignWithShape(bundle, shapeId, track) {
  const line = shapePoints(bundle, shapeId);
  if (!line || !track || track.length < 3) return null;
  // sample a handful of points - the shape can have hundreds of vertices and
  // we only need a directional sanity check, not a precise fit
  const pts = track.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 3) return null;
  const step = Math.max(1, Math.floor(pts.length / 10));
  const sample = [];
  for (let i = 0; i < pts.length; i += step) sample.push(pts[i]);
  if (sample[sample.length - 1] !== pts[pts.length - 1]) sample.push(pts[pts.length - 1]);

  let score = 0;
  for (const p of sample) {
    const snap = snapToPolyline(p, line);
    if (!snap) continue;
    if (snap.distance < 60) score += 1;
    else if (snap.distance < 150) score += 0.5;
  }
  return score / sample.length;
}

function dedupeStops(stops, metres) {
  const out = [];
  for (const s of stops) {
    const dup = out.find((o) => haversine(o, s) < metres && nameSimilarity(o.name, s.name) > 0.4);
    if (dup) {
      dup.route_ref = Array.from(new Set([...(dup.route_ref || []), ...(s.route_ref || [])]));
      dup.modes = Array.from(new Set([...(dup.modes || []), ...(s.modes || [])]));
      continue;
    }
    out.push(s);
  }
  return out;
}

function gtfsOrOsmStops(bundle, osmStops) {
  const fromGtfs = (bundle?.stops || []).map((s) => ({ name: s.stop_name, lat: s.lat, lon: s.lon }));
  return fromGtfs.length ? fromGtfs : osmStops;
}

export default {
  suggestVehicles, ensureBundle, bundleMeta, resolveAlighting, liveProgress, normalizeName,
};
