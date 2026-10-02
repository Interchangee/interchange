/* ==========================================================================
   Manage (admins + managers): all users, roles, credentials, games,
   transit agencies / GTFS feeds, and app settings.
   ========================================================================== */

import { h, esc, toast, confirmDialog, openModal, fmtDateTime, relTime } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import { ROLE_META, creatableRoles, canSeeCredentials } from '../authz.js';
import { bundleMeta, ensureBundle } from '../transit.js';
import { randomUsername, randomPassword } from './create.js';

export function renderManage(ctx) {
  const wrap = h('div');
  const card = h('div.card');
  wrap.appendChild(card);

  let tab = 'users';
  let search = '';

  async function render() {
    card.innerHTML = '';
    card.appendChild(h('div.card-head', [h('h2', store.isOverseer ? 'Manage' : 'Organise')]));

    if (!store.isStaff) {
      card.appendChild(ui.emptyState('Players cannot manage users or games.'));
      return;
    }

    const tabs = [['users', 'Users'], ['games', 'Games']];
    if (store.isOverseer) tabs.push(['transit', 'Transit feeds'], ['settings', 'Settings']);
    card.appendChild(h('div.tabs', tabs.map(([k, label]) => h('button', {
      'aria-selected': tab === k ? 'true' : 'false',
      onclick: () => { tab = k; render(); },
    }, label))));

    if (tab === 'users') drawUsers();
    else if (tab === 'games') drawGames();
    else if (tab === 'transit') drawTransit();
    else drawSettings();
  }

  /* -------------------------------------------------------------- users */
  async function drawUsers() {
    const host = h('div', [h('div', { style: { padding: '16px 0' } }, ui.spinner('dark'))]);
    card.appendChild(host);

    const searchInput = ui.textInput({ value: search, placeholder: 'Search usernames…' });
    searchInput.addEventListener('input', () => {
      search = searchInput.value;
      clearTimeout(searchInput._t);
      searchInput._t = setTimeout(load, 300);
    });

    const listHost = h('div');
    async function load() {
      listHost.innerHTML = '';
      listHost.appendChild(h('div', { style: { padding: '14px 0' } }, ui.spinner('dark')));
      const { data, error } = await api.listProfiles({ search: search || undefined, limit: 300 });
      listHost.innerHTML = '';
      if (error) { listHost.appendChild(ui.emptyState(error.message)); return; }

      const byRole = { admin: [], manager: [], gamemaster: [], player: [] };
      (data || []).forEach((p) => (byRole[p.role] || byRole.player).push(p));

      Object.entries(byRole).forEach(([role, people]) => {
        if (!people.length) return;
        listHost.appendChild(h('div.small.muted', { style: { margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.6px' } },
          `${ROLE_META[role].label}s (${people.length})`));
        people.forEach((p) => {
          listHost.appendChild(h('div.member', [
            h('div.m-name', [
              h('div', { style: { fontWeight: '600' } }, esc(p.display_name || p.username)),
              h('div.m-sub', [p.username, p.status !== 'active' ? p.status : null,
                p.last_seen_at ? `seen ${relTime(p.last_seen_at)}` : 'never signed in'].filter(Boolean).join(' · ')),
            ]),
            canSeeCredentials(p) ? ui.iconButton('download', () => showCreds(p), { title: 'Login details', cls: 'sm' }) : null,
            store.isOverseer ? ui.iconButton('star', () => changeRole(p), { title: 'Change role', cls: 'sm' }) : null,
            store.isOverseer ? ui.iconButton('trash', () => suspend(p), { title: 'Suspend', cls: 'sm' }) : null,
          ]));
        });
      });

      if (!data?.length) listHost.appendChild(ui.emptyState('No users match.'));
    }

    host.innerHTML = '';
    host.appendChild(searchInput);
    host.appendChild(listHost);

    if (creatableRoles().length) {
      host.appendChild(h('button.btn-primary.btn-block', {
        style: { marginTop: '16px' },
        onclick: () => ctx.go('create', { tab: 'player' }),
      }, 'Create a user'));
    }
    await load();
  }

  async function showCreds(p) {
    const { data, error } = await api.credentialsFor(p.id);
    if (error) return toast(error.message, 'bad');
    await openModal({
      title: p.username,
      body: h('div', [
        h('div.tile.mono', [
          h('div', `username: ${esc(data?.username || p.username)}`),
          h('div', `password: ${esc(data?.password || '(not stored)')}`),
          h('div', { style: { marginTop: '6px' } }, `email: ${esc(data?.fake_email || '–')}`),
          h('div', { style: { marginTop: '6px' } }, `role: ${esc(data?.role || p.role)}`),
          data?.games?.length ? h('div', { style: { marginTop: '6px' } }, `games: ${esc(data.games.join(', '))}`) : null,
        ]),
        h('p.tiny.muted', { style: { marginTop: '10px' } },
          'The player signs in with the username, not the email.'),
      ]),
      actions: [{
        label: 'Copy', value: 'copy',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(`username: ${data?.username}\npassword: ${data?.password}`);
            toast('Copied', 'good');
          } catch { toast('Copy failed', 'bad'); }
          return null; // keep the dialog open
        },
      }, { label: 'Close', value: null, kind: 'primary' }],
    });
  }

  async function changeRole(p) {
    const select = ui.selectInput(creatableRoles().map((r) => ({ value: r, label: ROLE_META[r].label })), { value: p.role });
    const res = await openModal({
      title: `Role for ${p.username}`,
      body: h('div', [ui.field('Role', select)]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', kind: 'primary' }],
    });
    if (res !== 'save') return;
    const role = select.querySelector('select').value;
    const { error } = await api.updateProfile(p.id, { role });
    if (error) return toast(error.message, 'bad');
    toast(`${p.username} is now ${ROLE_META[role].label}`, 'good');
    render();
  }

  async function suspend(p) {
    const select = ui.selectInput([
      { value: 'active', label: 'Active' },
      { value: 'suspended', label: 'Suspended' },
    ], { value: p.status });
    const res = await openModal({
      title: `Status for ${p.username}`,
      body: h('div', [
        ui.field('Status', select),
        h('p.tiny.muted', 'Suspending blocks sign-in for that account (do it in Supabase Auth as well to be strict).'),
      ]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', kind: 'primary' }],
    });
    if (res !== 'save') return;
    const status = select.querySelector('select').value;
    const { error } = await api.updateProfile(p.id, { status });
    if (error) return toast(error.message, 'bad');
    toast('Updated', 'good');
    render();
  }

  /* -------------------------------------------------------------- games */
  async function drawGames() {
    const host = h('div', [h('div', { style: { padding: '16px 0' } }, ui.spinner('dark'))]);
    card.appendChild(host);

    const gamemasters = store.isOverseer
      ? ((await api.listProfiles({ role: ['gamemaster', 'admin', 'manager'], limit: 300 })).data || [])
      : [{ id: store.user.id, username: store.profile.username }];

    host.innerHTML = '';
    host.appendChild(h('h3', { style: { marginTop: 0 } }, 'Games'));

    store.games.forEach((g) => {
      host.appendChild(h('div.member', [
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(g.name)),
          h('div.m-sub', `${g.gamemaster_name || 'unknown gm'} · ${g.status}${g.is_staff ? ' · you staff this' : ''}`),
        ]),
        h('button.btn-ghost.small', {
          onclick: () => {
            const found = store.games.find((x) => x.id === g.id);
            store.setGame(found);
            toast(`Active game: ${g.name}`, 'good');
            ctx.onGameChange?.();
          },
        }, store.game?.id === g.id ? 'Active' : 'Set active'),
      ]));
    });

    host.appendChild(h('h3', { style: { marginTop: '20px' } }, 'New game'));
    const name = ui.textInput({ placeholder: 'e.g. Saturday Sprint' });
    const desc = ui.textInput({ placeholder: 'optional description' });
    const gmSelect = ui.selectInput(gamemasters.map((p) => ({ value: p.id, label: p.username })), { value: store.user.id });
    const start = h('input', { type: 'date' });
    const end = h('input', { type: 'date' });

    host.appendChild(h('div', { style: { display: 'grid', gap: '10px' } }, [
      ui.field('Name', name),
      ui.field('Description', desc),
      ui.field('Gamemaster', gmSelect, 'Who runs this game? They can create players and teams for it.'),
      h('div.row', [
        h('div', { style: { flex: 1 } }, ui.field('Starts', start)),
        h('div', { style: { flex: 1 } }, ui.field('Ends', end)),
      ]),
      h('button.btn-primary.btn-block', {
        onclick: async () => {
          if (name.value.trim().length < 2) return toast('Give the game a name', 'bad');
          const { data, error } = await api.createGame({
            name: name.value.trim(),
            description: desc.value.trim() || null,
            gamemasterId: gmSelect.querySelector('select').value,
            startsAt: start.value ? new Date(start.value).toISOString() : null,
            endsAt: end.value ? new Date(end.value).toISOString() : null,
          });
          if (error) return toast(error.message, 'bad');
          toast('Game created', 'good');
          await ctx.reloadGames();
          const created = store.games.find((g) => g.id === data.id);
          if (created) store.setGame(created);
          render();
        },
      }, 'Create game'),
    ]));
  }

  /* ------------------------------------------------------------ transit */
  async function drawTransit() {
    const host = h('div');
    card.appendChild(host);
    const { data: agencies } = await api.listAgencies();

    host.appendChild(h('h3', { style: { marginTop: 0 } }, 'Transit feeds'));
    host.appendChild(h('p.small.muted',
      'Stops come from OpenStreetMap (Overpass). Schedules and route shapes come from a GTFS zip. Both are free — paste the feed url your city publishes.'));

    (agencies || []).forEach(async (a) => {
      const meta = await bundleMeta(a);
      const row = h('div.member', [
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(a.name)),
          h('div.m-sub.nowrap', a.static_gtfs_url || 'no GTFS url set'),
          h('div.tiny.muted', meta
            ? `cached ${relTime(new Date(meta.savedAt).toISOString())} · ${meta.stops} stops · ${meta.trips} trips`
            : 'not downloaded on this device yet'),
        ]),
        ui.iconButton('download', async () => {
          toast('Downloading GTFS…');
          const res = await ensureBundle(a, { force: true, onProgress: (p) => {
            if (p.phase === 'stop_times' || p.phase === 'trips') toast(`Indexing ${p.phase}…`);
          } });
          if (res.error) toast(res.error, 'bad');
          else toast(`Feed ready: ${res.bundle.stops.length} stops`, 'good');
          render();
        }, { title: 'Download feed now', cls: 'sm' }),
        ui.iconButton('edit', () => editAgency(a), { title: 'Edit', cls: 'sm' }),
      ]);
      host.appendChild(row);
    });

    host.appendChild(h('div', { style: { marginTop: '18px' } }, [
      h('h3', 'Add a feed'),
      (() => {
        const key = ui.textInput({ placeholder: 'my-city' });
        const name = ui.textInput({ placeholder: 'My City Transit' });
        const tz = ui.textInput({ placeholder: 'Europe/Berlin' });
        const gtfs = ui.textInput({ placeholder: 'https://…/google_transit.zip' });
        const rt = ui.textInput({ placeholder: 'https://…/vehiclepositions.pb (optional)' });
        return h('div', { style: { display: 'grid', gap: '10px' } }, [
          h('div.row', [h('div', { style: { flex: 1 } }, ui.field('Key', key)), h('div', { style: { flex: 2 } }, ui.field('Name', name))]),
          ui.field('Timezone', tz),
          ui.field('Static GTFS zip url', gtfs),
          ui.field('GTFS-Realtime vehicle positions', rt, 'Optional. Unlocks "LIVE" guesses with real vehicle numbers.'),
          h('button.btn-primary.btn-block', {
            onclick: async () => {
              if (!name.value.trim()) return toast('Name required', 'bad');
              const { error } = await api.upsertAgency({
                agency_key: (key.value.trim() || name.value.trim().toLowerCase().replace(/\W+/g, '-')),
                name: name.value.trim(),
                timezone: tz.value.trim() || 'UTC',
                static_gtfs_url: gtfs.value.trim() || null,
                rt_vehicle_positions_url: rt.value.trim() || null,
                active: true,
              });
              if (error) return toast(error.message, 'bad');
              toast('Feed saved', 'good');
              await ctx.reloadAgencies();
              render();
            },
          }, 'Save feed'),
        ]);
      })(),
    ]));
  }

  async function editAgency(a) {
    const name = ui.textInput({ value: a.name });
    const tz = ui.textInput({ value: a.timezone || 'UTC' });
    const gtfs = ui.textInput({ value: a.static_gtfs_url || '' });
    const rt = ui.textInput({ value: a.rt_vehicle_positions_url || '' });
    const res = await openModal({
      title: 'Transit feed',
      body: h('div', [ui.field('Name', name), ui.field('Timezone', tz), ui.field('GTFS zip', gtfs), ui.field('Realtime vehicles', rt)]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', kind: 'primary' }],
    });
    if (res !== 'save') return;
    const { error } = await api.upsertAgency({
      ...a,
      name: name.value.trim(),
      timezone: tz.value.trim() || 'UTC',
      static_gtfs_url: gtfs.value.trim() || null,
      rt_vehicle_positions_url: rt.value.trim() || null,
    });
    if (error) return toast(error.message, 'bad');
    await ctx.reloadAgencies();
    toast('Saved', 'good');
    render();
  }

  /* ----------------------------------------------------------- settings */
  async function drawSettings() {
    const host = h('div');
    card.appendChild(host);

    host.appendChild(h('div', { style: { marginBottom: '16px' } }, [
      ui.kv('Supabase url', h('span.mono.tiny', esc(store.client?.url || '–'))),
      ui.kv('Signed in as', esc(store.profile?.username || '–')),
      ui.kv('Role', esc(ROLE_META[store.role]?.label || store.role)),
      ui.kv('Tracking config', store.game?.tracking_config
        ? `${store.game.tracking_config.sample_seconds ?? 20}s / ${store.game.tracking_config.min_distance_m ?? 15}m`
        : 'default (20s / 15m)'),
      ui.kv('Local queue', `${store.__trackerQueued ?? 0} points waiting`),
    ]));

    host.appendChild(h('button.btn-ghost.btn-block', {
      onclick: () => { location.hash = '#/info'; },
    }, 'Connection details & data export'));

    host.appendChild(h('button.btn-danger.btn-block', {
      style: { marginTop: '12px' },
      onclick: async () => {
        const ok = await confirmDialog('Sign out of everything?',
          'This clears the saved Supabase connection from this browser as well as the session.', 'Sign out and reset', 'danger');
        if (!ok) return;
        await store.signOut();
        const cfg = (await import('../config.js')).default;
        cfg.reset();
        location.reload();
      },
    }, 'Sign out and reset connection'));
  }

  // fire and forget: the card fills itself in as the queries resolve
  render();
  return wrap;
}
