/* ==========================================================================
   The ride flow - the heart of the app.

   ENTER:  GPS fix -> Overpass stops near you -> GTFS departures + live
           vehicles -> ranked "you are probably on route 12 to Central"
           -> the rider confirms, or corrects from more options.

   EXIT:   GPS fix + recorded track -> GTFS shapes/stops -> where they got off,
           how many stops, how far -> points.
   ========================================================================== */

import { h, esc, toast, fmtTime, fmtDist, fmtDurClock } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import tracker from '../tracker.js';
import * as api from '../api.js';
import { suggestVehicles, resolveAlighting, liveProgress } from '../transit.js';
import { gps, haversine } from '../geo.js';

/* =========================================================== ENTER ======== */

export async function enterFlow(ctx) {
  const game = store.game;
  const me = store.profile;
  if (!game) { toast('You are not in a game yet.'); return false; }

  const ov = ui.overlay('Getting on', { onClose: () => { ov.close(); ctx.onRideChange?.(); }, dots: 4, activeDot: 0 });
  let track = [];
  let trackSub = null;
  let boardingStarted = false;

  // Start collecting GPS immediately - shape alignment needs a few samples.
  try {
    await tracker.start({ gameId: game.id, playerId: me.id });
    track = tracker.recent(900);
    trackSub = tracker.on(() => { track = tracker.recent(900); });
  } catch {}

  const cleanup = () => {
    trackSub?.();
    if (!boardingStarted) tracker.stop();
  };
  const originalClose = ov.close;
  ov.close = () => { cleanup(); originalClose(); };

  /* ---------------------------------------------------------------- step 1 */
  ov.setTitle('Finding your location');
  ov.body.appendChild(h('div.sheet', [
    h('div', { style: { textAlign: 'center', padding: '18px 0 6px' } }, [
      h('div', { id: 'fix-spin' }, ui.spinner('dark')),
      h('p', { id: 'fix-msg', style: { marginTop: '16px', color: '#4a4f57' } }, 'Waiting for a solid GPS fix…'),
      h('p.tiny.muted', 'Accuracy under about 100 m keeps the guess reliable.'),
    ]),
    h('div.row', { style: { justifyContent: 'center' } }, [
      h('button.btn-ghost', { id: 'fix-skip' }, 'Skip and pick manually'),
    ]),
  ]));

  const position = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    gps.getCurrent({ timeoutMs: 22000 })
      .then((p) => finish(p))
      .catch((err) => {
        const msg = document.getElementById('fix-msg');
        if (msg) msg.textContent = err.message + ' Retrying…';
        gps.getCurrent({ timeoutMs: 25000, maximumAge: 0 }).then(finish).catch(() => finish(null));
      });

    document.getElementById('fix-skip')?.addEventListener('click', () => {
      const msg = document.getElementById('fix-msg');
      if (msg) msg.textContent = 'Using your last known position…';
      const last = tracker.lastFix || track[track.length - 1];
      finish(last || null);
    });
  });

  if (!ov.root.isConnected) return false;

  if (!position) {
    ov.body.innerHTML = '';
    ov.setTitle('No location');
    ov.body.appendChild(h('div.sheet', [
      h('p', 'We could not get a GPS fix. Interchange needs your location to know which stop and vehicle you are at.'),
      h('div.tiny.muted', 'Check that location permission is allowed for this site, then try again.'),
      h('div.row', { style: { marginTop: '16px' } }, [
        h('button.btn-primary', { onclick: () => { ov.close(); enterFlow(ctx); } }, 'Try again'),
        h('button.btn-ghost', { onclick: () => ov.close() }, 'Cancel'),
      ]),
    ]));
    return false;
  }

  const accuracy = position.accuracy ? Math.round(position.accuracy) : null;

  /* ---------------------------------------------------------------- step 2 */
  ov.setDot(1);
  ov.setTitle('What are you on?');
  ov.body.innerHTML = '';
  const loadingHost = h('div.sheet', [
    h('div', { style: { textAlign: 'center', padding: '14px 0' } }, [
      ui.spinner('dark'),
      h('p', { id: 'match-msg', style: { marginTop: '14px', color: '#4a4f57' } }, 'Checking stops near you…'),
      h('p.tiny.muted', { id: 'match-sub' }, `GPS accuracy ±${accuracy ?? '?'} m · ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`),
    ]),
  ]);
  ov.body.appendChild(loadingHost);

  const agency = store.agency;
  const onProgress = ({ phase, message, pct }) => {
    const el = document.getElementById('match-msg');
    if (!el) return;
    const labels = {
      overpass: 'Looking up stops on OpenStreetMap…',
      schedule: 'Reading the timetable for those stops…',
      realtime: 'Asking for live vehicle positions…',
      download: `Downloading the GTFS feed… ${pct || 0}%`,
      stop_times: 'Building the timetable index (one time only)…',
      unzip: 'Unpacking the GTFS feed…',
      stops: 'Indexing stops…', routes: 'Indexing routes…', trips: 'Indexing trips…',
      calendar: 'Reading the service calendar…', shapes: 'Indexing route shapes…',
    };
    el.textContent = message || labels[phase] || 'Working…';
  };

  const result = await suggestVehicles({
    position, agency, track,
    radius: 350,
    windowMin: 25,
    onProgress,
  }).catch((err) => ({ candidates: [], nearbyStops: [], warnings: [err.message], best: null, confidence: 'low' }));

  if (!ov.root.isConnected) return false;

  let view = 'list';

  const redrawList = () => {
    ov.body.innerHTML = '';
    ov.body.appendChild(buildCandidateSheet(result, {
      position,
      onPick: (c) => startRide(c, { position, agency }),
      onRescan: () => { ov.close(); enterFlow(ctx); },
      onManualStop: () => { view = 'stops'; redrawStops(); },
      onSearch: () => { view = 'search'; redrawSearch(); },
      onSkip: () => startRide(null, { position, agency, manual: true }),
    }));
  };

  const redrawStops = () => {
    ov.body.innerHTML = '';
    const stops = result.nearbyStops.length ? result.nearbyStops : (result.gtfsStops || []);
    const sheet = h('div.sheet', [
      h('h3', { style: { marginTop: 0 } }, 'Which stop are you at?'),
      h('p.small.muted', 'We will then list what departs from there.'),
      ...stops.map((s) => h('button.opt', {
        onclick: () => {
          const filtered = { ...result, candidates: (result.candidates || []).filter((c) => c.stop_name === s.name) };
          ov.body.innerHTML = '';
          ov.body.appendChild(buildCandidateSheet(filtered, {
            position, onPick: (c) => startRide(c, { position, agency }),
            onRescan: () => { ov.close(); enterFlow(ctx); },
            onManualStop: () => redrawStops(),
            onSearch: () => redrawSearch(),
            onSkip: () => startRide(null, { position, agency, manual: true }),
            forcedStop: s,
          }));
        },
      }, [
        ui.icon('pin', { size: 22 }),
        h('div.opt-main', [
          h('div.opt-title', esc(s.name || 'Unnamed stop')),
          h('div.opt-sub', `${Math.round(s.distance_m || haversine(position, s))} m away${s.modes?.length ? ' · ' + s.modes.join(', ') : ''}`),
        ]),
      ])),
      h('button.btn-ghost.btn-block', { style: { marginTop: '12px' }, onclick: () => redrawList() }, 'Back'),
    ]);
    ov.body.appendChild(sheet);
  };

  const redrawSearch = () => {
    ov.body.innerHTML = '';
    const input = h('input', { type: 'search', placeholder: 'Route number or name, e.g. 12 or Airport', autofocus: true });
    const results = h('div');
    const sheet = h('div.sheet', [
      h('h3', { style: { marginTop: 0 } }, 'Type the route'),
      input,
      h('div', { style: { marginTop: '12px' } }, results),
      h('button.btn-ghost.btn-block', { onclick: () => redrawList() }, 'Back'),
    ]);
    ov.body.appendChild(sheet);

    const all = result.candidates || [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      results.innerHTML = '';
      const matches = q
        ? all.filter((c) => `${c.route_short_name} ${c.route_long_name || ''} ${c.headsign || ''}`.toLowerCase().includes(q))
        : all.slice(0, 8);
      if (!matches.length) {
        results.appendChild(h('div.empty', q
          ? 'Not in the current suggestions.'
          : 'Start typing to search the nearby routes.'));
        if (q) results.appendChild(h('button.btn-ghost.btn-block', {
          onclick: () => startRide({ route_short_name: input.value.trim(), route_mode: 'bus', source: 'manual' },
            { position, agency, manual: true }),
        }, `Record it as "${esc(input.value.trim())}" anyway`));
        return;
      }
      matches.forEach((c) => results.appendChild(candidateRow(c, () => startRide(c, { position, agency }))));
    };
    input.addEventListener('input', draw);
    draw();
  };

  /* ---------------------------------------------------------------- step 3 */
  async function startRide(candidate, { position: pos, agency: ag, manual = false }) {
    ov.setDot(2);
    ov.setTitle('Saving your ride');
    ov.body.innerHTML = '';
    ov.body.appendChild(h('div.sheet', [
      h('div', { style: { textAlign: 'center', padding: '14px 0' } }, [
        ui.spinner('dark'),
        h('p', { style: { marginTop: '14px', color: '#4a4f57' } }, 'Registering the vehicle and starting GPS tracking…'),
      ]),
    ]));

    const c = candidate || {};
    let vehicleId = null;
    try {
      const veh = await api.findOrCreateVehicle({
        agency_id: ag?.id || null,
        game_id: game.id,
        source: c.source === 'realtime' ? 'realtime' : c.source === 'manual' ? 'manual' : 'schedule',
        route_id: c.route_id || null,
        route_short_name: c.route_short_name || null,
        route_long_name: c.route_long_name || null,
        route_mode: c.route_mode || 'bus',
        route_color: c.route_color || null,
        headsign: c.headsign || null,
        direction_id: c.direction_id ?? null,
        trip_id: c.trip_id || null,
        vehicle_id: c.vehicle_id || null,
        label: c.vehicle_label || null,
      });
      if (veh.error) toast('Vehicle could not be saved: ' + veh.error.message, 'bad');
      vehicleId = veh.data?.id || null;
    } catch (err) {
      toast('Offline: the ride will be recorded without the vehicle.', 'bad');
    }

    const teamId = store.game?.team_id || null;
    const bo = await api.startBoarding({
      gameId: game.id,
      playerId: me.id,
      vehicle: vehicleId ? { id: vehicleId, stop_id: c.stop_id || null, stop_name: c.stop_name || null } : { stop_id: c.stop_id, stop_name: c.stop_name },
      teamId,
      position: pos,
      confidence: manual ? 'manual' : (result.confidence || 'medium'),
      source: c.source === 'realtime' ? 'realtime' : c.source === 'manual' ? 'manual' : 'schedule',
      guess: result.best ? {
        route: result.best.route_short_name, headsign: result.best.headsign,
        score: result.best.score, reasons: result.best.reasons,
        options: (result.candidates || []).slice(0, 6).map((x) => ({ route: x.route_short_name, headsign: x.headsign, score: x.score, source: x.source })),
      } : null,
      extra: { picked: { route: c.route_short_name || null, headsign: c.headsign || null, source: c.source || 'manual', trip_id: c.trip_id || null } },
    });

    if (bo.error) {
      toast('Could not start the ride: ' + bo.error.message, 'bad');
      ov.body.innerHTML = '';
      ov.body.appendChild(h('div.sheet', [
        h('p', 'Something went wrong saving the ride.'),
        h('pre.tiny.mono', { style: { whiteSpace: 'pre-wrap', color: '#b3261e' } }, bo.error.message),
        h('button.btn-primary.btn-block', { onclick: () => { ov.close(); enterFlow(ctx); } }, 'Try again'),
      ]));
      return;
    }

    boardingStarted = true;
    tracker.setBoarding(bo.data.id);
    ctx.setActiveBoarding({ ...bo.data, vehicle: candidate ? {
      route_short_name: c.route_short_name, route_long_name: c.route_long_name,
      headsign: c.headsign, route_mode: c.route_mode, route_id: c.route_id,
    } : null });

    /* -------------------------------------------------------------- step 4 */
    ov.setDot(3);
    ov.setTitle('On board');
    ov.body.innerHTML = '';
    ov.body.appendChild(h('div.sheet', [
      h('div', { style: { textAlign: 'center', padding: '8px 0 4px' } }, [
        ui.icon('check', { size: 54, cls: 'ok' }),
        h('h3', { style: { margin: '10px 0 4px' } }, c.route_short_name ? `You are on ${esc(c.route_short_name)}` : 'Ride started'),
        c.headsign ? h('p.muted', { style: { margin: 0 } }, `towards ${esc(c.headsign)}`) : null,
        h('p.tiny.muted', { style: { marginTop: '10px' } },
          `${result.confidence === 'realtime' ? 'Confirmed by live vehicle data.' : result.confidence === 'high' ? 'Strong match from the timetable and your GPS.' : 'Best guess from the timetable - correct it any time.'}`),
      ]),
      h('div', { style: { marginTop: '16px' } }, [
        ui.kv('Boarded at', esc(c.stop_name || 'unknown stop')),
        ui.kv('Time', fmtTime(new Date())),
        ui.kv('GPS accuracy', accuracy ? `±${accuracy} m` : 'unknown'),
      ]),
      h('button.btn-primary.btn-block.btn-lg', {
        style: { marginTop: '16px' },
        onclick: () => { ov.close(); toast('Tracking. Tap "I got off" when you leave.', 'good'); ctx.onRideChange?.(); },
      }, 'Start riding'),
    ]));
  }

  /* ------------------------------------------------------------- dispatch */
  if (!result.candidates?.length) {
    ov.body.innerHTML = '';
    ov.body.appendChild(h('div.sheet', [
      h('h3', { style: { marginTop: 0 } }, 'No service found near you'),
      h('p.small.muted', result.warnings?.length
        ? result.warnings.join(' ')
        : 'Nothing in the timetable departs from a stop close to your position right now.'),
      h('div.row', { style: { marginTop: '14px', flexWrap: 'wrap' } }, [
        h('button.btn-primary', { onclick: () => { ov.close(); enterFlow(ctx); } }, 'Scan again'),
        h('button.btn-ghost', { onclick: () => redrawStops() }, 'Pick a stop'),
        h('button.btn-ghost', { onclick: () => redrawSearch() }, 'Type the route'),
      ]),
      h('button.btn-ghost.btn-block', { style: { marginTop: '10px' }, onclick: () => startRide(null, { position, agency, manual: true }) },
        'Just record that I am riding (no route)'),
    ]));
  } else if (result.confidence === 'low' || result.candidates[0].score < 40) {
    redrawSearch();
  } else {
    redrawList();
  }

  return true;
}

