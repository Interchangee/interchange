/* ==========================================================================
   Interchange - runtime configuration.

   Nothing secret lives here. The anon (publishable) key is designed to be
   public: every table is protected by Row Level Security (see supabase/).

   Two ways to point the app at a project, in priority order:

     1. `npm run build` writes assets/js/config.local.js from the
        SUPABASE_URL / SUPABASE_ANON_KEY environment variables. That file is
        git-ignored and is what a hosted deployment uses.
     2. Otherwise leave it empty and use the in-app "Connect to Supabase"
        screen; those values are stored in the browser only.

   A value saved in the browser always wins over a baked-in default, so you
   can point one device at a staging project without rebuilding.
   ========================================================================== */

let local = null;
try {
  // absent unless `npm run build` generated it - both files are intentional
  local = (await import('./config.local.js')).default;
} catch {
  local = null;
}

export const BUILD = {
  supabaseUrl: local?.supabaseUrl || '',      // e.g. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: local?.supabaseAnonKey || '', // e.g. 'eyJhbGciOi...'
  appName: 'Interchange',
};

const LS = {
  url: 'ic.supabase.url',
  key: 'ic.supabase.key',
  game: 'ic.game.id',
  agency: 'ic.agency.id',
  setupDone: 'ic.setup.done',
};

function lsGet(k) {
  try { return localStorage.getItem(k) || ''; } catch { return ''; }
}
function lsSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {}
}

export const config = {
  get url() { return lsGet(LS.url) || BUILD.supabaseUrl; },
  get key() { return lsGet(LS.key) || BUILD.supabaseAnonKey; },
  get gameId() { return lsGet(LS.game); },
  get agencyId() { return lsGet(LS.agency); },
  get configured() { return Boolean(this.url && this.key); },
  /** true when the connection came from config.local.js rather than this browser */
  get bakedIn() { return Boolean(BUILD.supabaseUrl && BUILD.supabaseAnonKey); },

  save({ url, key }) {
    if (typeof url === 'string') lsSet(LS.url, url.trim().replace(/\/+$/, ''));
    if (typeof key === 'string') lsSet(LS.key, key.trim());
  },
  setGame(id) { lsSet(LS.game, id || ''); },
  setAgency(id) { lsSet(LS.agency, id || ''); },
  reset() {
    [LS.url, LS.key, LS.game, LS.agency, LS.setupDone].forEach((k) => lsSet(k, ''));
  },
};

export default config;
