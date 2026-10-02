/* ==========================================================================
   Staff tools: all users, transit feeds and app settings.

   Games, teams and players are NOT created here - that happens on the Game
   control tab and in the Teams tab, so staff do not have to hunt for a screen.
   This is the directory and configuration corner, reached from Game control.
   ========================================================================== */

import { h, esc, toast, confirmDialog, openModal, relTime } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import { ROLE_META, creatableRoles, canSeeCredentials } from '../authz.js';
import { bundleMeta, ensureBundle } from '../transit.js';
import config from '../config.js';

export function renderManage(ctx) {
  const wrap = h('div');
  const card = h('div.card');
  wrap.appendChild(card);

  let tab = ['users', 'transit', 'settings'].includes(ctx.params?.tab) ? ctx.params.tab : 'users';
  let search = '';

  async function render() {
    card.innerHTML = '';
    card.appendChild(h('div.card-head', [
      h('h2', 'Staff tools'),
      ui.iconButton('refresh', render, { title: 'Refresh', cls: 'plain sm' }),
    ]));

    if (!store.isStaff) {
      card.appendChild(ui.emptyState('Only admins, managers and gamemasters can open staff tools.'));
      card.appendChild(h('button.btn-ghost.btn-block', { onclick: () => ctx.go('game') }, 'Back to Game control'));
      return;
    }

    const tabs = [['users', 'Users']];
    if (store.isOverseer) tabs.push(['transit', 'Transit feeds'], ['settings', 'Settings']);
    card.appendChild(h('div.tabs', tabs.map(([k, label]) => h('button', {
      'aria-selected': tab === k ? 'true' : 'false',
      onclick: () => { tab = k; render(); },
    }, label))));

    if (tab === 'users') await drawUsers();
    else if (tab === 'transit') await drawTransit();
    else await drawSettings();
  }

  /* -------------------------------------------------------------- users */
  async function drawUsers() {
    const host = h('div');
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
        listHost.appendChild(h('div.small.muted', {
          style: { margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.6px' },
        }, `${ROLE_META[role].label}s (${people.length})`));
        people.forEach((p) => {
          listHost.appendChild(h('div.member', [
            h('div.m-name', [
              h('div', { style: { fontWeight: '600' } }, esc(p.display_name || p.username)),
              h('div.m-sub', [
                p.username,
                p.status !== 'active' ? p.status : null,
                p.last_seen_at ? `seen ${relTime(p.last_seen_at)}` : 'never signed in',
              ].filter(Boolean).join(' · ')),
            ]),
            canSeeCredentials(p) ? ui.iconButton('download', () => showCreds(p), { title: 'Login details', cls: 'sm' }) : null,
            store.isOverseer ? ui.iconButton('star', () => changeRole(p), { title: 'Change role', cls: 'sm' }) : null,
            store.isOverseer ? ui.iconButton('trash', () => suspend(p), { title: 'Suspend', cls: 'sm' }) : null,
          ]));
        });
      });
      if (!data?.length) listHost.appendChild(ui.emptyState('No users match.'));
    }

    host.appendChild(searchInput);
    host.appendChild(listHost);
    if (creatableRoles().length) {
      host.appendChild(h('button.btn-primary.btn-block', {
        style: { marginTop: '16px' },
        onclick: () => ctx.go('game'),
      }, 'Create accounts from Game control'));
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
        h('p.tiny.muted', { style: { marginTop: '10px' } }, 'The player signs in with the username, not the email.'),
      ]),
      actions: [{
        label: 'Copy',
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
        h('p.tiny.muted', 'Suspending marks the account. Also disable it in Supabase Auth to block sign-in completely.'),
      ]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', kind: 'primary' }],
    });
    if (res !== 'save') return;
    const { error } = await api.updateProfile(p.id, { status: select.querySelector('select').value });
    if (error) return toast(error.message, 'bad');
    toast('Updated', 'good');
    render();
  }

  /* ------------------------------------------------------------ transit */
  async function drawTransit() {
    const host = h('div');
    card.appendChild(host);
    const { data: agencies } = await api.listAgencies();

    host.appendChild(h('p.small.muted',
      'Stops come from OpenStreetMap. Schedules and route shapes come from a GTFS zip. Both are free — paste the feed url your city publishes.'));

    for (const a of agencies || []) {
      const meta = await bundleMeta(a);
      host.appendChild(h('div.member', [
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(a.name)),
          h('div.m-sub.nowrap', a.static_gtfs_url || 'no GTFS url set'),
          h('div.tiny.muted', meta
            ? `cached ${relTime(new Date(meta.savedAt).toISOString())} · ${meta.stops} stops · ${meta.trips} trips`
            : 'not downloaded on this device yet'),
        ]),
        ui.iconButton('download', async () => {
          const res = await ensureBundle(a, { force: true });
          if (res.error) toast(res.error, 'bad');
          else toast(`Feed ready: ${res.bundle.stops.length} stops`, 'good');
          render();
        }, { title: 'Download feed now', cls: 'sm' }),
        ui.iconButton('edit', () => editAgency(a), { title: 'Edit', cls: 'sm' }),
      ]));
    }

    const key = ui.textInput({ placeholder: 'my-city' });
    const name = ui.textInput({ placeholder: 'My City Transit' });
    const tz = ui.textInput({ placeholder: 'Europe/Zurich' });
    const gtfs = ui.textInput({ placeholder: 'https://…/google_transit.zip' });
    const rt = ui.textInput({ placeholder: 'https://…/vehiclepositions.pb (optional)' });
    host.appendChild(h('div', { style: { marginTop: '18px', display: 'grid', gap: '10px' } }, [
      h('h3', { style: { margin: 0 } }, 'Add a feed'),
      h('div.row', [
        h('div', { style: { flex: 1 } }, ui.field('Key', key)),
        h('div', { style: { flex: 2 } }, ui.field('Name', name)),
      ]),
      ui.field('Timezone', tz, 'Must match the agency timezone inside the feed.'),
      ui.field('Static GTFS zip url', gtfs),
      ui.field('GTFS-Realtime vehicle positions', rt, 'Optional. Unlocks "LIVE" guesses with real vehicle numbers.'),
      h('button.btn-primary.btn-block', {
        onclick: async () => {
          if (!name.value.trim()) return toast('Name required', 'bad');
          const { error } = await api.upsertAgency({
            agency_key: key.value.trim() || name.value.trim().toLowerCase().replace(/\W+/g, '-'),
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
      ui.kv('Connection', config.bakedIn ? 'built in at deploy time' : 'entered in this browser'),
    ]));

    host.appendChild(h('button.btn-ghost.btn-block', {
      onclick: async () => {
        const { clearStopCache } = await import('../overpass.js');
        const n = await clearStopCache();
        toast(`Cleared ${n} cached stop lookups`, 'good');
      },
    }, 'Clear cached OpenStreetMap stops'));

    host.appendChild(h('button.btn-ghost.btn-block', {
      style: { marginTop: '10px' },
      onclick: async () => {
        const { idb } = await import('../idb.js');
        await idb.clear('gtfs');
        toast('Transit feeds will download again on next use', 'good');
      },
    }, 'Clear cached transit feeds'));

    host.appendChild(h('button.btn-danger.btn-block', {
      style: { marginTop: '10px' },
      onclick: async () => {
        const ok = await confirmDialog('Sign out and reset connection?',
          'Clears the saved Supabase connection from this browser as well as the session.', 'Sign out and reset', 'danger');
        if (!ok) return;
        await store.signOut();
        config.reset();
        location.reload();
      },
    }, 'Sign out and reset connection'));
  }

  render();
  return wrap;
}

export default renderManage;