/* --------------------------------------------------------------- helpers */

function candidateRow(c, onPick) {
  const conf = c.realtime ? 'high' : c.score >= 70 ? 'high' : c.score >= 45 ? 'medium' : 'low';
  const eta = Number.isFinite(c.eta_sec)
    ? (c.eta_sec <= 0 ? `left ${Math.max(1, Math.round(-c.eta_sec / 60))} min ago` : `in ${Math.max(1, Math.round(c.eta_sec / 60))} min`)
    : (c.observed_at ? 'live now' : 'no timetable');
  return h('button.opt', { onclick: onPick }, [
    ui.routeBadge(c),
    h('div.opt-main', [
      h('div.opt-title.nowrap', esc(c.route_long_name || c.headsign || `${c.route_short_name || 'Transit'}`)),
      h('div.opt-sub.nowrap', [
        c.headsign ? `→ ${esc(c.headsign)}` : (c.route_mode_label || 'Transit'),
        c.stop_name ? ` · ${esc(c.stop_name)}` : '',
        ` · ${eta}`,
      ].join('')),
      c.reasons?.length ? h('div.tiny.muted.nowrap', c.reasons.slice(0, 2).join(' · ')) : null,
    ]),
    h('div', { style: { textAlign: 'right' } }, [
      h(`div.conf.${conf}`, conf === 'high' ? 'likely' : conf === 'medium' ? 'maybe' : 'guess'),
      c.stop_distance_m !== null && c.stop_distance_m !== undefined
        ? h('div.tiny.muted', `${Math.round(c.stop_distance_m)} m`)
        : null,
    ]),
  ]);
}

