/**
 * EPUB 章节渲染：内容放进同源 iframe（允许读 DOM、禁止脚本），
 * 高度随内容自适应，外层仍是普通滚动容器，进度算法与 TXT 完全一致。
 */

export function mountChapterFrame(host, html, onReady) {
  const frame = document.createElement('iframe');
  frame.className = 'epub-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = '章节内容';
  frame.srcdoc = html;

  host.replaceChildren(frame);

  let observer = null;
  let disposed = false;
  let ready = false;

  const notifyReady = () => {
    if (ready || disposed) return;
    ready = true;
    onReady?.();
  };

  const syncHeight = () => {
    if (disposed) return;
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.documentElement) return;
      const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
      if (height > 0 && Math.abs(frame.offsetHeight - height) > 1) {
        frame.style.height = `${height}px`;
      }
    } catch {
      /* 跨域或尚未就绪，忽略 */
    }
  };

  const onLoad = () => {
    syncHeight();
    requestAnimationFrame(notifyReady);
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      if ('ResizeObserver' in window) {
        observer = new ResizeObserver(syncHeight);
        observer.observe(doc.documentElement);
        if (doc.body) observer.observe(doc.body);
      }
      doc.querySelectorAll('img').forEach((image) => image.addEventListener('load', syncHeight, { once: true }));
      // 图片加载后高度可能继续变化，兜底再通知一次
      doc.querySelectorAll('img').forEach((image) =>
        image.addEventListener('load', () => requestAnimationFrame(notifyReady), { once: true }),
      );
    } catch {
      /* 忽略 */
    }
  };

  frame.addEventListener('load', onLoad);
  window.addEventListener('resize', syncHeight);

  return () => {
    disposed = true;
    observer?.disconnect();
    window.removeEventListener('resize', syncHeight);
  };
}

const EXTENSION_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  css: 'text/css',
  js: 'text/javascript',
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function guessMediaType(path) {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(path));
  return (match && EXTENSION_TYPES[match[1].toLowerCase()]) || 'application/octet-stream';
}
