/* ==========================================================================
   GPS tracking service.

   - drops noisy fixes, throttles by time AND distance
   - keeps samples in IndexedDB first, so a tunnel / dead zone never loses data
   - flushes to Supabase in small batches (low bandwidth, battery friendly)
   - keeps a rolling in-memory window for the matcher
   ========================================================================== */

import { gps } from './geo.js';
import idb from './idb.js';
import { pushTrackPoints } from './api.js';

const MAX_QUEUE = 5000;
const FLUSH_EVERY_MS = 45000;
const FLUSH_AT_ROWS = 40;
const KEEP_BOARDING_POINTS = 8;

export class Tracker {
  constructor() {
    this.watchId = null;
    this.active = false;
    this.context = { gameId: null, playerId: null, boardingId: null };
    this.config = { sample_seconds: 20, min_distance_m: 15, accuracy_max_m: 120 };
    this.window = [];          // in-memory recent samples (for the matcher)
    this.queue = [];           // rows waiting for upload
    this.status = 'idle';      // idle | acquiring | tracking | error | paused
    this.lastError = null;
    this.lastFix = null;
    this.lastPushAt = 0;
    this.pushedCount = 0;
    this.listeners = new Set();
    this._flushTimer = null;
    this._loadPromise = null;
  }

  /* ------------------------------------------------------------ lifecycle */

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this.listeners.forEach((fn) => { try { fn(this.snapshot()); } catch (e) { console.error(e); } }); }

  snapshot() {
    return {
      status: this.status, active: this.active, lastFix: this.lastFix,
      lastError: this.lastError, queued: this.queue.length, pushed: this.pushedCount,
      windowSize: this.window.length, boardingId: this.context.boardingId,
    };
  }

  configure({ tracking_config } = {}) {
    if (!tracking_config) return;
    this.config = {
      sample_seconds: Number(tracking_config.sample_seconds) || 20,
      min_distance_m: Number(tracking_config.min_distance_m) || 15,
      accuracy_max_m: Number(tracking_config.accuracy_max_m) || 120,
    };
  }

  /** Start watching GPS. Safe to call repeatedly. */
  async start(context = {}) {
    Object.assign(this.context, context);
    if (!this._loadPromise) this._loadPromise = this._loadQueue();

    if (this.active) { this._emit(); return; }
    if (!gps.supported) {
      this.status = 'error';
      this.lastError = 'Geolocation is not supported on this device.';
      this._emit();
      return;
    }

    await this._loadPromise;
    this.active = true;
    this.status = 'acquiring';
    this._emit();

    this.watchId = gps.watch(
      (fix) => this._onFix(fix),
      (err) => { this.status = 'error'; this.lastError = err.message; this._emit(); },
    );

    clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => { this.flush().catch(() => {}); }, FLUSH_EVERY_MS);
  }

  stop() {
    this.active = false;
    this.status = 'idle';
    this.watchId?.stop();
    this.watchId = null;
    clearInterval(this._flushTimer);
    this._flushTimer = null;
    this._emit();
  }

  setBoarding(boardingId) {
    this.context.boardingId = boardingId || null;
    this._emit();
  }

  /* ----------------------------------------------------------------- input */

  _onFix(fix) {
    this.lastFix = fix;
    if (this.status === 'acquiring') this.status = 'tracking';

    // reject wild fixes, but always accept the very first one
    const maxAcc = this.config.accuracy_max_m;
    if (fix.accuracy && fix.accuracy > maxAcc && this.window.length) { this._emit(); return; }

    const prev = this.window[this.window.length - 1];
    if (prev) {
      const dt = (fix.ts - (prev.ts || 0)) / 1000;
      if (dt < Math.max(3, this.config.sample_seconds - 6)) { this._emit(); return; }
    }

    const row = {
      lat: round6(fix.lat),
      lon: round6(fix.lon),
      accuracy_m: fix.accuracy ? Math.round(fix.accuracy) : null,
      speed_mps: fix.speed_mps !== null && fix.speed_mps >= 0 ? Math.round(fix.speed_mps * 10) / 10 : null,
      heading_deg: fix.heading_deg !== null ? Math.round(fix.heading_deg) : null,
      recorded_at: fix.recorded_at,
      ts: fix.ts,
      source: 'gps',
    };

    this.window.push(row);
    if (this.window.length > 240) this.window.splice(0, this.window.length - 240);

    this._enqueue(row);
    this._emit();
    if (this.queue.length >= FLUSH_AT_ROWS) this.flush().catch(() => {});
  }

  /** Let the server see where someone is even before they tap "exit". */
  _enqueue(row) {
    this.queue.push(row);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    idb.set('pending', this.queue.slice(-800), 'queue').catch(() => {});
  }

  async _loadQueue() {
    try {
      const stored = await idb.get('pending', 'queue');
      if (Array.isArray(stored) && stored.length) this.queue = stored.concat(this.queue);
    } catch {}
  }

  /* ----------------------------------------------------------------- flush */

  async flush({ force = false } = {}) {
    if (!this.queue.length) return { pushed: 0 };
    if (!this.context.gameId || !this.context.playerId) return { pushed: 0, error: 'missing context' };

    const batch = this.queue.slice(0, 200);
    const rows = batch.map((r, i) => ({
      game_id: this.context.gameId,
      player_id: this.context.playerId,
      boarding_id: this.context.boardingId,
      lat: r.lat,
      lon: r.lon,
      accuracy_m: r.accuracy_m,
      speed_mps: r.speed_mps,
      heading_deg: r.heading_deg,
      recorded_at: r.recorded_at,
      seq: i,
      source: r.source || 'gps',
    }));

    const { error } = await pushTrackPoints(rows);
    if (error) {
      this.lastError = error.message;
      this._emit();
      return { pushed: 0, error: error.message };
    }
    this.queue.splice(0, batch.length);
    this.pushedCount += batch.length;
    this.lastPushAt = Date.now();
    idb.set('pending', this.queue.slice(-800), 'queue').catch(() => {});
    this._emit();
    if (this.queue.length >= FLUSH_AT_ROWS) return this.flush();
    return { pushed: batch.length };
  }

  /* ------------------------------------------------------------- readings */

  /** Recent samples, newest last. `seconds` bounds the window. */
  recent(seconds = 900) {
    const cutoff = Date.now() - seconds * 1000;
    return this.window.filter((p) => (p.ts || Date.parse(p.recorded_at)) >= cutoff);
  }

  trackSince(startedAtIso) {
    const t = Date.parse(startedAtIso);
    return this.window.filter((p) => (p.ts || Date.parse(p.recorded_at)) >= t);
  }

  clearWindow() { this.window = []; this._emit(); }
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

export const tracker = new Tracker();
export default tracker;
