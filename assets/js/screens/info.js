/* ==========================================================================
   Info screen: who you are, what your role may do, tracking status,
   your full trip history (with GPX export) and app/setup details.
   ========================================================================== */

import { h, esc, toast, fmtDateTime, fmtTime, fmtDist, fmtDurClock, relTime, download } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import tracker from '../tracker.js';
import { ROLE_META, MATRIX } from '../authz.js';
import config from '../config.js';

export function renderInfo(ctx) {
  const wrap = h('div');

  /* --- who am I --- */
  const meCard = h('div.card');
  wrap.appendChild(meCard);
  const me = store.profile;
  meCard.appendChild(h('div.card-head', [h('h2', 'Account')]));
  meCard.appendChild(h('div', [
    ui.kv('Username', esc(me?.username || '–')),
    ui.kv('Display name', esc(me?.display_name || '–')),
    ui.kv('Role', esc(ROLE_META[store.role]?.label || store.role)),
    ui.kv('Sign-in email', h('span.tiny.mono', esc(me?.email || '–'))),
    ui.kv('Member since', fmtDateTime(me?.created_at)),
  ]));
  meCard.appendChild(h('p.tiny.muted', { style: { marginTop: '10px' } },
    ROLE_META[store.role]?.blurb || ''));
  meCard.appendChild(h('div.row', { style: { marginTop: '12px', flexWrap: 'wrap' } }, [
    h('button.btn-ghost', {
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Checking…';
        const { data, error } = await api.reloadProfile();
        btn.disabled = false;
        btn.textContent = 'Refresh my access';
        if (error) return toast(error.message, 'bad');
        // setProfile emits 'role' when it moved, which rebuilds the whole shell
        toast(`Your role is ${ROLE_META[data.role]?.label || data.role}`, 'good');
        ctx.rerender();
      },
    }, 'Refresh my access'),
    h('span.tiny.muted', 'Use this if your role was changed for you.'),
  ]));

  /* --- what my role can do --- */
  const permCard = h('div.card', [h('h3', 'Who can create what')]);
  const table = h('table.data', [
    h('thead', h('tr', [h('th', 'Role'), h('th', 'Can create'), h('th', 'Teams')])),
    h('tbody', MATRIX.map((r) => h('tr', {
      style: r.role === store.role ? { background: '#fff2e6' } : null,
    }, [
      h('td', { style: { fontWeight: '600' } }, ROLE_META[r.role].label),
      h('td.small', r.creates),
      h('td.small', r.teams),
    ]))),
  ]);
  permCard.appendChild(table);
  wrap.appendChild(permCard);

  /* --- tracking --- */
  const trackCard = h('div.card');
  wrap.appendChild(trackCard);
  const snap = tracker.snapshot();
  trackCard.appendChild(h('div.card-head', [h('h3', 'GPS tracking')]));
  trackCard.appendChild(h('div', [
    ui.kv('Status', snap.status),
    ui.kv('Points recorded locally', String(snap.windowSize)),
    ui.kv('Waiting to upload', String(snap.queued)),
    ui.kv('Uploaded this session', String(snap.pushed)),
    ui.kv('Last fix', snap.lastFix
      ? `${snap.lastFix.lat.toFixed(5)}, ${snap.lastFix.lon.toFixed(5)} ±${Math.round(snap.lastFix.accuracy || 0)} m`
      : '–'),
  ]));
  if (snap.lastError) trackCard.appendChild(h('div.tiny', { style: { color: '#b3261e', marginTop: '8px' } }, snap.lastError));

  trackCard.appendChild(h('div.row', { style: { marginTop: '14px', flexWrap: 'wrap' } }, [
    h('button.btn-ghost', {
      onclick: () => {
        if (tracker.active) { tracker.stop(); toast('Tracking paused'); }
        else { tracker.start({ gameId: store.game?.id, playerId: me.id }); toast('Tracking started', 'good'); }
        ctx.rerender();
      },
    }, tracker.active ? 'Pause tracking' : 'Start tracking'),
    h('button.btn-ghost', {
      onclick: async () => {
        const res = await tracker.flush({ force: true });
        toast(res.error ? res.error : `Uploaded ${res.pushed} points`, res.error ? 'bad' : 'good');
        ctx.rerender();
      },
    }, 'Upload now'),
    h('button.btn-ghost', {
      onclick: async () => {
        const { data } = await api.listTrackPoints({ playerId: me.id, limit: 5000 });
        if (!data?.length) return toast('No points recorded');
        const gpx = trackToGpx(data, me.username);
        download(`interchange-${me.username}.gpx`, gpx, 'application/gpx+xml');
        toast('GPX exported', 'good');
      },
    }, 'Export GPX'),
  ]));

  /* --- trips --- */
  const tripCard = h('div.card', [h('h3', 'My trips')]);
  const tripHost = h('div', ui.spinner('dark'));
  tripCard.appendChild(tripHost);
  wrap.appendChild(tripCard);

  (async () => {
    const { data } = await api.listMyBoardings(me.id, 100);
    tripHost.innerHTML = '';
    if (!data?.length) { tripHost.appendChild(ui.emptyState('No trips recorded yet.')); return; }
    const totalKm = data.reduce((a, b) => a + (b.distance_m || 0), 0) / 1000;
    const totalStops = data.reduce((a, b) => a + (b.stops_travelled || 0), 0);
    tripHost.appendChild(ui.statGrid([
      { value: data.length, label: 'trips' },
      { value: totalStops, label: 'stops' },
      { value: totalKm.toFixed(1), label: 'km' },
    ]));
    data.slice(0, 25).forEach((b) => {
      const v = b.vehicle || {};
      tripHost.appendChild(h('div.member', [
        ui.routeBadge({ route_short_name: v.route_short_name || '?', route_mode: v.route_mode || 'bus' }),
        h('div.m-name', [
          h('div', esc(v.route_long_name || v.headsign || 'Transit')),
          h('div.m-sub', `${fmtDateTime(b.board_at)} · ${b.stops_travelled ?? '?'} stops · ${fmtDist(b.distance_m)} · ${b.confidence}`),
        ]),
        h('span.tiny.muted', b.status),
      ]));
    });
  })();

  /* --- connection + app --- */
  const sysCard = h('div.card', [h('h3', 'Connection')]);
  sysCard.appendChild(h('div', [
    ui.kv('Supabase', h('span.tiny.mono.nowrap', esc(store.client?.url || 'not configured'))),
    ui.kv('Game', esc(store.game?.name || '–')),
    ui.kv('Transit feed', esc(store.agency ? `${store.agency.name}${store.agency.static_gtfs_url ? '' : ' (no GTFS url)'}` : '–')),
    ui.kv('Games available', String(store.games.length)),
  ]));

  const agency = store.agency;
  if (agency) {
    const sel = ui.selectInput(store.agencies.map((a) => ({ value: a.id, label: a.name })), { value: agency.id });
    sel.querySelector('select').addEventListener('change', (e) => {
      config.setAgency(e.target.value);
      store.setAgencies(store.agencies);
      toast('Transit feed switched');
      ctx.rerender();
    });
    sysCard.appendChild(ui.field('Active transit feed', sel, 'Only feeds you add here are used for matching.'));
  }

  if (store.games.length > 1) {
    const sel = ui.selectInput(store.games.map((g) => ({ value: g.id, label: g.name })), { value: store.game?.id || '' });
    sel.querySelector('select').addEventListener('change', (e) => {
      const g = store.games.find((x) => x.id === e.target.value);
      store.setGame(g);
      tracker.configure({ tracking_config: g?.tracking_config });
      toast(`Now playing ${g.name}`, 'good');
      ctx.onGameChange?.();
    });
    sysCard.appendChild(ui.field('Active game', sel));
  }

  sysCard.appendChild(h('div.row', { style: { marginTop: '14px', flexWrap: 'wrap' } }, [
    h('button.btn-ghost', {
      onclick: async () => {
        if (!('serviceWorker' in navigator)) return toast('No service worker support');
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update()));
        toast('Checked for updates', 'good');
      },
    }, 'Check for updates'),
    h('button.btn-danger', {
      onclick: async () => {
        await store.signOut();
        location.reload();
      },
    }, 'Sign out'),
  ]));

  sysCard.appendChild(h('p.tiny.muted', { style: { marginTop: '14px' } },
    'Interchange works offline once loaded: the app shell, your pending GPS points and the transit feed are all cached on this device.'));

  wrap.appendChild(sysCard);
  return wrap;
}

/* ------------------------------------------------------------ GPX export */

function trackToGpx(points, name) {
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Interchange" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name || 'rider')} track log</name><time>${new Date().toISOString()}</time></metadata>
  <trk><name>Interchange</name><trkseg>`;
  const body = points.map((p) => `    <trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.recorded_at).toISOString()}</time>${p.accuracy_m ? `<hdop>${(p.accuracy_m / 5).toFixed(1)}</hdop>` : ''}</trkpt>`).join('\n');
  return `${head}\n${body}\n  </trkseg></trk>\n</gpx>\n`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
