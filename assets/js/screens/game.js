/* ==========================================================================
   Game master console: the roster, live positions, who is riding what,
   point rules for THIS game, and manual point awards.
   ========================================================================== */

import { h, esc, toast, confirmDialog, openModal, fmtTime, fmtDist, fmtNum, relTime, download } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import { creatableRoles, ROLE_META } from '../authz.js';

export function renderGame(ctx) {
  const wrap = h('div');
  let gameId = store.game?.id || store.games[0]?.id || '';
  let tab = 'roster';

  const card = h('div.card');
  wrap.appendChild(card);

  const drawTabs = () => h('div.tabs', ['roster', 'live', 'points', 'rules'].map((k) => h('button', {
    'aria-selected': tab === k ? 'true' : 'false',
    onclick: () => { tab = k; render(); },
  }, { roster: 'Roster', live: 'Live', points: 'Points', rules: 'Rules' }[k])));

  async function render() {
    const game = store.games.find((g) => g.id === gameId) || store.game;
    card.innerHTML = '';

    card.appendChild(h('div.card-head', [
      h('h2', store.isOverseer ? 'Game control' : 'My game'),
      ui.iconButton('refresh', render, { title: 'Refresh', cls: 'plain sm' }),
    ]));

    if (!store.games.length) {
      card.appendChild(ui.emptyState(store.role === 'admin' || store.role === 'manager'
        ? 'No game yet. Create one from Manage.'
        : 'No game assigned to you yet.'));
      return;
    }

    if (store.games.length > 1) {
      const gameSelect = ui.selectInput(
        store.games.map((g) => ({ value: g.id, label: `${g.name}${g.is_staff ? '' : ' (player)'}` })),
        { value: gameId },
      );
      card.appendChild(ui.field('Game', gameSelect));
      gameSelect.addEventListener('change', () => {
        gameId = gameSelect.querySelector('select').value;
        const g = store.games.find((x) => x.id === gameId);
        if (g) store.setGame(g);
        render();
      });
    }

    card.appendChild(drawTabs());

    if (!game) { card.appendChild(ui.emptyState('Pick a game.')); return; }

    const isStaff = game.is_staff || store.isStaff;
    if (tab === 'roster') await drawRoster(game, isStaff);
    else if (tab === 'live') await drawLive(game, isStaff);
    else if (tab === 'points') await drawPoints(game, isStaff);
    else await drawRules(game, isStaff);
  }

  /* ------------------------------------------------------------- roster */
  async function drawRoster(game, isStaff) {
    const host = h('div', [h('div', { style: { padding: '16px 0' } }, ui.spinner('dark'))]);
    card.appendChild(host);

    const [members, teams, lb] = await Promise.all([
      api.listGameMembers(game.id),
      api.listTeams(game.id),
      api.leaderboard(game.id),
    ]);
    host.innerHTML = '';

    if (members.error) { host.appendChild(ui.emptyState(members.error.message)); return; }

    // Score lookup for the roster rows
    const pointsByPlayer = new Map((lb.data || []).map((r) => [r.player_id, r]));
    const teamByPlayer = new Map();
    (teams.data || []).forEach((t) => (t.team_members || []).forEach((m) => teamByPlayer.set(m.profile_id, t.name)));

    const rows = (members.data || [])
      .map((m) => m.profile)
      .filter(Boolean)
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));

    host.appendChild(h('div.small.muted', { style: { marginBottom: '10px' } },
      `${rows.length} people${teams.data?.length ? ` · ${teams.data.length} teams` : ''}`));

    rows.forEach((p) => {
      const lbRow = pointsByPlayer.get(p.id);
      const teamName = teamByPlayer.get(p.id);
      host.appendChild(h('div.member', [
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(p.display_name || p.username)),
          h('div.m-sub', [
            p.username,
            ROLE_META[p.role]?.label || p.role,
            teamName || null,
            p.last_seen_at ? `seen ${relTime(p.last_seen_at)}` : null,
          ].filter(Boolean).join(' · ')),
        ]),
        lbRow ? h('span.pill', `${fmtNum(lbRow.points)} pts`) : null,
        isStaff ? ui.iconButton('star', () => awardDialog(game, p), { title: 'Award points', cls: 'sm' }) : null,
        isStaff ? ui.iconButton('edit', () => editMember(game, p), { title: 'Manage', cls: 'sm' }) : null,
      ]));
    });

    if (isStaff) {
      const roles = creatableRoles();
      if (roles.length) {
        host.appendChild(h('button.btn-primary.btn-block', {
          style: { marginTop: '14px' },
          onclick: () => ctx.go('create', { tab: 'player' }),
        }, `Create a ${roles.includes('player') ? 'player' : ROLE_META[roles[0]].label}`));
      }
    }

    /* leaderboard */
    host.appendChild(h('h3', { style: { marginTop: '22px' } }, 'Leaderboard'));
    if (!lb.data?.length) host.appendChild(ui.emptyState('No scores yet.'));
    else {
      const table = h('table.data', [
        h('thead', h('tr', [h('th', '#'), h('th', 'Player'), h('th', 'Team'), h('th', 'Rides'), h('th', 'Points')])),
        h('tbody', lb.data.map((r, i) => h('tr', [
          h('td', String(i + 1)),
          h('td', esc(r.display_name || r.username)),
          h('td.small.muted', esc(r.team || '–')),
          h('td', String(r.boardings ?? 0)),
          h('td', { style: { fontWeight: '700' } }, fmtNum(r.points, 0)),
        ]))),
      ]);
      host.appendChild(table);
    }
  }

  async function editMember(game, p) {
    const teams = (await api.listTeams(game.id)).data || [];
    const teamSelect = ui.selectInput(
      [{ value: '', label: 'No team' }, ...teams.map((t) => ({ value: t.id, label: t.name }))],
      { value: '' },
    );
    const roleSelect = ui.selectInput(
      ['player', 'gamemaster'].map((r) => ({ value: r, label: ROLE_META[r].label })),
      { value: p.role === 'gamemaster' ? 'gamemaster' : 'player' },
    );

    const credBox = h('div');
    const res = await openModal({
      title: p.username,
      body: h('div', [
        ui.field('Team in this game', teamSelect),
        store.isOverseer || store.role === 'gamemaster' ? ui.field('Role in this game', roleSelect) : null,
        h('div.row', { style: { marginTop: '6px' } }, [
          ui.iconButton('download', async () => {
            const { data, error } = await api.credentialsFor(p.id);
            if (error || !data) { toast(error?.message || 'Not allowed', 'bad'); return; }
            credBox.innerHTML = '';
            credBox.appendChild(h('div.tile.mono.small', { style: { marginTop: '12px' } }, [
              h('div', `username: ${data.username}`),
              h('div', `password: ${data.password ?? '(hidden)'}`),
              h('div', `email: ${data.fake_email ?? '–'}`),
            ]));
          }, { title: 'Show login details', cls: 'plain' }),
        ]),
        credBox,
      ]),
      actions: [
        { label: 'Remove from game', value: 'remove', kind: 'danger' },
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', kind: 'primary' },
      ],
    });
    if (!res) return;

    if (res === 'remove') {
      const ok = await confirmDialog('Remove from game?', `${p.username} loses access to this game's tracking and points.`, 'Remove', 'danger');
      if (!ok) return;
      const { error } = await api.removeGameMember(game.id, p.id);
      if (error) return toast(error.message, 'bad');
      toast('Removed from game', 'good');
      render();
      return;
    }

    const teamId = teamSelect.querySelector('select').value;
    // clear existing teams in this game, then set the chosen one
    for (const t of teams) await api.removeTeamMember(t.id, p.id);
    if (teamId) await api.addTeamMember(teamId, p.id);

    const newRole = roleSelect.querySelector('select').value;
    if ((store.isOverseer || store.role === 'gamemaster') && newRole !== p.role && p.role === 'player') {
      const upd = await api.updateProfile(p.id, { role: newRole });
      if (upd.error) toast(upd.error.message, 'bad');
    }
    toast('Saved', 'good');
    render();
  }

  /* --------------------------------------------------------------- live */
  async function drawLive(game, isStaff) {
    const host = h('div', [h('div', { style: { padding: '16px 0' } }, ui.spinner('dark'))]);
    card.appendChild(host);

    const [boardings, points] = await Promise.all([
      api.listGameBoardings(game.id, { since: new Date(Date.now() - 6 * 3600_000).toISOString(), limit: 80 }),
      api.listPoints({ gameId: game.id, limit: 30 }),
    ]);
    host.innerHTML = '';

    const riding = (boardings.data || []).filter((b) => b.status === 'riding');
    const recent = (boardings.data || []).filter((b) => b.status !== 'riding').slice(0, 15);

    host.appendChild(h('div.row', { style: { marginBottom: '12px' } }, [
      ui.pill(`${riding.length} riding now`, riding.length ? 'live' : ''),
      h('div.spacer'),
      ui.iconButton('refresh', render, { title: 'Refresh', cls: 'plain sm' }),
    ]));

    if (riding.length) {
      riding.forEach((b) => host.appendChild(h('div.member', [
        ui.routeBadge({ route_short_name: b.vehicle?.route_short_name || '?', route_mode: 'bus' }),
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(b.player?.display_name || b.player?.username || 'player')),
          h('div.m-sub', `${fmtTime(b.board_at)} → now${b.board_stop_name ? ' · from ' + esc(b.board_stop_name) : ''} · ${b.confidence}`),
        ]),
        ui.pill('riding', 'live'),
      ])));
    } else {
      host.appendChild(ui.emptyState('Nobody is riding right now.'));
    }

    host.appendChild(h('h3', { style: { marginTop: '20px' } }, 'Recent rides'));
    if (!recent.length) host.appendChild(ui.emptyState('No completed rides yet.'));
    recent.forEach((b) => host.appendChild(h('div.member', [
      ui.routeBadge({ route_short_name: b.vehicle?.route_short_name || '?', route_mode: 'bus' }),
      h('div.m-name', [
        h('div', esc(b.player?.username || 'player')),
        h('div.m-sub', `${fmtTime(b.board_at)}–${b.alight_at ? fmtTime(b.alight_at) : '?'} · ${b.stops_travelled ?? '?'} stops · ${fmtDist(b.distance_m)}`),
      ]),
      h('span.tiny.muted', esc(b.alight_stop_name || '')),
    ])));

    host.appendChild(h('h3', { style: { marginTop: '20px' } }, 'Latest points'));
    if (!points.data?.length) host.appendChild(ui.emptyState('No points awarded yet.'));
    points.data.slice(0, 10).forEach((p) => host.appendChild(h('div.kv', [
      h('div.k', `${esc(p.player?.username || '')} · ${esc(p.reason || p.kind)}`),
      h('div.v', `${fmtNum(p.points)}`),
    ])));

    host.appendChild(h('button.btn-ghost.btn-block', {
      style: { marginTop: '16px' },
      onclick: () => exportGame(game.id),
    }, 'Export this game as JSON'));
  }

  async function exportGame(gameIdToExport) {
    const [boardings, points, lb] = await Promise.all([
      api.listGameBoardings(gameIdToExport, { limit: 1000 }),
      api.listPoints({ gameId: gameIdToExport, limit: 1000 }),
      api.leaderboard(gameIdToExport),
    ]);
    const game = store.games.find((g) => g.id === gameIdToExport);
    const payload = {
      exported_at: new Date().toISOString(),
      game: game ? { id: game.id, name: game.name } : { id: gameIdToExport },
      leaderboard: lb.data, boardings: boardings.data, points: points.data,
    };
    download(`interchange-${(game?.name || 'game').replace(/\W+/g, '-').toLowerCase()}.json`, JSON.stringify(payload, null, 2));
    toast('Export downloaded', 'good');
  }

  /* ------------------------------------------------------------- points */
  async function drawPoints(game, isStaff) {
    const host = h('div', [h('div', { style: { padding: '16px 0' } }, ui.spinner('dark'))]);
    card.appendChild(host);
    const [points, lb] = await Promise.all([
      api.listPoints({ gameId: game.id, limit: 60 }),
      api.leaderboard(game.id),
    ]);
    host.innerHTML = '';

    const total = (lb.data || []).reduce((a, r) => a + Number(r.points || 0), 0);
    host.appendChild(ui.statGrid([
      { value: total, label: 'total points' },
      { value: lb.data?.length ?? 0, label: 'scorers' },
      { value: points.data?.length ?? 0, label: 'awards' },
    ]));

    if (isStaff) {
      const players = (await api.listGameMembers(game.id)).data || [];
      const select = ui.selectInput(players.map((m) => ({ value: m.profile_id, label: m.profile?.username || m.profile_id })));
      const amount = h('input', { type: 'number', value: '5', min: '1' });
      const reason = ui.textInput({ placeholder: 'e.g. best transfer of the day' });
      host.appendChild(h('h3', { style: { marginTop: '18px' } }, 'Award points'));
      host.appendChild(h('div', { style: { display: 'grid', gap: '10px' } }, [
        ui.field('Player', select),
        h('div.row', [h('div', { style: { flex: '1' } }, ui.field('Points', amount)), h('div', { style: { flex: '2' } }, ui.field('Reason', reason))]),
        h('button.btn-primary.btn-block', {
          onclick: async () => {
            const pid = select.querySelector('select').value;
            const val = Number(amount.value) || 0;
            if (!pid) return toast('Pick a player', 'bad');
            const { error } = await api.awardPoints({
              gameId: game.id, playerId: pid, points: val,
              reason: reason.value.trim() || 'manual award', kind: 'manual',
            });
            if (error) return toast(error.message, 'bad');
            toast(`Awarded ${val} points`, 'good');
            render();
          },
        }, 'Award'),
      ]));
    }

    host.appendChild(h('h3', { style: { marginTop: '20px' } }, 'Ledger'));
    if (!points.data?.length) { host.appendChild(ui.emptyState('Nothing awarded yet.')); return; }
    points.data.forEach((p) => {
      const row = h('div.kv', [
        h('div.k', [
          h('div', esc(p.player?.display_name || p.player?.username || '')),
          h('div.tiny.muted', `${esc(p.reason || p.kind)} · ${relTime(p.created_at)}${p.auto ? ' · auto' : ''}`),
        ]),
        h('div.v', fmtNum(p.points)),
      ]);
      if (isStaff) {
        row.appendChild(ui.iconButton('trash', async () => {
          const ok = await confirmDialog('Revoke?', `${fmtNum(p.points)} points will be removed.`, 'Revoke', 'danger');
          if (!ok) return;
          const { error } = await api.revokePoints(p.id);
          if (error) return toast(error.message, 'bad');
          toast('Revoked');
          render();
        }, { title: 'Revoke', cls: 'plain sm' }));
      }
      host.appendChild(row);
    });
  }

  /* -------------------------------------------------------------- rules */
  async function drawRules(game, isStaff) {
    const cfg = game.points_config || {};
    const host = h('div');
    card.appendChild(host);

    const keys = [
      ['points_per_stop', 'Points per stop travelled'],
      ['points_per_km', 'Points per kilometre'],
      ['points_per_new_route', 'Bonus: first time on a route'],
      ['points_per_new_station', 'Bonus: first time at a station'],
      ['points_per_transfer', 'Bonus: completing a ride'],
      ['points_per_minute', 'Points per minute riding'],
      ['points_per_visit', 'Points per team visit (custom games)'],
    ];

    const inputs = {};
    const grid = h('div');
    keys.forEach(([k, label]) => {
      const input = h('input', { type: 'number', min: '0', step: '0.5', value: String(cfg[k] ?? 0) });
      inputs[k] = input;
      grid.appendChild(ui.field(label, input));
    });

    host.appendChild(h('div.small.muted', { style: { marginBottom: '12px' } },
      'These rules drive the automatic scoring for every ride in this game. Different games can score completely differently while sharing the same tracker.'));
    host.appendChild(grid);

    if (isStaff) {
      host.appendChild(h('button.btn-primary.btn-block', {
        onclick: async () => {
          const next = {};
          for (const [k, el] of Object.entries(inputs)) next[k] = Number(el.value) || 0;
          next.bonus_rules = cfg.bonus_rules || [];
          const { error } = await api.updateGame(game.id, { points_config: next });
          if (error) return toast(error.message, 'bad');
          toast('Scoring rules saved', 'good');
          ctx.reloadGames();
        },
      }, 'Save scoring rules'));
    }

    /* named point events */
    const rules = (await api.listPointRules(game.id)).data || [];
    host.appendChild(h('h3', { style: { marginTop: '22px' } }, 'Named point events'));
    host.appendChild(h('div.tiny.muted', { style: { marginBottom: '10px' } },
      'Free-form awards your gamemasters can hand out, e.g. "Reached the terminus" or "Photo at the oldest station".'));
    if (!rules.length) host.appendChild(ui.emptyState('No named events yet.'));
    rules.forEach((r) => host.appendChild(h('div.member', [
      h('div.m-name', [
        h('div', { style: { fontWeight: '600' } }, esc(r.label)),
        h('div.m-sub', `${r.code} · ${fmtNum(r.points)} pts${r.unique_once ? ' · once per player' : ''}`),
      ]),
      isStaff ? ui.iconButton('trash', async () => {
        const ok = await confirmDialog('Delete event?', r.label, 'Delete', 'danger');
        if (!ok) return;
        await api.deletePointRule(r.id);
        render();
      }, { title: 'Delete', cls: 'sm' }) : null,
    ])));

    if (isStaff) {
      const label = ui.textInput({ placeholder: 'Reached the terminus' });
      const code = ui.textInput({ placeholder: 'terminus' });
      const pts = h('input', { type: 'number', value: '25' });
      const once = h('input', { type: 'checkbox' });
      host.appendChild(h('div', { style: { display: 'grid', gap: '10px', marginTop: '12px' } }, [
        ui.field('Label', label),
        h('div.row', [
          h('div', { style: { flex: 1 } }, ui.field('Code', code)),
          h('div', { style: { flex: 1 } }, ui.field('Points', pts)),
        ]),
        h('label.row', { style: { gap: '8px' } }, [once, h('span.small', 'Award at most once per player')]),
        h('button.btn-ghost.btn-block', {
          onclick: async () => {
            const l = label.value.trim();
            const c = (code.value.trim() || l.toLowerCase().replace(/\W+/g, '_')).slice(0, 40);
            if (!l) return toast('Give the event a label', 'bad');
            const { error } = await api.upsertPointRule({
              game_id: game.id, code: c, label: l,
              points: Number(pts.value) || 0, unique_once: once.checked, category: 'custom', active: true,
            });
            if (error) return toast(error.message, 'bad');
            toast('Event saved', 'good');
            render();
          },
        }, 'Add event'),
      ]));
    }
  }

  async function awardDialog(game, player) {
    const rules = (await api.listPointRules(game.id)).data || [];
    const select = ui.selectInput([
      { value: 'manual', label: 'Custom amount' },
      ...rules.map((r) => ({ value: `rule:${r.id}`, label: `${r.label} (${r.points})` })),
    ]);
    const amount = h('input', { type: 'number', value: '5' });
    const reason = ui.textInput({ placeholder: 'why?' });
    const res = await openModal({
      title: `Award to ${player.username}`,
      body: h('div', [
        ui.field('What for', select),
        h('div.row', [
          h('div', { style: { flex: 1 } }, ui.field('Points', amount)),
          h('div', { style: { flex: 2 } }, ui.field('Note', reason)),
        ]),
      ]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Award', value: 'go', kind: 'primary' }],
    });
    if (res !== 'go') return;

    const val = select.querySelector('select').value;
    let points = Number(amount.value) || 0;
    let label = reason.value.trim() || 'manual award';
    if (val.startsWith('rule:')) {
      const rule = rules.find((r) => r.id === val.slice(5));
      if (rule) { points = Number(rule.points) || points; label = rule.label; }
    }
    const { error } = await api.awardPoints({
      gameId: game.id, playerId: player.id, points, reason: label, kind: 'manual',
    });
    if (error) return toast(error.message, 'bad');
    toast(`Awarded ${points} to ${player.username}`, 'good');
    render();
  }

  render();
  return wrap;
}
