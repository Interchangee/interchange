/* ==========================================================================
   Node smoke test for the pure engine modules (no browser, no network).
   Run:  node tests/engine.test.mjs
   Covers: geo maths, CSV parsing, GTFS parsing, departure lookup, trip/shape
   progress. Browser-only code (DOM, GPS, fetch) is not touched.
   ========================================================================== */

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mod = (p) => pathToFileURL(join(here, '..', 'assets', 'js', p)).href;

const geo = await import(mod('geo.js'));
const zip = await import(mod('zip.js'));
const gtfs = await import(mod('gtfs.js'));
const overpass = await import(mod('overpass.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

console.log('\ngeo');

test('haversine matches a known short distance', () => {
  const d = geo.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - 111195) < 200, `got ${d}`);
});

test('haversine is zero for identical points', () => {
  assert.equal(geo.haversine({ lat: 52.5, lon: 13.4 }, { lat: 52.5, lon: 13.4 }), 0);
});

test('bearing points north for a northward hop', () => {
  const b = geo.bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(b < 0.5 || b > 359.5, `got ${b}`);
});

test('gtfsTimeToSeconds handles times past midnight', () => {
  assert.equal(geo.gtfsTimeToSeconds('25:10:00'), 25 * 3600 + 600);
  assert.equal(geo.gtfsTimeToSeconds('08:05'), 8 * 3600 + 300);
  assert.equal(geo.gtfsTimeToSeconds('nonsense'), null);
});

test('secondsToClock wraps to 24h', () => {
  assert.equal(geo.secondsToClock(25 * 3600 + 600), '01:10');
});

test('snapToPolyline finds the closest segment and progress', () => {
  const line = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }, { lat: 0, lon: 0.02 }];
  const snap = geo.snapToPolyline({ lat: 0.0002, lon: 0.015 }, line);
  assert.ok(snap.distance < 30, `distance ${snap.distance}`);
  assert.ok(snap.progressM > 1000 && snap.progressM < 2000, `progress ${snap.progressM}`);
});

test('withinRadius sorts near to far and honours the radius', () => {
  const items = [{ lat: 0, lon: 0.001 }, { lat: 0, lon: 0.02 }];
  const res = geo.withinRadius(items, { lat: 0, lon: 0 }, 5000);
  assert.equal(res.length, 2);
  assert.equal(res[0].item, items[0]);
  const tight = geo.withinRadius(items, { lat: 0, lon: 0 }, 300);
  assert.equal(tight.length, 1);
});

test('localTimeParts returns a service date and weekday', () => {
  const t = geo.localTimeParts(new Date('2024-05-06T10:00:00Z'), 'UTC');
  assert.equal(t.date, '2024-05-06');
  assert.equal(t.weekday, 'Mon');
  assert.equal(t.seconds, 10 * 3600);
});

test('modeFor maps GTFS route types', () => {
  assert.equal(geo.modeFor(1).key, 'rail');
  assert.equal(geo.modeFor(3).key, 'bus');
  assert.equal(geo.modeFor(4).key, 'ferry');
  assert.equal(geo.modeFor(999).key, 'bus');
});

test('speedFromTrack reads movement from a GPS window', () => {
  const a = { lat: 52.5, lon: 13.4, ts: 0, recorded_at: new Date(0).toISOString() };
  const b = { lat: 52.51, lon: 13.4, ts: 60000, recorded_at: new Date(60000).toISOString() };
  const v = geo.speedFromTrack([a, b], 20);
  assert.ok(v > 15 && v < 20, `got ${v} m/s`);
  assert.equal(geo.speedFromTrack([a], 20), 0);
});

console.log('\ncsv');

testAsync('parseCsv handles quotes, commas and CRLF', async () => {
  const rows = [];
  for await (const r of zip.parseCsv('a,b\r\n"x,1","y""2"\r\n')) rows.push(r);
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['x,1', 'y"2']);
});

testAsync('parseCsvObjects keys rows by header (with BOM)', async () => {
  const out = [];
  for await (const r of zip.parseCsvObjects('\uFEFFstop_id,stop_name\nS1,Central\n')) out.push(r);
  assert.deepEqual(out, [{ stop_id: 'S1', stop_name: 'Central' }]);
});

console.log('\ngtfs');

