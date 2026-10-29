// Called by client after trip_event is finalized (alight confirmed).
// Reads games.rules_json, appends to score_ledger.
import { adminClient } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const sb = adminClient();
  const { trip_event_id } = await req.json();
  if (!trip_event_id) return new Response('trip_event_id required', { status: 400 });

  const { data: ev } = await sb.from('trip_events').select('*').eq('id', trip_event_id).single();
  if (!ev?.alight_at) return new Response('not finalized', { status: 409 });

  const { data: sess } = await sb
    .from('player_sessions').select('game_id, player_id').eq('id', ev.player_session_id).single();
  if (!sess) return new Response('session missing', { status: 404 });

  const { data: game } = await sb.from('games').select('rules_json').eq('id', sess.game_id).single();
  const rules = game?.rules_json ?? {};

  let delta = rules.points_per_ride ?? 10;
  const reasons: string[] = ['base_ride'];

  const late = ev.arrival_delay_seconds ?? 0;
  const lateRule = rules.late_arrival ?? { mode: 'info_only', threshold_seconds: 300, points: 0 };
  if (late >= (lateRule.threshold_seconds ?? 300)) {
    if (lateRule.mode === 'bonus')   { delta += lateRule.points ?? 0; reasons.push('late_bonus'); }
    if (lateRule.mode === 'penalty') { delta -= lateRule.points ?? 0; reasons.push('late_penalty'); }
  }

  if (ev.cancellation_detected) {
    const c = rules.cancelled_trip ?? { mode: 'disruption_bonus', points: 0 };
    if (c.mode === 'zero')              { delta = 0; reasons.push('cancelled_zero'); }
    if (c.mode === 'keep_partial')      { delta = Math.round(delta / 2); reasons.push('cancelled_partial'); }
    if (c.mode === 'disruption_bonus')  { delta += c.points ?? 0; reasons.push('disruption_bonus'); }
  }

  const skip = rules.skipped_stop ?? { mode: 'excuse', penalty: 0 };
  if (skip.mode === 'penalty' && (ev.metadata as any)?.skipped_stop) {
    delta -= skip.penalty ?? 0;
    reasons.push('skipped_penalty');
  }

  const { data: existing } = await sb.from('score_ledger')
    .select('id').eq('event_type', 'ride')
    .eq('metadata_json->>trip_event_id', ev.id).maybeSingle();
  if (existing) return new Response(JSON.stringify({ ok: true, already: true }));

  await sb.from('score_ledger').insert({
    player_session_id: ev.player_session_id,
    game_id: sess.game_id,
    event_type: 'ride',
    points_delta: delta,
    metadata_json: { trip_event_id: ev.id, reasons, arrival_delay_seconds: late },
  });

  await sb.from('trip_events').update({ points_awarded: delta }).eq('id', ev.id);
  await sb.rpc('refresh_leaderboard').catch(() => {});

  return new Response(JSON.stringify({ ok: true, delta }));
});