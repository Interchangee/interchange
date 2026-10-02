/* ==========================================================================
   App-wide store: supabase client, session, profile, active game.
   Kept deliberately small - it is the only mutable global state.
   ========================================================================== */

import { createClient } from './supabase-lite.js';
import config from './config.js';

let _client = null;
let _profile = null;
let _game = null;
let _games = [];
let _agencies = [];
const listeners = new Set();

export const store = {
  /* ---- client ---- */
  get client() {
    if (!_client && config.configured) _client = createClient(config.url, config.key);
    return _client;
  },
  rebuildClient() {
    _client = config.configured ? createClient(config.url, config.key) : null;
    return _client;
  },
  get configured() { return config.configured; },

  /* ---- session ---- */
  get session() { return this.client?.session || null; },
  get user() { return this.client?.user || null; },
  get isSignedIn() { return Boolean(this.client?.session?.access_token); },

  /* ---- profile ---- */
  get profile() { return _profile; },
  setProfile(p) { _profile = p; this.emit('profile'); },
  get role() { return _profile?.role || 'player'; },
  get isStaff() { return ['admin', 'manager', 'gamemaster'].includes(this.role); },
  get isOverseer() { return ['admin', 'manager'].includes(this.role); },
  can(what) {
    const r = this.role;
    switch (what) {
      case 'create:admin': return r === 'admin';
      case 'create:manager': return r === 'admin';
      case 'create:gamemaster': return r === 'admin' || r === 'manager';
      case 'create:player': return r !== 'player';
      case 'create:team': return r !== 'player';
      case 'manage:games': return r !== 'player';
      case 'manage:points': return r !== 'player';
      default: return false;
    }
  },

  /* ---- active game ---- */
  get game() { return _game; },
  get games() { return _games; },
  setGames(list) { _games = list || []; this.emit('games'); },
  setGame(g) {
    _game = g || null;
    config.setGame(_game?.id || '');
    this.emit('game');
  },

  /* ---- transit agencies ---- */
  get agencies() { return _agencies; },
  setAgencies(list) { _agencies = list || []; this.emit('agencies'); },
  get agency() {
    return _agencies.find((a) => a.id === config.agencyId) || _agencies[0] || null;
  },

  /* ---- events ---- */
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(what) { listeners.forEach((fn) => { try { fn(what); } catch (e) { console.error(e); } }); },

  /* ---- teardown ---- */
  async signOut() {
    await this.client?.signOut();
    _profile = null; _game = null; _games = []; _agencies = [];
    this.emit('signedout');
  },
};

export default store;
