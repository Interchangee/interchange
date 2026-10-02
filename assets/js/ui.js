/* ==========================================================================
   Shared UI parts: icons, headers, cards, the overlay shell.
   Icons are inline SVG paths (no icon font, no image requests).
   ========================================================================== */

import { h, append, esc, fmtNum } from './dom.js';
import store from './store.js';

/* ------------------------------------------------------------------ icons */

const P = {
  home: '<path d="M12 3.2 3 10.4V21h6.2v-6.4h5.6V21H21V10.4z"/>',
  ticket: '<path d="M4 6h16a1 1 0 0 1 1 1v3.2a2 2 0 0 0 0 3.6V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3.2a2 2 0 0 0 0-3.6V7a1 1 0 0 1 1-1Zm3 3v6h2V9Zm4 0v6h2V9Z"/>',
  person: '<path d="M12 12a4.2 4.2 0 1 0 0-8.4A4.2 4.2 0 0 0 12 12Zm0 2c-3.6 0-7 1.9-7 4.4V21h14v-2.6c0-2.5-3.4-4.4-7-4.4Z"/>',
  people: '<path d="M8.6 11.4a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Zm7.2.6a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM2.6 20.4h12v-1.9c0-1.1-.6-2-1.6-2.7a9.6 9.6 0 0 0-8.8 0c-1 .7-1.6 1.6-1.6 2.7Zm12.9 0h5.9v-1.6c0-.9-.5-1.6-1.3-2.1a6.5 6.5 0 0 0-3.4-.9c-.6 0-1.2.1-1.7.2.6.8 1 1.8 1 3V20.4Z"/>',
  checklist: '<path d="M3 5h11v2H3zm0 6h11v2H3zm0 6h11v2H3zm13.6-9.4 1.5 1.5 3.4-3.4 1.4 1.4-4.8 4.8-2.9-2.9z"/>',
  info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1.1 15.2h-2.2v-6.5h2.2Zm0-8.3h-2.2V6.7h2.2Z"/>',
  shuffle: '<path d="M17 3.5 21.5 8 17 12.5v-3h-1.8l-2.1 2.6-1.3-1.6 2.6-3.2H17Zm0 11L21.5 19 17 23.5v-3h-2.3l-2.4-3 1.3-1.6 1.9 2.4H17ZM2.5 8h4.2l3.1 3.9-1.3 1.6L5.8 10.1H2.5Zm0 8h4.2l6.2-7.9H17v3l-4-3.5H6.7Z"/>',
  refresh: '<path d="M12 5V2L7.5 6.5 12 11V8a4.8 4.8 0 1 1-4.7 5.9H5A7 7 0 1 0 12 5Z"/>',
  trash: '<path d="M9 3h6l.8 1.5H20v2H4v-2h4.2Zm-3 5h12l-.9 12.1a1.5 1.5 0 0 1-1.5 1.4H8.4a1.5 1.5 0 0 1-1.5-1.4Z"/>',
  edit: '<path d="M4 17.2 15.4 5.8l3.3 3.3L7.3 20.5H4Zm14.7-10.8-1.5-1.5 1.3-1.3a1 1 0 0 1 1.4 0l.3.3a1 1 0 0 1 0 1.4Z"/>',
  plus: '<path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/>',
  minus: '<path d="M4 11h16v2H4z"/>',
  check: '<path d="M9.2 16.4 4.8 12l-1.4 1.4 5.8 5.8L20.6 7.8 19.2 6.4z"/>',
  close: '<path d="m12 10.6 4.9-4.9 1.4 1.4L13.4 12l4.9 4.9-1.4 1.4L12 13.4l-4.9 4.9-1.4-1.4L10.6 12 5.7 7.1l1.4-1.4z"/>',
  play: '<path d="M7 4.5 20 12 7 19.5z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  pin: '<path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.4A2.4 2.4 0 1 1 12 6.6a2.4 2.4 0 0 1 0 4.8Z"/>',
  bus: '<path d="M6 2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-1 1.7V20a1.5 1.5 0 0 1-3 0v-2H8v2a1.5 1.5 0 0 1-3 0v-3.3A2 2 0 0 1 4 15V4a2 2 0 0 1 2-2Zm0 4v6h12V6Zm1.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm9 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>',
  rail: '<path d="M6 2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2l2 4h-2.6l-1.4-3h-8l-1.4 3H4l2-4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 4v5h12V6Zm1.6 8.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Zm8.8 0a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z"/>',
  tram: '<path d="M7 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm1 3v7h8V5Zm-1 12h10l1.8 3h-2.3l-1.2-2h-6.6l-1.2 2H5.2ZM9 19a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/>',
  ferry: '<path d="M11 2h2v3h4l-1.4 4H19l2 6c-1.6 1.4-3.2 2-4.8 2-1.5 0-2.7-.5-4.2-1.4-1.5.9-2.7 1.4-4.2 1.4C6.2 17 4.6 16.4 3 15l2-6h1.4L5 5h6Zm-4 9h10l.7-2H7.7Z"/>',
  search: '<path d="M10.5 3a7.5 7.5 0 1 0 4.6 13.4l4.2 4.3 1.5-1.5-4.2-4.2A7.5 7.5 0 0 0 10.5 3Zm0 2.2a5.3 5.3 0 1 1 0 10.6 5.3 5.3 0 0 1 0-10.6Z"/>',
  logout: '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5Zm4.6 3.6-1.4 1.4L15.2 10H9v2h6.2l-2 2 1.4 1.4L19 11z"/>',
  download: '<path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4L11 12.2Z"/><path d="M4 18h16v2H4z"/>',
  qr: '<path d="M3 3h8v8H3Zm2 2v4h4V5Zm8-2h8v8h-8Zm2 2v4h4V5ZM3 13h8v8H3Zm2 2v4h4v-4Zm11-2h2v2h-2Zm3 0h2v3h-2Zm-5 3h2v2h-2Zm4 1h2v2h-2Zm-2 2h2v2h-2Zm-4-3h2v5h-2Z"/>',
  clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5h-2v6l5 3 1-1.7-4-2.3Z"/>',
  route: '<path d="M6 2a3 3 0 0 1 1 5.8V16a2 2 0 0 0 2 2h6a3 3 0 1 1 0 2H9a4 4 0 0 1-4-4V7.8A3 3 0 0 1 6 2Zm11.5 12.5A3 3 0 1 1 14 17.5Z" opacity=".0"/><path d="M5.5 2.5A3 3 0 0 0 4 8v9a4 4 0 0 0 4 4h6.2a2.5 2.5 0 1 1 0-2H8a2 2 0 0 1-2-2V8a3 3 0 0 0-.5-5.5Z"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.5 9.7l5.9-.8Z"/>',
  warn: '<path d="M12 2 1.5 21h21Zm-1 6h2v7h-2Zm0 9h2v2h-2Z"/>',
  wifi: '<path d="M12 20.5 8.8 17a4.5 4.5 0 0 1 6.4 0ZM12 12a8.5 8.5 0 0 1 6 2.5l1.5-1.6A10.7 10.7 0 0 0 12 10a10.7 10.7 0 0 0-7.5 2.9L6 14.5A8.5 8.5 0 0 1 12 12Zm0-5a13.5 13.5 0 0 1 9.5 3.9l1.5-1.6A15.7 15.7 0 0 0 12 5 15.7 15.7 0 0 0 1 9.8l1.5 1.6A13.5 13.5 0 0 1 12 7Z"/>',
  cloud: '<path d="M6.5 19a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 17.6 9.6 4.2 4.2 0 0 1 17.5 19Z"/>',
  grid: '<path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>',
};

