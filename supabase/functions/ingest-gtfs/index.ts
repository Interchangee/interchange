import { adminClient } from '../_shared/supabase.ts';
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2';

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift()!.split(',').map(h => h.replace(/^"|"$/g, ''));
  return lines.map(line => {
    const cells = line.match(/(".*?"|[^,]+)(?=,|$)/g) ?? [];
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? '').replace(/^"|"$/g, '')));
    return row;
  });
}

Deno.serve(async () => {
  const sb = adminClient();
  const snapshot = crypto.randomUUID();

  const zip = await (await fetch(Deno.env.get('GTFS_STATIC_URL')!)).arrayBuffer();
  const files = unzipSync(new Uint8Array(zip));
  const read = (n: string) => (files[n] ? strFromU8(files[n]) : null);

  const agencies = read('agency.txt') ? parseCsv(read('agency.txt')!) : [];
  const routes   = read('routes.txt') ? parseCsv(read('routes.txt')!) : [];
  const stops    = read('stops.txt') ? parseCsv(read('stops.txt')!) : [];
  const trips    = read('trips.txt') ? parseCsv(read('trips.txt')!) : [];
  const times    = read('stop_times.txt') ? parseCsv(read('stop_times.txt')!) : [];

  await sb.from('gtfs_agencies').upsert(
    agencies.map(a => ({
      agency_id: a.agency_id || a.agency_name,
      agency_name: a.agency_name,
      agency_timezone: a.agency_timezone || 'Europe/Zurich',
      snapshot_id: snapshot,
    }))
  );

  await sb.from('gtfs_routes').upsert(
    routes.map(r => ({
      route_id: r.route_id,
      agency_id: r.agency_id,
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      route_type: Number(r.route_type) || null,
    }))
  );

  await sb.from('gtfs_stops').upsert(
    stops
      .filter(s => s.stop_lat && s.stop_lon)
      .map(s => ({
        stop_id: s.stop_id,
        stop_name: s.stop_name,
        stop_location: `SRID=4326;POINT(${s.stop_lon} ${s.stop_lat})`,
      }))
  );

  await sb.from('gtfs_trips').upsert(
    trips.map(t => ({
      trip_id: t.trip_id,
      route_id: t.route_id,
      service_id: t.service_id,
      trip_headsign: t.trip_headsign,
    }))
  );

  const CHUNK = 5000;
  for (let i = 0; i < times.length; i += CHUNK) {
    await sb.from('gtfs_stop_times').upsert(
      times.slice(i, i + CHUNK).map(t => ({
        trip_id: t.trip_id,
        stop_sequence: Number(t.stop_sequence),
        stop_id: t.stop_id,
        arrival_time: t.arrival_time,
        departure_time: t.departure_time,
      }))
    );
  }

  return new Response(JSON.stringify({ ok: true, snapshot }));
});