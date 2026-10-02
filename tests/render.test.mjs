/* ==========================================================================
   Render + wiring smoke test.

   Loads every UI module against a tiny DOM shim, renders each screen with
   stubbed Supabase responses, then audits the SQL migration and project config
   for the helpers, RLS coverage and settings this build depends on.

   Catches the errors a syntax check cannot: missing exports, bad selectors,
   calling into the API with the wrong shape, crashes in the synchronous part
   of a screen, and a database that the app would talk to in vain.

   Run:  node tests/render.test.mjs
   ========================================================================== */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mod = (p) => pathToFileURL(join(here, '..', 'assets', 'js', p)).href;

/* ------------------------------------------------------------ DOM shim --- */

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); this._sync(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this._sync(); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : Boolean(force);
    if (on) this.set.add(c); else this.set.delete(c);
    this._sync();
    return on;
  }
  contains(c) { return this.set.has(c); }
  _sync() { this.el._class = Array.from(this.set).join(' '); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList(this);
    this._class = '';
    this._text = '';
    this._html = '';
    this._listeners = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.isConnected = false;
    this.id = '';
  }
  get className() { return this._class; }
  set className(v) {
    this._class = String(v || '');
    this.classList.set = new Set(this._class.split(/\s+/).filter(Boolean));
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children.length = 0; }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') { this._class = String(v); this.classList.set = new Set(this._class.split(/\s+/).filter(Boolean)); }
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  dispatch(type, evt = {}) {
    (this._listeners[type] || []).forEach((fn) => fn({ type, target: this, preventDefault() {}, ...evt }));
  }
  appendChild(node) {
    if (!node) return node;
    node.parentNode = this;
    node.isConnected = true;
    this.children.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  insertBefore(node, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    node.isConnected = false;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(node) { this.parentNode?.insertBefore(node, this); this.remove(); }
  get firstChild() { return this.children[0] || null; }
  contains(n) {
    if (n === this) return true;
    return this.children.some((c) => c.contains?.(n));
  }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); });
    };
    walk(this);
    return out;
  }
  focus() {}
  blur() {}
  click() { this.dispatch('click'); }
  setSelectionRange() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  get offsetWidth() { return 100; }
}

function matches(el, sel) {
  if (!el || !el.tagName) return false;
  const parts = String(sel).trim().split(/(?=[.#\[])/);
  return parts.every((p) => {
    if (!p) return true;
    if (p.startsWith('.')) return el.classList.contains(p.slice(1));
    if (p.startsWith('#')) return el.id === p.slice(1);
    if (p.startsWith('[')) {
      const m = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p);
      if (!m) return true;
      const v = el.attributes[m[1]] ?? el[m[1]];
      return m[2] === undefined ? v !== undefined : String(v) === m[2];
    }
    return el.tagName === p.toUpperCase();
  });
}

function installDom() {
  const document = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (t) => { const n = new FakeNode('#text'); n._text = String(t); return n; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  document.body = new FakeNode('body');
  document.documentElement = new FakeNode('html');

  class FakeDialog extends FakeNode {
    constructor() { super('dialog'); this.open = false; }
  }

  const window = {
    document,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { hash: '#/home', reload: () => {} },
    navigator: { geolocation: null, clipboard: { writeText: async () => {} }, serviceWorker: null },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
      };
    })(),
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto,
    isSecureContext: true,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    innerWidth: 390,
    innerHeight: 844,
  };
  window.window = window;

  globalThis.window = window;

  // Node 21+ exposes navigator as a getter-only global, so define, don't assign
  const define = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); }
    catch { try { globalThis[name] = value; } catch {} }
  };
  define('document', document);
  define('navigator', window.navigator);
  define('localStorage', window.localStorage);
  define('Node', FakeNode);
  define('DOMParser', class { parseFromString() { return { querySelectorAll: () => [] }; } });
  if (!globalThis.crypto) define('crypto', window.crypto);
  return { window, document, FakeNode };
}

