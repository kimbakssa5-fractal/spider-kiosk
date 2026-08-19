/* 쓰리쿠션 3구 당구 — 서비스 워커
 * 앱 껍데기를 캐시해 두 번째 실행부터는 인터넷 없이도 뜬다.
 * 캐시 이름의 버전을 올리면 옛 캐시는 activate 때 지워진다(배포마다 build_variants.py 가 갱신).
 */
var CACHE = 'billiards39-v20260819-210416';
var SHELL = [
  './',
  './index.html',
  './js/physics.js',
  './js/fullscreen.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // 하나가 실패해도 나머지는 담는다(폰트 등 외부 자원은 처음부터 넣지 않는다)
    return Promise.all(SHELL.map(function (u) {
      return c.add(u).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 내 폴더 안의 것만 처리한다. 네트워크가 되면 최신을 쓰고(캐시도 갱신), 끊기면 캐시로 낸다. */
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // 폰트 등 외부는 건드리지 않음
  if (url.pathname.indexOf(new URL('./', self.location).pathname) !== 0) return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy).catch(function () {}); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
