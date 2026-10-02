/* ==========================================================================
   Data access layer. Every screen talks to Supabase through this module so
   that query shapes and error handling stay in one place.
   ========================================================================== */

import store from './store.js';

function fail(error, where) {
  console.warn(`[api:${where}]`, error);
  return { data: null, error };
}

/* ------------------------------------------------------------------ users */

export async function loadMyProfile() {
  const sb = store.client;
  if (!sb) return fail({ message: 'Not configured' }, 'profile');
  const { data: auth } = await sb.getUser();
  if (!auth?.user) return { data: null, error: { message: 'Not signed in' } };
  const { data, error } = await sb.from('profiles').select('*').eq('id', auth.user.id).maybeSingle();
  if (error) return fail(error, 'profile');
  if (!data) {
    // The auth trigger should have made this row. Self-heal if it did not.
    const fallback = {
      id: auth.user.id,
      email: auth.user.email,
      username: auth.user.user_metadata?.username || auth.user.email?.split('@')[0] || 'user',
      display_name: auth.user.user_metadata?.display_name || null,
      role: auth.user.user_metadata?.role || 'player',
    };
    const ins = await sb.from('profiles').upsert(fallback).select().maybeSingle();
    if (ins.error) return fail(ins.error, 'profile-create');
    return { data: ins.data, error: null };
  }
  return { data, error: null };
}

/** Turn a plain username into the synthetic auth email, then sign in. */
export async function signIn(username, password) {
  const sb = store.client;
  if (!sb) return fail({ message: 'Supabase is not configured yet' }, 'signin');
  const uname = String(username || '').trim();
  const { data: email, error } = await sb.rpc('email_for_username', { uname });
  if (error) return fail(error, 'signin-lookup');
  const resolved = typeof email === 'string' ? email : (Array.isArray(email) ? email[0] : null);
  if (!resolved) return fail({ message: 'Unknown username. Ask your gamemaster to create an account for you.' }, 'signin-lookup');
  const res = await sb.signInWithPassword({ email: resolved, password });
  if (res.error) {
    const msg = /invalid/i.test(res.error.message || '') ? 'Wrong password.' : res.error.message;
    return fail({ message: msg }, 'signin');
  }
  return { data: res.data, error: null };
}

/** Staff-created account (goes through the create-user edge function). */
export async function createAccount(payload) {
  const sb = store.client;
  await sb.ensureFresh();
  const { data, error } = await sb.invoke('create-user', { body: payload });
  if (error) return fail(error, 'create-user');
  if (data?.error) return fail({ message: data.error }, 'create-user');
  return { data, error: null };
}

export async function listProfiles({ role, search, limit = 200 } = {}) {
  const sb = store.client;
  let q = sb.from('profiles').select('id,username,display_name,role,status,color,created_by,created_at,last_seen_at').order('created_at', { ascending: false }).limit(limit);
  if (role) q = Array.isArray(role) ? q.in('role', role) : q.eq('role', role);
  if (search) q = q.ilike('username', `%${search}%`);
  const { data, error } = await q;
  if (error) return fail(error, 'profiles');
  return { data, error: null };
}

export async function updateProfile(id, patch) {
  const sb = store.client;
  const { data, error } = await sb.from('profiles').update(patch).eq('id', id).select().maybeSingle();
  if (error) return fail(error, 'profile-update');
  return { data, error: null };
}

