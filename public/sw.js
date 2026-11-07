// Kerbside service worker: keeps an offline copy of the app shell and satellite tiles.
// The page itself is always fetched fresh when online, so a stale copy can't break a new version.
const CACHE = 'kerbside-v33';
const TILES = 'kerbside-tiles';
const TILE_HOSTS = ['server.arcgisonline.com', 'api.maptiler.com', 'raw.githubusercontent.com'];
const SHELL = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];

// A response that came through a redirect can't be used for a page load (Safari shows a blank page).
async function clean(r) {
  if (!r || !r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('openf1.org')) return;
  if (url.origin === location.origin && (url.pathname === '/ws' || url.pathname === '/status' || url.pathname === '/track' || url.pathname.startsWith('/tracks') || url.pathname === '/room' || url.pathname === '/hang' || url.pathname === '/ice' || url.pathname === '/weather' || url.pathname.startsWith('/push/') || url.search.includes('reset'))) return;
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(TILES).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await clean(await fetch(e.request));
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
        return r;
      } catch (err) {
        const hit = await caches.match('/');
        return (await clean(hit)) || new Response('<p style="font:16px system-ui;padding:20px">Kerbside is offline and has no saved copy yet.</p>', { headers: { 'content-type': 'text/html' } });
      }
    })());
    return;
  }
  if (url.origin === location.origin && /\.html?$/.test(url.pathname)) return; // never serve pages cache-first
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok && !r.redirected && (url.origin === location.origin || url.hostname.includes('fonts.g') || url.hostname === 'cdnjs.cloudflare.com')) {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return r;
  })));
});

// Weather alerts from the Worker
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (err) { m = { title: 'Kerbside', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Kerbside weather', {
    body: m.body || '', tag: m.tag || 'kerbside', renotify: !!m.urgent, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: m.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && 'focus' in c) { c.navigate && c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
