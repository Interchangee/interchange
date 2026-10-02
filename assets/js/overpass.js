/* ==========================================================================
   Overpass API client - completely free, no key.
   Used for one thing: "which transit stops are within N metres of me?"
   That is the geography layer; schedules come from GTFS.
   ========================================================================== */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

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

function buildQuery(lat, lon, radius) {
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const body = STOP_FILTER.map((f) => `  ${f}${around};`).join('\n');
  return `[out:json][timeout:25];\n(\n${body}\n);\nout body center;`;
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

function detectModes(tags, el) {
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

/**
 * Find transit stops near a coordinate.
 * @returns {Promise<{stops:Array, source:string, error?:string}>}
 */
export async function findNearbyStops(lat, lon, { radius = 350, signal } = {}) {
  const query = buildQuery(lat, lon, radius);
  let lastErr = null;

  for (const endpoint of ENDPOINTS) {
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
      if (!res.ok) { lastErr = new Error(`Overpass HTTP ${res.status}`); continue; }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { json = parseOverpassXml(text); }
      return { stops: parseElements(json), source: endpoint, query };
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      lastErr = err;
    }
  }
  return { stops: [], source: null, query, error: lastErr?.message || 'Overpass unavailable' };
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

export const overpass = { findNearbyStops, toMatcherStops, ENDPOINTS };
export default overpass;
