// Every 30s. Fetch Trip Updates + Service Alerts, upsert state.
// Env: GTFS_RT_TRIP_UPDATES_URL, GTFS_RT_ALERTS_URL, GTFS_RT_API_KEY (optional)
import { adminClient } from '../_shared/supabase.ts';
import G from 'https://esm.sh/gtfs-realtime-bindings@1.1.1';

async function fetchFeed(url: string) {
  const key = Deno.env.get('GTFS_RT_API_KEY');
  const res = await fetch(url, key ? { headers: { Authorization: key } } : undefined);
  if (!res.ok) throw new Error(`feed ${url} → ${res.status}`);
  return G.transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

Deno.serve(async () => {
  const sb = adminClient();
  const now = new Date().toISOString();

  // Trip Updates
  const tu = await fetchFeed(Deno.env.get('GTFS_RT_TRIP_UPDATES_URL')!);
  const tripRows: any[] = [];
  for (const entity of tu.entity) {
    const t = entity.tripUpdate;
    if (!t?.trip?.tripId) continue;
    const stus = t.stopTimeUpdate ?? [];
    const next = stus.find(s => (s.arrival?.time ?? s.departure?.time ?? 0) * 1000 > Date.now());
    tripRows.push({
      trip_id: t.trip.tripId,
      delay_seconds: t.delay ?? null,
      cancelled: t.trip.scheduleRelationship === 3,
      skipped_stop_ids: stus.filter(s => s.scheduleRelationship === 1).map(s => s.stopId).filter(Boolean),
      next_stop_id: next?.stopId ?? null,
      observed_at: now,
    });
  }
  if (tripRows.length) {
    await sb.from('trip_realtime_state').upsert(tripRows, { onConflict: 'trip_id' });
  }

  // Service Alerts
  const al = await fetchFeed(Deno.env.get('GTFS_RT_ALERTS_URL')!);
  const alertRows: any[] = [];
  for (const entity of al.entity) {
    const a = entity.alert;
    if (!a?.headerText?.translation?.length) continue;
    const start = a.activePeriod?.[0]?.start;
    const end   = a.activePeriod?.[0]?.end;
    const range = start || end
      ? `[${start ? new Date(start * 1000).toISOString() : ''},${end ? new Date(end * 1000).toISOString() : ''})`
      : null;
    alertRows.push({
      id: entity.id,
      route_ids: (a.informedEntity ?? []).map(e => e.routeId).filter(Boolean),
      stop_ids:  (a.informedEntity ?? []).map(e => e.stopId).filter(Boolean),
      effect: G.transit_realtime.Alert.Effect[a.effect ?? 0] ?? 'UNKNOWN_EFFECT',
      header: a.headerText.translation[0].text,
      description: a.descriptionText?.translation?.[0]?.text ?? null,
      active_period: range,
      observed_at: now,
    });
  }
  if (alertRows.length) {
    await sb.from('service_alerts').upsert(alertRows, { onConflict: 'id' });
  }

  return new Response(JSON.stringify({ trips: tripRows.length, alerts: alertRows.length }));
});