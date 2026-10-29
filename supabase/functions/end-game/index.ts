import { adminClient } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const sb = adminClient();
  const { game_id } = await req.json();
  if (!game_id) return new Response('game_id required', { status: 400 });

  await sb.from('games').update({ status: 'ended' }).eq('id', game_id);
  return new Response(JSON.stringify({ ok: true }));
});