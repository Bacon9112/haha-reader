/**
 * 排版设置：字号、行距、页边距、字体、主题。
 * 存在 localStorage（小、同步、无需 IndexedDB）。
 * 主题色与字体栈同时供阅读器页面和 EPUB iframe 使用。
 */

const STORAGE_KEY = 'haha-reader/settings/v1';

export const FONTS = [
  { id: 'serif', label: '宋体' },
  { id: 'sans', label: '黑体' },
  { id: 'kai', label: '楷体' },
  { id: 'system', label: '系统' },
];

export const FONT_STACKS = {
  serif: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", serif',
  sans: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "楷体", serif',
  system: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
};

export const THEMES = [
  { id: 'light', label: '浅色' },
  { id: 'sepia', label: '护眼' },
  { id: 'dark', label: '夜间' },
];

export const THEME_COLORS = {
  light: { fg: '#1f1d1a', bg: '#f6f4ef' },
  sepia: { fg: '#3a2f22', bg: '#f2e8d5' },
  dark: { fg: '#d7d3ca', bg: '#14161a' },
};

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 18,
  lineHeight: 1.9,
  margin: 28,
  font: 'serif',
  theme: 'light',
});

const FONT_IDS = new Set(FONTS.map((item) => item.id));
const THEME_IDS = new Set(THEMES.map((item) => item.id));

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    fontSize: Math.round(clampNumber(source.fontSize, 14, 30, DEFAULT_SETTINGS.fontSize)),
    lineHeight: Math.round(clampNumber(source.lineHeight, 1.4, 2.4, DEFAULT_SETTINGS.lineHeight) * 10) / 10,
    margin: Math.round(clampNumber(source.margin, 12, 48, DEFAULT_SETTINGS.margin)),
    font: FONT_IDS.has(source.font) ? source.font : DEFAULT_SETTINGS.font,
    theme: THEME_IDS.has(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
  };
}

/** 给 EPUB iframe 用的内联样式值。 */
export function readerStyle(settings) {
  const safe = sanitizeSettings(settings);
  const colors = THEME_COLORS[safe.theme] || THEME_COLORS.light;
  return {
    color: colors.fg,
    background: colors.bg,
    dark: safe.theme === 'dark',
    fontFamily: FONT_STACKS[safe.font] || FONT_STACKS.serif,
    fontSize: safe.fontSize,
    lineHeight: safe.lineHeight,
    margin: safe.margin,
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下可能写入失败，忽略即可 */
  }
}

export function applySettings(settings) {
  const safe = sanitizeSettings(settings);
  const root = document.documentElement;
  root.style.setProperty('--reader-font-size', `${safe.fontSize}px`);
  root.style.setProperty('--reader-line-height', String(safe.lineHeight));
  root.style.setProperty('--reader-margin', `${safe.margin}px`);
  root.dataset.theme = safe.theme;
  root.dataset.font = safe.font;
  return safe;
}
