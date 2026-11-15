// アプリの画面（このフォルダ内のファイル）と、Riot の Data Dragon のデータをキャッシュする。
// アプリの画面：まずネットから取りに行き、つながらないときだけキャッシュを使う。
// Data Dragon：パッチ番号付きのURLは中身が変わらないので、キャッシュがあればそれを使う。
const CACHE = 'lol-matchup-v1';
const DD_CACHE = 'lol-matchup-dd';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('lol-matchup') && k !== CACHE && k !== DD_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const networkFirst = (req, cacheName, fallback) =>
  fetch(req)
    .then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(cacheName).then(c => c.put(req, copy)); }
      return res;
    })
    .catch(() => caches.match(req).then(r => r || (fallback ? caches.match(fallback) : Response.error())));

// 新しいパッチが出たら、古いパッチのデータをキャッシュから消す
async function pruneOldPatches(versions) {
  const latest = Array.isArray(versions) && versions[0];
  if (!latest) return;
  const c = await caches.open(DD_CACHE);
  for (const req of await c.keys()) {
    const m = new URL(req.url).pathname.match(/^\/cdn\/([\d.]+)\//);
    if (m && m[1] !== latest) await c.delete(req);
  }
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.hostname === 'ddragon.leagueoflegends.com') {
    if (url.pathname.startsWith('/api/')) {
      e.respondWith(networkFirst(e.request, DD_CACHE).then(res => {
        if (res.ok) res.clone().json().then(pruneOldPatches).catch(() => {});
        return res;
      }));
      return;
    }
    if (url.pathname.startsWith('/cdn/')) {
      e.respondWith(caches.open(DD_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }))));
    }
    return;
  }

  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  e.respondWith(networkFirst(e.request, CACHE, './index.html'));
});
