// ============================================================================
//  Supabase Edge Function: create-user
//
//  The ONLY way an account can be created. Enforces the role rules:
//    admin      -> admin | manager | gamemaster | player, any game
//    manager    -> gamemaster | player, any game
//    gamemaster -> player, only in games they run
//    player     -> nobody
//
//  Deploy:  supabase functions deploy create-user
//  (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
//   automatically by the platform - do not hard-code them.)
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLES = ['admin', 'manager', 'gamemaster', 'player'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function cleanUsername(raw) {
  return String(raw || '').trim();
}

function syntheticEmail(username) {
  const slug = username.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 60);
  return `u_${slug}@players.interchange.local`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anon || !serviceKey) {
    return json({ error: 'Function is missing Supabase environment variables.' }, 500);
  }

  /* ---------------------------------------------------------- authenticate */
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'Missing bearer token.' }, 401);
  }

  const callerClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerAuth, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerAuth?.user) return json({ error: 'Not signed in.' }, 401);
  const callerId = callerAuth.user.id;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerProfile, error: profErr } = await admin
    .from('profiles').select('id, username, role, status').eq('id', callerId).maybeSingle();
  if (profErr) return json({ error: `Could not read your profile: ${profErr.message}` }, 500);
  if (!callerProfile) return json({ error: 'Your profile row is missing.' }, 403);
  if (callerProfile.status !== 'active') return json({ error: 'Your account is not active.' }, 403);

  const callerRole = callerProfile.role;

  /* ------------------------------------------------------------- validate */
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

  const username = cleanUsername(body.username);
  const password = String(body.password || '');
  const role = String(body.role || 'player');
  const displayName = body.displayName ? String(body.displayName).slice(0, 80) : null;
  let gameId = body.gameId ? String(body.gameId) : null;
  const teamIds = Array.isArray(body.teamIds) ? body.teamIds.map(String) : [];
  const gamemasterId = body.gamemasterId ? String(body.gamemasterId) : null;

  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    return json({ error: 'Username must be 3-40 characters: letters, numbers, dot, dash or underscore.' }, 400);
  }
  if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400);
  if (!ROLES.includes(role)) return json({ error: `Unknown role "${role}".` }, 400);

  const allow = {
    admin: ['admin', 'manager', 'gamemaster', 'player'],
    manager: ['gamemaster', 'player'],
    gamemaster: ['player'],
    player: [],
  }[callerRole] || [];

  if (!allow.includes(role)) {
    return json({ error: `A ${callerRole} cannot create a ${role}.` }, 403);
  }

  /* which games may this caller use? */
  const isOverseer = callerRole === 'admin' || callerRole === 'manager';
  let allowedGames = [];
  if (isOverseer) {
    const { data } = await admin.from('games').select('id, gamemaster_id');
    allowedGames = data || [];
  } else {
    const { data } = await admin.from('games').select('id, gamemaster_id').eq('gamemaster_id', callerId);
    allowedGames = data || [];
  }

  if (gameId) {
    const ok = allowedGames.some((g) => g.id === gameId);
    if (!ok) return json({ error: 'You cannot add people to that game.' }, 403);
  }

  // A gamemaster creating a player without naming a game gets a default one.
  if (!gameId && (role === 'player' || role === 'gamemaster')) {
    if (isOverseer) {
      // leave unattached; an admin can attach them later
    } else {
      const own = allowedGames[0];
      if (own) {
        gameId = own.id;
      } else {
        const { data: created, error } = await admin.from('games').insert({
          name: `${callerProfile.username}'s game`,
          description: 'Created automatically when the first player was added.',
          gamemaster_id: callerId,
          created_by: callerId,
        }).select('id').maybeSingle();
        if (error) return json({ error: `Could not create a default game: ${error.message}` }, 500);
        gameId = created.id;
        await admin.from('game_members').upsert(
          { game_id: gameId, profile_id: callerId, role_in_game: 'gamemaster', is_player: false },
          { onConflict: 'game_id,profile_id' },
        );
      }
    }
  }

  /* ------------------------------------------------------- create the user */
  const email = syntheticEmail(username);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName, role, created_by: callerId },
  });

  if (createErr) {
    const msg = /already/i.test(createErr.message || '')
      ? `The username "${username}" is already taken.`
      : createErr.message;
    return json({ error: msg }, 400);
  }

  const newId = created.user.id;
  const warnings = [];

  /* profile: the auth trigger normally creates it; patch it to be certain. */
  const { error: upErr } = await admin.from('profiles').upsert({
    id: newId,
    email,
    username,
    display_name: displayName,
    role,
    status: 'active',
    created_by: callerId,
  }, { onConflict: 'id' });
  if (upErr) warnings.push(`profile: ${upErr.message}`);

  /* credentials ledger so staff can always hand out the login */
  const { error: credErr } = await admin.from('auth_accounts').upsert({
    user_id: newId,
    username,
    fake_email: email,
    password,
    created_by: callerId,
  }, { onConflict: 'user_id' });
  if (credErr) warnings.push(`credentials: ${credErr.message}`);

  /* gamemaster <-> player link */
  if (role === 'player') {
    const gm = gamemasterId && isOverseer ? gamemasterId : (callerRole === 'gamemaster' ? callerId : null);
    if (gm) {
      const { error } = await admin.from('gamemaster_players').upsert(
        { gamemaster_id: gm, player_id: newId, created_by: callerId },
        { onConflict: 'gamemaster_id,player_id' },
      );
      if (error) warnings.push(`gamemaster link: ${error.message}`);
    }
  }

  /* game membership */
  if (gameId) {
    const { error } = await admin.from('game_members').upsert({
      game_id: gameId,
      profile_id: newId,
      role_in_game: role,
      is_player: role === 'player',
    }, { onConflict: 'game_id,profile_id' });
    if (error) warnings.push(`game membership: ${error.message}`);
  }

  /* teams */
  for (const teamId of teamIds) {
    const { error } = await admin.from('team_members').upsert(
      { team_id: teamId, profile_id: newId },
      { onConflict: 'team_id,profile_id' },
    );
    if (error) warnings.push(`team ${teamId}: ${error.message}`);
  }

  return json({
    ok: true,
    user: { id: newId, username, role, gameId },
    credentials: { username, password, fake_email: email },
    warnings,
  });
});
