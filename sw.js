/* Hojas service worker.
   • The app's own files (HTML, JS, CSS) are NETWORK-FIRST: whenever you are online you get what is on the website right now,
     the saved copy is only a fallback for offline use. A new upload therefore shows up on the next load, without any version bump.
   • Installing never fails because one file is missing; every file is fetched on its own, skipping the browser's HTTP cache.
   • Big libraries and icons never change, so they are cache-first.
   Only Cache Storage is used here. Books, vocabulary, progress and settings live in IndexedDB / localStorage and are never touched. */
const CACHE = 'hojas-7.1';
const APP = ['./', './index.html', './style.css', './app.js', './lex.js', './review.js', './paginate.js', './chapters.js', './manifest.webmanifest'];
const STATIC = ['./vendor/jszip.min.js', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
const abs = u => new URL(u, self.registration ? self.registration.scope : location.href).href;
const STATIC_URLS = new Set(STATIC.map(abs));

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled([...APP, ...STATIC].map(async u => {
      const res = await fetch(new Request(abs(u), { cache: 'reload' }));
      if (res.ok) await cache.put(abs(u), res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hojas-') && k !== CACHE) await caches.delete(k);   // only Hojas' own older caches
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const url = req.url;
  try {
    const res = await Promise.race([
      fetch(url, { cache: 'no-cache' }),                                   // revalidate with the website (a cheap 304 when unchanged)
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 5000))
    ]);
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.split('#')[0], copy)).catch(() => { }); return res; }
    const hit = await caches.match(url, { ignoreSearch: true });
    return hit || res;
  } catch {
    const hit = await caches.match(url, { ignoreSearch: true });           // offline or very slow: the saved copy
    return hit || (req.mode === 'navigate' ? await caches.match(abs('./index.html')) : null) || Response.error();
  }
}
async function cacheFirst(req) {
  const hit = await caches.match(req.url, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req.url);
  if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req.url, copy)).catch(() => { }); }
  return res;
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;                                // dictionary and translation calls go straight to the network
  e.respondWith(STATIC_URLS.has(u.origin + u.pathname) ? cacheFirst(req) : networkFirst(req));
});
