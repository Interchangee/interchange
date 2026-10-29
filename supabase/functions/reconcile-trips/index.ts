import { adminClient } from '../_shared/supabase.ts';

Deno.serve(async () => {
  const sb = adminClient();

  const { data: active } = await sb
    .from('trip_events')
    .select('id, player_session_id, trip_id, board_at, declared_alight_stop_id, alight_at')
    .is('alight_at', null)
    .not('trip_id', 'is', null);

  if (!active?.length) return new Response(JSON.stringify({ reconciled: 0 }));

  const tripIds = [...new Set(active.map(e => e.trip_id))];
  const { data: rt } = await sb.from('trip_realtime_state').select('*').in('trip_id', tripIds);
  const byTrip = new Map((rt ?? []).map(r => [r.trip_id, r]));

  let reconciled = 0;
  for (const ev of active) {
    const state = byTrip.get(ev.trip_id!);
    if (!state) continue;

    if (state.cancelled) {
      const { data: inferred } = await sb.rpc('infer_alight_stop', {
        p_session_id: ev.player_session_id,
      });
      const stop = inferred?.[0];
      await sb
        .from('trip_events')
        .update({
          cancellation_detected: true,
          inferred_alight_stop_id: stop?.stop_id ?? null,
          metadata: { inferred_distance_m: stop?.distance_m ?? null },
        })
        .eq('id', ev.id);
      reconciled++;
    } else {
      await sb
        .from('trip_events')
        .update({ arrival_delay_seconds: state.delay_seconds ?? 0 })
        .eq('id', ev.id);
    }
  }

  return new Response(JSON.stringify({ reconciled }));
});