/**
 * Service Worker：预缓存应用外壳，让阅读器离线可用。
 * 书籍数据在 IndexedDB 里，只要外壳能起来，断网照样能读书。
 *
 * 改动静态资源后请递增 VERSION，否则老客户端会继续用旧缓存。
 */

const VERSION = 'v3';
const CACHE = `haha-reader-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './src/app.js',
  './src/db.js',
  './src/epub-view.js',
  './src/epub.js',
  './src/format.js',
  './src/library.js',
  './src/reader.js',
  './src/search.js',
  './src/settings.js',
  './src/txt.js',
  './src/ui.js',
  './src/xml.js',
  './src/zip.js',
];

const APP_PATHS = new Set(ASSETS.map((asset) => new URL(asset, self.location).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航一律回退到应用外壳（离线也能打开）
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(
        (cached) =>
          cached ||
          fetch(request).catch(() => caches.match('./index.html')),
      ),
    );
    return;
  }

  // 只接管应用自身的静态资源，其它路径（测试样例等）不干预
  if (!APP_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || Response.error());
    }),
  );
});