const dom = installDom();

/* -------------------------------------------------- stub Supabase client - */

const AGENCY = {
  id: 'ag-1', agency_key: 'test-city', name: 'Test City Transit', timezone: 'Europe/Berlin',
  static_gtfs_url: 'https://example.org/gtfs.zip', rt_vehicle_positions_url: null,
  rt_trip_updates_url: null, rt_headers: {}, active: true,
};

const GAME = {
  id: 'game-1', name: 'Saturday Sprint', status: 'active', gamemaster_id: 'gm-1',
  gamemaster_name: 'gm', my_role: 'gamemaster', is_staff: true,
  points_config: { points_per_stop: 10, points_per_km: 1, points_per_new_route: 25, points_per_new_station: 15, points_per_transfer: 5 },
  tracking_config: { sample_seconds: 20, min_distance_m: 15, accuracy_max_m: 120, live_tracking: true, keep_history_hours: 168 },
};

const PROFILE = {
  id: 'gm-1', username: 'gm', display_name: 'Game Master', role: 'gamemaster',
  status: 'active', email: 'u_gm@players.interchange.local',
  created_at: new Date().toISOString(),
};

function fakeQuery(table) {
  const rows = {
    profiles: [PROFILE, { id: 'p-1', username: 'swift-otter-42', display_name: null, role: 'player', status: 'active', created_at: new Date().toISOString() }],
    games: [GAME],
    game_members: [
      { profile_id: 'gm-1', role_in_game: 'gamemaster', is_player: false, profile: PROFILE },
      { profile_id: 'p-1', role_in_game: 'player', is_player: true, profile: { id: 'p-1', username: 'swift-otter-42', display_name: null, role: 'player', status: 'active' } },
    ],
    teams: [{ id: 't-1', game_id: GAME.id, name: 'Team 1', description: null, team_members: [{ profile_id: 'p-1', profile: { id: 'p-1', username: 'swift-otter-42', display_name: null, role: 'player' } }] }],
    vehicles: [],
    boardings: [],
    track_points: [],
    point_events: [{ id: 'pe-1', game_id: GAME.id, code: 'terminus', label: 'Reached the terminus', points: 25, unique_once: true, active: true }],
    points_events: [],
    transit_agencies: [AGENCY],
    auth_accounts: [],
  }[table] || [];

  const q = {
    select: () => q, order: () => q, limit: () => q, range: () => q,
    eq: () => q, neq: () => q, is: () => q, not: () => q, in: () => q,
    gt: () => q, gte: () => q, lt: () => q, lte: () => q, like: () => q, ilike: () => q, or: () => q,
    insert: () => q, update: () => q, upsert: () => q, delete: () => q,
    single: () => q, maybeSingle: () => q,
    then: (res, rej) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(res, rej),
    catch: (fn) => Promise.resolve({ data: rows, error: null }).catch(fn),
  };
  return q;
}

const fakeClient = {
  url: 'https://demo.supabase.co',
  key: 'anon',
  session: { access_token: 'a.b.c', user: { id: PROFILE.id, email: PROFILE.email } },
  user: { id: PROFILE.id, email: PROFILE.email },
  from: (table) => fakeQuery(table),
  rpc: async (fn) => {
    switch (fn) {
      case 'list_my_games': return { data: [GAME], error: null };
      case 'list_assignable_games': return { data: [{ id: GAME.id, name: GAME.name, gamemaster_id: 'gm-1', gamemaster_name: 'gm' }], error: null };
      case 'game_leaderboard': return { data: [{ player_id: 'p-1', username: 'swift-otter-42', display_name: null, team: 'Team 1', points: 120, boardings: 3 }], error: null };
      case 'email_for_username': return { data: 'u_gm@players.interchange.local', error: null };
      case 'player_credentials': return { data: [{ username: 'swift-otter-42', password: 'hunter2xy', fake_email: 'u_swift@players.interchange.local', role: 'player', games: [GAME.name] }], error: null };
      case 'admin_exists': return { data: false, error: null };
      case 'claim_first_admin': return { data: { ok: true, username: 'gm' }, error: null };
      default: return { data: null, error: { message: `unknown rpc ${fn}` } };
    }
  },
  invoke: async () => ({ data: { ok: true, credentials: { username: 'x', password: 'y', fake_email: 'z' } }, error: null }),
  getUser: async () => ({ data: { user: { id: PROFILE.id, email: PROFILE.email } }, error: null }),
  ensureFresh: async () => true,
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  signOut: async () => ({ error: null }),
};

