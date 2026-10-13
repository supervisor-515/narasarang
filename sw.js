// 앱 파일을 바꾸면 VERSION을 올려야 사용자 기기에 새 버전이 반영됩니다.
const VERSION = 'v18';
const PREFIX = 'narasarang-';
const CACHE = PREFIX + VERSION;
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/data.js',
  'js/engine.js',
  'js/app.js',
  'manifest.webmanifest',
  'privacy.html',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

// 브라우저 HTTP 캐시(GitHub Pages 10분)를 건너뛰고 서버에서 새로 받아 저장
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// 이 앱의 예전 버전 캐시만 지움 (같은 도메인의 다른 앱 캐시는 건드리지 않음)
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const SHELL_URLS = new Set(SHELL.map((u) => new URL(u, self.registration.scope).href));

// 앱 파일(SHELL): 이 버전 캐시에서만 응답 → data.js·engine.js·app.js가 항상 같은 릴리스로 맞춰짐
//   (새 버전은 sw.js의 VERSION이 바뀌면 install에서 전부 새로 받아 한꺼번에 교체)
// 그 밖의 같은 도메인 파일: 네트워크 우선, 오프라인이면 저장된 파일
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  url.search = '';
  url.hash = '';
  const isShell = req.mode === 'navigate' || SHELL_URLS.has(url.href);

  if (isShell) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = (await c.match(url.href)) || (req.mode === 'navigate' ? await c.match(new URL('index.html', self.registration.scope).href) : undefined);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) c.put(url.href, res.clone());
      return res;
    }));
    return;
  }

  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true })).then((hit) => hit || Response.error()))
  );
});
