import { renderShelf } from './library.js';
import { openReader } from './reader.js';
import { applySettings, loadSettings } from './settings.js';
import { escapeHtml } from './format.js';

const app = document.getElementById('app');
let controller = new AbortController();

async function route() {
  controller.abort();
  controller = new AbortController();
  const { signal } = controller;

  const hash = location.hash || '#/';
  const match = hash.match(/^#\/read\/([^/?#]+)$/);

  try {
    if (match) {
      await openReader(app, decodeURIComponent(match[1]), signal);
    } else {
      await renderShelf(app, signal);
    }
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="fatal"><h2>页面出错了</h2><pre>${escapeHtml(String(error?.message || error))}</pre></div>`;
  }
}

applySettings(loadSettings());
window.addEventListener('hashchange', route);
route();

// PWA：注册 Service Worker，让应用离线可用（仅安全上下文）
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure =
    location.protocol === 'https:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!secure) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .catch((error) => console.warn('Service Worker 注册失败', error));
  });
}

registerServiceWorker();
