/* ==========================================================================
   Service worker: cache the app shell so Interchange opens instantly and
   keeps working in a tunnel with no signal.

   Deliberately conservative:
     - only same-origin GETs are cached
     - Supabase, Overpass and GTFS requests always go straight to the network
       (the app caches GTFS in IndexedDB and queues GPS points itself)
   ========================================================================== */

const VERSION = 'interchange-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/icons/icon.svg',
  './assets/js/app.js',
  './assets/js/api.js',
  './assets/js/authz.js',
  './assets/js/config.js',
  './assets/js/dom.js',
  './assets/js/geo.js',
  './assets/js/gtfs.js',
  './assets/js/iconbar.js',
  './assets/js/idb.js',
  './assets/js/overpass.js',
  './assets/js/protobuf.js',
  './assets/js/realtime.js',
  './assets/js/store.js',
  './assets/js/supabase-lite.js',
  './assets/js/tracker.js',
  './assets/js/transit.js',
  './assets/js/ui.js',
  './assets/js/zip.js',
  './assets/js/screens/auth.js',
  './assets/js/screens/create.js',
  './assets/js/screens/game.js',
  './assets/js/screens/home.js',
  './assets/js/screens/info.js',
  './assets/js/screens/manage.js',
  './assets/js/screens/ride.js',
  './assets/js/screens/teams.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // added one by one: a single missing file must not fail the whole install
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] could not cache', url); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function isCacheable(res) {
  return res && res.ok && (res.type === 'basic' || res.type === 'default');
}

async function handleNavigation(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(VERSION);
    cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await caches.match('./index.html');
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="font:16px system-ui;padding:24px">Interchange is offline and the app shell is not cached yet. Reconnect once to install it.</body>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function handleAsset(request) {
  // config.local.js only exists when the build step generated it: answer with
  // an empty config rather than letting the import fail on a 404 body.
  if (new URL(request.url).pathname.endsWith('/assets/js/config.local.js')) {
    const res = await fetch(request).catch(() => null);
    if (res && res.ok) return res;
    return new Response('export default null;\n', {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
    });
  }

  const cached = await caches.match(request);
  if (cached) {
    // refresh quietly in the background so the next launch is up to date
    fetch(request).then(async (res) => {
      if (isCacheable(res)) (await caches.open(VERSION)).put(request, res);
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (isCacheable(res)) (await caches.open(VERSION)).put(request, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // never touch external APIs

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }
  event.respondWith(handleAsset(req));
});
