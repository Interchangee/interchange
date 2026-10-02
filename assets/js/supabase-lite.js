/* ==========================================================================
   Minimal Supabase client (REST + GoTrue + Edge Functions).
   Written by hand so the whole app ships in ~40 kB with no bundler and no
   node_modules. Implements the subset of the supabase-js API we actually use.
   ========================================================================== */

const SESSION_KEY = 'ic.session.v1';
const REFRESH_SKEW_MS = 60_000;

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function writeSession(s) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
}

function isExpired(s) {
  if (!s || !s.access_token) return true;
  try {
    const [, payload] = s.access_token.split('.');
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!json.exp) return false;
    return json.exp * 1000 - REFRESH_SKEW_MS < Date.now();
  } catch { return false; }
}

class QueryBuilder {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this._filters = [];
    this._select = '*';
    this._order = [];
    this._limit = null;
    this._rangeFrom = null;
    this._rangeTo = null;
    this._method = 'GET';
    this._body = null;
    this._single = null;
    this._count = null;
    this._returning = true;
    this._onConflict = null;
    this._ignoreDuplicates = false;
    this._upsert = false;
    this._head = false;
  }

  select(sel = '*', opts = {}) {
    this._select = sel === null ? '' : sel;
    // "minimal" mirrors supabase-js: write nothing back, just acknowledge.
    if (this._select === '' || opts.minimal) this._returning = false;
    if (opts.count) this._count = opts.count;
    if (opts.head) this._head = true;
    return this;
  }
  order(col, opts = {}) {
    this._order.push(`${col}.${opts.ascending === false ? 'desc' : 'asc'}${opts.nullsFirst ? '.nullsfirst' : ''}`);
    return this;
  }
  limit(n) { this._limit = n; return this; }
  range(from, to) { this._rangeFrom = from; this._rangeTo = to; return this; }
  eq(col, val) { return this._cmp(col, 'eq', val); }
  neq(col, val) { return this._cmp(col, 'neq', val); }
  is(col, val) { return this._cmp(col, 'is', val); }
  not(col, op, val) { return this._cmp(col, `not.${op}`, val); }
  in(col, vals) { return this._cmp(col, 'in', `(${vals.map(v => (v === null ? 'null' : v)).join(',')})`); }
  gt(col, val) { return this._cmp(col, 'gt', val); }
  gte(col, val) { return this._cmp(col, 'gte', val); }
  lt(col, val) { return this._cmp(col, 'lt', val); }
  lte(col, val) { return this._cmp(col, 'lte', val); }
  like(col, val) { return this._cmp(col, 'like', val); }
  ilike(col, val) { return this._cmp(col, 'ilike', val); }
  or(filter) { this._filters.push(`or=(${filter})`); return this; }

  _cmp(col, op, val) {
    const v = val === null || val === undefined ? 'null' : String(val);
    this._filters.push(`${encodeURIComponent(col)}=${op}.${encodeURIComponent(v)}`);
    return this;
  }

  insert(rows) {
    this._method = 'POST';
    this._body = Array.isArray(rows) ? rows : [rows];
    this._returning = true;
    return this;
  }
  upsert(rows, opts = {}) {
    this._method = 'POST';
    this._body = Array.isArray(rows) ? rows : [rows];
    this._upsert = true;
    this._onConflict = opts.onConflict || null;
    this._ignoreDuplicates = Boolean(opts.ignoreDuplicates);
    return this;
  }
  update(patch) { this._method = 'PATCH'; this._body = patch; return this; }
  delete() { this._method = 'DELETE'; return this; }

  single() { this._single = 'single'; return this; }
  maybeSingle() { this._single = 'maybeSingle'; return this; }

  _qs() {
    const parts = [];
    if (this._select) parts.push(`select=${encodeURIComponent(this._select)}`);
    if (this._count) parts.push(`count=${this._count}`);
    if (this._onConflict) parts.push(`on_conflict=${encodeURIComponent(this._onConflict)}`);
    this._order.forEach((o) => parts.push(`order=${encodeURIComponent(o)}`));
    if (this._limit !== null) parts.push(`limit=${this._limit}`);
    if (this._rangeFrom !== null) parts.push(`offset=${this._rangeFrom}`);
    parts.push(...this._filters);
    return parts.join('&');
  }

  _headers() {
    const hdrs = {};
    if (this._method === 'POST' || this._method === 'PATCH' || this._method === 'DELETE') {
      const ret = this._returning ? 'representation' : 'minimal';
      const parts = [`return=${ret}`];
      if (this._method === 'POST' && this._upsert) {
        parts.push(this._ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates');
      }
      if (this._count) parts.push('count=exact');
      hdrs.Prefer = parts.join(',');
    }
    if (this._single === 'single') hdrs.Accept = 'application/vnd.pgrst.object+json';
    return hdrs;
  }

  then(resolve, reject) { return this._run().then(resolve, reject); }
  catch(fn) { return this._run().catch(fn); }
  finally(fn) { return this._run().finally(fn); }

  async _run() {
    const path = `/rest/v1/${this.table}?${this._qs()}`;
    const res = await this.client._request(path, {
      method: this._method,
      body: this._body,
      headers: this._headers(),
      count: this._count,
    });
    if (res.error) return { data: null, error: res.error, count: null, status: res.status };
    if (this._single === 'single' && Array.isArray(res.data)) {
      if (res.data.length === 1) return { ...res, data: res.data[0] };
      return { ...res, data: null, error: { message: 'No rows found', code: 'PGRST116' } };
    }
    if (this._single === 'maybeSingle' && Array.isArray(res.data)) {
      return { ...res, data: res.data.length ? res.data[0] : null };
    }
    return res;
  }
}

