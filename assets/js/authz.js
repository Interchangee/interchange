/* ========================================================================== 
   Client-side mirror of the SQL permission rules (supabase/migrations). 
   The database is the real gate; this exists so the UI never offers an action 
   that would be rejected. 
   ========================================================================== */ 

import store from './store.js';

export const ROLES = ['admin', 'manager', 'gamemaster', 'player'];

export const ROLE_META = {
  admin: { label: 'Admin', blurb: 'Everything: all users, all games, all teams.' },
  manager: { label: 'Manager', blurb: 'Creates gamemasters and players, runs the whole event.' },
  gamemaster: { label: 'Gamemaster', blurb: 'Runs their own game: teams, players, points.' },
  player: { label: 'Player', blurb: 'Rides transit, records trips, earns points.' },
};

/** Which roles the signed-in user may hand out. */
export function creatableRoles() {
  const r = store.role;
  if (r === 'admin') return ['admin', 'manager', 'gamemaster', 'player'];
  if (r === 'manager') return ['gamemaster', 'player'];
  if (r === 'gamemaster') return ['player'];
  return [];
}

export function canCreateRole(role) {
  return creatableRoles().includes(role);
}

export function canCreateUsers() {
  return creatableRoles().length > 0;
}

export function canCreateTeams() {
  return store.role !== 'player';
}

export function canManagePoints() {
  return store.role !== 'player';
}

/** Games this user may assign a new player to (mirrors list_assignable_games). */
export function assignableGames(allGames = store.games) {
  if (store.isOverseer) return allGames;
  if (store.role === 'gamemaster') {
    return allGames.filter((g) => g.gamemaster_id === store.user?.id || g.is_staff);
  }
  return allGames.filter((g) => g.is_staff);
}

/** Editing someone else's profile: admin/manager, or their own gamemaster. */
export function canEditProfile(profile) {
  if (!profile) return false;
  if (profile.id === store.user?.id) return true;
  if (store.isOverseer) return true;
  return store.role === 'gamemaster';
}

export function canSeeCredentials(profile) {
  if (!profile) return false;
  if (store.isOverseer) return true;
  return profile.created_by === store.user?.id;
}

/** Check if the user can create a new game (Max 3 games per gamemaster) */
export function canCreateGame() {
  if (!store.games) return true;
  const myGames = store.games.filter((g) => g.gamemaster_id === store.user?.id);
  return myGames.length < 3;
}

/** Check if a player can join a game (Max 3 games, all must be from the same gamemaster) */
export function canJoinGame(playerGames, targetGamemasterId) {
  if (!playerGames || playerGames.length === 0) return true;
  if (playerGames.length >= 3) return false;
  return playerGames.every((game) => game.gamemaster_id === targetGamemasterId);
}

/** A short explanation of who can create whom, for the Info screen. */
export const MATRIX = [
  { role: 'admin', creates: 'admins, managers, gamemasters, players', teams: 'any game', games: 'any' },
  { role: 'manager', creates: 'gamemasters, players', teams: 'any game', games: 'any' },
  { role: 'gamemaster', creates: 'players in their own game', teams: 'own game', games: 'own game' },
  { role: 'player', creates: 'nobody', teams: 'none', games: 'tracking only' },
];

export default {
  creatableRoles,
  canCreateRole,
  canCreateUsers,
  canCreateTeams,
  canManagePoints,
  assignableGames,
  canEditProfile,
  canSeeCredentials,
  canCreateGame,
  canJoinGame,
  ROLES,
  ROLE_META,
  MATRIX,
};