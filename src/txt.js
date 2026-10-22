/**
 * TXT 解码、章节切分与段落重组。全部是纯函数，不触碰 DOM / IndexedDB，便于单元测试。
 */

// 章节标题：第一章 / 第12回 / 序章 / 楔子 / 尾声 / 番外 ……
const CHAPTER_TITLE_RE =
  /^[\s\u3000]*(?:第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回卷部篇集]|序章|序言|楔子|引子|尾声|终章|后记|番外)[^\n]{0,40}$/;

// 标题行不该以句读结尾，否则多半是正文里以"第三章……"开头的句子
const TITLE_TAIL_RE = /[。，,；;：:！!？?、…—]$/;

const INDENT_RE = /^[\s\u3000]{2,}|^\u3000|^\t/u;

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * 解码为字符串：优先 UTF-8（BOM 与无 BOM 均可），失败则回退 GB18030。
 * 这是中文 TXT 最常见的两种编码。
 */
export function decodeText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.length === 0) return '';

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return normalizeText(new TextDecoder('utf-8').decode(bytes.subarray(3)));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return normalizeText(new TextDecoder('utf-16le').decode(bytes.subarray(2)));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return normalizeText(new TextDecoder('utf-16be').decode(bytes.subarray(2)));
  }

  try {
    // fatal: true 让非法 UTF-8 直接抛错，从而进入 GB18030 分支
    return normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return normalizeText(new TextDecoder('gb18030').decode(bytes));
  }
}

export function isChapterTitle(line) {
  const title = String(line ?? '').trim();
  if (!title || title.length > 40) return false;
  if (!CHAPTER_TITLE_RE.test(title)) return false;
  if (TITLE_TAIL_RE.test(title)) return false;
  return true;
}

/**
 * 判断整篇 TXT 的段落风格，决定换行是"段内硬换行"还是"段落分隔"：
 * - indent：多数非空行带首行缩进（人工排版的书）
 * - block：靠空行分段（硬换行 + 空行，常见于网页导出）
 * - line：每行一段（无缩进、无空行）
 */
export function detectParagraphStyle(lines) {
  const all = lines.map((line) => String(line ?? ''));
  const lastTextIndex = all.reduce((last, line, index) => (line.trim() ? index : last), -1);

  let nonEmpty = 0;
  let indented = 0;
  let internalBlanks = 0;

  for (let index = 0; index < all.length; index += 1) {
    const line = all[index];
    if (!line.trim()) {
      // 只统计正文中间的空白行；结尾的换行不算分段依据
      if (index < lastTextIndex) internalBlanks += 1;
      continue;
    }
    nonEmpty += 1;
    if (INDENT_RE.test(line)) indented += 1;
  }

  if (nonEmpty === 0) return 'indent';
  if (indented / nonEmpty >= 0.15) return 'indent';
  if (internalBlanks >= 1) return 'block';
  return 'line';
}

const ASCII_TAIL_RE = /[A-Za-z0-9]$/;
const ASCII_HEAD_RE = /^[A-Za-z0-9]/;

function joinLine(prev, next) {
  // 英文硬换行需要空格；中文直接拼接
  return ASCII_TAIL_RE.test(prev) && ASCII_HEAD_RE.test(next) ? `${prev} ${next}` : prev + next;
}

/**
 * 把一批原始行整理成段落。
 * @param {string[]} lines
 * @param {'indent'|'block'|'line'} style detectParagraphStyle 的结果
 */
export function linesToParagraphs(lines, style = 'indent') {
  const paragraphs = [];
  let buffer = '';

  const flush = () => {
    const text = buffer.trim();
    if (text) paragraphs.push(text);
    buffer = '';
  };

  for (const raw of lines) {
    const line = String(raw ?? '').replace(/[\s\u3000]+$/u, '');
    if (!line.trim()) {
      flush();
      continue;
    }

    if (style === 'line') {
      flush();
      paragraphs.push(line.trim());
      continue;
    }

    const indented = style === 'indent' && INDENT_RE.test(line);
    if (!buffer) {
      buffer = line.trim();
    } else if (indented) {
      flush();
      buffer = line.trim();
    } else {
      buffer = joinLine(buffer, line.trim());
    }
  }

  flush();
  return paragraphs;
}

/**
 * 切分章节。识别不到章节标题时，整篇作为「正文」一章。
 * @returns {{ title: string, paragraphs: string[] }[]}
 */
export function splitChapters(text) {
  const lines = normalizeText(text).split('\n');
  const style = detectParagraphStyle(lines);
  const chapters = [];
  let current = { title: '正文', lines: [] };

  const commit = () => {
    const paragraphs = linesToParagraphs(current.lines, style);
    if (paragraphs.length === 0) return;
    chapters.push({ title: current.title, paragraphs });
  };

  for (const line of lines) {
    if (isChapterTitle(line)) {
      if (current.lines.some((item) => item.trim())) {
        commit();
        current = { title: line.trim(), lines: [] };
      } else {
        // 连续两个标题之间没有正文，以后一个为准，避免空章节
        current.title = line.trim();
      }
    } else {
      current.lines.push(line);
    }
  }
  commit();

  if (chapters.length === 0) {
    chapters.push({ title: '正文', paragraphs: [] });
  }
  return chapters;
}
