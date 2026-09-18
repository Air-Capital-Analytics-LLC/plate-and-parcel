/**
 * sw.js — precache the shell so the app opens with zero network.
 *
 * The dominant failure mode for this app is a dead signal inside a warehouse,
 * so the page itself must never depend on the network to start. Only
 * same-origin GETs are touched; the Firebase stream and writes always go to
 * the network, and a stale response must never be served in their place.
 */

// Bump on EVERY deploy. The fetch handler serves from cache first, so without a
// bump a device can run yesterday's modules against today's data shape — a
// combination that was never tested. `activate` deletes every other version, so
// the shell upgrades as one unit rather than file by file.
const VERSION = 'v22';
const CACHE = `plate-and-parcel-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './app/main.js',
  './app/store.js',
  './app/sync.js',
  './app/view.js',
  './app/crypto.js',
  './app/data.js',
  './icon.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
  './favicon.png',
  './brand.png',
  './brand-light.png',
  // NOT preview.png. It is the link-preview card, fetched only by whatever
  // scraper draws the message bubble - the app never loads it. Precaching it
  // would cost every phone the download for nothing.
];

/**
 * `AbortSignal.timeout` is Safari 16 / iOS 16. On older iPhones it is
 * `undefined`, and calling it threw inside the fetch handler's async arrow —
 * which the outer catch swallowed, falling through to a bare network fetch and
 * discarding the cache entirely. The precache was populated and never read, so
 * the one thing this file exists for stopped working on exactly the handsets
 * least likely to be upgraded.
 */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // `cache: 'reload'` bypasses the HTTP cache. GitHub Pages serves assets
      // with max-age, so without it a VERSION bump would faithfully precache
      // yesterday's modules and the new cache would be a copy of the old one —
      // the mixed-version graph this versioning exists to prevent.
      .then(async (c) => {
        const results = await Promise.allSettled(
          SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))
        );
        // All or nothing. `allSettled` alone left a MISSING module in an
        // otherwise-complete cache: offline, that one file 503s and the app is
        // dead with nothing to explain why. A cache we cannot trust is worse
        // than no cache, because no cache still falls through to the network.
        if (results.some((r) => r.status === 'rejected')) {
          await caches.delete(CACHE);
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // Firebase: always network
  if (req.headers.get('accept') === 'text/event-stream') return;

  // Stale-while-revalidate: instant paint from cache, quiet refresh behind it.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: false });
      // Untimed revalidation on a dead network leaves ~10 requests hanging
      // through the platform's retry ladder, each pinned by waitUntil, holding
      // the service worker resident and the radio connected for a minute --
      // during every cold open in the store, which is exactly when the app is
      // supposed to be cheap.
      const network = fetch(req, { signal: timeoutSignal(5000) })
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) { e.waitUntil(network); return cached; }

      const res = await network;
      if (res) return res;

      // Offline, never cached: a navigation still has somewhere to land.
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }).catch(() => fetch(req).catch(
      // Storage pressure can make caches.open itself reject. Falling through to
      // the network keeps a navigation on the app rather than the browser's
      // error page.
      () => new Response('Offline', { status: 503, statusText: 'Offline' })
    ))
  );
});
