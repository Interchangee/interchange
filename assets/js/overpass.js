/* ==========================================================================
   Overpass API client - free, no key.
   Used for one thing: "which transit stops are within N metres of me?"
   That is the geography layer; schedules come from GTFS.

   Being a good citizen matters here, because these are donated servers. The
   FOSSGIS operator (overpass-api.de) asks for two things that shape this file:

     - "Make sure you rate-limit" and never ignore a 429: "If you get a 429,
       wait at least 30s before sending the next query." Clients that retry
       quickly get automatically banned by IP.
     - Cache aggressively. Stop positions are valid for days, and the operator
       says "there's no reason to refresh results more than once per minute".

   So: results are cached per coordinate cell for a week, every endpoint is
   skipped while it is in cooldown, and a 429/406 never triggers an immediate
   retry on any other endpoint either. Only one request happens per lookup.
   ========================================================================== */

import idb from './idb.js';
import { haversine } from './geo.js';

/**
 * Free, keyless, global-coverage instances only.
 * Verified 2026-10-02 against the wiki's public instance table:
 *   - overpass.kumi.systems is gone (renamed to private.coffee in 2024 and
 *     times out), so it is deliberately not listed.
 *   - private.coffee did not answer any request that day, so it is left out
 *     until it proves reliable again.
 * The paid/keyed and regional-only instances (Switzerland, Virginia, Ethiopia,
 * Britain) are no good for a mobile app that can run anywhere.
 */
export const ENDPOINTS = [
  // FOSSGIS, the official instance for light use: the only one with a written
  // fair-use policy. Drop it first in the list but expect 504s when it is busy.
  'https://overpass-api.de/api/interpreter',
  // VK Maps. Stated policy: "no requests limitations"; answered every probe.
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  // Global data, answered every probe. No longer on the official wiki list and
  // its published policy is stale, so it is last.
  'https://overpass.openstreetmap.fr/api/interpreter',
];

/** Per-endpoint cooldown, in ms since epoch. A 429/406 parks an endpoint. */
const cooldownUntil = new Map();

const COOLDOWN_AFTER_429_MS = 30_000;   // operator's stated minimum
const COOLDOWN_AFTER_406_MS = 60 * 60_000; // UA/Referer ban: an hour, then try again
const COOLDOWN_AFTER_5XX_MS = 20_000;   // 504 = "server too busy"
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'osm-stops:';

const STOP_FILTER = [
  'node["highway"="bus_stop"]',
  'node["public_transport"="platform"]',
  'node["public_transport"="stop_position"]',
  'node["railway"="station"]',
  'node["railway"="halt"]',
  'node["railway"="tram_stop"]',
  'node["railway"="subway_entrance"]',
  'node["amenity"="ferry_terminal"]',
  'node["station"="subway"]',
  'node["station"="light_rail"]',
  'node["aerialway"="station"]',
];

export function buildQuery(lat, lon, radius) {
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const body = STOP_FILTER.map((f) => `  ${f}${around};`).join('\n');
  return `[out:json][timeout:25];\n(\n${body}\n);\nout body center;`;
}

/**
 * Cache key on a ~500 m grid. Two lookups from the same street hit the same
 * key, which is what keeps the daily request count far below the "regular use"
 * threshold the operator documents (<100/day for a whole application).
 */
export function cellKey(lat, lon, radius = 350) {
  const size = Math.max(0.002, (radius * 1.2) / 111_320);   // degrees
  const latCell = Math.round(lat / size);
  const lonCell = Math.round(lon / size);
  return `${CACHE_PREFIX}${latCell}:${lonCell}:${Math.round(radius)}`;
}

function parseElements(json) {
  const stops = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    stops.push({
      osm_id: `${el.type}/${el.id}`,
      osm_type: el.type,
      lat, lon,
      name: tags.name || tags['name:en'] || tags.ref || tags.local_ref || null,
      ref: tags.ref || tags.local_ref || null,
      operator: tags.operator || null,
      network: tags.network || null,
      route_ref: tags.route_ref || tags.routes || null,
      // GTFS ids are sometimes mapped directly on the OSM object
      gtfs_stop_id: tags.gtfs_id || tags['gtfs:stop_id'] || tags['ref:gtfs'] || null,
      modes: detectModes(tags, el),
      raw_tags: tags,
    });
  }
  return stops;
}

function detectModes(tags) {
  const modes = new Set();
  if (tags.highway === 'bus_stop') modes.add('bus');
  if (tags.railway === 'tram_stop') modes.add('tram');
  if (tags.railway === 'station' || tags.railway === 'halt') {
    if (tags.station === 'subway' || tags.subway === 'yes') modes.add('rail');
    else if (tags.tram === 'yes') modes.add('tram');
    else if (tags.light_rail === 'yes') modes.add('rail');
    else modes.add('rail');
  }
  if (tags.railway === 'subway_entrance') modes.add('rail');
  if (tags.station === 'subway') modes.add('rail');
  if (tags.station === 'light_rail') modes.add('rail');
  if (tags.amenity === 'ferry_terminal') modes.add('ferry');
  if (tags.aerialway === 'station') modes.add('tram');
  if (!modes.size) modes.add('bus');
  return Array.from(modes);
}