export function icon(name, { size = 24, cls = '', fill = 'currentColor' } = {}) {
  const path = P[name] || P.info;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', fill);
  el.setAttribute('aria-hidden', 'true');
  if (cls) el.setAttribute('class', cls);
  el.innerHTML = path;
  return el;
}

export function modeIcon(mode, size = 20) {
  return icon(mode === 'rail' ? 'rail' : mode === 'tram' ? 'tram' : mode === 'ferry' ? 'ferry' : 'bus', { size });
}

/* ------------------------------------------------------------------ parts */

export function card(children, { cls = '', id = null } = {}) {
  return h(`div.card${cls ? '.' + cls.split(' ').join('.') : ''}`, id ? { id } : null, children);
}

export function statGrid(items) {
  return h('div.stat-grid', items.map((i) => h('div.stat', [h('b', fmtNum(i.value)), h('span', i.label)])));
}

export function kv(k, v) {
  return h('div.kv', [h('div.k', k), h('div.v', v)]);
}

export function emptyState(text) {
  return h('div.empty', text);
}

export function spinner(cls = '') {
  return h(`div.spinner${cls ? '.' + cls : ''}`);
}

export function pill(text, kind = '') {
  return h(`span.pill${kind ? '.' + kind : ''}`, text);
}

export function field(label, input, hint) {
  return h('label.field', [
    h('span', label),
    input,
    hint ? h('div.tiny.muted', { style: { marginTop: '6px' } }, hint) : null,
  ]);
}

