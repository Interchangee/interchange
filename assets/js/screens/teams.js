/* ==========================================================================
   Teams screen - the lower half of the reference screenshot:
   a Teams header with shuffle + refresh, then one card per team listing its
   members with an edit affordance.
   ========================================================================== */

import { h, esc, toast, confirmDialog, openModal, relTime } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import { canCreateTeams } from '../authz.js';

export function renderTeams(ctx) {
  const wrap = h('div');
  const card = h('div.card');
  wrap.appendChild(card);

  let teams = [];
  let gameMembers = [];

  const draw = () => {
    card.innerHTML = '';
    const game = store.game;

    card.appendChild(h('div.card-head', [
      h('h2', 'Teams'),
      h('div.row', [
        canCreateTeams() && game
          ? ui.iconButton('shuffle', shuffle, { title: 'Shuffle players into teams', cls: 'plain sm' })
          : null,
        ui.iconButton('refresh', load, { title: 'Refresh', cls: 'plain sm' }),
      ]),
    ]));

    if (!game) {
      card.appendChild(ui.emptyState('No game selected. Create or join one first.'));
      return;
    }

    if (!teams.length) {
      card.appendChild(ui.emptyState('No teams yet.'));
      if (canCreateTeams()) {
        card.appendChild(h('button.btn-primary.btn-block', {
          onclick: () => ctx.go('create', { tab: 'team' }),
        }, 'Create a team'));
      }
      return;
    }
    teams.forEach((t) => card.appendChild(teamCard(t)));
  };

  function teamCard(t) {
    const members = t.team_members || [];
    const box = h('div.teamcard');

    box.appendChild(h('div.teamcard-head', [
      h('h4.nowrap', esc(t.name)),
      h('span.pill', `${members.length}`),
      canCreateTeams()
        ? ui.iconButton('person', () => addMember(t), { title: 'Add member', cls: 'sm' })
        : null,
      canCreateTeams()
        ? ui.iconButton('trash', async () => {
          const ok = await confirmDialog('Delete team?', `"${t.name}" will be removed. Members stay in the game.`, 'Delete', 'danger');
          if (!ok) return;
          const { error } = await api.deleteTeam(t.id);
          if (error) return toast(error.message, 'bad');
          toast('Team deleted', 'good');
          load();
        }, { title: 'Delete team', cls: 'sm' })
        : null,
    ]));

    if (!members.length) {
      box.appendChild(h('div.tiny.muted', { style: { padding: '4px 2px 2px' } }, 'No members yet.'));
    }

    members.forEach((m) => {
      const p = m.profile || {};
      box.appendChild(h('div.member', [
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(p.display_name || p.username || 'unknown')),
          h('div.m-sub', [p.username, p.role && p.role !== 'player' ? ` · ${p.role}` : ''].filter(Boolean).join('')),
        ]),
        canCreateTeams()
          ? ui.iconButton('edit', async () => {
            const ok = await confirmDialog('Remove from team?', `${p.username} will be removed from ${t.name}.`, 'Remove', 'danger');
            if (!ok) return;
            const { error } = await api.removeTeamMember(t.id, m.profile_id);
            if (error) return toast(error.message, 'bad');
            load();
          }, { title: 'Remove from team', cls: 'sm' })
          : null,
      ]));
    });

    return box;
  }

  async function addMember(t) {
    const inTeam = new Set((t.team_members || []).map((m) => m.profile_id));
    const candidates = gameMembers
      .map((m) => m.profile)
      .filter((p) => p && !inTeam.has(p.id));

    if (!candidates.length) { toast('Everyone in this game is already on a team.'); return; }

    const select = ui.selectInput(
      candidates.map((p) => ({ value: p.id, label: `${p.username}${p.display_name ? ' (' + p.display_name + ')' : ''}` })),
    );
    const res = await openModal({
      title: `Add to ${t.name}`,
      body: h('div', [ui.field('Player', select)]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'add', kind: 'primary' }],
    });
    if (res !== 'add') return;
    const pid = select.querySelector('select').value;
    const { error } = await api.addTeamMember(t.id, pid);
    if (error) return toast(error.message, 'bad');
    toast('Added', 'good');
    load();
  }

  async function shuffle() {
    const game = store.game;
    if (teams.length < 2) { toast('You need at least two teams to shuffle.'); return; }

    // everyone who plays in this game and could be on a team
    const players = gameMembers
      .map((m) => m.profile)
      .filter((p) => p && p.role === 'player');
    if (!players.length) { toast('No players in this game.'); return; }

    const includeStaff = await openModal({
      title: 'Shuffle players',
      body: h('div', [
        h('p', { style: { marginTop: 0 } }, `${players.length} players will be dealt evenly across ${teams.length} teams.`),
        h('p.tiny.muted', 'Current team assignments for this game will be replaced.'),
      ]),
      actions: [{ label: 'Cancel', value: false }, { label: 'Shuffle', value: true, kind: 'primary' }],
    });
    if (!includeStaff) return;

    const { error } = await api.shuffleTeams(game.id, teams.map((t) => t.id), players.map((p) => p.id));
    if (error) return toast(error.message, 'bad');
    toast('Teams shuffled', 'good');
    load();
  }

  async function load() {
    const game = store.game;
    if (!game) { draw(); return; }
    card.innerHTML = '';
    card.appendChild(h('div.card-head', [h('h2', 'Teams'), ui.iconButton('refresh', load, { title: 'Refresh', cls: 'plain sm' })]));
    card.appendChild(h('div', { style: { padding: '20px 0' } }, ui.spinner('dark')));

    const [t, m] = await Promise.all([
      api.listTeams(game.id),
      api.listGameMembers(game.id),
    ]);
    if (t.error) toast(t.error.message, 'bad');
    teams = t.data || [];
    gameMembers = m.data || [];
    draw();
  }

  load();
  return wrap;
}
