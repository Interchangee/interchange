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

/* ------------------------------------------------------------------ forms */

/**
 * Build a small form and read it back by name.
 *
 *   const f = createForm([
 *     { name: 'name', label: 'Name', placeholder: 'Saturday Sprint' },
 *     { name: 'game', label: 'Game', type: 'select', options: [...], value: id },
 *   ]);
 *   host.append(f.el);
 *   const v = f.values();   // { name: '...', game: '...' }
 *   f.setError('name', 'required');
 *
 * Field spec: { name, label, type, value, placeholder, hint, options, min, max,
 *               rows, required, onChange }
 * type: text (default) | password | number | date | select | textarea
 */
export function createForm(fields, { submitLabel = null, onSubmit = null, submitKind = 'primary' } = {}) {
  const el = h('div', { style: { display: 'grid', gap: '10px' } });
  const controls = new Map();
  const errorSlots = new Map();

  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      const sel = h('select', { name: f.name });
      (f.options || []).forEach((o) => {
        const opt = h('option', { value: o.value }, o.label);
        if (o.disabled) opt.disabled = true;
        sel.appendChild(opt);
      });
      if (f.value !== undefined && f.value !== null) sel.value = String(f.value);
      input = h('div.select-wrap', sel);
      controls.set(f.name, sel);
    } else if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, rows: f.rows || 3, placeholder: f.placeholder || '' });
      controls.set(f.name, input);
    } else {
      input = h('input', {
        type: f.type || 'text',
        name: f.name,
        placeholder: f.placeholder || '',
        autocomplete: f.autocomplete || 'off',
        autocapitalize: f.autocapitalize || 'off',
        min: f.min, max: f.max, step: f.step,
      });
      if (f.value !== undefined && f.value !== null) input.value = String(f.value);
      controls.set(f.name, input);
    }
    if (f.onChange) controls.get(f.name).addEventListener('change', f.onChange);

    const err = h('div.tiny', { style: { color: 'var(--bad)', minHeight: '0' } });
    errorSlots.set(f.name, err);
    el.appendChild(h('label.field', { style: { marginBottom: '0' } }, [
      h('span', f.label),
      input,
      f.hint ? h('div.tiny.muted', { style: { marginTop: '6px' } }, f.hint) : null,
      err,
    ]));
    if (f.hidden) el.lastChild.classList.add('hidden');
  }

  const button = submitLabel
    ? h(`button.btn-${submitKind}.btn-block`, { type: 'button' }, submitLabel)
    : null;
  if (button) el.appendChild(button);

  const api = {
    el,
    controls,
    get: (name) => controls.get(name)?.value ?? '',
    reset() {
      for (const [, c] of controls) { if ('value' in c) c.value = ''; }
      api.clearErrors();
    },
    values() {
      const out = {};
      for (const [name, c] of controls) {
        out[name] = c.type === 'number' ? (c.value === '' ? null : Number(c.value)) : c.value.trim();
      }
      return out;
    },
    clearErrors() { errorSlots.forEach((e) => { e.textContent = ''; }); },
    setError(name, message) {
      const slot = errorSlots.get(name);
      if (slot) slot.textContent = message || '';
    },
    /** Returns true when every field passes its `required` check. */
    validate() {
      api.clearErrors();
      let ok = true;
      for (const f of fields) {
        if (!f.required) continue;
        const value = api.get(f.name);
        if (value === '' || value === null || value === undefined) {
          api.setError(f.name, `${f.label} is required`);
          ok = false;
        }
      }
      return ok;
    },
    busy(on, label) {
      if (!button) return;
      button.disabled = Boolean(on);
      if (label) button.textContent = on ? label : submitLabel;
    },
  };

  if (button && onSubmit) {
    button.addEventListener('click', async () => {
      if (!api.validate()) return;
      api.busy(true, 'Working…');
      try { await onSubmit(api); }
      finally { api.busy(false); }
    });
  }
  return api;
}
