// 앱 파일을 바꾸면 VERSION을 올려야 사용자 기기에 새 버전이 반영됩니다.
const VERSION = 'v13';
const PREFIX = 'narasarang-';
const CACHE = PREFIX + VERSION;
const TIMEOUT = 4000; // 네트워크가 이보다 느리면 저장된 파일로 응답
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

function fromCache(req) {
  return caches.open(CACHE)
    .then((c) => c.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === 'navigate' ? c.match('index.html') : undefined)));
}

// 앱 파일: 네트워크 우선(항상 최신) → 오프라인·지연·서버 오류면 저장된 파일
// 외부 파일(폰트): 캐시 우선
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  if (sameOrigin) {
    e.respondWith(new Promise((resolve) => {
      let done = false;
      const fallback = (res) => fromCache(req).then((hit) => { if (!done) { done = true; resolve(hit || res || Response.error()); } });
      const timer = setTimeout(() => fallback(), TIMEOUT);
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            clearTimeout(timer);
            if (!done) { done = true; resolve(res); }
          } else {
            clearTimeout(timer);
            fallback(res); // 5xx 등은 저장된 파일이 있으면 그걸로
          }
        })
        .catch(() => { clearTimeout(timer); fallback(); });
    }));
    return;
  }

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
  );
});