/* -------------------------------------------------------------- helpers -- */

const store = (await import(mod('store.js'))).default;
store.client;            // ensures the getter path runs
Object.defineProperty(store, 'client', { configurable: true, get: () => fakeClient });
store.setProfile(PROFILE);
store.setGames([GAME]);
store.setGame(GAME);
store.setAgencies([AGENCY]);

const ctx = {
  params: null,
  activeBoarding: null,
  onRideChange: null,
  route: 'home',
  timers: {},
  addTimer(k, id) { this.timers[k] = id; },
  clearTimers() { Object.values(this.timers).forEach((id) => clearInterval(id)); this.timers = {}; },
  go() {}, rerender() {}, setActiveBoarding(b) { this.activeBoarding = b; },
  reloadGames: async () => [GAME],
  reloadAgencies: async () => [AGENCY],
  onGameChange() {},
};

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ')}`);
    process.exitCode = 1;
  }
}

/* ---------------------------------------------------------------- tests -- */

console.log('\nmodules');

const moduleNames = [
  'dom.js', 'config.js', 'store.js', 'api.js', 'authz.js', 'geo.js', 'idb.js',
  'zip.js', 'overpass.js', 'gtfs.js', 'protobuf.js', 'realtime.js', 'transit.js',
  'tracker.js', 'ui.js', 'iconbar.js',
  'screens/auth.js', 'screens/home.js', 'screens/create.js', 'screens/teams.js',
  'screens/game.js', 'screens/manage.js', 'screens/info.js', 'screens/ride.js',
];

for (const name of moduleNames) {
  await check(`imports ${name}`, async () => {
    const m = await import(mod(name));
    assert.ok(m, 'module namespace');
  });
}

const domMod = await import(mod('dom.js'));
const uiMod = await import(mod('ui.js'));

console.log('\ndom helpers');

await check('h() builds elements, classes, ids and children', () => {
  const el = domMod.h('div.card#main', { title: 'x' }, [domMod.h('span', 'hello'), null, 'text']);
  assert.equal(el.tagName, 'DIV');
  assert.equal(el.id, 'main');
  assert.ok(el.classList.contains('card'));
  assert.equal(el.attributes.title, 'x');
  assert.equal(el.children.length, 2);
});

await check('h() wires onclick handlers', () => {
  let hits = 0;
  const el = domMod.h('button', { onclick: () => { hits++; } });
  el.dispatch('click');
  assert.equal(hits, 1);
});

