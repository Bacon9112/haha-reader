/**
 * 纯展示/计算工具函数。不依赖 DOM、IndexedDB，可直接在 Node 中单元测试。
 */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 全书进度百分比：章节索引 + 章内滚动比例。
 * 例：10 章，停在第 4 章（0 起）一半处 → (4 + 0.5) / 10 = 45%
 */
export function percentOf(chapterIndex, ratio, chapterCount) {
  const total = Number(chapterCount);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const index = Number.isFinite(Number(chapterIndex)) ? Math.floor(Number(chapterIndex)) : 0;
  const safeIndex = clamp(index, 0, total - 1);
  const safeRatio = clamp(Number.isFinite(Number(ratio)) ? Number(ratio) : 0, 0, 1);
  return clamp(((safeIndex + safeRatio) / total) * 100, 0, 100);
}

export function formatPercent(percent) {
  const p = clamp(Number(percent) || 0, 0, 100);
  if (p <= 0) return '0%';
  if (p >= 100) return '100%';
  if (p < 0.1) return '<0.1%';
  return `${p.toFixed(1).replace(/\.0$/, '')}%`;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function formatDate(timestamp, now = Date.now()) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  if (date.getFullYear() === today.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function stripExtension(filename) {
  return String(filename || '').replace(/\.[^.]+$/, '') || '未命名';
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
