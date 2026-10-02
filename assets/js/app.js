/* ==========================================================================
   Interchange - application shell and router.

   Screens live in five <section> elements, switched by hash route. The top
   icon bar mirrors the reference design. Everything is plain ES modules.
   ========================================================================== */

import { h, clear, toast, fmtNum } from './dom.js';
import * as ui from './ui.js';
import store from './store.js';
import config from './config.js';
import * as api from './api.js';
import tracker from './tracker.js';
import { renderSetup, renderLogin } from './screens/auth.js';
import { renderHome } from './screens/home.js';
import { renderCreate } from './screens/create.js';
import { renderTeams } from './screens/teams.js';
import { renderGame } from './screens/game.js';
import { renderInfo } from './screens/info.js';
import { icbar } from './iconbar.js';

const ROUTES = ['home', 'create', 'teams', 'game', 'info'];

const ctx = {
  params: null,
  activeBoarding: null,
  timers: {},
  route: 'home',
  addTimer(key, id) { clearInterval(this.timers[key]); this.timers[key] = id; },
  clearTimers() { Object.values(this.timers).forEach((id) => clearInterval(id)); this.timers = {}; },
  go(route, params = null) {
    this.params = params;
    location.hash = `#/${route}`;
  },
  rerender() { render(); },
  setActiveBoarding(b) {
    this.activeBoarding = b;
    this.onRideChange?.();
  },
  async reloadGames() {
    const { data } = await api.loadMyGames();
    store.setGames(data || []);
    if (!store.game && store.games.length) store.setGame(store.games[0]);
    return store.games;
  },
  async reloadAgencies() {
    const { data } = await api.listAgencies();
    store.setAgencies(data || []);
    return store.agencies;
  },
  onGameChange() { render(); },
};

/* ------------------------------------------------------------------ boot */

async function boot() {
  const appEl = document.getElementById('app');
  const bootEl = document.getElementById('boot');
  const overlayEl = document.getElementById('boot-overlay');

  const showAuth = (node) => {
    bootEl?.remove();
    appEl.hidden = true;
    overlayEl.innerHTML = '';
    overlayEl.appendChild(node);
  };

  if (!config.configured) {
    showAuth(renderSetup(() => location.reload()));
    return;
  }

  const sb = store.client;

  try {
    if (!sb?.session) throw new Error('no session');
    const { data: auth } = await sb.getUser();
    if (!auth?.user) throw new Error('no user');
  } catch {
    showAuth(renderLogin());
    return;
  }

  /* signed in: load identity */
  const { data: profile, error } = await api.loadMyProfile();
  if (error || !profile) {
    showAuth(renderLogin());
    toast(error?.message || 'Could not load your profile', 'bad');
    return;
  }
  store.setProfile(profile);

  await Promise.all([ctx.reloadGames(), ctx.reloadAgencies()]);

  // restore an in-progress ride
  const { data: active } = await api.activeBoarding(profile.id);
  if (active) {
    ctx.activeBoarding = active;
    tracker.setBoarding(active.id);
    tracker.start({ gameId: active.game_id, playerId: profile.id });
  }

  tracker.configure({ tracking_config: store.game?.tracking_config });
  tracker.start({ gameId: store.game?.id, playerId: profile.id });

  bootEl?.remove();
  overlayEl.innerHTML = '';
  appEl.hidden = false;

  buildIconbar();
  window.addEventListener('hashchange', render);

  // A role change (promotion, demotion) changes which icons and screens exist,
  // so rebuild the shell rather than leaving a stale navigation behind.
  store.on((what) => {
    if (what !== 'role') return;
    buildIconbar();
    markIconbar();
    render();
    toast(`Your access changed: ${store.role}`, 'good');
  });

  if (!location.hash) location.hash = '#/home';
  render();
  startBackgroundJobs();
}

/* ---------------------------------------------------------------- routing */

function render() {
  const route = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'home');
  ctx.route = ROUTES.includes(route) ? route : 'home';
  ctx.clearTimers();
  ctx.onRideChange = null;

  ROUTES.forEach((r) => {
    const sec = document.getElementById(`screen-${r}`);
    if (sec) sec.classList.toggle('active', r === ctx.route);
  });
  markIconbar();

  const host = document.getElementById(`screen-${ctx.route}`);
  if (!host) return;
  clear(host);

  try {
    let node = null;
    switch (ctx.route) {
      case 'home': node = renderHome(ctx); break;
      case 'create': node = renderCreate(ctx); break;
      case 'teams': node = renderTeams(ctx); break;
      case 'game': node = renderGame(ctx); break;
      case 'info': node = renderInfo(ctx); break;
      default: node = renderHome(ctx);
    }
    host.appendChild(node);
  } catch (err) {
    console.error(err);
    host.appendChild(h('div.card', [
      h('h3', 'Something broke on this screen'),
      h('pre.tiny.mono', { style: { whiteSpace: 'pre-wrap', color: '#b3261e' } }, err.message),
      h('button.btn-primary', { onclick: () => render() }, 'Retry'),
    ]));
  }
}

/* -------------------------------------------------------------- icon bar */

function buildIconbar() {
  const existing = document.getElementById('interchange-iconbar');
  if (existing) existing.remove();
  const bar = icbar({
    onNavigate: (route) => ctx.go(route),
    onPoints: () => toast('Points live in your game screen and on the leaderboard.'),
  });
  bar.id = 'interchange-iconbar';
  document.body.insertBefore(bar, document.getElementById('app'));
}

function markIconbar() {
  document.querySelectorAll('#interchange-iconbar button[data-route]').forEach((b) => {
    if (b.dataset.route === ctx.route) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/* -------------------------------------------------------- background jobs */

function startBackgroundJobs() {
  // keep "last seen" fresh so gamemasters can see who is online
  setInterval(async () => {
    if (document.visibilityState !== 'visible' || !store.user) return;
    await store.client.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', store.user.id);
  }, 5 * 60_000);

  // flush queued GPS points when we come back to the foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tracker.flush().catch(() => {});
      if (ctx.route === 'home' && ctx.activeBoarding) render();
    }
  });

  // opportunistic flush if the browser regains connectivity
  window.addEventListener('online', () => { tracker.flush().catch(() => {}); });

  // live ride card refresh (nearest stop, distance) every 30 s while riding
  setInterval(() => {
    if (ctx.route !== 'home' || !ctx.activeBoarding) return;
  }, 30000);
}

/* ---------------------------------------------------------------- helpers */

window.addEventListener('error', (e) => console.error('[interchange]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[interchange] unhandled', e.reason));

boot();