/** Endpoints currently not parked, soonest-to-recover first. */
function availableEndpoints(now = Date.now()) {
  return ENDPOINTS
    .map((url) => ({ url, ready: cooldownUntil.get(url) || 0 }))
    .filter((e) => e.ready <= now)
    .sort((a, b) => a.ready - b.ready)
    .map((e) => e.url);
}

function park(url, ms) {
  cooldownUntil.set(url, Date.now() + ms);
}

/** How long until any endpoint is usable again, in ms (0 = right now). */
export function cooldownRemaining() {
  const now = Date.now();
  if (availableEndpoints(now).length) return 0;
  return Math.min(...ENDPOINTS.map((u) => (cooldownUntil.get(u) || 0) - now));
}

function retryAfterMs(res, fallback) {
  const header = res.headers?.get?.('Retry-After');
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 10 * 60_000);
  return fallback;
}

async function readCached(key) {
  try {
    const row = await idb.get(key);
    if (row && Date.now() - (row.at || 0) < CACHE_TTL_MS) return row.stops;
  } catch {}
  return null;
}

/**
 * Find transit stops near a coordinate.
 *
 * @returns {Promise<{stops:Array, source:string|null, query:string, error?:string,
 *                    cached?:boolean, cooldownMs?:number}>}
 */
export async function findNearbyStops(lat, lon, { radius = 350, signal, force = false } = {}) {
  const query = buildQuery(lat, lon, radius);
  const key = cellKey(lat, lon, radius);

  if (!force) {
    const cached = await readCached(key);
    if (cached) return { stops: cached, source: 'cache', query, cached: true };
  }

  const pending = cooldownRemaining();
  if (pending > 0) {
    return {
      stops: [], source: null, query, cooldownMs: pending,
      error: `OpenStreetMap is not answering right now (cooling down for another ${Math.ceil(pending / 1000)} s).`,
    };
  }

  let lastErr = null;
  for (const endpoint of availableEndpoints()) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (res.status === 429) {
        // rate limited: back off, and do NOT try the next mirror immediately -
        // the quota is documented as counting a whole application, not one host
        park(endpoint, retryAfterMs(res, COOLDOWN_AFTER_429_MS));
        return { stops: [], source: null, query, cooldownMs: COOLDOWN_AFTER_429_MS, error: 'OpenStreetMap rate limit reached. Try again in about a minute.' };
      }
      if (res.status === 406) {
        // User-Agent/Referer ban: stop using this instance for a while
        park(endpoint, COOLDOWN_AFTER_406_MS);
        lastErr = new Error('Overpass refused this client (406)');
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500) park(endpoint, COOLDOWN_AFTER_5XX_MS);
        lastErr = new Error(`Overpass HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { json = parseOverpassXml(text); }
      const stops = parseElements(json);
      idb.set(key, { at: Date.now(), stops, source: endpoint }).catch(() => {});
      return { stops, source: endpoint, query };
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      lastErr = err;
    }
  }
  return { stops: [], source: null, query, error: lastErr?.message || 'Overpass unavailable' };
}

/** Forget cached stop lookups, e.g. from the Info screen. Returns how many. */
export async function clearStopCache() {
  try {
    // the kv store keeps the key out of the stored value, so read the keys
    const keys = await idb.getAllKeys();
    const mine = (keys || []).filter((k) => typeof k === 'string' && k.startsWith(CACHE_PREFIX));
    await Promise.all(mine.map((k) => idb.del(k)));
    return mine.length;
  } catch {
    return 0;
  }
}

/** Minimal Overpass-XML fallback (in case a mirror ignores the JSON accept). */
export function parseOverpassXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const elements = [];
  doc.querySelectorAll('node, way, center').forEach((el) => {
    const tags = {};
    el.querySelectorAll('tag').forEach((t) => { tags[t.getAttribute('k')] = t.getAttribute('v'); });
    const node = el.tagName === 'center' ? el.parentElement : el;
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    elements.push({ type: node.tagName, id: node.getAttribute('id'), lat, lon, tags });
  });
  return { elements };
}

/** Normalise Overpass stops into the shape used by the matcher. */
export function toMatcherStops(osmStops) {
  return (osmStops || []).map((s, i) => ({
    key: s.osm_id || `osm-${i}`,
    osm_id: s.osm_id,
    name: s.name || s.ref || 'Unnamed stop',
    lat: s.lat,
    lon: s.lon,
    modes: s.modes || [],
    route_ref: s.route_ref ? String(s.route_ref).split(/[;,]/).map((x) => x.trim()).filter(Boolean) : [],
    gtfs_stop_id: s.gtfs_stop_id || null,
  }));
}

/** Nearest stop in a stop list, handy for tests and for the exit flow. */
export function nearestStop(stops, point) {
  let best = null;
  let bestD = Infinity;
  for (const s of stops || []) {
    const d = haversine(point, s);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best ? { stop: best, distance: bestD } : null;
}

export const overpass = { findNearbyStops, toMatcherStops, cellKey, clearStopCache, ENDPOINTS };
export default overpass;
