/* ==========================================================================
   The top icon bar - reproduces the six icons from the reference design.
   Visible items depend on the signed-in role; the layout stays identical
   (equal columns, white icons on orange) so it always looks the same.
   ========================================================================== */

import { h } from './dom.js';
import { icon } from './ui.js';
import store from './store.js';

const ITEMS = [
  { route: 'home', icon: 'home', label: 'Home' },
  { route: 'create', icon: 'qr', label: 'Create players and teams', anyRole: true },
  { route: 'teams', icon: 'people', label: 'Teams' },
  { route: 'game', icon: 'person', label: 'Games and users' },
  { route: 'info', icon: 'checklist', label: 'My account and trips' },
  { route: 'about', icon: 'info', label: 'About', info: true },
];

export function visibleItems() {
  const role = store.role;
  const isOverseer = role === 'admin' || role === 'manager';
  if (isOverseer) return ITEMS;                 // full navigation
  if (role === 'gamemaster') {
    return ITEMS.filter((it) => it.route !== 'game');
  }
  // players: tracking + their own account only
  return ITEMS.filter((it) => it.route === 'home' || it.route === 'info' || it.info);
}

export function icbar({ onNavigate, onPoints }) {
  const bar = h('header.iconbar', { role: 'navigation' });
  visibleItems().forEach((item) => {
    bar.appendChild(h('button', {
      type: 'button',
      'data-route': item.route,
      title: item.label,
      'aria-label': item.label,
      onclick: () => (item.info ? showAbout() : onNavigate(item.route)),
    }, icon(item.icon, { size: 29 })));
  });
  return bar;
}

/* ------------------------------------------------------------------ about */

function showAbout() {
  import('./dom.js').then(({ openModal, esc }) => {
    const game = store.game;
    const row = (k, v) => h('div.kv', [h('div.k', k), h('div.v', esc(v))]);
    openModal({
      title: 'Interchange',
      body: h('div', [
        h('p', { style: { marginTop: 0 } },
          'An in-real-life transit game. The app records where you are with GPS, then uses OpenStreetMap (Overpass) to find the stop you are at and a free GTFS feed to work out which vehicle you are on.'),
        h('div', { style: { margin: '12px 0' } }, [
          row('Playing', game?.name || 'no game selected'),
          row('Role', store.role),
          row('Transit feed', store.agency?.name || 'none configured'),
          row('Live data', store.agency?.rt_vehicle_positions_url ? 'available' : 'timetable only'),
        ]),
        h('p.tiny.muted', 'Everything is stored in your own Supabase project. GPS points are uploaded in small batches and pruned automatically by the game\'s retention setting.'),
      ]),
      actions: [{ label: 'Close', value: null, kind: 'primary' }],
    });
  });
}

export default icbar;