/* --- a miniature but realistic feed ------------------------------------- */
const FEED = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Test Transit,https://example.org,Europe/Berlin\n',
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    'S1,Central Station,52.5000,13.4000',
    'S2,Museum Island,52.5180,13.3990',
    'S3,North Gate,52.5360,13.3980',
  ].join('\n') + '\n',
  'routes.txt': [
    'route_id,agency_id,route_short_name,route_long_name,route_type',
    'R1,A,12,Airport Express,3',
    'R2,A,M1,Riverside Metro,1',
  ].join('\n') + '\n',
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id',
    'R1,WEEK,T1,Airport,0,SH1',
    'R2,WEEK,T2,Harbour,1,SH2',
  ].join('\n') + '\n',
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'T1,08:00:00,08:00:00,S1,1',
    'T1,08:06:00,08:06:00,S2,2',
    'T1,08:12:00,08:12:00,S3,3',
    'T2,08:03:00,08:03:00,S2,1',
    'T2,08:09:00,08:09:00,S1,2',
  ].join('\n') + '\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWEEK,1,1,1,1,1,0,0,20240101,20301231\n',
  'calendar_dates.txt': 'service_id,date,exception_type\nWEEK,20240506,2\n',
  'shapes.txt': [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'SH1,52.5000,13.4000,1',
    'SH1,52.5180,13.3990,2',
    'SH1,52.5360,13.3980,3',
  ].join('\n') + '\n',
};

function testBundle() {
  // parseGtfsText takes `filename -> csv text`, exactly like an unzipped feed
  return gtfs.parseGtfsText(new Map(Object.entries(FEED)));
}

testAsync('parseGtfsText builds stops, routes, trips and indexes', async () => {
  const bundle = await testBundle();
  assert.equal(bundle.stops.length, 3);
  assert.equal(bundle.routes.length, 2);
  assert.equal(bundle.trips.length, 2);
  assert.equal(bundle.index.stopTimesByStop.S1.length, 2);
  assert.equal(bundle.index.stopTimesByTrip.T1.length, 3);
  assert.equal(bundle.index.routeById.R1.mode, 'bus');
  assert.equal(bundle.index.tripsById.T1.headsign, 'Airport');
  assert.equal(bundle.feed.timezone, 'Europe/Berlin');
});

testAsync('a feed missing required files is rejected clearly', async () => {
  await assert.rejects(
    () => gtfs.parseGtfsText(new Map([['stops.txt', 'stop_id\nS1\n']])),
    /GTFS feed/,
  );
});

testAsync('nearestGtfsStops respects the radius and sorts', async () => {
  const bundle = await testBundle();
  const near = gtfs.nearestGtfsStops(bundle, { lat: 52.4995, lon: 13.4005 }, { radius: 500 });
  assert.equal(near[0].stop_id, 'S1');
  assert.ok(near.length >= 1);
  const none = gtfs.nearestGtfsStops(bundle, { lat: 0, lon: 0 }, { radius: 500 });
  assert.equal(none.length, 0);
});

testAsync('scheduledDepartures finds the right trips at the right stop', async () => {
  const bundle = await testBundle();
  const stops = [{ stop_id: 'S1', name: 'Central Station', lat: 52.5, lon: 13.4, distance_m: 20 }];
  // Monday 2024-05-13, 08:02 local: T1 left S1 two minutes ago, T2 departs 08:09
  const deps = gtfs.scheduledDepartures({
    bundle, stops, seconds: 8 * 3600 + 120, serviceDate: '2024-05-13', windowSec: 900, allowPast: 600,
  });
  const ids = deps.map((d) => d.trip_id);
  assert.ok(ids.includes('T1'), `got ${ids}`);
  assert.ok(ids.includes('T2'), `got ${ids}`);
  assert.equal(deps[0].trip_id, 'T1', 'the most recent departure should rank first');
  assert.equal(deps[0].eta_sec, -120);
});

testAsync('scheduledDepartures honours calendar_dates removals', async () => {
  const bundle = await testBundle();
  const stops = [{ stop_id: 'S1', name: 'Central', lat: 52.5, lon: 13.4 }];
  // 2024-05-06 is removed by calendar_dates (the feed only has WEEK)
  const removed = gtfs.scheduledDepartures({
    bundle, stops, seconds: 8 * 3600, serviceDate: '2024-05-06', windowSec: 900,
  });
  assert.equal(removed.length, 0, `expected no service, got ${removed.length}`);
  // a week later service is back
  const back = gtfs.scheduledDepartures({
    bundle, stops, seconds: 8 * 3600, serviceDate: '2024-05-13', windowSec: 900,
  });
  assert.ok(back.length > 0);
});