export function textInput(props = {}) { return h('input', { type: 'text', ...props }); }

export function selectInput(options, props = {}) {
  const sel = h('select', props);
  options.forEach((o) => {
    const opt = h('option', { value: o.value }, o.label);
    if (o.disabled) opt.disabled = true;
    sel.appendChild(opt);
  });
  return h('div.select-wrap', sel);
}

export function iconButton(name, onClick, { title = '', cls = '', size = 20 } = {}) {
  return h(`button.icon-btn${cls ? '.' + cls.split(' ').join('.') : ''}`, { onclick: onClick, title, 'aria-label': title || name }, icon(name, { size }));
}

/** A route "badge" coloured by mode, like a headsign plate. */
export function routeBadge(candidate) {
  const mode = candidate?.route_mode || 'bus';
  return h(`div.badge-route.mode-${mode}`, String(candidate?.route_short_name || '?').slice(0, 6));
}

/* ---------------------------------------------------------------- overlay */

/**
 * Full-screen orange overlay used for the enter/exit flow.
 * Returns { root, body, setTitle, close }.
 */
export function overlay(title, { onClose = null, dots = 0, activeDot = 0 } = {}) {
  const body = h('div.overlay-inner');
  const head = h('div.overlay-head', [
    onClose ? h('button.appbar-btn', { onclick: onClose, 'aria-label': 'Close' }, icon('close', { size: 26 })) : null,
    h('h2', title),
  ]);
  const root = h('div.overlay', [h('div.overlay-inner', { style: { padding: 0, display: 'flex', flexDirection: 'column' } }, [head, body])]);
  document.body.appendChild(root);
  document.body.style.overflow = 'hidden';

  let dotHost = null;
  if (dots > 0) {
    dotHost = h('div.step-dots');
    body.appendChild(dotHost);
  }
  const renderDots = (active) => {
    if (!dotHost) return;
    dotHost.innerHTML = '';
    for (let i = 0; i < dots; i++) dotHost.appendChild(h(`i${i === active ? '.on' : ''}`));
  };
  if (dotHost) renderDots(activeDot);

  return {
    root, body, head,
    setTitle(t) { head.querySelector('h2').textContent = t; },
    setDot(i) { renderDots(i); },
    close() {
      document.body.style.overflow = '';
      root.remove();
    },
  };
}

/* ------------------------------------------------------------------ appbar */

export function appBar({ title, subtitle, right = [], onLeft = null }) {
  return h('header.appbar', [
    onLeft ? h('button.appbar-btn', { onclick: onLeft, 'aria-label': 'Back' }, icon('close', { size: 24 })) : null,
    h('div.brand', { style: { paddingLeft: onLeft ? '0' : '8px' } }, [
      icon('route', { size: 28 }),
      h('div', [h('div', title), subtitle ? h('small', subtitle) : null]),
    ]),
    ...right,
  ]);
}

export function gamePill() {
  const g = store.game;
  const name = g?.name || (store.games.length ? 'Select a game' : 'No game yet');
  return h('span.pill', { style: { background: 'rgba(255,255,255,.22)', color: '#fff' } }, name);
}