export class SupabaseLite {
  constructor(url, key) {
    this.url = (url || '').replace(/\/+$/, '');
    this.key = key || '';
    this.session = readSession();
    this._authListeners = new Set();
    this._refreshing = null;
    this._timer = null;
    if (this.session) this._scheduleRefresh();
  }

  /* ---------------- low level ---------------- */

  async _request(path, { method = 'GET', body = null, headers = {}, count = null, auth = true, raw = false, timeoutMs = 25000 } = {}) {
    const hdrs = {
      apikey: this.key,
      Accept: 'application/json',
      ...headers,
    };
    const token = this.session?.access_token;
    if (auth && token) hdrs.Authorization = `Bearer ${token}`;
    else if (auth) hdrs.Authorization = `Bearer ${this.key}`;

    let payload;
    if (body !== null && body !== undefined) {
      hdrs['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.url + path, { method, headers: hdrs, body: payload, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = err?.name === 'AbortError' ? 'Request timed out (check your connection)' : `Network error: ${err.message}`;
      return { data: null, error: { message: msg, code: 'network' }, status: 0 };
    }
    clearTimeout(timer);

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }

    const outCount = res.headers.get('content-range')
      ? Number(String(res.headers.get('content-range')).split('/').pop())
      : null;
    if (count && outCount !== null && !Number.isNaN(outCount)) count = outCount;

    if (!res.ok) {
      // A stale token should surface as an auth error so the app can re-login.
      const message = (data && (data.message || data.error_description || data.msg || data.hint)) || `HTTP ${res.status}`;
      return { data: null, error: { message, code: (data && data.code) || String(res.status), details: data, status: res.status }, status: res.status, count };
    }
    if (raw) return { data: text, error: null, status: res.status, count };
    return { data, error: null, status: res.status, count: count ?? outCount };
  }

  from(table) { return new QueryBuilder(this, table); }

  async rpc(fn, args = {}) {
    return this._request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
  }

  async invoke(fn, { body = {}, headers = {} } = {}) {
    return this._request(`/functions/v1/${fn}`, { method: 'POST', body, headers, timeoutMs: 40000 });
  }

  /* ---------------- auth ---------------- */

  _setSession(s) {
    this.session = s;
    writeSession(s);
    this._scheduleRefresh();
    this._authListeners.forEach((cb) => { try { cb(s ? 'SIGNED_IN' : 'SIGNED_OUT', s); } catch {} });
    return s;
  }

  onAuthStateChange(cb) {
    this._authListeners.add(cb);
    return { data: { subscription: { unsubscribe: () => this._authListeners.delete(cb) } } };
  }

  get user() { return this.session?.user || null; }
  get accessToken() { return this.session?.access_token || null; }

  _scheduleRefresh() {
    clearTimeout(this._timer);
    if (!this.session) return;
    let ms = 30 * 60_000;
    try {
      const [, payload] = this.session.access_token.split('.');
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (json.exp) ms = Math.max(5000, json.exp * 1000 - Date.now() - REFRESH_SKEW_MS);
    } catch {}
    this._timer = setTimeout(() => { this.refresh().catch(() => {}); }, Math.min(ms, 30 * 60_000));
  }

  async signInWithPassword({ email, password }) {
    const res = await this._request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password }, auth: false,
    });
    if (res.error) return { data: { user: null, session: null }, error: res.error };
    this._setSession(res.data);
    return { data: { user: res.data.user, session: res.data }, error: null };
  }

  async refresh() {
    if (!this.session?.refresh_token) return { data: null, error: { message: 'no session' } };
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const res = await this._request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: { refresh_token: this.session.refresh_token }, auth: false,
      });
      this._refreshing = null;
      if (res.error) { this._setSession(null); return res; }
      this._setSession({ ...res.data, user: res.data.user ?? this.session.user });
      return res;
    })();
    return this._refreshing;
  }

  async getUser() {
    if (!this.session) return { data: { user: null }, error: null };
    if (isExpired(this.session)) { await this.refresh().catch(() => {}); }
    const res = await this._request('/auth/v1/user', { method: 'GET' });
    if (res.error && res.status === 401) { this._setSession(null); }
    if (res.data && this.session) this._setSession({ ...this.session, user: res.data });
    return { data: { user: res.data }, error: res.error };
  }

  async signOut() {
    try { await this._request('/auth/v1/logout', { method: 'POST' }); } catch {}
    this._setSession(null);
    return { error: null };
  }

  /* convenience: ensure we have a valid token before writing */
  async ensureFresh() {
    if (this.session && isExpired(this.session)) await this.refresh().catch(() => {});
    return Boolean(this.session);
  }
}

export function createClient(url, key) {
  return new SupabaseLite(url, key);
}