function buildCandidateSheet(result, handlers) {
  const { position, onPick, onRescan, onManualStop, onSearch, onSkip, forcedStop } = handlers;
  const sheet = h('div.sheet');

  const best = result.candidates?.[0];
  sheet.appendChild(h('div', { style: { marginBottom: '14px' } }, [
    h('div', { style: { fontSize: '20px', fontWeight: '700' } },
      forcedStop ? `Departures at ${esc(forcedStop.name)}`
        : best ? `Are you on ${esc(best.route_short_name)}?` : 'What are you on?'),
    h('div.small.muted', { style: { marginTop: '4px' } },
      result.confidence === 'realtime'
        ? 'Live vehicle data says this is the closest one to you.'
        : result.confidence === 'high'
          ? 'This matches the timetable and your position.'
          : 'These are the closest options by timetable and distance.'),
  ]));

  (result.candidates || []).slice(0, 10).forEach((c) => sheet.appendChild(candidateRow(c, () => onPick(c))));

  if (!result.candidates?.length) {
    sheet.appendChild(h('div.empty', 'Nothing found for that stop.'));
  }

  if (result.warnings?.length) {
    sheet.appendChild(h('div.tiny.muted', { style: { marginTop: '6px', background: '#fff4e5', color: '#b26a00', padding: '10px', borderRadius: '8px' } },
      result.warnings.slice(0, 2).join(' ')));
  }

  sheet.appendChild(h('div', { style: { marginTop: '16px', borderTop: '1px solid #e9eaed', paddingTop: '14px' } }, [
    h('div.small.muted', { style: { marginBottom: '10px' } }, 'None of these?'),
    h('div.row', { style: { flexWrap: 'wrap' } }, [
      h('button.btn-ghost', { onclick: onManualStop }, 'Pick a stop'),
      h('button.btn-ghost', { onclick: onSearch }, 'Type the route'),
      h('button.btn-ghost', { onclick: onRescan }, 'Scan again'),
    ]),
    h('button.btn-ghost.btn-block', { style: { marginTop: '10px' }, onclick: onSkip }, 'Record a ride with no route'),
  ]));

  const meta = result.meta || {};
  const bits = [];
  if (meta.overpass) bits.push(`${meta.overpass.count ?? 0} stops from OpenStreetMap`);
  if (meta.gtfs) bits.push(meta.gtfs.ok ? `GTFS ${meta.gtfs.cached ? 'from device cache' : 'downloaded'}` : 'GTFS unavailable');
  if (meta.realtime) bits.push(`${meta.realtime.count ?? 0} live vehicles`);
  sheet.appendChild(h('div.tiny.muted', { style: { marginTop: '12px' } }, bits.join(' · ')));

  return sheet;
}

