/* ==========================================================================
   GTFS: free, open transit schedules.
   We download a city's static GTFS zip ONCE, parse it in the browser, keep the
   compact parts in IndexedDB, and answer "what transit am I on?" from it.
   ========================================================================== */

import { listZip, parseCsvObjects } from './zip.js';
import { idb } from './idb.js';
import { gtfsTimeToSeconds, haversine, localTimeParts, nearest, snapToPolyline, modeFor } from './geo.js';

export const GTFS_CACHE_MS = 24 * 60 * 60 * 1000; // refresh a feed once a day

/** Cache key for an agency (falls back to 'default'). */
export function bundleKey(agency) {
  return agency?.agency_key || agency?.id || 'default';
}

/* ------------------------------------------------------------------ parse */

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/**
 * Parse a GTFS zip into the bundle the matcher needs.
 * Only the files we actually use are read, which keeps memory and CPU low.
 */
export async function parseGtfsZip(arrayBuffer, { onProgress = () => {} } = {}) {
  onProgress({ phase: 'unzip', pct: 2 });
  const wanted = [
    'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt',
    'calendar.txt', 'calendar_dates.txt', 'shapes.txt', 'agency.txt', 'feed_info.txt',
  ];
  const decoder = new TextDecoder('utf-8');
  const files = new Map();
  for (const entry of await listZip(arrayBuffer)) {
    if (entry.name.endsWith('/')) continue;
    const base = entry.name.split('/').pop();
    if (!wanted.includes(base)) continue;
    files.set(base, decoder.decode(await entry.getBytes()));
  }
  return parseGtfsText(files, { onProgress });
}

/**
 * The parser proper: takes `filename -> csv text` so it can be unit tested
 * without a zip, and reused for any other CSV source.
 */
