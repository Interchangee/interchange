/* ==========================================================================
   First-run setup + sign-in.

   There is deliberately no sign-up: accounts only exist because an admin,
   manager or gamemaster created them. Players sign in with the username they
   were handed; we map it to the generated email behind the scenes.
   ========================================================================== */

import { h, esc, toast } from '../dom.js';
import * as ui from '../ui.js';
import store from '../store.js';
import config from '../config.js';
import * as api from '../api.js';
import { icon } from '../ui.js';

/* --------------------------------------------------------------- setup ---- */

export function renderSetup(onDone) {
  const url = ui.textInput({ value: config.url, placeholder: 'https://yourproject.supabase.co', autocomplete: 'off' });
  const key = ui.textInput({ value: config.key, placeholder: 'anon / publishable key', autocomplete: 'off' });
  const status = h('div.tiny.muted');

  const save = h('button.btn-primary.btn-block.btn-lg', async () => {
    const u = url.value.trim();
    const k = key.value.trim();
    if (!/^https?:\/\//.test(u)) return toast('The project URL should start with https://', 'bad');
    if (k.length < 30) return toast('That does not look like a Supabase anon key.', 'bad');
    config.save({ url: u, key: k });
    store.rebuildClient();

    status.textContent = 'Contacting your project…';
    const probe = await store.client.rpc('email_for_username', { uname: '__probe__' });
    if (probe.error && /Could not find the function|schema cache|404/i.test(probe.error.message || '')) {
      status.textContent = '';
      toast('Connected, but the database schema is missing. Run supabase/migrations/0001_init.sql first.', 'bad');
      return;
    }
    status.textContent = '';
    toast('Connected', 'good');
    onDone();
  });

  const root = h('div.auth-wrap', h('div.auth-card', [
    h('div.auth-logo', [
      h('div', { style: { background: 'var(--orange)', borderRadius: '14px', padding: '10px', display: 'flex' } }, icon('route', { size: 30, fill: '#fff' })),
      h('div', [h('h1', 'Interchange'), h('div.small.muted', 'GPS transit game')]),
    ]),
    h('p.small.muted', 'Connect this app to your own Supabase project. Both values are safe to store in the browser — the anon key only grants what Row Level Security allows.'),
    ui.field('Project URL', url),
    ui.field('Anon (publishable) key', key),
    save,
    status,
    h('details', { style: { marginTop: '16px' } }, [
      h('summary.small.muted', 'Where do I find these?'),
      h('ol.small.muted', { style: { paddingLeft: '18px' } }, [
        h('li', 'Create a free project at supabase.com.'),
        h('li', 'Open the SQL editor and run supabase/migrations/0001_init.sql.'),
        h('li', 'Settings → API gives you the Project URL and the anon key.'),
        h('li', 'Then deploy the create-user edge function so staff can add players.'),
      ]),
    ]),
  ]));
  return root;
}

/* ---------------------------------------------------------------- login --- */

export function renderLogin() {
  const username = ui.textInput({
    placeholder: 'username (or the full email address)',
    autocomplete: 'username',
    autocapitalize: 'off',
  });
  const password = h('input', { type: 'password', placeholder: 'your password', autocomplete: 'current-password' });
  const err = h('div.small', { style: { color: '#b3261e', minHeight: '18px', margin: '4px 0 8px' } });

  const submit = h('button.btn-primary.btn-block.btn-lg', 'Sign in');

  const doLogin = async () => {
    const u = username.value.trim();
    const p = password.value;
    if (!u || !p) { err.textContent = 'Enter your username and password.'; return; }
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    err.textContent = '';
    const { error } = await api.signIn(u, p);
    submit.disabled = false;
    submit.textContent = 'Sign in';
    if (error) { err.textContent = error.message || 'Sign-in failed.'; return; }

    // Fresh project? Whoever gets here first becomes the admin.
    const claim = h('div', { style: { marginTop: '14px' } });
    const card = submit.closest('.auth-card') || submit.parentNode;
    card?.appendChild(claim);
    const state = await api.adminExists();
    if (state.data === true) {
      claim.appendChild(h('div.tile', { style: { marginBottom: '10px' } }, [
        h('div', { style: { fontWeight: '700' } }, 'This project has no admin yet'),
        h('div.small.muted', 'Claim it now to become the administrator of Interchange.'),
      ]));
      claim.appendChild(h('button.btn-orange.btn-block', {
        onclick: async () => {
          const res = await api.claimFirstAdmin();
          if (res.error) { toast(res.error.message, 'bad'); return; }
          if (res.data?.ok === false) { toast(res.data.reason || 'Could not claim', 'bad'); return; }
          toast('You are the admin now', 'good');
          location.reload();
        },
      }, 'Make me the admin'));
      claim.appendChild(h('button.btn-ghost.btn-block', {
        style: { marginTop: '8px' },
        onclick: () => location.reload(),
      }, 'Sign in without claiming'));
      return;
    }
    location.reload();
  };

  submit.addEventListener('click', doLogin);
  [username, password].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); }));

  return h('div.auth-wrap', h('div.auth-card', [
    h('div.auth-logo', [
      h('div', { style: { background: 'var(--orange)', borderRadius: '14px', padding: '10px', display: 'flex' } }, icon('route', { size: 30, fill: '#fff' })),
      h('div', [h('h1', 'Interchange'), h('div.small.muted', 'Ride transit. Get points.')]),
    ]),
    ui.field('Username', username, 'Accounts made in the Supabase dashboard have no username yet — sign in with their full email address.'),
    ui.field('Password', password),
    err,
    submit,
    h('p.tiny.muted', { style: { marginTop: '14px' } },
      'Accounts are created by an admin, manager or gamemaster — there is no public sign-up.'),
    h('p.tiny.muted', escapeHint()),
  ]));
}

function escapeHint() {
  const link = h('a', {
    href: '#',
    style: { color: 'var(--navy)' },
    onclick: (e) => {
      e.preventDefault();
      config.reset();
      location.reload();
    },
  }, 'Change Supabase connection');
  return h('span', ['Wrong project? ', link]);
}
