/* ========================================================================== 
   Game master console: the roster, live positions, who is riding what, point rules
   for THIS game, and manual point awards. 
   ========================================================================== */ 

import { h, esc, toast, confirmDialog, openModal, fmtTime, fmtDist, fmtNum, relTime, download } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import { creatableRoles, canCreateGame, canJoinGame, ROLE_META } from '../authz.js';

export function renderGame(ctx) {
  const wrap = h('div');
  let gameId = store.game?.id || store.games[0]?.id || '';
  let tab = 'roster';
  const card = h('div.card');
  wrap.appendChild(card);

  const drawTabs = () =>
    h('div.tabs', ['roster', 'live', 'points', 'rules'].map((k) =>
      h('button', {
        'aria-selected': tab === k ? 'true' : 'false',
        onclick: () => { tab = k; render(); },
      }, { roster: 'Roster', live: 'Live', points: 'Points', rules: 'Rules' }[k])
    ));

  async function render() {
    const game = store.games.find((g) => g.id === gameId) || store.game;
    card.innerHTML = '';
    card.appendChild(
      h('div.card-head', [
        h('h2', store.isOverseer ? 'Game control' : 'My game'),
        ui.iconButton('refresh', render, { title: 'Refresh', cls: 'plain sm' }),
      ])
    );

    if (!store.games.length) {
      // ---- EMPTY STATE: CREATE GAME FORM ----
      const nameInput = ui.textInput({ placeholder: 'e.g., Zurich Transit Challenge' });
      const descInput = ui.textInput({ placeholder: 'optional description' });

      const form = h('div', { style: 'margin-top: 1rem; display: flex; flex-direction: column; gap: 1rem;' }, [
        h('p', { style: 'color: #666; text-align: center;' }, 'No game yet. Create your first game below.'),
        ui.field('Game Name', nameInput),
        ui.field('Description', descInput),
        ui.button('Create game', async (btn) => {
          const name = nameInput.value.trim();
          const description = descInput.value.trim();

          if (!name) return toast('Name is required', 'bad');

          // Client-side check for 3 game limit
          if (!canCreateGame()) {
            return toast('You have reached the maximum of 3 games.', 'bad');
          }

          btn.disabled = true;
          btn.textContent = 'Creating...';

          const { data, error } = await api.createGame({ name, description });

          if (error) {
            btn.disabled = false;
            btn.textContent = 'Create game';
            return toast(error.message, 'bad');
          }

          toast('Game created successfully!', 'good');

          // Refresh the games list and re-render
          if (store.setGames) {
            // Reload games from the API
            const { data: games } = await api.loadAssignableGames();
            if (games) store.setGames(games);
          }
          render();
        }),
      ]);

      card.appendChild(form);
      return;
    }

    if (store.games.length > 1) {
      const gameSelect = ui.selectInput(
        store.games.map((g) => ({
          value: g.id,
          label: `${g.name}${g.is_staff ? '' : ' (player)'}`,
        })),
        { value: gameId }
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

    if (!game) {
      card.appendChild(ui.emptyState('Pick a game.'));
      return;
    }

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
    if (members.error) {
      host.appendChild(ui.emptyState(members.error.message));
      return;
    }

    // Score lookup for the roster rows
    const pointsByPlayer = new Map((lb.data || []).map((r) => [r.player_id, r]));
    const teamByPlayer = new Map();
    (teams.data || []).forEach((t) =>
      (t.team_members || []).forEach((m) => teamByPlayer.set(m.profile_id, t.name))
    );

    const rows = (members.data || [])
      .map((m) => m.profile)
      .filter(Boolean)
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));

    host.appendChild(
      h('div.small.muted', { style: { marginBottom: '10px' } },
        `${rows.length} people${teams.data?.length ? ` · ${teams.data.length} teams` : ''}`)
    );

    rows.forEach((p) => {
      const lbRow = pointsByPlayer.get(p.id);
      const teamName = teamByPlayer.get(p.id);
      host.appendChild(
        h('div.member', [
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
        ])
      );
    });

    if (isStaff) {
      const roles = creatableRoles();
      if (roles.length) {
        host.appendChild(
          h('button.btn-primary.btn-block', {
            style: { marginTop: '14px' },
            onclick: () => ctx.go('create', { tab: 'player' }),
          }, `Create a ${roles.includes('player') ? 'player' : ROLE_META[roles[0]].label}`)
        );
      }

      // ---- TEAM CREATION FORM ----
      const teamNameInput = ui.textInput({ placeholder: 'e.g., Team Zurich' });
      const teamDescInput = ui.textInput({ placeholder: 'optional description' });
      host.appendChild(
        h('div', { style: { marginTop: '1.5rem', padding: '1rem', border: '1px solid #eee', borderRadius: '6px' } }, [
          h('h4', { style: { margin: '0 0 0.75rem 0' } }, 'Create a new team'),
          ui.field('Team Name', teamNameInput),
          ui.field('Description', teamDescInput),
          ui.button('Create Team', async (btn) => {
            const name = teamNameInput.value.trim();
            const description = teamDescInput.value.trim();
            if (!name) return toast('Team name is required', 'bad');

            btn.disabled = true;
            btn.textContent = 'Creating...';

            const { error } = await api.createTeam(game.id, name, description);

            btn.disabled = false;
            btn.textContent = 'Create Team';

            if (error) return toast(error.message, 'bad');
            toast('Team created!', 'good');
            render();
          }),
        ])
      );
    }

    /* leaderboard */
    host.appendChild(h('h3', { style: { marginTop: '22px' } }, 'Leaderboard'));
    if (!lb.data?.length) host.appendChild(ui.emptyState('No scores yet.'));
    else {
      const table = h('table.data', [
        h('thead', h('tr', [h('th', '#'), h('th', 'Player'), h('th', 'Team'), h('th', 'Rides'), h('th', 'Points')])),
        h('tbody', lb.data.map((r, i) =>
          h('tr', [
            h('td', String(i + 1)),
            h('td', esc(r.display_name || r.username)),
            h('td.small.muted', esc(r.team || '–')),
            h('td', String(r.boardings ?? 0)),
            h('td', { style: { fontWeight: '700' } }, fmtNum(r.points, 0)),
          ])
        )),
      ]);
      host.appendChild(table);
    }
  }

  async function editMember(game, p) {
    const teams = (await api.listTeams(game.id)).data || [];
    const teamSelect = ui.selectInput(
      [{ value: '', label: 'No team' }, ...teams.map((t) => ({ value: t.id, label: t.name }))],
      { value: '' }
    );
    const roleSelect = ui.selectInput(
      ['player', 'gamemaster'].map((r) => ({ value: r, label: ROLE_META[r].label })),
      { value: p.role === 'gamemaster' ? 'gamemaster' : 'player' }
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
            if (error || !data) {
              toast(error?.message || 'Not allowed', 'bad');
              return;
            }
            credBox.innerHTML = '';
            credBox.appendChild(
              h('div.tile.mono.small', { style: { marginTop: '12px' } }, [
                h('div', `username: ${data.username}`),
                h('div', `password: ${data.password ?? '(hidden)'}`),
                h('div', `email: ${data.fake_email ?? '–'}`),
              ])
            );
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
    host.appendChild(
      h('div.row', { style: { marginBottom: '12px' } }, [
        ui.pill(`${riding.length} riding now`, riding.length ? 'live' : ''),
        h('div.spacer'),
        ui.iconButton('refresh', render, { title: 'Refresh', cls: 'plain sm' }),
      ])
    );
    if (riding.length) {
      riding.forEach((b) =>
        host.appendChild(
          h('div.member', [
            ui.routeBadge({ route_short_name: b.vehicle?.route_short_name || '?', route_mode: 'bus' }),
            h('div.m-name', [
              h('div', { style: { fontWeight: '600' } }, esc(b.player?.display_name || b.player?.username || 'player')),
              h('div.m-sub', `${fmtTime(b.board_at)} → now${b.board_stop_name ? ' · from ' + esc(b.board_stop_name) : ''} · ${b.confidence}`),
            ]),
            ui.pill('riding', 'live'),
          ])
        )
      );
    } else {
      host.appendChild(ui.emptyState('Nobody is riding right now.'));
    }
    host.appendChild(h('h3', { style: { marginTop: '20px' } }, 'Recent rides'));
    if (!recent.length) host.appendChild(ui.emptyState('No completed rides yet.'));
    recent.forEach((b) =>
      host.appendChild(
        h('div.member', [
          ui.routeBadge({ route_short_name: b.vehicle?.route_short_name || '?', route_mode: 'bus' }),
          h('div.m-name', [
            h('div', esc(b.player?.username || 'player')),
            h('div.m-sub', `${fmtTime(b.board_at)}–${b.alight_at ? fmtTime(b.alight_at) : '?'} · ${b.stops_travelled ?? '?'} stops · ${fmtDist(b.distance_m)}`),
          ]),
          h('span.tiny.muted', esc(b.alight_stop_name || '')),
        ])
      )
    );
    host.appendChild(h('h3', { style: { marginTop: '20px' } }, 'Latest points'));
    if (!points.data?.length) host.appendChild(ui.emptyState('No points awarded yet.'));
    points.data.slice(0, 10).forEach((p) =>
      host.appendChild(
        h('div.kv', [
          h('div.k', `${esc(p.player?.username || '')} · ${esc(p.reason || p.kind)}`),
          h('div.v', `${fmtNum(p.points)}`),
        ])
      )
    );
    host.appendChild(
      h('button.btn-ghost.btn-block', { style: { marginTop: '16px' }, onclick: () => exportGame(game.id) }, 'Export this game as JSON')
    );
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
      leaderboard: lb.data,
      boardings: boardings.data,
      points: points.data,
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
    host.appendChild(
      ui.statGrid([
        { value: total, label: 'total points' },
        { value: lb.data?.length ?? 0, label: 'scorers' },
        { value: points.data?.length ?? 0, label: 'awards' },
      ])
    );
    if (isStaff) {
      const players = (await api.listGameMembers(game.id)).data || [];
      const select = ui.selectInput(players.map((m) => ({ value: m.profile_id, label: m.profile?.username || m.profile_id })));
      const amount = h('input', { type: 'number', value: '5', min: '1' });
      const reason = ui.textInput({ placeholder: 'e.g. best transfer of the day' });
      host.appendChild(h('h3', { style: { marginTop: '18px' } }, 'Award points'));
      host.appendChild(
        h('div', { style: { display: 'grid', gap: '10px' } }, [
          ui.field('Player', select),
          h('div.row', [
            h('div', { style: { flex: '1' } }, ui.field('Points', amount)),
            h('div', { style: { flex: '2' } }, ui.field('Reason', reason)),
          ]),
          ui.button('Award points', async () => {
            const playerId = select.querySelector('select').value;
            const pts = Number(amount.value);
            if (!playerId || !pts) return toast('Pick a player and amount', 'bad');
            const { error } = await api.awardPoints({ gameId: game.id, playerId, points: pts, reason: reason.value.trim() || 'manual award' });
            if (error) return toast(error.message, 'bad');
            toast('Points awarded', 'good');
            render();
          }),
        ])
      );
    }
    /* ... rest of points drawing ... */
  }

  /* ------------------------------------------------------------- rules */
  async function drawRules(game, isStaff) {
    /* ... your existing rules code ... */
  }

  /* --------------------------------------------------------- award dialog */
  async function awardDialog(game, player) {
    /* ... your existing award dialog code ... */
  }

  // Initial render
  render();
  return wrap;
}