export async function parseGtfsText(files, { onProgress = () => {} } = {}) {
  const required = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
  const missing = required.filter((f) => !files.has(f));
  if (missing.length) {
    throw new Error(`This does not look like a GTFS feed (missing ${missing.join(', ')}).`);
  }

  const bundle = {
    parsed_at: new Date().toISOString(),
    feed: {},
    stops: [],
    routes: [],
    trips: [],
    stopTimes: [],
    shapes: [],
    calendar: [],
    calendarDates: [],
    index: {},
  };

  /* stops -------------------------------------------------------------- */
  onProgress({ phase: 'stops', pct: 10 });
  if (files.has('stops.txt')) {
    for await (const r of parseCsvObjects(files.get('stops.txt'))) {
      const lat = Number(r.stop_lat), lon = Number(r.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      bundle.stops.push({
        stop_id: r.stop_id,
        stop_code: r.stop_code || null,
        stop_name: r.stop_name || r.stop_code || r.stop_id,
        lat, lon,
        parent_station: r.parent_station || null,
        location_type: r.location_type ? Number(r.location_type) : 0,
      });
    }
  }

  /* routes ------------------------------------------------------------- */
  onProgress({ phase: 'routes', pct: 22 });
  if (files.has('routes.txt')) {
    for await (const r of parseCsvObjects(files.get('routes.txt'))) {
      const mode = modeFor(r.route_type);
      bundle.routes.push({
        route_id: r.route_id,
        agency_id: r.agency_id || null,
        short_name: r.route_short_name || r.route_id,
        long_name: r.route_long_name || null,
        desc: r.route_desc || null,
        type: r.route_type ? Number(r.route_type) : 3,
        mode: mode.key,
        mode_label: mode.label,
        color: r.route_color ? `#${r.route_color.replace('#', '')}` : null,
        text_color: r.route_text_color ? `#${r.route_text_color.replace('#', '')}` : null,
      });
    }
  }
  const routeById = new Map(bundle.routes.map((r) => [r.route_id, r]));

  /* calendar ----------------------------------------------------------- */
  onProgress({ phase: 'calendar', pct: 32 });
  if (files.has('calendar.txt')) {
    for await (const r of parseCsvObjects(files.get('calendar.txt'))) {
      bundle.calendar.push({
        service_id: r.service_id,
        days: [r.sunday, r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday].map((x) => x === '1'),
        start_date: r.start_date, end_date: r.end_date,
      });
    }
  }
  if (files.has('calendar_dates.txt')) {
    for await (const r of parseCsvObjects(files.get('calendar_dates.txt'))) {
      bundle.calendarDates.push({ service_id: r.service_id, date: r.date, exception_type: Number(r.exception_type) });
    }
  }

  /* trips -------------------------------------------------------------- */
  onProgress({ phase: 'trips', pct: 44 });
  if (files.has('trips.txt')) {
    for await (const r of parseCsvObjects(files.get('trips.txt'))) {
      const route = routeById.get(r.route_id) || {};
      bundle.trips.push({
        trip_id: r.trip_id,
        route_id: r.route_id,
        service_id: r.service_id || null,
        headsign: r.trip_headsign || route.long_name || route.short_name || null,
        short_name: route.short_name || r.route_id,
        long_name: route.long_name || null,
        mode: route.mode || 'bus',
        mode_label: route.mode_label || 'Transit',
        color: route.color || null,
        direction_id: r.direction_id === '' || r.direction_id === undefined ? null : Number(r.direction_id),
        block_id: r.block_id || null,
        shape_id: r.shape_id || null,
        wheelchair: r.wheelchair_accessible || null,
      });
    }
  }
  const tripById = new Map(bundle.trips.map((t) => [t.trip_id, t]));

  /* stop_times (the big one) -------------------------------------------- */
  onProgress({ phase: 'stop_times', pct: 56 });
  const stopIndex = new Map();  // stop_id -> [{trip_id, sec, seq}]
  const tripIndex = new Map();  // trip_id -> [{seq, sec, stop_id}]
  if (files.has('stop_times.txt')) {
    let rows = 0;
    for await (const r of parseCsvObjects(files.get('stop_times.txt'))) {
      const sec = gtfsTimeToSeconds(r.departure_time || r.arrival_time);
      if (sec === null) continue;
      const seq = Number(r.stop_sequence || 0);
      const stopId = r.stop_id;
      const tripId = r.trip_id;
      const headsign = r.stop_headsign || null;

      if (!stopIndex.has(stopId)) stopIndex.set(stopId, []);
      stopIndex.get(stopId).push({ trip_id: tripId, sec, seq, stop_id: stopId, headsign });

      if (!tripIndex.has(tripId)) tripIndex.set(tripId, []);
      tripIndex.get(tripId).push({ seq, sec, stop_id: stopId });

      if (++rows % 20000 === 0) {
        onProgress({ phase: 'stop_times', pct: Math.min(88, 56 + Math.round(rows / 20000)) });
        await yieldToUi();
      }
    }
    for (const list of stopIndex.values()) list.sort((a, b) => a.sec - b.sec);
    for (const list of tripIndex.values()) list.sort((a, b) => a.seq - b.seq);
  }
  // we never keep the raw stop_times rows: the per-stop and per-trip indexes
  // are a fraction of the size and hold everything the matcher needs.
  bundle.stopTimes = [];

  /* shapes -------------------------------------------------------------- */
  onProgress({ phase: 'shapes', pct: 90 });
  if (files.has('shapes.txt')) {
    const byShape = new Map();
    for await (const r of parseCsvObjects(files.get('shapes.txt'))) {
      const lat = Number(r.shape_pt_lat), lon = Number(r.shape_pt_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = r.shape_id;
      if (!byShape.has(key)) byShape.set(key, []);
      byShape.get(key).push({ seq: Number(r.shape_pt_sequence || 0), lat, lon });
    }
    for (const [shape_id, pts] of byShape) {
      pts.sort((a, b) => a.seq - b.seq);
      // thin the line out: 1 point per ~40 m is plenty for matching
      const thinned = [];
      for (const p of pts) {
        if (!thinned.length || haversine(thinned[thinned.length - 1], p) > 40) thinned.push(p);
      }
      if (thinned.length < 2 && pts.length >= 2) thinned.push(pts[pts.length - 1]);
      if (thinned.length >= 2) bundle.shapes.push({ shape_id, points: thinned });
    }
  }

  /* feed info / agency -------------------------------------------------- */
  if (files.has('agency.txt')) {
    const first = [];
    for await (const r of parseCsvObjects(files.get('agency.txt'))) { first.push(r); if (first.length >= 3) break; }
    bundle.feed.agencies = first.map((r) => ({
      agency_id: r.agency_id || null,
      name: r.agency_name || null,
      url: r.agency_url || null,
      timezone: r.agency_timezone || null,
      lang: r.agency_lang || null,
    }));
    bundle.feed.timezone = first[0]?.agency_timezone || null;
  }
  if (files.has('feed_info.txt')) {
    for await (const r of parseCsvObjects(files.get('feed_info.txt'))) {
      bundle.feed.publisher = r.feed_publisher_name || null;
      bundle.feed.version = r.feed_version || null;
      bundle.feed.start = r.feed_start_date || null;
      bundle.feed.end = r.feed_end_date || null;
      break;
    }
  }

  /* lookup indexes ------------------------------------------------------ */
  bundle.index = {
    tripsById: Object.fromEntries(bundle.trips.map((t) => [t.trip_id, t])),
    routeById: Object.fromEntries(bundle.routes.map((r) => [r.route_id, r])),
    stopTimesByStop: Object.fromEntries(
      Array.from(stopIndex.entries()).map(([k, v]) => [k, v]),
    ),
    stopTimesByTrip: Object.fromEntries(
      Array.from(tripIndex.entries()).map(([k, v]) => [k, v]),
    ),
    stopById: Object.fromEntries(bundle.stops.map((s) => [s.stop_id, s])),
    serviceIds: activeServiceIds(bundle, new Date()),
  };

  onProgress({ phase: 'done', pct: 100 });
  return bundle;
}

/** Download + parse + cache a feed. Cached bundles load instantly offline. */
export async function loadBundle(agency, { force = false, onProgress = () => {}, signal } = {}) {
  const key = bundleKey(agency);
  if (!force) {
    const cached = await idb.getGtfs(key);
    if (cached && Date.now() - (cached.savedAt || 0) < GTFS_CACHE_MS) {
      return { bundle: revive(cached), fromCache: true, savedAt: cached.savedAt };
    }
  }
  const url = agency?.static_gtfs_url;
  if (!url) throw new Error('No static GTFS url configured for this agency.');

  onProgress({ phase: 'download', pct: 1 });
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GTFS download failed (HTTP ${res.status}). Check the feed url.`);
  const buf = await res.arrayBuffer();
  const bundle = await parseGtfsZip(buf, { onProgress });
  await idb.putGtfs(key, bundle);
  return { bundle, fromCache: false, savedAt: Date.now() };
}

/** Rebuild the Map-based indexes after a round-trip through IndexedDB. */
function revive(row) {
  const bundle = { ...row };
  const idx = bundle.index || {};
  bundle.index = {
    ...idx,
    tripsById: idx.tripsById || Object.fromEntries(bundle.trips.map((t) => [t.trip_id, t])),
    routeById: idx.routeById || Object.fromEntries(bundle.routes.map((r) => [r.route_id, r])),
    stopById: idx.stopById || Object.fromEntries(bundle.stops.map((s) => [s.stop_id, s])),
    stopTimesByStop: idx.stopTimesByStop || {},
    stopTimesByTrip: idx.stopTimesByTrip || {},
    serviceIds: idx.serviceIds || activeServiceIds(bundle, new Date()),
  };
  return bundle;
}

/* ------------------------------------------------------------- calendars */

export function ymdToInt(d) { return Number(String(d).replace(/-/g, '')); }

/** Service date as yyyy-mm-dd, in the feed's own timezone. */
export function serviceDateFor(bundle, date = new Date()) {
  const tz = bundle?.feed?.timezone || 'UTC';
  return localTimeParts(date, tz);
}

/**
 * Which service_ids run on a given date.
 * @param {object} bundle
 * @param {Date|string} date  a Date, or a 'yyyy-mm-dd' service date string
 * @param {string} [timeZone] only used when `date` is a Date
 */
export function activeServiceIds(bundle, date = new Date(), timeZone = null) {
  let dateStr;
  let weekday;
  if (typeof date === 'string') {
    dateStr = date.slice(0, 10);
    // weekday from the calendar date itself (UTC noon avoids DST edges)
    weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  } else {
    const tz = timeZone || bundle.feed?.timezone || 'UTC';
    const parts = localTimeParts(date, tz);
    dateStr = parts.date;
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    weekday = dow < 0 ? 1 : dow;
  }
  const ymd = ymdToInt(dateStr);
  const idx = weekday;
  const out = new Set();
  for (const c of bundle.calendar || []) {
    if (ymd >= ymdToInt(c.start_date) && ymd <= ymdToInt(c.end_date) && c.days?.[idx]) out.add(c.service_id);
  }
  for (const e of bundle.calendarDates || []) {
    if (ymdToInt(e.date) !== ymd) continue;
    if (e.exception_type === 1) out.add(e.service_id);
    else if (e.exception_type === 2) out.delete(e.service_id);
  }
  if (!out.size && !(bundle.calendar || []).length) {
    // feed has no calendar at all: assume every trip is valid
    for (const t of bundle.trips) if (t.service_id) out.add(t.service_id);
  }
  return Array.from(out);
}

/* ------------------------------------------------------------- querying */

/**
 * Scheduled departures at a set of stops inside a time window.
 * @param {object} args
 * @param {object} args.bundle      parsed GTFS bundle
 * @param {Array}  args.stops       [{stop_id|key,name,lat,lon,source}]
 * @param {number} args.seconds     seconds since local midnight
 * @param {string} args.serviceDate yyyy-mm-dd (local to the feed)
 * @param {number} args.windowSec   how far either side of `seconds`
 * @param {number} args.maxPerStop
 */
export function scheduledDepartures({
  bundle, stops, seconds, serviceDate, windowSec = 1500, maxPerStop = 14, allowPast = 300,
}) {
  const out = [];
  if (!bundle) return out;
  const active = new Set(activeServiceIds(bundle, serviceDate));
  // If the feed carries a calendar at all, an empty active set genuinely means
  // "no service today". Otherwise (no calendar files) everything is presumed to run.
  const hasCalendar = Boolean((bundle.calendar || []).length || (bundle.calendarDates || []).length);
  const idx = bundle.index?.stopTimesByStop || {};
  const tripIdx = bundle.index?.tripsById || {};

  for (const stop of stops || []) {
    const stopId = stop.stop_id || stop.gtfs_stop_id;
    if (!stopId) continue;
    const rows = idx[stopId] || [];
    let taken = 0;
    for (const row of rows) {
      const delta = row.sec - seconds;
      if (delta < -allowPast || delta > windowSec) continue;
      const trip = tripIdx[row.trip_id];
      if (!trip) continue;
      if (hasCalendar && trip.service_id && !active.has(trip.service_id)) continue;
      out.push({
        trip_id: trip.trip_id,
        route_id: trip.route_id,
        route_short_name: trip.short_name,
        route_long_name: trip.long_name,
        route_mode: trip.mode,
        route_mode_label: trip.mode_label,
        route_color: trip.color,
        headsign: row.headsign || trip.headsign,
        direction_id: trip.direction_id,
        shape_id: trip.shape_id,
        stop_id: stopId,
        stop_name: stop.name || stop.stop_name,
        stop_lat: stop.lat, stop_lon: stop.lon,
        seconds: row.sec,
        eta_sec: delta,
        eta_min: Math.round(delta / 60),
        stop_source: stop.source || 'gtfs',
        stop_distance_m: stop.distance_m ?? null,
      });
      if (++taken >= maxPerStop) break;
    }
  }
  return out.sort((a, b) => a.eta_sec - b.eta_sec);
}

/** {stop_id,name,distance} for the closest GTFS stops to a coordinate. */
export function nearestGtfsStops(bundle, position, { radius = 400, limit = 10 } = {}) {
  if (!bundle) return [];
  const res = [];
  for (const s of bundle.stops) {
    if (s.location_type === 3 || s.location_type === 4) continue;
    const d = haversine(position, s);
    if (d <= radius) res.push({ stop_id: s.stop_id, name: s.stop_name, lat: s.lat, lon: s.lon, distance_m: d, source: 'gtfs' });
  }
  res.sort((a, b) => a.distance_m - b.distance_m);
  return res.slice(0, limit);
}

/** Stops of a trip in order (from the per-trip index). */
export function tripStops(bundle, tripId) {
  const direct = bundle?.index?.stopTimesByTrip?.[tripId];
  if (direct?.length) return direct;
  const rows = (bundle?.stopTimes || []).filter((r) => r.trip_id === tripId);
  if (rows.length) return rows.sort((a, b) => a.seq - b.seq);
  const idx = bundle?.index?.stopTimesByStop || {};
  const out = [];
  for (const [stopId, list] of Object.entries(idx)) {
    for (const r of list) if (r.trip_id === tripId) out.push({ ...r, stop_id: stopId });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Polyline for a shape id, or null. */
export function shapePoints(bundle, shapeId) {
  if (!bundle || !shapeId) return null;
  const s = (bundle.shapes || []).find((x) => x.shape_id === shapeId);
  return s ? s.points : null;
}

/** How far along its route is this position, in metres, plus the nearest stop. */
export function progressOnTrip(bundle, tripId, position) {
  const trip = bundle?.index?.tripsById?.[tripId];
  const line = shapePoints(bundle, trip?.shape_id);
  if (!line) return null;
  const snap = snapToPolyline(position, line);
  if (!snap) return null;
  const stops = tripStops(bundle, tripId)
    .map((r) => {
      const s = bundle.index?.stopById?.[r.stop_id];
      return s ? { ...s, seq: r.seq, sec: r.sec, snap: snapToPolyline(s, line) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq);
  return { snap, stops };
}

/**
 * Work out which stops a tracked journey passed through, so we can count stops
 * and reason about the alighting station even without a GTFS zip loaded.
 */
export function stopsBetween(gtfsStops, fromPoint, toPoint, { corridorM = 250 } = {}) {
  const a = nearest(gtfsStops, fromPoint)?.item;
  const b = nearest(gtfsStops, toPoint)?.item;
  if (!a || !b) return { from: a || null, to: b || null, passed: [] };
  const mid = { lat: (fromPoint.lat + toPoint.lat) / 2, lon: (fromPoint.lon + toPoint.lon) / 2 };
  const span = haversine(fromPoint, toPoint);
  const passed = gtfsStops.filter((s) => {
    const dFromStart = haversine(fromPoint, s);
    const dFromEnd = haversine(toPoint, s);
    return dFromStart + dFromEnd <= span * 1.25 + corridorM && haversine(mid, s) <= span * 0.75 + corridorM;
  });
  return { from: a, to: b, passed: passed.sort((x, y) => haversine(fromPoint, x) - haversine(fromPoint, y)) };
}

export default {
  loadBundle, parseGtfsZip, parseGtfsText, scheduledDepartures, nearestGtfsStops,
  activeServiceIds, tripStops, shapePoints, progressOnTrip, bundleKey,
};
