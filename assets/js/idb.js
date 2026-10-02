/* ==========================================================================
   Micro IndexedDB wrapper. Stores the parsed GTFS bundle so a device only
   ever downloads a city feed once (low bandwidth, works offline afterwards).
   ========================================================================== */

const DB_NAME = 'interchange';
const DB_VERSION = 1;
let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('gtfs')) db.createObjectStore('gtfs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export const idb = {
  async get(key, storeName = 'kv') {
    try { return await tx(storeName, 'readonly', (s) => s.get(key)); } catch { return undefined; }
  },
  async set(key, value, storeName = 'kv') {
    try { return await tx(storeName, 'readwrite', (s) => s.put(value, key)); } catch { return undefined; }
  },
  async del(key, storeName = 'kv') {
    try { return await tx(storeName, 'readwrite', (s) => s.delete(key)); } catch { return undefined; }
  },
  async getAll(storeName = 'kv') {
    try { return await tx(storeName, 'readonly', (s) => s.getAll()); } catch { return []; }
  },
  async clear(storeName = 'kv') {
    try { return await tx(storeName, 'readwrite', (s) => s.clear()); } catch { return undefined; }
  },

  /* ---- gtfs bundle helpers ---- */
  async getGtfs(key) {
    const row = await idb.get(key, 'gtfs');
    return row || null;
  },
  async putGtfs(key, payload) {
    return idb.set(key, { key, savedAt: Date.now(), ...payload }, 'gtfs');
  },
  async listGtfs() {
    const rows = await idb.getAll('gtfs');
    return (rows || []).map((r) => ({ key: r.key, savedAt: r.savedAt, stops: r.stops?.length || 0, trips: r.trips?.length || 0 }));
  },
};

export default idb;