/* ============================================================ EXIT ======== */

export async function exitFlow(ctx) {
  const active = ctx.activeBoarding || (await api.activeBoarding(store.profile.id)).data;
  if (!active) { toast('You are not on a ride.'); return false; }

  const ov = ui.overlay('Getting off', { onClose: () => { ov.close(); ctx.onRideChange?.(); }, dots: 3, activeDot: 0 });
  ov.body.appendChild(h('div.sheet', [
    h('div', { style: { textAlign: 'center', padding: '18px 0' } }, [
      ui.spinner('dark'),
      h('p', { id: 'exit-msg', style: { marginTop: '14px', color: '#4a4f57' } }, 'Saving your track and finding where you got off…'),
    ]),
  ]));

  const setMsg = (t) => { const el = document.getElementById('exit-msg'); if (el) el.textContent = t; };

  await tracker.flush().catch(() => {});
  setMsg('Taking a final GPS fix…');
  let position = null;
  try { position = await gps.getCurrent({ timeoutMs: 15000 }); } catch {}
  if (!position) {
    const last = tracker.lastFix || tracker.recent(3600).slice(-1)[0];
    position = last ? { lat: last.lat, lon: last.lon, accuracy: last.accuracy_m ?? null } : null;
  }

  const track = tracker.trackSince(active.board_at);
  const agency = store.agency;

  setMsg('Matching the timetable…');
  let bundle = null;
  try {
    const gtfsModule = await import('../transit.js');
    const b = await gtfsModule.ensureBundle(agency);
    bundle = b.bundle;
  } catch {}

  const resolved = resolveAlighting({
    bundle,
    tripId: active.vehicle?.trip_id || active.confirmed_payload?.picked?.trip_id || null,
    boarding: active,
    position: position || { lat: active.board_lat, lon: active.board_lon },
    track,
  });

  setMsg('Saving…');
  const endRes = await api.endBoarding(active.id, {
    position,
    stop: resolved.stop ? { stop_id: resolved.stop.stop_id, stop_name: resolved.stop.name } : null,
    stopsTravelled: resolved.stops_travelled,
    distanceM: resolved.distance_m,
    resolvedBy: resolved.method,
  });
  if (endRes.error) toast('Could not save the exit: ' + endRes.error.message, 'bad');

  await tracker.flush().catch(() => {});
  tracker.setBoarding(null);
  ctx.setActiveBoarding(null);

  let awarded = 0;
  const pts = await api.awardRidePoints(active.id);
  if (!pts.error) awarded = Number(pts.data || 0);

  ov.setDot(2);
  ov.setTitle('Ride complete');
  ov.body.innerHTML = '';
  const duration = Date.now() - new Date(active.board_at).getTime();
  ov.body.appendChild(h('div.sheet', [
    h('div', { style: { textAlign: 'center', padding: '6px 0 2px' } }, [
      ui.icon('check', { size: 54 }),
      h('h3', { style: { margin: '10px 0 2px' } }, awarded > 0 ? `+${awarded} points` : 'Ride recorded'),
      h('p.muted', { style: { margin: 0 } }, active.vehicle?.route_short_name
        ? `${esc(active.vehicle.route_short_name)}${active.vehicle.headsign ? ' → ' + esc(active.vehicle.headsign) : ''}`
        : 'Transit ride'),
    ]),
    h('div', { style: { marginTop: '16px' } }, [
      ui.kv('Boarded', `${fmtTime(active.board_at)}${active.board_stop_name ? ' · ' + esc(active.board_stop_name) : ''}`),
      ui.kv('Got off', `${fmtTime(new Date())}${resolved.stop?.name ? ' · ' + esc(resolved.stop.name) : ''}`),
      ui.kv('Duration', fmtDurClock(duration)),
      ui.kv('Stops', resolved.stops_travelled ?? '–'),
      ui.kv('Distance', fmtDist(resolved.distance_m)),
      ui.kv('Worked out by', resolved.method === 'shape-progress' ? 'route shape + GPS'
        : resolved.method === 'nearest-gtfs-stop' ? 'nearest stop' : 'GPS track'),
    ]),
    resolved.stop ? null : h('div.tiny.muted', { style: { marginTop: '10px' } },
      'No stop matched your final position, so only the GPS distance was scored.'),
    h('button.btn-primary.btn-block.btn-lg', {
      style: { marginTop: '16px' },
      onclick: () => { ov.close(); ctx.onRideChange?.(); },
    }, 'Done'),
  ]));

  return true;
}

/* -------------------------------------------------- live progress (home) */

export async function refreshLiveProgress(boarding) {
  if (!boarding) return null;
  const agency = store.agency;
  const { bundle } = await import('../transit.js').then((m) => m.ensureBundle(agency)).catch(() => ({ bundle: null }));
  if (!bundle) return null;
  const pos = tracker.lastFix;
  if (!pos) return null;
  return liveProgress({
    bundle,
    tripId: boarding.vehicle?.trip_id || boarding.confirmed_payload?.picked?.trip_id,
    position: pos,
  });
}