export async function credentialsFor(playerId) {
  const { data, error } = await store.client.rpc('player_credentials', { player: playerId });
  if (error) return fail(error, 'credentials');
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/* ------------------------------------------------------- first-run admin */

/** Has anybody claimed admin on this project yet? */
export async function adminExists() {
  const sb = store.client;
  if (!sb) return { data: null, error: { message: 'Not configured' } };
  const { data, error } = await sb.rpc('admin_exists');
  if (error) return fail(error, 'admin-exists');
  return { data: data === true, error: null };
}

/** Promote the signed-in account to admin - works exactly once. */
export async function claimFirstAdmin() {
  const sb = store.client;
  await sb.ensureFresh();
  const { data, error } = await sb.rpc('claim_first_admin');
  if (error) return fail(error, 'claim-admin');
  return { data, error: null };
}

/* ------------------------------------------------------------------ games */

export async function loadMyGames() {
  const sb = store.client;
  const { data, error } = await sb.rpc('list_my_games');
  if (error) return fail(error, 'my-games');
  return { data: data || [], error: null };
}

export async function loadAssignableGames() {
  const sb = store.client;
  const { data, error } = await sb.rpc('list_assignable_games');
  if (error) return fail(error, 'assignable-games');
  return { data: data || [], error: null };
}

export async function createGame({ name, description, gamemasterId, startsAt, endsAt, pointsConfig, trackingConfig }) {
  const sb = store.client;
  const payload = {
    name,
    description: description || null,
    gamemaster_id: gamemasterId || store.user.id,
    starts_at: startsAt || null,
    ends_at: endsAt || null,
    points_config: pointsConfig || undefined,
    tracking_config: trackingConfig || undefined,
    created_by: store.user.id,
  };
  const { data, error } = await sb.from('games').insert(payload).select().maybeSingle();
  if (error) return fail(error, 'game-create');
  if (data) await addGameMember(data.id, payload.gamemaster_id, 'gamemaster', false);
  return { data, error: null };
}

export async function updateGame(id, patch) {
  const sb = store.client;
  const { data, error } = await sb.from('games').update(patch).eq('id', id).select().maybeSingle();
  if (error) return fail(error, 'game-update');
  return { data, error: null };
}

export async function addGameMember(gameId, profileId, roleInGame = 'player', isPlayer = true) {
  const sb = store.client;
  const { data, error } = await sb.from('game_members')
    .upsert({ game_id: gameId, profile_id: profileId, role_in_game: roleInGame, is_player: isPlayer },
      { onConflict: 'game_id,profile_id' })
    .select().maybeSingle();
  if (error) return fail(error, 'game-member-add');
  return { data, error: null };
}

export async function removeGameMember(gameId, profileId) {
  const sb = store.client;
  const { error } = await sb.from('game_members').delete().eq('game_id', gameId).eq('profile_id', profileId);
  if (error) return fail(error, 'game-member-remove');
  return { data: true, error: null };
}

export async function linkGamemasterPlayer(gamemasterId, playerId) {
  const sb = store.client;
  const { error } = await sb.from('gamemaster_players')
    .upsert({ gamemaster_id: gamemasterId, player_id: playerId, created_by: store.user.id },
      { onConflict: 'gamemaster_id,player_id', ignoreDuplicates: true });
  if (error) return fail(error, 'gm-link');
  return { data: true, error: null };
}

export async function listGameMembers(gameId) {
  const sb = store.client;
  const { data, error } = await sb.from('game_members')
    .select('profile_id, role_in_game, is_player, joined_at, profile:profiles!game_members_profile_id_fkey(id,username,display_name,role,status)')
    .eq('game_id', gameId);
  if (error) return fail(error, 'game-members');
  return { data: data || [], error: null };
}

/* ------------------------------------------------------------------ teams */

export async function listTeams(gameId) {
  const sb = store.client;
  const { data, error } = await sb.from('teams')
    .select('id,game_id,name,description,created_at, team_members(profile_id, profile:profiles!team_members_profile_id_fkey(id,username,display_name,role))')
    .eq('game_id', gameId).order('name');
  if (error) return fail(error, 'teams');
  return { data: data || [], error: null };
}

export async function createTeam(gameId, name, description) {
  const sb = store.client;
  const { data, error } = await sb.from('teams')
    .insert({ game_id: gameId, name, description: description || null, created_by: store.user.id })
    .select().maybeSingle();
  if (error) return fail(error, 'team-create');
  return { data, error: null };
}

export async function renameTeam(id, name, description) {
  const sb = store.client;
  const { data, error } = await sb.from('teams').update({ name, description }).eq('id', id).select().maybeSingle();
  if (error) return fail(error, 'team-update');
  return { data, error: null };
}

export async function deleteTeam(id) {
  const sb = store.client;
  const { error } = await sb.from('teams').delete().eq('id', id);
  if (error) return fail(error, 'team-delete');
  return { data: true, error: null };
}

export async function addTeamMember(teamId, profileId) {
  const sb = store.client;
  const { error } = await sb.from('team_members')
    .upsert({ team_id: teamId, profile_id: profileId }, { onConflict: 'team_id,profile_id', ignoreDuplicates: true });
  if (error) return fail(error, 'team-member-add');
  return { data: true, error: null };
}

export async function removeTeamMember(teamId, profileId) {
  const sb = store.client;
  const { error } = await sb.from('team_members').delete().eq('team_id', teamId).eq('profile_id', profileId);
  if (error) return fail(error, 'team-member-remove');
  return { data: true, error: null };
}

export async function shuffleTeams(gameId, teamIds, memberIds) {
  // Fisher-Yates over the players, dealt round-robin into the teams.
  const players = [...memberIds];
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const sb = store.client;
  await sb.from('team_members').delete().in('team_id', teamIds);
  const rows = players.map((pid, idx) => ({ team_id: teamIds[idx % teamIds.length], profile_id: pid }));
  if (rows.length) {
    const { error } = await sb.from('team_members').insert(rows);
    if (error) return fail(error, 'shuffle');
  }
  return { data: rows, error: null };
}

/* ------------------------------------------------------------------ rides */

export async function startBoarding({ gameId, playerId, vehicle, teamId, position, confidence, source, guess, notes, extra }) {
  const sb = store.client;
  const now = new Date().toISOString();
  const { data, error } = await sb.from('boardings').insert({
    game_id: gameId,
    player_id: playerId,
    vehicle_id: vehicle?.id || null,
    team_id: teamId || null,
    status: 'riding',
    source: source || 'schedule',
    confidence: confidence || 'medium',
    board_lat: position?.lat ?? null,
    board_lon: position?.lon ?? null,
    board_accuracy_m: position?.accuracy ?? null,
    board_at: now,
    board_stop_id: vehicle?.stop_id || null,
    board_stop_name: vehicle?.stop_name || null,
    guess_payload: guess || null,
    confirmed_payload: extra || null,
    notes: notes || null,
  }).select().maybeSingle();
  if (error) return fail(error, 'boarding-start');
  return { data, error: null };
}

export async function endBoarding(id, { position, stop, stopsTravelled, distanceM, resolvedBy }) {
  const sb = store.client;
  const { data, error } = await sb.from('boardings').update({
    status: 'completed',
    alight_lat: position?.lat ?? null,
    alight_lon: position?.lon ?? null,
    alight_accuracy_m: position?.accuracy ?? null,
    alight_at: new Date().toISOString(),
    alight_stop_id: stop?.stop_id || null,
    alight_stop_name: stop?.stop_name || null,
    stops_travelled: stopsTravelled ?? null,
    distance_m: distanceM ?? null,
    confirmed_payload: resolvedBy ? { resolved_by: resolvedBy } : undefined,
  }).eq('id', id).select().maybeSingle();
  if (error) return fail(error, 'boarding-end');
  return { data, error: null };
}

export async function cancelBoarding(id, reason) {
  const sb = store.client;
  const { error } = await sb.from('boardings')
    .update({ status: 'cancelled', notes: reason || 'cancelled by player' }).eq('id', id);
  if (error) return fail(error, 'boarding-cancel');
  return { data: true, error: null };
}

export async function activeBoarding(playerId) {
  const sb = store.client;
  const { data, error } = await sb.from('boardings')
    .select('*, vehicle:vehicles(*)')
    .eq('player_id', playerId).eq('status', 'riding')
    .order('board_at', { ascending: false }).limit(1).maybeSingle();
  if (error && error.code !== 'PGRST116') return fail(error, 'boarding-active');
  return { data: data || null, error: null };
}

export async function listMyBoardings(playerId, limit = 60) {
  const sb = store.client;
  const { data, error } = await sb.from('boardings')
    .select('id,game_id,status,board_at,alight_at,board_stop_name,alight_stop_name,stops_travelled,distance_m,confidence,vehicle:vehicles(route_short_name,route_long_name,headsign,route_mode,agency_id)')
    .eq('player_id', playerId).order('board_at', { ascending: false }).limit(limit);
  if (error) return fail(error, 'boardings');
  return { data: data || [], error: null };
}

export async function listGameBoardings(gameId, { since, limit = 200 } = {}) {
  const sb = store.client;
  let q = sb.from('boardings')
    .select('id,status,board_at,alight_at,board_stop_name,alight_stop_name,stops_travelled,distance_m,confidence,player:profiles!boardings_player_id_fkey(id,username,display_name),vehicle:vehicles(route_short_name,route_long_name,headsign)')
    .eq('game_id', gameId).order('board_at', { ascending: false }).limit(limit);
  if (since) q = q.gte('board_at', since);
  const { data, error } = await q;
  if (error) return fail(error, 'game-boardings');
  return { data: data || [], error: null };
}

/* ------------------------------------------------------------- vehicles */

export async function findOrCreateVehicle(vehicle) {
  const sb = store.client;
  const source = vehicle.source || 'schedule';
  const tripId = vehicle.trip_id || null;
  let found = null;
  if (tripId) {
    const q = await sb.from('vehicles').select('*')
      .eq('source', source).eq('trip_id', tripId).limit(1).maybeSingle();
    found = q.data;
  } else {
    // manual entry with no trip id: reuse a matching route if we saw it before
    const q = await sb.from('vehicles').select('*')
      .eq('source', source)
      .eq('route_short_name', vehicle.route_short_name || '')
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    found = q.data;
  }
  if (found) return { data: found, error: null };

  const { data, error } = await sb.from('vehicles').insert({
    agency_id: vehicle.agency_id || null,
    game_id: vehicle.game_id || null,
    source: vehicle.source || 'schedule',
    route_id: vehicle.route_id || null,
    route_short_name: vehicle.route_short_name || null,
    route_long_name: vehicle.route_long_name || null,
    route_mode: vehicle.route_mode || null,
    route_color: vehicle.route_color || null,
    headsign: vehicle.headsign || null,
    direction_id: vehicle.direction_id ?? null,
    trip_id: vehicle.trip_id || null,
    vehicle_id: vehicle.vehicle_id || null,
    label: vehicle.label || null,
    created_by: store.user?.id || null,
  }).select().maybeSingle();
  if (error) return fail(error, 'vehicle-create');
  return { data, error: null };
}

/* -------------------------------------------------------------- tracking */

export async function pushTrackPoints(rows) {
  if (!rows?.length) return { data: true, error: null };
  const sb = store.client;
  const { error } = await sb.from('track_points').insert(rows);
  if (error) return fail(error, 'track-push');
  return { data: true, error: null };
}

export async function listTrackPoints({ boardingId, playerId, limit = 2000 } = {}) {
  const sb = store.client;
  let q = sb.from('track_points')
    .select('id,lat,lon,accuracy_m,speed_mps,recorded_at,boarding_id,player_id,source')
    .order('recorded_at', { ascending: true }).limit(limit);
  if (boardingId) q = q.eq('boarding_id', boardingId);
  if (playerId) q = q.eq('player_id', playerId);
  const { data, error } = await q;
  if (error) return fail(error, 'track-list');
  return { data: data || [], error: null };
}

/* ---------------------------------------------------------------- points */

export async function listPointRules(gameId) {
  const sb = store.client;
  const { data, error } = await sb.from('point_events').select('*').eq('game_id', gameId).order('code');
  if (error) return fail(error, 'point-rules');
  return { data: data || [], error: null };
}

export async function upsertPointRule(rule) {
  const sb = store.client;
  const { data, error } = await sb.from('point_events')
    .upsert({ ...rule, game_id: rule.game_id }, { onConflict: 'game_id,code' })
    .select().maybeSingle();
  if (error) return fail(error, 'point-rule-upsert');
  return { data, error: null };
}

export async function deletePointRule(id) {
  const sb = store.client;
  const { error } = await sb.from('point_events').delete().eq('id', id);
  if (error) return fail(error, 'point-rule-delete');
  return { data: true, error: null };
}

export async function listPoints({ gameId, playerId, limit = 200 } = {}) {
  const sb = store.client;
  let q = sb.from('points_events')
    .select('id,game_id,player_id,kind,reason,points,created_at,auto,boarding_id, player:profiles!points_events_player_id_fkey(username,display_name)')
    .order('created_at', { ascending: false }).limit(limit);
  if (gameId) q = q.eq('game_id', gameId);
  if (playerId) q = q.eq('player_id', playerId);
  const { data, error } = await q;
  if (error) return fail(error, 'points-list');
  return { data: data || [], error: null };
}

export async function awardPoints({ gameId, playerId, points, reason, kind = 'manual', boardingId = null, teamId = null, lat = null, lon = null }) {
  const sb = store.client;
  const { data, error } = await sb.from('points_events').insert({
    game_id: gameId, player_id: playerId, points, reason, kind,
    boarding_id: boardingId, team_id: teamId, lat, lon,
    awarded_by: store.user.id, auto: false,
  }).select().maybeSingle();
  if (error) return fail(error, 'points-award');
  return { data, error: null };
}

export async function revokePoints(id) {
  const sb = store.client;
  const { error } = await sb.from('points_events').delete().eq('id', id);
  if (error) return fail(error, 'points-revoke');
  return { data: true, error: null };
}

export async function awardRidePoints(boardingId) {
  const { data, error } = await store.client.rpc('award_ride_points', { bid: boardingId });
  if (error) return fail(error, 'award-ride');
  return { data, error: null };
}

export async function leaderboard(gameId) {
  const { data, error } = await store.client.rpc('game_leaderboard', { gid: gameId });
  if (error) return fail(error, 'leaderboard');
  return { data: data || [], error: null };
}

export async function myPoints(gameId, playerId) {
  const sb = store.client;
  const { data, error } = await sb.from('points_events').select('points')
    .eq('game_id', gameId).eq('player_id', playerId);
  if (error) return fail(error, 'my-points');
  const total = (data || []).reduce((a, r) => a + Number(r.points || 0), 0);
  return { data: { total, count: (data || []).length }, error: null };
}

/* -------------------------------------------------------------- agencies */

export async function listAgencies() {
  const sb = store.client;
  const { data, error } = await sb.from('transit_agencies').select('*').eq('active', true).order('name');
  if (error) return fail(error, 'agencies');
  return { data: data || [], error: null };
}

export async function upsertAgency(agency) {
  const sb = store.client;
  const { data, error } = await sb.from('transit_agencies')
    .upsert(agency, { onConflict: 'agency_key' }).select().maybeSingle();
  if (error) return fail(error, 'agency-upsert');
  return { data, error: null };
}

/** Local cache of scheduled departures (used when a device has no GTFS zip). */
export async function findCachedDepartures({ stopIds, afterTime, windowMinutes = 45, limit = 40 }) {
  const sb = store.client;
  const [hh, mm] = afterTime.split(':').map(Number);
  const startMin = hh * 60 + mm - 20;
  if (!stopIds?.length) return { data: [], error: null };
  const { data, error } = await sb.from('gtfs_departures')
    .select('*')
    .in('stop_id', stopIds.slice(0, 60))
    .eq('service_date', new Date().toISOString().slice(0, 10))
    .order('departure_time').limit(limit);
  if (error) return fail(error, 'departures');
  const rows = (data || []).filter((r) => {
    const p = r.departure_time.split(':').map(Number);
    const mins = p[0] * 60 + p[1];
    return mins >= startMin && mins <= startMin + windowMinutes;
  });
  return { data: rows, error: null };
}

/* end of data access layer */
