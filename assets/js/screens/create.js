/* ==========================================================================
   "Create Players and Teams" - mirrors the screenshot's two tabs.
   Player:  username + password + (role) + game [+ team]  -> creates the login
   Team:    name + game [+ description]
   ========================================================================== */

import { h, esc, toast, openModal, confirmDialog } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import * as api from '../api.js';
import { creatableRoles, ROLE_META, assignableGames } from '../authz.js';

const ADJ = ['swift', 'silver', 'quiet', 'north', 'amber', 'lucky', 'rapid', 'blue', 'urban', 'sunny'];
const NOUN = ['otter', 'falcon', 'tram', 'comet', 'harbor', 'sparrow', 'metro', 'cedar', 'pixel', 'ember'];

export function randomUsername() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const b = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${a}-${b}-${Math.floor(10 + Math.random() * 89)}`;
}

export function randomPassword(len = 10) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  crypto.getRandomValues(new Uint32Array(len)).forEach((n) => { out += chars[n % chars.length]; });
  return out;
}

export function renderCreate(ctx) {
  const wrap = h('div');
  let tab = ctx.params?.tab === 'team' ? 'team' : 'player';

  const tabs = h('div.tabs', { role: 'tablist' });
  const tabDefs = [
    { key: 'player', label: 'Player' },
    { key: 'team', label: 'Team' },
  ];
  const panel = h('div');

  const drawTabs = () => {
    tabs.innerHTML = '';
    tabDefs.forEach((t) => {
      tabs.appendChild(h('button', {
        role: 'tab',
        'aria-selected': tab === t.key ? 'true' : 'false',
        onclick: () => { tab = t.key; drawTabs(); drawPanel(); },
      }, t.label));
    });
  };

  const drawPanel = () => {
    panel.innerHTML = '';
    if (tab === 'player') panel.appendChild(playerPanel(ctx));
    else panel.appendChild(teamPanel());
  };

  const card = h('div.card', [h('h2', 'Create Players and Teams'), tabs, panel]);
  wrap.appendChild(card);

  drawTabs();
  drawPanel();
  return wrap;
}

/* ============================================================== PLAYER ==== */

function playerPanel(ctx) {
  const me = store.profile;
  const roles = creatableRoles();

  if (!roles.length) {
    return h('div.empty', 'Players cannot create other users. Ask an admin, manager or your gamemaster for an account.');
  }

  const games = assignableGames(store.games);
  const state = {
    username: '',
    password: randomPassword(),
    role: roles.includes('player') ? 'player' : roles[0],
    gameId: store.game?.id || games[0]?.id || '',
    alsoTeam: '',
    displayName: '',
  };

  const usernameInput = ui.textInput({ value: state.username, placeholder: 'e.g. swift-otter-42', autocomplete: 'off' });
  const passwordInput = ui.textInput({ value: state.password, autocomplete: 'off' });
  const displayInput = ui.textInput({ placeholder: 'optional, shown on the leaderboard' });
  const roleSelect = ui.selectInput(roles.map((r) => ({ value: r, label: `${ROLE_META[r].label} — ${ROLE_META[r].blurb}` })), { value: state.role });
  const gameSelect = ui.selectInput(
    games.length ? games.map((g) => ({ value: g.id, label: g.name })) : [{ value: '', label: 'No game available', disabled: true }],
    { value: state.gameId },
  );
  const teamSelect = ui.selectInput([{ value: '', label: 'No team' }], { value: '' });

  const roleHint = h('div.tiny.muted');
  const updateRoleHint = () => {
    roleHint.textContent = ROLE_META[roleSelect.querySelector('select')?.value || state.role]?.blurb || '';
  };
  roleSelect.addEventListener('change', updateRoleHint);
  updateRoleHint();

  const credPreview = h('div.tile.mono.small', { style: { marginBottom: '16px' } }, [
    h('div', `username: ${state.username || '(not set)'}`),
    h('div', `password: ${state.password}`),
    h('div.tiny.muted', { style: { marginTop: '4px' } }, 'Sign-in uses this username; the email is generated for you.'),
  ]);
  const refreshPreview = () => {
    credPreview.innerHTML = '';
    credPreview.appendChild(h('div', `username: ${usernameInput.value || '(not set)'}`));
    credPreview.appendChild(h('div', `password: ${passwordInput.value || '(not set)'}`));
    credPreview.appendChild(h('div.tiny.muted', { style: { marginTop: '4px' } }, 'Sign-in uses this username; the email is generated for you.'));
  };

  // team dropdown depends on the chosen game
  const loadTeams = async () => {
    const gid = gameSelect.querySelector('select')?.value;
    const sel = teamSelect.querySelector('select');
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, 'No team'));
    if (!gid) return;
    const { data } = await api.listTeams(gid);
    (data || []).forEach((t) => sel.appendChild(h('option', { value: t.id }, t.name)));
  };
  gameSelect.addEventListener('change', loadTeams);
  loadTeams();

  const submit = h('button.btn-primary.btn-block.btn-lg', { style: { marginTop: '6px' } }, 'Create Player');

  submit.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const role = roleSelect.querySelector('select').value;
    const gameId = gameSelect.querySelector('select').value;
    const teamId = teamSelect.querySelector('select').value;

    if (username.length < 3) return toast('Username must be at least 3 characters.', 'bad');
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return toast('Username may only contain letters, numbers, dot, dash and underscore.', 'bad');
    if (password.length < 6) return toast('Password must be at least 6 characters.', 'bad');
    if (!gameId && role === 'player') return toast('Pick the game this player belongs to.', 'bad');

    if (role === 'admin' || role === 'manager') {
      const ok = await confirmDialog(`Create ${ROLE_META[role].label}?`,
        `${ROLE_META[role].label} accounts can create other users. Only do this for people you trust.`, 'Create', 'primary');
      if (!ok) return;
    }

    submit.disabled = true;
    submit.textContent = 'Creating…';
    const { data, error } = await api.createAccount({
      username,
      password,
      role,
      displayName: displayInput.value.trim() || null,
      gameId: gameId || null,
      teamIds: teamId ? [teamId] : [],
      gamemasterId: role === 'player' ? (store.role === 'gamemaster' ? me.id : undefined) : undefined,
    });
    submit.disabled = false;
    submit.textContent = 'Create Player';

    if (error) {
      toast(error.message || 'Could not create the account.', 'bad');
      return;
    }

    const creds = data.credentials || { username, password };
    usernameInput.value = '';
    passwordInput.value = randomPassword();
    displayInput.value = '';
    refreshPreview();
    await ctx.reloadGames();

    await openModal({
      title: `${ROLE_META[role].label} created`,
      body: h('div', [
        h('p', { style: { marginTop: 0 } }, 'Hand these details to the player. They cannot sign up themselves.'),
        h('div.tile.mono', [
          h('div', { style: { fontSize: '18px', fontWeight: '700' } }, esc(creds.username)),
          h('div', { style: { fontSize: '18px' } }, esc(creds.password)),
          creds.fake_email ? h('div.tiny.muted', { style: { marginTop: '8px' } }, esc(creds.fake_email)) : null,
        ]),
        data.warnings?.length ? h('div.tiny', { style: { marginTop: '10px', color: '#b26a00' } }, data.warnings.join(' ')) : null,
        h('div.row', { style: { marginTop: '14px' } }, [
          h('button.btn-ghost', {
            onclick: async () => {
              const text = `Interchange login\nusername: ${creds.username}\npassword: ${creds.password}`;
              try { await navigator.clipboard.writeText(text); toast('Copied', 'good'); } catch { toast('Copy failed'); }
            },
          }, 'Copy'),
        ]),
      ]),
      actions: [{ label: 'Done', value: true, kind: 'primary' }],
    });
  });

  usernameInput.addEventListener('input', refreshPreview);
  passwordInput.addEventListener('input', refreshPreview);

  const dice = h('button.icon-btn.plain', {
    title: 'Random username',
    onclick: () => { usernameInput.value = randomUsername(); refreshPreview(); },
  }, ui.icon('shuffle', { size: 20 }));
  const dicePw = h('button.icon-btn.plain', {
    title: 'Random password',
    onclick: () => { passwordInput.value = randomPassword(); refreshPreview(); },
  }, ui.icon('refresh', { size: 20 }));

  const fields = [
    ui.field('Username', h('div.row', [usernameInput, dice])),
    ui.field('Password', h('div.row', [passwordInput, dicePw])),
  ];

  if (roles.length > 1) fields.push(ui.field('Role', roleSelect, ''));
  fields.push(h('div.tiny.muted', { style: { margin: '-10px 0 16px' } }, roleHint.textContent));
  roleSelect.addEventListener('change', () => { roleHint.textContent = ROLE_META[roleSelect.querySelector('select').value]?.blurb || ''; });

  if (roleIsPlayer()) {
    fields.push(ui.field('Game', gameSelect, 'Which game should this player score in?'));
    fields.push(ui.field('Team', teamSelect, 'Optional. You can shuffle teams later.'));
  } else {
    fields.push(ui.field('Game', gameSelect, 'Games this person runs or helps with (optional for admins).'));
  }
  fields.push(ui.field('Display name', displayInput, 'Optional. Otherwise the username is shown.'));

  function roleIsPlayer() { return roleSelect.querySelector('select').value === 'player'; }
  roleSelect.addEventListener('change', () => {
    const isPlayer = roleIsPlayer();
    teamSelect.closest('.field')?.classList.toggle('hidden', !isPlayer);
  });

  return h('div', [
    ...fields,
    credPreview,
    submit,
    h('div.tiny.muted', { style: { marginTop: '12px' } },
      'Accounts are created with a generated email address on your Supabase project. Nobody can sign themselves up.'),
  ]);
}

/* ================================================================ TEAM ==== */

function teamPanel() {
  const games = assignableGames(store.games);
  const state = { gameId: store.game?.id || games[0]?.id || '' };
  const nameInput = ui.textInput({ placeholder: 'e.g. Team 1' });
  const descInput = ui.textInput({ placeholder: 'optional' });
  const gameSelect = ui.selectInput(
    games.length ? games.map((g) => ({ value: g.id, label: g.name })) : [{ value: '', label: 'No game available', disabled: true }],
    { value: state.gameId },
  );
  const list = h('div', { style: { marginTop: '18px' } });

  const loadList = async () => {
    list.innerHTML = '';
    const gid = gameSelect.querySelector('select').value;
    if (!gid) { list.appendChild(ui.emptyState('Create a game first.')); return; }
    list.appendChild(ui.spinner('dark'));
    const { data } = await api.listTeams(gid);
    list.innerHTML = '';
    if (!data?.length) { list.appendChild(ui.emptyState('No teams in this game yet.')); return; }
    data.forEach((t) => {
      list.appendChild(h('div.member', [
        h('div.m-name', [
          h('div', { style: { fontWeight: '600' } }, esc(t.name)),
          h('div.m-sub', `${(t.team_members || []).length} member${(t.team_members || []).length === 1 ? '' : 's'}${t.description ? ' · ' + esc(t.description) : ''}`),
        ]),
        ui.iconButton('edit', () => rename(t), { title: 'Rename', cls: 'sm' }),
        ui.iconButton('trash', async () => {
          const ok = await confirmDialog('Delete team?', `"${t.name}" will be removed. Members stay in the game.`, 'Delete', 'danger');
          if (!ok) return;
          const { error } = await api.deleteTeam(t.id);
          if (error) return toast(error.message, 'bad');
          toast('Team deleted');
          loadList();
        }, { title: 'Delete', cls: 'sm' }),
      ]));
    });
  };

  async function rename(t) {
    const input = ui.textInput({ value: t.name });
    const desc = ui.textInput({ value: t.description || '', placeholder: 'description' });
    const res = await openModal({
      title: 'Rename team',
      body: h('div', [ui.field('Name', input), ui.field('Description', desc)]),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', kind: 'primary' }],
    });
    if (!res) return;
    const { error } = await api.renameTeam(t.id, input.value.trim(), desc.value.trim() || null);
    if (error) return toast(error.message, 'bad');
    toast('Team updated', 'good');
    loadList();
  }

  gameSelect.addEventListener('change', loadList);

  const submit = h('button.btn-primary.btn-block.btn-lg', async () => {
    const gid = gameSelect.querySelector('select').value;
    const name = nameInput.value.trim();
    if (!gid) return toast('No game selected.', 'bad');
    if (name.length < 1) return toast('Give the team a name.', 'bad');
    submit.disabled = true;
    const { error } = await api.createTeam(gid, name, descInput.value.trim() || null);
    submit.disabled = false;
    if (error) return toast(error.message, 'bad');
    nameInput.value = ''; descInput.value = '';
    toast(`Team "${name}" created`, 'good');
    loadList();
  }, 'Create Team');

  loadList();

  return h('div', [
    ui.field('Team name', nameInput),
    ui.field('Game', gameSelect),
    ui.field('Description', descInput, 'Optional.'),
    submit,
    h('div', { style: { marginTop: '18px' } }, [
      h('div.small.muted', { style: { marginBottom: '8px' } }, 'Teams in this game'),
      list,
    ]),
  ]);
}
