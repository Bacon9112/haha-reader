/**
 * Service Worker：预缓存应用外壳，让阅读器离线可用。
 * 书籍数据在 IndexedDB 里，只要外壳能起来，断网照样能读书。
 *
 * 改动静态资源后请递增 VERSION，否则老客户端会继续用旧缓存。
 */

const VERSION = 'v8';
const CACHE = `haha-reader-${VERSION}`;
const SHARED_CACHE = 'haha-reader-shared';
const SHARED_FILE_URL = new URL('./shared-file', self.location).href;

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
  './src/version.js',
  './src/xml.js',
  './src/zip.js',
];

const APP_PATHS = new Set(ASSETS.map((asset) => new URL(asset, self.location).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' 强制绕过 HTTP 缓存，避免把上一版的旧文件缓存进来
      .then((cache) => cache.addAll(ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))))
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

/** 处理"分享到应用"的文件：先存进 Cache，再跳回应用，由页面负责导入。 */
async function handleShare(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') {
      return Response.redirect('./?share=empty', 303);
    }
    const buffer = await file.arrayBuffer();
    const cache = await caches.open(SHARED_CACHE);
    await cache.put(
      SHARED_FILE_URL,
      new Response(buffer, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name || 'shared-book.epub'),
        },
      }),
    );
    return Response.redirect('./?share=1', 303);
  } catch (error) {
    console.error('处理分享文件失败', error);
    return Response.redirect('./?share=error', 303);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 分享目标：接收 POST 上传的文件
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(request));
    return;
  }

  if (request.method !== 'GET') return;

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
