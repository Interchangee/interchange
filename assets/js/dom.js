/* ==========================================================================
   Tiny DOM + formatting helpers. No framework, no build step.
   ========================================================================== */

/** Create an element: h('div.card', {onclick}, [children]) */
export function h(spec, props = null, children = null) {
  const raw = String(spec);
  const hashAt = raw.indexOf('#');
  const head = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const id = hashAt >= 0 ? raw.slice(hashAt + 1).split('.')[0] : null;
  const [tag, ...classes] = head.split('.');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.filter(Boolean).join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children = props;
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) { children.forEach((c) => append(parent, c)); return parent; }
  parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- formatting ---------- */

export function pad2(n) { return String(n).padStart(2, '0'); }

export function fmtTime(d) {
  if (!d) return '--:--';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(+x)) return '--:--';
  return `${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

export function fmtDateTime(d) {
  if (!d) return '-';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(+x)) return '-';
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} ${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return hh > 0 ? `${hh}h ${pad2(mm)}m` : `${mm}m`;
}

export function fmtDurClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

export function fmtDist(m) {
  if (m === null || m === undefined || !Number.isFinite(+m)) return '-';
  const v = +m;
  return v < 950 ? `${Math.round(v)} m` : `${(v / 1000).toFixed(2)} km`;
}

export function fmtNum(n, digits = 0) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function relTime(d) {
  if (!d) return 'never';
  const t = (Date.now() - new Date(d).getTime()) / 1000;
  if (t < 45) return 'just now';
  if (t < 3600) return `${Math.round(t / 60)} min ago`;
  if (t < 86400) return `${Math.round(t / 3600)} h ago`;
  return `${Math.round(t / 86400)} d ago`;
}

/* ---------- ui primitives ---------- */

let toastHost = null;
export function toast(msg, kind = '', ms = 3200) {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.appendChild(toastHost);
  }
  const el = h('div.toast', { class: kind }, msg);
  toastHost.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, ms - 250);
  setTimeout(() => el.remove(), ms);
}

/**
 * Promise-based confirm/prompt sheet built on <dialog>.
 * openModal({ title, body: Node|string, actions: [{label, value, kind}] }) -> value|undefined
 */
export function openModal({ title, body, actions = [{ label: 'Close', value: null }], dismissable = true }) {
  return new Promise((resolve) => {
    const dlg = h('dialog.modal');
    const bodyEl = h('div.modal-body');
    if (title) bodyEl.appendChild(h('h3', { style: { margin: '0 0 10px' } }, title));
    append(bodyEl, body);
    const foot = h('div.modal-foot');
    const done = (v) => { try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
    actions.forEach((a) => {
      foot.appendChild(h('button', {
        class: a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost',
        onclick: () => {
          if (a.onClick) { const r = a.onClick(dlg); if (r !== undefined) return done(r); }
          done(a.value);
        },
      }, a.label));
    });
    if (dismissable) {
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(undefined); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) done(undefined); });
    }
    dlg.appendChild(bodyEl);
    dlg.appendChild(foot);
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  });
}

export function confirmDialog(title, message, confirmLabel = 'Confirm', kind = 'primary') {
  return openModal({
    title,
    body: h('p', { style: { margin: 0, color: '#4a4f57' } }, message),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, kind }],
  });
}

/* ---------- misc ---------- */

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function groupBy(list, keyFn) {
  const m = new Map();
  for (const item of list || []) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

export function unique(arr) { return Array.from(new Set(arr)); }

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
