/* ==========================================================================
   Home screen: the big "I just got on / I'm getting off" control, live ride
   status, points and recent trips.
   ========================================================================== */

import { h, fmtNum, fmtDurClock, fmtTime, fmtDist, esc, toast, confirmDialog, relTime } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import tracker from '../tracker.js';
import * as api from '../api.js';
import { enterFlow, exitFlow } from './ride.js';

export function renderHome(ctx) {
  const wrap = h('div');
  const refresh = () => { const next = renderHome(ctx); wrap.replaceWith(next); };

  const game = store.game;
  const me = store.profile;

  wrap.appendChild(h('div.row', { style: { alignItems: 'flex-end', margin: '0 2px 14px' } }, [
    h('div', [
      h('div', { style: { color: '#fff', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '.8px', opacity: .95 } },
        game ? game.name : 'No game selected'),
      h('div', { style: { color: '#fff', fontSize: '24px', fontWeight: '800' } }, `Hi ${esc(me?.display_name || me?.username || 'rider')}`),
    ]),
    h('div.spacer'),
    store.games.length > 1
      ? h('button', { class: 'btn', style: { background: 'rgba(255,255,255,.2)', color: '#fff' }, onclick: () => ctx.go('info') }, 'Switch')
      : null,
  ]));

  /* ----- the toggle card ----- */
  const rideCard = h('div.card');
  wrap.appendChild(rideCard);

  const status = tracker.snapshot();

  async function drawRide() {
    rideCard.innerHTML = '';
    const active = ctx.activeBoarding;

    if (!active) {
      rideCard.appendChild(h('button.ride-toggle', {
        onclick: async () => {
          const res = await enterFlow(ctx);
          if (res) refresh();
        },
      }, [
        ui.icon('play', { size: 46 }),
        h('span.rt-main', 'I just got on'),
        h('span.rt-sub', 'Tap when you enter the bus, train, tram or ferry'),
      ]));

      rideCard.appendChild(h('div.row', { style: { marginTop: '14px' } }, [
        h('div', { class: 'small muted', style: { flex: 1 } },
          tracker.active
            ? (status.status === 'tracking' ? 'Location tracking is on.' : 'Waiting for a GPS fix…')
            : 'Tracking starts automatically when you tap.'),
        h('button.btn-ghost.small', {
          onclick: async () => {
            if (tracker.active) { tracker.stop(); toast('Tracking paused'); }
            else { tracker.start({ gameId: game?.id, playerId: me?.id }); toast('Tracking started'); }
            refresh();
          },
        }, tracker.active ? 'Pause GPS' : 'Track in background'),
      ]));
      return;
    }

    /* riding */
    const v = active.vehicle || {};
    const elapsed = Date.now() - new Date(active.board_at).getTime();
    const routeName = v.route_short_name || 'Transit';
    const conf = active.confidence || 'medium';

    rideCard.appendChild(h('div.row', { style: { alignItems: 'center', gap: '12px', marginBottom: '12px' } }, [
      h(`div.badge-route.mode-${v.route_mode || 'bus'}`, routeName),
      h('div', { style: { flex: 1, minWidth: 0 } }, [
        h('div', { style: { fontWeight: '700', fontSize: '17px' } }, esc(v.route_long_name || v.headsign || 'On board')),
        h('div.small.muted.nowrap', esc(`Boarded ${fmtTime(active.board_at)}${active.board_stop_name ? ' at ' + active.board_stop_name : ''}`)),
      ]),
      ui.pill(conf === 'realtime' ? 'LIVE' : conf.toUpperCase(), conf === 'realtime' ? 'live' : ''),
    ]));

    const stats = h('div.stat-grid', [
      h('div.stat', [h('b', { id: 'ride-elapsed' }, fmtDurClock(elapsed)), h('span', 'on board')]),
      h('div.stat', [h('b', { id: 'ride-stops' }, String(active.stops_travelled ?? '–')), h('span', 'stops')]),
      h('div.stat', [h('b', { id: 'ride-dist' }, fmtDist(active.distance_m)) , h('span', 'distance')]),
    ]);
    rideCard.appendChild(stats);
    rideCard.appendChild(h('div.tiny.muted', { id: 'ride-progress', style: { marginTop: '10px' } },
      `${status.queued ? status.queued + ' GPS points waiting to upload · ' : ''}${status.status === 'tracking' ? 'recording' : status.status}`));

    rideCard.appendChild(h('button.ride-toggle.riding', {
      style: { marginTop: '14px' },
      onclick: async () => {
        const ok = await confirmDialog('Getting off?', 'We will use your GPS and the timetable to work out where you got off.', 'Yes, I got off', 'primary');
        if (ok) { await exitFlow(ctx); refresh(); }
      },
    }, [
      ui.icon('stop', { size: 42 }),
      h('span.rt-main', 'I got off'),
      h('span.rt-sub', 'Tap when you leave the vehicle'),
    ]));

    rideCard.appendChild(h('div.row', { style: { marginTop: '12px' } }, [
      h('button.btn-ghost.small', {
        onclick: async () => {
          const ok = await confirmDialog('Discard this ride?', 'Nothing will be scored for it.', 'Discard', 'danger');
          if (!ok) return;
          await api.cancelBoarding(active.id, 'discarded by player');
          tracker.setBoarding(null);
          ctx.setActiveBoarding(null);
          toast('Ride discarded');
          refresh();
        },
      }, 'Discard ride'),
      h('div.spacer'),
      h('button.btn-ghost.small', { onclick: () => ctx.go('info') }, 'GPX / details'),
    ]));
  }

  drawRide();
  ctx.onRideChange = () => { refresh(); };

  // live ticking clock on the riding card
  ctx.addTimer('home-clock', setInterval(() => {
    const el = document.getElementById('ride-elapsed');
    if (!el || !ctx.activeBoarding) return;
    el.textContent = fmtDurClock(Date.now() - new Date(ctx.activeBoarding.board_at).getTime());
  }, 1000));

  /* ----- stats ----- */
  const statsCard = h('div.card');
  statsCard.appendChild(h('div.card-head', [h('h3', 'Your game')]));
  const statsHost = h('div', ui.spinner('dark'));
  statsCard.appendChild(statsHost);
  wrap.appendChild(statsCard);

  (async () => {
    if (!game) {
      statsHost.innerHTML = '';
      statsHost.appendChild(h('div.empty', 'No game yet. A gamemaster has to add you to one.'));
      return;
    }
    const [points, boardings] = await Promise.all([
      api.myPoints(game.id, me.id),
      api.listMyBoardings(me.id, 20),
    ]);
    statsHost.innerHTML = '';
    const list = boardings.data || [];
    const km = list.reduce((a, b) => a + (b.distance_m || 0), 0) / 1000;
    const stops = list.reduce((a, b) => a + (b.stops_travelled || 0), 0);
    statsHost.appendChild(ui.statGrid([
      { value: points.data?.total ?? 0, label: 'points' },
      { value: list.length, label: 'rides' },
      { value: km.toFixed(1), label: 'km' },
      { value: stops, label: 'stops' },
    ]));

    const recent = h('div', { style: { marginTop: '16px' } });
    recent.appendChild(h('div.small.muted', { style: { marginBottom: '8px' } }, 'Recent trips'));
    if (!list.length) recent.appendChild(ui.emptyState('No rides recorded yet.'));
    list.slice(0, 6).forEach((b) => {
      const v = b.vehicle || {};
      recent.appendChild(h('div.member', [
        h(`div.badge-route.mode-${v.route_mode || 'bus'}`, { style: { minWidth: '44px', fontSize: '14px' } }, v.route_short_name || '?'),
        h('div.m-name', [
          h('div', esc(v.route_long_name || v.headsign || 'Transit')),
          h('div.m-sub', `${fmtTime(b.board_at)} → ${b.alight_at ? fmtTime(b.alight_at) : '…'} · ${b.stops_travelled ?? '?'} stops · ${fmtDist(b.distance_m)}`),
        ]),
        h('span.small.muted', relTime(b.board_at)),
      ]));
    });
    statsHost.appendChild(recent);
  })();

  return wrap;
}