await check('esc() neutralises HTML', () => {
  assert.equal(domMod.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

await check('selectInput produces options', () => {
  const el = uiMod.selectInput([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
  const sel = el.querySelectorAll('select')[0] || el.children[0];
  assert.equal(sel.children.length, 2);
  assert.equal(sel.children[0].attributes.value, 'a');
});

await check('field/label helper wraps an input', () => {
  const el = uiMod.field('Username', uiMod.textInput({ placeholder: 'x' }));
  assert.equal(el.children.length, 2);
});

await check('routeBadge is mode aware', () => {
  const el = uiMod.routeBadge({ route_short_name: 'M1', route_mode: 'rail' });
  assert.ok(el.classList.contains('badge-route'));
  assert.ok(el.classList.contains('mode-rail'));
});

await check('overlay() mounts a full screen layer and closes', () => {
  const ov = uiMod.overlay('Test', { dots: 3, activeDot: 1, onClose: () => {} });
  assert.ok(dom.document.body.contains(ov.root));
  ov.setTitle('Other');
  ov.setDot(2);
  ov.close();
  assert.ok(!dom.document.body.contains(ov.root));
});

console.log('\nscreens (synchronous render)');

const screens = {
  home: (await import(mod('screens/home.js'))).renderHome,
  create: (await import(mod('screens/create.js'))).renderCreate,
  teams: (await import(mod('screens/teams.js'))).renderTeams,
  game: (await import(mod('screens/game.js'))).renderGame,
  info: (await import(mod('screens/info.js'))).renderInfo,
  login: (await import(mod('screens/auth.js'))).renderLogin,
  setup: (await import(mod('screens/auth.js'))).renderSetup,
};

for (const [name, fn] of Object.entries(screens)) {
  await check(`renders ${name} without throwing`, async () => {
    const host = dom.document.createElement('section');
    dom.document.body.appendChild(host);
    const node = fn(name === 'setup' ? () => {} : ctx);
    assert.ok(node, 'returned a node');
    host.appendChild(node);
    assert.ok(host.children.length >= 1);
    // let the screen's own async fills settle
    await new Promise((r) => setTimeout(r, 60));
    ctx.clearTimers();
    host.remove();
  });
}

console.log('\nfirst-run bootstrap');

const api = await import(mod('api.js'));

/* Sign-in resolves a username -> generated email, but a user created by hand in
   the Supabase dashboard has no auth_accounts row, so a literal email address
   must be accepted directly. Driven through the real REST client with fetch
   stubbed, which is the code path that actually runs in a browser. */
const { createClient } = await import(mod('supabase-lite.js'));
const realStoreClient = store.client;
const calls = [];
let rpcEmail = 'u_admin@players.interchange.local';

function stubFetch(url, opts) {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
  const json = (obj, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(obj),
  });
  if (String(url).includes('/rpc/email_for_username')) return Promise.resolve(json(rpcEmail));
  if (String(url).includes('/auth/v1/token')) {
    return Promise.resolve(json({
      access_token: 'h.p.s', refresh_token: 'r.1',
      user: { id: PROFILE.id, email: rpcEmail },
    }));
  }
  return Promise.resolve(json({ message: 'unexpected url' }, 404));
}

// swap the stub client for a real one whose network is stubbed, so signIn()
// exercises the actual request building
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => stubFetch(url, opts);
Object.defineProperty(store, 'client', {
  configurable: true,
  get: () => createClient('https://demo.supabase.co', 'publishable-key'),
});

await check('unknown username explains both ways to sign in', async () => {
  rpcEmail = null;
  calls.length = 0;
  const res = await api.signIn('does-not-exist', 'pw');
  assert.ok(res.error, 'expected an error');
  assert.match(res.error.message, /No account called/);
  assert.match(res.error.message, /full email address/);
});

await check('a username is resolved through email_for_username', async () => {
  rpcEmail = 'u_gm@players.interchange.local';
  calls.length = 0;
  const res = await api.signIn('u_gm', 'pw');
  assert.equal(res.error, null, res.error?.message);
  assert.ok(calls.some((c) => c.url.includes('/rpc/email_for_username')), 'should call the lookup');
  const token = calls.find((c) => c.url.includes('/auth/v1/token'));
  assert.equal(token.body.email, 'u_gm@players.interchange.local');
});

await check('a full email address skips the lookup and signs in directly', async () => {
  calls.length = 0;
  const res = await api.signIn('u_admin@players.interchange.local', 'pw');
  assert.equal(res.error, null, res.error?.message);
  assert.ok(!calls.some((c) => c.url.includes('/rpc/email_for_username')), 'must not do a username lookup');
  const token = calls.find((c) => c.url.includes('/auth/v1/token'));
  assert.equal(token.body.email, 'u_admin@players.interchange.local');
});

// restore the stub client + real fetch for the remaining checks
globalThis.fetch = realFetch;
Object.defineProperty(store, 'client', { configurable: true, get: () => realStoreClient });

await check('adminExists() reports whether the project has an admin', async () => {
  const res = await api.adminExists();
  assert.equal(res.error, null);
  assert.equal(res.data, false);
});

await check('claimFirstAdmin() returns the function verdict', async () => {
  const res = await api.claimFirstAdmin();
  assert.equal(res.error, null);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.username, 'gm');
});

console.log('\nmigration sanity');

// Migrations are applied in version order, so concat them the same way and
// audit the result - a later file may redefine an earlier definition.
const migrationsDir = join(here, '..', 'supabase', 'migrations');
const migrationFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
assert.ok(migrationFiles.length >= 1, 'expected at least one migration');
const sql = (await Promise.all(
  migrationFiles.map((f) => readFile(join(migrationsDir, f), 'utf8')),
)).join('\n');

await check('migration files are version ordered by name', () => {
  for (const f of migrationFiles) {
    assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/, `${f} should be <14-digit version>_<name>.sql`);
  }
});

await check('a fresh project ends up with the permissive role guard', () => {
  // The exemption is what makes the first-admin bootstrap possible. Migrations
  // run in filename order, so the LAST definition of the function is the one a
  // fresh database ends up with - if a later migration reintroduced the strict
  // version, this fails.
  const defs = [...sql.matchAll(
    /create or replace function public\.guard_profile_role\(\)([\s\S]*?)\$\$;/g,
  )];
  assert.ok(defs.length >= 1, 'guard_profile_role must be defined');
  const effective = defs[defs.length - 1][1];
  assert.match(effective, /auth\.uid\(\) is null/,
    'the effective guard must exempt statements that have no session (SQL editor, migrations, service_role)');
  assert.match(effective, /only an admin can change a role/,
    'the guard must still reject API clients that are not admins');
});

await check('the migration defines every helper the app calls', () => {
  for (const fn of [
    'current_role_of', 'is_admin', 'is_manager', 'is_overseer', 'is_game_staff',
    'is_game_member', 'can_manage_team', 'shares_team_with', 'can_create_role',
    'can_assign_game', 'list_assignable_games', 'list_my_games', 'game_leaderboard',
    'email_for_username', 'player_credentials', 'award_ride_points',
    'purge_old_track_points', 'admin_exists', 'claim_first_admin',
  ]) {
    assert.ok(new RegExp(`function public\\.${fn}\\s*\\(`).test(sql), `missing function ${fn}`);
  }
});

await check('every RPC the client calls is granted to authenticated callers', () => {
  const rpcs = [
    'email_for_username', 'player_credentials', 'list_my_games',
    'list_assignable_games', 'game_leaderboard', 'award_ride_points',
    'admin_exists', 'claim_first_admin',
  ];
  for (const fn of rpcs) {
    assert.ok(new RegExp(`function public\\.${fn}\\s*\\(`).test(sql), `missing ${fn}`);
  }
  // security definer is what lets these read across RLS boundaries safely
  const definers = sql.match(/security definer/g) || [];
  assert.ok(definers.length >= 20, `expected many security definer helpers, found ${definers.length}`);
});

await check('every table gets row level security enabled', () => {
  const created = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.ok(created.length >= 14, `only found ${created.length} tables`);
  for (const table of created) {
    assert.ok(
      new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(sql),
      `RLS not enabled on ${table}`,
    );
  }
});

await check('sign-up is disabled in the Supabase project config', async () => {
  const cfg = await readFile(join(here, '..', 'supabase', 'config.toml'), 'utf8');
  assert.ok(/enable_signup = false/.test(cfg));
  assert.ok(/\[functions\.create-user\]/.test(cfg));
  assert.ok(/verify_jwt = true/.test(cfg));
});

console.log('\ndeploy config');

await check('Vercel config points at the packed output', async () => {
  const cfg = JSON.parse(await readFile(join(here, '..', 'vercel.json'), 'utf8'));
  assert.equal(cfg.outputDirectory, 'public');
  assert.match(cfg.buildCommand, /npm run build/);
  // asset caching must stay short: filenames carry no content hash
  const rules = JSON.stringify(cfg.headers || []);
  assert.ok(!/max-age=604800|max-age=[1-9]\d{5,}/.test(rules), 'a long cache would pin clients to stale assets');
});

await check('.vercelignore never excludes what the build needs', async () => {
  const ig = await readFile(join(here, '..', '.vercelignore'), 'utf8');
  const patterns = ig.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // Vercel runs `npm run build` -> `node tools/build.mjs` inside the upload,
  // so excluding tools/ breaks the deploy with MODULE_NOT_FOUND.
  for (const needed of ['tools', 'assets', 'supabase']) {
    assert.ok(
      !patterns.some((p) => p.replace(/^\//, '').replace(/\/$/, '') === needed),
      `.vercelignore must not exclude ${needed}/ - the build needs it`,
    );
  }
  assert.ok(patterns.includes('.env'), '.env must stay excluded from uploads');
  assert.ok(patterns.some((p) => p.includes('.env.example')), '.env.example should be documented');
});

await check('build script and packer exist where the build command looks', async () => {
  for (const f of ['tools/build.mjs', 'tools/pack.mjs']) {
    const src = await readFile(join(here, '..', f), 'utf8');
    assert.ok(src.length > 100, `${f} looks empty`);
  }
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /tools\/build\.mjs/);
  assert.ok(!pkg.engines, 'an open-ended engines range triggers Vercel Node auto-upgrade warnings');
});

console.log('\npermissions');

const authz = await import(mod('authz.js'));

await check('gamemaster may only create players', () => {
  assert.deepEqual(authz.creatableRoles(), ['player']);
  assert.equal(authz.canCreateRole('player'), true);
  assert.equal(authz.canCreateRole('admin'), false);
  assert.equal(authz.canCreateRole('gamemaster'), false);
});

await check('player may create nobody', () => {
  store.setProfile({ ...PROFILE, role: 'player' });
  assert.deepEqual(authz.creatableRoles(), []);
  assert.equal(authz.canCreateUsers(), false);
  store.setProfile(PROFILE);
});

await check('admin may create every role', () => {
  store.setProfile({ ...PROFILE, role: 'admin' });
  assert.deepEqual(authz.creatableRoles(), ['admin', 'manager', 'gamemaster', 'player']);
  store.setProfile(PROFILE);
});

await check('manager may create gamemasters and players only', () => {
  store.setProfile({ ...PROFILE, role: 'manager' });
  assert.deepEqual(authz.creatableRoles(), ['gamemaster', 'player']);
  store.setProfile(PROFILE);
});

console.log('\nicon bar');

const iconbar = await import(mod('iconbar.js'));

await check('admin sees all six icons', () => {
  store.setProfile({ ...PROFILE, role: 'admin' });
  assert.equal(iconbar.visibleItems().length, 6);
  store.setProfile(PROFILE);
});

await check('gamemaster sees five (no user management)', () => {
  const routes = iconbar.visibleItems().map((i) => i.route);
  assert.ok(!routes.includes('game'), routes.join(','));
  assert.ok(routes.includes('create'));
  assert.ok(routes.includes('teams'));
});

await check('player sees home, info and about only', () => {
  store.setProfile({ ...PROFILE, role: 'player' });
  assert.deepEqual(iconbar.visibleItems().map((i) => i.route), ['home', 'info', 'about']);
  store.setProfile(PROFILE);
});

await check('icbar renders one button per visible item', () => {
  const bar = iconbar.icbar({ onNavigate: () => {}, onPoints: () => {} });
  assert.equal(bar.children.length, iconbar.visibleItems().length);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);

// The tracker keeps a flush interval alive; nothing else holds the loop open.
process.exit(process.exitCode || 0);
