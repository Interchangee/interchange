/* ==========================================================================
   Geospatial helpers + the GPS service.
   Pure functions where possible so the matcher stays testable.
   ========================================================================== */

export const EARTH_R = 6371008.8;

export function toRad(d) { return (d * Math.PI) / 180; }

/** Great-circle distance in metres between {lat,lon} objects or arrays. */
export function haversine(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = a.lat ?? a[0], lon1 = a.lon ?? a[1];
  const lat2 = b.lat ?? b[0], lon2 = b.lon ?? b[1];
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function nearest(items, point, keyFn = (x) => x) {
  let best = null, bestD = Infinity;
  for (const it of items || []) {
    const d = haversine(point, keyFn(it));
    if (d < bestD) { bestD = d; best = it; }
  }
  return best ? { item: best, distance: bestD } : null;
}

/** All points within radius, sorted near -> far. */
export function withinRadius(items, point, radiusM, keyFn = (x) => x) {
  return (items || [])
    .map((it) => ({ item: it, distance: haversine(point, keyFn(it)) }))
    .filter((r) => r.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance);
}

/** Cheap "is this point plausibly moving" test used to boost confidence. */
export function speedFromTrack(points, minSpanSec = 20) {
  if (!points || points.length < 2) return 0;
  const first = points[0], last = points[points.length - 1];
  const dt = (new Date(last.recorded_at || last.ts) - new Date(first.recorded_at || first.ts)) / 1000;
  if (!(dt >= minSpanSec)) return 0;
  return haversine(first, last) / dt; // m/s
}

/** Project a point onto segment ab, returning {t, point, distance}. */
export function projectOnSegment(p, a, b) {
  const latScale = 111320;
  const lonScale = 111320 * Math.cos(toRad(a.lat ?? a[0]));
  const ax = (a.lon ?? a[1]) * lonScale, ay = (a.lat ?? a[0]) * latScale;
  const bx = (b.lon ?? b[1]) * lonScale, by = (b.lat ?? b[0]) * latScale;
  const px = (p.lon ?? p[1]) * lonScale, py = (p.lat ?? p[0]) * latScale;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { t, distance: Math.hypot(px - cx, py - cy), point: { lat: cy / latScale, lon: cx / lonScale } };
}

/** Snap a GPS point onto a polyline: {index, t, distance, progressM, point}. */
export function snapToPolyline(p, line) {
  if (!line || line.length === 0) return null;
  if (line.length === 1) return { index: 0, t: 0, distance: haversine(p, line[0]), progressM: 0, point: line[0] };
  let cum = 0, best = null, total = 0;
  const segLens = [];
  for (let i = 1; i < line.length; i++) {
    const d = haversine(line[i - 1], line[i]);
    segLens.push(d); total += d;
  }
  for (let i = 1; i < line.length; i++) {
    const proj = projectOnSegment(p, line[i - 1], line[i]);
    if (!best || proj.distance < best.distance) {
      best = { index: i - 1, t: proj.t, distance: proj.distance, progressM: cum + proj.t * segLens[i - 1], point: proj.point };
    }
    cum += segLens[i - 1];
  }
  if (best) best.lengthM = total;
  return best;
}

/** Total travelled distance along a track, in metres. */
export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < (points || []).length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

/* ------------------------------------------------------------------ times */

const HHMM = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/;

/** "25:10:00" (GTFS allows >24h) -> seconds since service-day midnight. */
export function gtfsTimeToSeconds(t) {
  const m = HHMM.exec(String(t || ''));
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
}

export function secondsToClock(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600) % 24;
  const mm = Math.floor((s % 3600) / 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function localTimeParts(date = new Date(), timeZone = 'UTC') {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const seconds = (+parts.hour % 24) * 3600 + (+parts.minute) * 60 + (+parts.second);
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      ymd: [+parts.year, +parts.month, +parts.day],
      seconds,
      clock: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
      weekday: parts.weekday,
    };
  } catch {
    const d = date;
    return {
      date: d.toISOString().slice(0, 10),
      ymd: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
      seconds: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
      clock: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
      weekday: 'Mon',
    };
  }
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayOfWeek(date = new Date(), timeZone = 'UTC') {
  return WD[new Date(localTimeParts(date, timeZone).date + 'T12:00:00Z').getUTCDay()];
}

/* -------------------------------------------------------------------- GPS */

export const gps = {
  supported: typeof navigator !== 'undefined' && 'geolocation' in navigator,

  options: {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  },

  /** One-shot fix with a hard timeout so the UI never hangs. */
  getCurrent({ timeoutMs = 20000, maximumAge = 3000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.supported) return reject(new Error('Geolocation is not available on this device'));
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('Could not get a GPS fix in time. Try again outdoors.')); }
      }, timeoutMs + 2000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve(readPosition(pos));
        },
        (err) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          reject(new Error(gpsMessage(err)));
        },
        { ...this.options, timeout: timeoutMs, maximumAge },
      );
    });
  },

  /** Continuous tracking: cb({lat,lon,accuracy,speed_mps,heading_deg,recorded_at}) */
  watch(cb, onError) {
    if (!this.supported) { onError?.(new Error('Geolocation is not available')); return { stop() {} }; }
    const id = navigator.geolocation.watchPosition(
      (pos) => cb(readPosition(pos)),
      (err) => onError?.(new Error(gpsMessage(err))),
      this.options,
    );
    return { stop() { try { navigator.geolocation.clearWatch(id); } catch {} } };
  },
};

function readPosition(pos) {
  const c = pos.coords;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: c.accuracy ?? null,
    altitude: c.altitude ?? null,
    speed_mps: c.speed ?? null,
    heading_deg: c.heading ?? null,
    recorded_at: new Date(pos.timestamp || Date.now()).toISOString(),
    ts: pos.timestamp || Date.now(),
  };
}

export function gpsMessage(err) {
  if (!err) return 'Location unavailable';
  switch (err.code) {
    case 1: return 'Location permission denied. Enable location for this site in your browser settings.';
    case 2: return 'Location unavailable. Move somewhere with a clearer view of the sky.';
    case 3: return 'Timed out waiting for GPS. Try again.';
    default: return err.message || 'Location error';
  }
}

/* --------------------------------------------------- route type friendly */

export const ROUTE_MODES = {
  0: { key: 'tram', label: 'Tram', icon: 'tram' },
  1: { key: 'rail', label: 'Metro / Subway', icon: 'rail' },
  2: { key: 'rail', label: 'Rail', icon: 'rail' },
  3: { key: 'bus', label: 'Bus', icon: 'bus' },
  4: { key: 'ferry', label: 'Ferry', icon: 'ferry' },
  5: { key: 'tram', label: 'Cable tram', icon: 'tram' },
  6: { key: 'tram', label: 'Aerial lift', icon: 'tram' },
  7: { key: 'tram', label: 'Funicular', icon: 'tram' },
  11: { key: 'bus', label: 'Trolleybus', icon: 'bus' },
  12: { key: 'rail', label: 'Monorail', icon: 'rail' },
};

export function modeFor(routeType) {
  return ROUTE_MODES[Number(routeType)] || { key: 'bus', label: 'Transit', icon: 'bus' };
}