testAsync('scheduledDepartures skips a too-old departure', async () => {
  const bundle = await testBundle();
  const stops = [{ stop_id: 'S1', name: 'Central', lat: 52.5, lon: 13.4 }];
  const deps = gtfs.scheduledDepartures({
    bundle, stops, seconds: 8 * 3600 + 3600, serviceDate: '2024-05-13', windowSec: 900, allowPast: 300,
  });
  assert.equal(deps.length, 0, 'a departure an hour ago is not a candidate');
});

testAsync('tripStops returns the ordered stop list', async () => {
  const bundle = await testBundle();
  const stops = gtfs.tripStops(bundle, 'T1');
  assert.deepEqual(stops.map((s) => s.stop_id), ['S1', 'S2', 'S3']);
});

testAsync('progressOnTrip reports metres along the shape', async () => {
  const bundle = await testBundle();
  const prog = gtfs.progressOnTrip(bundle, 'T1', { lat: 52.5180, lon: 13.3990 });
  assert.ok(prog);
  assert.ok(prog.snap.progressM > 1900 && prog.snap.progressM < 2100, `progress ${prog.snap.progressM}`);
  assert.equal(prog.stops.length, 3);
});

testAsync('activeServiceIds falls back to weekdays', async () => {
  const bundle = await testBundle();
  const sunday = gtfs.activeServiceIds(bundle, new Date('2024-05-12T12:00:00Z'), 'Europe/Berlin');
  assert.equal(sunday.length, 0, 'no Sunday service in this feed');
});

console.log('\noverpass client');

test('only live, global, keyless instances are used', () => {
  const list = overpass.ENDPOINTS;
  assert.ok(list.length >= 2, 'need at least one fallback instance');
  for (const url of list) {
    assert.match(url, /^https:\/\//, `${url} must be https`);
    // an API key placeholder would mean the instance is not free
    assert.ok(!/YOUR_API_KEY|API_KEY/i.test(url), `${url} looks like a keyed instance`);
  }
  // overpass.kumi.systems was renamed to private.coffee in 2024 and times out;
  // private.coffee answered nothing when probed, so neither may be relied on
  const joined = list.join(' ');
  assert.ok(!/kumi\.systems/.test(joined), 'kumi.systems is dead and must not be listed');
  assert.ok(!/private\.coffee/.test(joined), 'private.coffee was unresponsive and must not be listed');
  // regional-only instances would return nothing useful for a global app
  for (const regional of ['overpass.osm.ch', 'overpass.maprva.org', 'openplaceguide.org', 'atownsend.org.uk']) {
    assert.ok(!joined.includes(regional), `${regional} only covers one region`);
  }
  assert.ok(joined.includes('overpass-api.de'), 'the documented light-use instance should be present');
});

test('the query stays small: bounded timeout and radius', () => {
  const q = overpass.buildQuery(52.5, 13.4, 350);
  assert.match(q, /\[out:json\]\[timeout:25\]/, 'timeout must stay well under the 180 s default');
  assert.match(q, /around:350,52\.500000,13\.400000/);
  assert.match(q, /out body center;/);
  // the operator bans clients that hammer it, so the query must not grow into a
  // world scrape: a handful of stop tags, nothing else
  assert.ok(q.split('\n').length < 20, 'query should stay a short list of stop tags');
});

test('nearby lookups share one cache cell', () => {
  // two points on the same street must reuse one cached answer, which is what
  // keeps a whole app inside the documented <100 requests/day band
  const a = overpass.cellKey(52.52001, 13.40999, 350);
  const b = overpass.cellKey(52.52008, 13.41003, 350);
  assert.equal(a, b, 'points ~10 m apart should share a cell');
  const far = overpass.cellKey(52.61, 13.41, 350);
  assert.notEqual(a, far, 'a kilometre away should be a different cell');
  assert.match(a, /^osm-stops:/, 'cache keys must be namespaced so they can be cleared');
});

test('stop normalisation splits route_ref and keeps the gtfs id', () => {
  const [s] = overpass.toMatcherStops([{
    osm_id: 'node/1', name: 'Central', lat: 1, lon: 2,
    route_ref: '12; M1 ,34', gtfs_stop_id: 'S1', modes: ['bus'],
  }]);
  assert.deepEqual(s.route_ref, ['12', 'M1', '34']);
  assert.equal(s.gtfs_stop_id, 'S1');
});

test('stops with no name fall back to their ref', () => {
  const [s] = overpass.toMatcherStops([{ osm_id: 'node/2', lat: 1, lon: 2, ref: 'B7' }]);
  assert.equal(s.name, 'B7');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);
