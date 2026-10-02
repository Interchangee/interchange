/* ========================================================================== 
   Data access layer. Every screen talks to Supabase through this module so that 
   query shapes and error handling stay in one place. 
   ========================================================================== */ 

import store from './store.js';

function fail(error, where) {
  console.warn(`[api:${where}]`, error);
  return { data: null, error };
}

/**
 * Turn a row-level-security rejection into something a human can act on.
 */
function explainPermission(error, what) {
  if (!error) return error;
  const text = `${error.code || ''} ${error.message || ''}`;
  const denied =
    error.code === '42501' ||
    /row-level security|permission denied|violates row-level security/i.test(text);
  if (!denied) return error;
  const role = store.role;
  const hint =
    role === 'admin' || role === 'manager'
      ? 'Your session still holds an older profile. Press "Refresh my access" on the Info tab, or sign out and back in.'
      : `Your role is "${role}", which may not ${what}. An admin, manager or gamemaster can change that.`;
  return { ...error, message: `Not allowed: ${what}. ${hint}` };
}

/* ------------------------------------------------------------------ users */

export async function loadMyProfile() {
  const sb = store.client;
  if (!sb) return fail({ message: 'Not configured' }, 'profile');
  const { data: auth } = await sb.getUser();
  if (!auth?.user) return { data: null, error: { message: 'Not signed in' } };
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (error) return fail(error, 'profile');
  if (!data) {
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

export async function signIn(identifier, password) {
  const sb = store.client;
  if (!sb) return fail({ message: 'Supabase is not configured yet' }, 'signin');
  const value = String(identifier || '').trim();
  let email = null;
  if (value.includes('@')) {
    email = value;
  } else {
    const { data, error } = await sb.rpc('email_for_username', { uname: value });
    if (error) return fail(error, 'signin-lookup');
    email = typeof data === 'string' ? data : Array.isArray(data) ? data[0] : null;
    if (!email) {
      return fail({
        message: `No account called "${value}". Check the spelling - or, if this account was created directly in Supabase, sign in with its full email address instead. Staff can create `,
      });
    }
  }
  // ... rest of signIn is unchanged
}

/* ... other user functions remain unchanged ... */

/* ------------------------------------------------------------------ games */

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
    timezone: 'Europe/Zurich', // Default to Switzerland
  };
  const { data, error } = await sb.from('games').insert(payload).select().maybeSingle();
  if (error) return fail(explainPermission(error, 'create a game'), 'game-create');
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
  const { data, error } = await sb
    .from('game_members')
    .upsert(
      { game_id: gameId, profile_id: profileId, role_in_game: roleInGame, is_player: isPlayer },
      { onConflict: 'game_id,profile_id' }
    )
    .select()
    .maybeSingle();
  if (error) return fail(error, 'game-member-add');
  return { data, error: null };
}

export async function removeGameMember(gameId, profileId) {
  const sb = store.client;
  const { error } = await sb
    .from('game_members')
    .delete()
    .eq('game_id', gameId)
    .eq('profile_id', profileId);
  if (error) return fail(error, 'game-member-remove');
  return { data: true, error: null };
}

export async function linkGamemasterPlayer(gamemasterId, playerId) {
  const sb = store.client;
  const { error } = await sb
    .from('gamemaster_players')
    .upsert(
      { gamemaster_id: gamemasterId, player_id: playerId, created_by: store.user.id },
      { onConflict: 'gamemaster_id,player_id', ignoreDuplicates: true }
    );
  if (error) return fail(error, 'gm-link');
  return { data: true, error: null };
}

export async function listGameMembers(gameId) {
  const sb = store.client;
  const { data, error } = await sb
    .from('game_members')
    .select('profile_id, role_in_game, is_player, joined_at, profile:profiles!game_members_profile_id_fkey(id,username,display_name,role,status)')
    .eq('game_id', gameId);
  if (error) return fail(error, 'game-members');
  return { data: data || [], error: null };
}

export async function loadAssignableGames() {
  const sb = store.client;
  const { data, error } = await sb.rpc('list_assignable_games');
  if (error) return fail(error, 'assignable-games');
  return { data: data || [], error: null };
}

/* ------------------------------------------------------------------ teams */

export async function listTeams(gameId) {
  const sb = store.client;
  const { data, error } = await sb
    .from('teams')
    .select('id,game_id,name,description,created_at, team_members(profile_id, profile:profiles!team_members_profile_id_fkey(id,username,display_name,role))')
    .eq('game_id', gameId)
    .order('name');
  if (error) return fail(error, 'teams');
  return { data: data || [], error: null };
}

export async function createTeam(gameId, name, description) {
  const sb = store.client;
  const { data, error } = await sb
    .from('teams')
    .insert({ game_id: gameId, name, description: description || null, created_by: store.user.id })
    .select()
    .maybeSingle();
  if (error) return fail(error, 'team-create');
  return { data, error: null };
}

/* ... other team functions remain unchanged ... */

/* ------------------------------------------------------------------ players */

export async function createPlayer({ username, displayName, gamemasterId }) {
  const sb = store.client;
  const payload = {
    username: username.trim(),
    display_name: displayName.trim(),
    role: 'player',
    created_by: gamemasterId,
  };
  const { data, error } = await sb.from('profiles').insert(payload).select().maybeSingle();
  if (error) return fail(error, 'player-create');
  return { data, error: null };
}