/**
 * EPUB 解析与章节 HTML 构建。
 * 支持 EPUB 3（nav）与 EPUB 2（NCX）目录、封面提取、资源 URL 改写。
 */
import { unzip, readText } from './zip.js';
import { escapeText, findAll, findFirst, getAttribute, localName, parseXml, serialize, textOf } from './xml.js';
import { linesToParagraphs } from './txt.js';

export function dirName(path) {
  const index = String(path).lastIndexOf('/');
  return index === -1 ? '' : String(path).slice(0, index);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 把 href 解析为相对 OPF 目录的绝对路径；绝对 URL 原样返回。 */
export function resolvePath(baseDir, href) {
  const raw = String(href ?? '');
  const clean = raw.split('#')[0];
  if (!clean) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return clean;

  const parts = (baseDir ? String(baseDir).split('/') : []).concat(clean.split('/'));
  const out = [];
  for (const part of parts) {
    const decoded = decodeSegment(part);
    if (!decoded || decoded === '.') continue;
    if (decoded === '..') out.pop();
    else out.push(decoded);
  }
  return out.join('/');
}

function readEntry(files, path) {
  return readText(files, path);
}

function findText(parent, localTag) {
  const node = findAll(parent, (item) => localName(item.name) === localTag)[0];
  return node ? textOf(node).trim() : '';
}

function readToc(opf, manifest, files) {
  // EPUB 3：manifest 中 properties 含 nav 的文档
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  if (navItem) {
    const text = readEntry(files, navItem.path);
    if (text) {
      const doc = parseXml(text);
      const nav =
        findFirst(doc, (node) => localName(node.name) === 'nav' && getAttribute(node, 'type') === 'toc') ||
        findFirst(doc, (node) => localName(node.name) === 'nav');
      if (nav) {
        const baseDir = dirName(navItem.path);
        return findAll(nav, (node) => localName(node.name) === 'a')
          .map((anchor) => {
            const href = getAttribute(anchor, 'href');
            if (!href) return null;
            const title = textOf(anchor).replace(/\s+/g, ' ').trim();
            return title ? { title, path: resolvePath(baseDir, href) } : null;
          })
          .filter(Boolean);
      }
    }
  }

  // EPUB 2：NCX
  const spineEl = findFirst(opf, (node) => localName(node.name) === 'spine');
  const tocId = spineEl ? getAttribute(spineEl, 'toc') : '';
  const ncxItem =
    (tocId && manifest.get(tocId)) ||
    [...manifest.values()].find((item) => item.mediaType.includes('dtbncx'));
  if (!ncxItem) return [];

  const text = readEntry(files, ncxItem.path);
  if (!text) return [];
  const doc = parseXml(text);
  const baseDir = dirName(ncxItem.path);
  return findAll(doc, (node) => localName(node.name) === 'navPoint')
    .map((point) => {
      const label = findFirst(point, (node) => localName(node.name) === 'navLabel');
      const content = findFirst(point, (node) => localName(node.name) === 'content');
      const href = content ? getAttribute(content, 'src') : '';
      if (!href) return null;
      const title = textOf(label).replace(/\s+/g, ' ').trim();
      return title ? { title, path: resolvePath(baseDir, href) } : null;
    })
    .filter(Boolean);
}

function findCover(opf, manifest, files) {  const metadata = findFirst(opf, (node) => localName(node.name) === 'metadata');
  const metaCover = metadata
    ? findAll(metadata, (node) => localName(node.name) === 'meta').find(
        (meta) => getAttribute(meta, 'name') === 'cover',
      )
    : null;
  const metaId = metaCover ? getAttribute(metaCover, 'content') : '';

  const item =
    (metaId && manifest.get(metaId)) ||
    [...manifest.values()].find((entry) => entry.properties.split(/\s+/).includes('cover-image')) ||
    [...manifest.values()].find((entry) => /^image\//.test(entry.mediaType) && /cover/i.test(entry.path));

  if (!item) return null;
  const bytes = files.get(item.path);
  if (!bytes) return null;
  return { path: item.path, bytes, mediaType: item.mediaType };
}

// 章节标题样式的段落：「第一回　甄士隱夢幻識通靈」「第三章 出发」
const SECTION_TITLE_RE = /^第[0-9０-９一二三四五六七八九十百千零〇两]+[回章卷節节篇]/;
const SECTION_SCAN_RE = /第[0-9０-９一二三四五六七八九十百千零〇两]+[回章卷節节篇]/g;

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-zA-Z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 没有目录条目时，用章节文档里的第一个标题兜底。 */
export function guessTitle(source) {
  const head = String(source ?? '').slice(0, 20000);
  const heading = head.match(/<h[1-4][^>]*>([\s\S]{1,300}?)<\/h[1-4]>/i);
  const candidate = heading ? heading[1] : (head.match(/<title[^>]*>([\s\S]{1,160}?)<\/title>/i) || [])[1];
  if (!candidate) return '';
  const cleaned = stripTags(candidate).replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '');
  return cleaned.length > 0 && cleaned.length <= 60 ? cleaned : '';
}

/**
 * 把一章文档按「第X回 / 第X章」段落切成多个小节。
 * 中文公版书常见做法：一个大文件塞十几回，且回目标题只是普通 <p>。
 * @returns {{ title: string, nodes: object[] }[]}
 */
export function splitSections(doc) {  const body = findFirst(doc, (node) => localName(node.name) === 'body');
  const nodes = body ? body.children : doc.children;
  const sections = [];
  let current = { title: '', nodes: [] };

  const flush = () => {
    const hasContent = current.nodes.some((node) => (node.name === '#text' ? node.value.trim() : textOf(node).trim()));
    if (hasContent) sections.push(current);
    current = { title: '', nodes: [] };
  };

  for (const node of nodes) {
    if (node.name === '#text') {
      current.nodes.push(node);
      continue;
    }
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length <= 40 && SECTION_TITLE_RE.test(text)) {
      flush();
      current = { title: text, nodes: [node] };
    } else {
      current.nodes.push(node);
    }
  }
  flush();
  return sections;
}

/** 取文档正文纯文本（顶层块之间补换行，保留块内硬换行）。 */
export function chapterText(doc) {
  const body = findFirst(doc, (node) => localName(node.name) === 'body');
  const nodes = body ? body.children : doc.children;
  return nodes.map((node) => (node.name === '#text' ? node.value : textOf(node))).join('\n');
}

/**
 * 判断一章是不是"纯文本转 HTML"的产物：
 * 段落巨大、只有硬换行没有分段、且没有图片。
 * 这类章节按 DOM 切不准，改用纯文本通道处理。
 */
export function isTextDump(doc, source) {
  if (/<(img|image|svg|video|audio)\b/i.test(String(source ?? ''))) return false;
  const plain = chapterText(doc);
  if (plain.length < 3000) return false;
  const newlines = (plain.match(/\n/g) || []).length;
  return newlines > plain.length / 60;
}

const TEXT_HEADING_RE = /(?:^|\n)[ \t\u3000]*(第[0-9０-９一二三四五六七八九十百千零〇两]+[回章卷節节篇][^\n]{0,40})/g;
const DECORATION_RE = /^[\s—\-_=·*]{4,}$/;

/** 去掉装饰线后，这一节真正的正文长度。 */
function sectionLength(section) {
  return (section?.body || '')
    .split('\n')
    .filter((line) => !DECORATION_RE.test(line))
    .join('')
    .trim().length;
}
const BARE_HEADING_RE = /^第[0-9０-９一二三四五六七八九十百千零〇两]+[回章卷節节篇]$/;

/** 在纯文本里按「第X回」行首标题切分，返回 { title, body }。 */
export function splitTextSections(plain) {
  const text = String(plain ?? '');
  const starts = [];
  TEXT_HEADING_RE.lastIndex = 0;
  let match;
  while ((match = TEXT_HEADING_RE.exec(text))) {
    starts.push({
      index: match.index + match[0].length - match[1].length,
      title: match[1].replace(/[\s\u3000]+/g, ' ').trim(),
    });
    if (match.index === TEXT_HEADING_RE.lastIndex) TEXT_HEADING_RE.lastIndex += 1;
  }

  if (starts.length === 0) return [];

  const sections = [];
  const preamble = text.slice(0, starts[0].index).trim();
  if (preamble) sections.push({ title: '', body: preamble });

  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
    const chunk = text.slice(start.index, end);
    const firstBreak = chunk.indexOf('\n');
    let title = start.title;
    let body = firstBreak === -1 ? '' : chunk.slice(firstBreak + 1).trim();

    // 标题只有「第三回」时，把下一行副标题接上，并从正文里去掉重复行
    if (BARE_HEADING_RE.test(title)) {
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line || DECORATION_RE.test(line)) continue;
        if (line.length <= 40) {
          title = `${title} ${line.replace(/[\s\u3000]+/g, ' ').trim()}`;
          lines.splice(i, 1);
          body = lines.join('\n');
        }
        break;
      }
    }

    // 标题行后面直接跟了正文（没有换行）时，切掉叙述开头
    const proseAt = title.search(/話說|却说|且說|却说|原來|原来|當下|当下|次日|只見|只见|卻說|只有/);
    if (proseAt > 4) title = title.slice(0, proseAt).trim();

    sections.push({ title, body });
  });

  // 回目标题落在文件末尾、正文在下一个文件时，这些节会由调用方跳过
  return sections;
}

/**
 * 打开 EPUB（传 ArrayBuffer 或已解压的 Map）。
 * @returns {Promise<{files: Map<string, Uint8Array>, title: string, author: string,
 *   chapters: {title: string, path: string, section?: number}[],
 *   toc: {title: string, path: string}[],
 *   cover: {path: string, bytes: Uint8Array, mediaType: string}|null}>}
 */
export async function openEpub(input) {
  const files = input instanceof Map ? input : await unzip(input);

  const containerText = readEntry(files, 'META-INF/container.xml');
  if (!containerText) throw new Error('EPUB 缺少 META-INF/container.xml');
  const container = parseXml(containerText);
  const rootfile = findFirst(container, (node) => localName(node.name) === 'rootfile');
  const opfPath = rootfile ? getAttribute(rootfile, 'full-path') : '';
  if (!opfPath) throw new Error('EPUB 没有声明 OPF 文件');

  const opfText = readEntry(files, opfPath);
  if (!opfText) throw new Error(`EPUB 缺少 OPF 文件：${opfPath}`);
  const opf = parseXml(opfText);
  const opfDir = dirName(opfPath);

  const metadata = findFirst(opf, (node) => localName(node.name) === 'metadata');
  const title = findText(metadata, 'title') || '未命名';
  const author = findText(metadata, 'creator');

  const manifest = new Map();
  for (const item of findAll(opf, (node) => localName(node.name) === 'item')) {
    const id = getAttribute(item, 'id');
    const href = getAttribute(item, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href,
      path: resolvePath(opfDir, href),
      mediaType: getAttribute(item, 'media-type') || '',
      properties: getAttribute(item, 'properties') || '',
    });
  }

  const spineEl = findFirst(opf, (node) => localName(node.name) === 'spine');
  const spineItems = findAll(spineEl, (node) => localName(node.name) === 'itemref')
    .map((itemref) => manifest.get(getAttribute(itemref, 'idref')))
    .filter(Boolean);

  const toc = readToc(opf, manifest, files);
  const tocByPath = new Map();
  for (const entry of toc) {
    // 同一文件可能在目录里出现多次（书名页 / 版本页 / Contents），保留第一条
    if (!tocByPath.has(entry.path)) tocByPath.set(entry.path, entry.title);
  }

  const chapters = [];
  let counter = 0;
  let carryTitle = '';

  for (const item of spineItems) {
    const text = readEntry(files, item.path);
    counter += 1;
    const fallbackTitle =
      carryTitle || tocByPath.get(item.path) || guessTitle(text || '') || `第 ${counter} 章`;
    carryTitle = '';

    // 只有含多个「第X回/章」标记的文档才值得解析：拆分与纯文本检测都依赖它
    const markerCount = text ? (text.match(SECTION_SCAN_RE) || []).length : 0;
    let doc = null;
    if (markerCount >= 2) {
      try {
        doc = parseXml(text);
      } catch {
        doc = null;
      }
    }

    // 纯文本转 HTML 的章节：改用纯文本切分，复用 TXT 的分段逻辑
    if (doc && isTextDump(doc, text)) {
      const textSections = splitTextSections(chapterText(doc));
      if (textSections.length >= 2) {
        textSections.forEach((section, index) => {
          if (sectionLength(section) < 20) {
            // 只有标题、正文在下一个文件里，把标题带过去
            if (section.title) carryTitle = section.title;
            return;
          }
          let title = section.title;
          if (!title) {
            title = carryTitle || (index === 0 ? fallbackTitle : `${fallbackTitle} · ${index + 1}`);
            carryTitle = '';
          }
          chapters.push({ title, path: item.path, textSection: index, mediaType: item.mediaType });
        });
        continue;
      }
    }

    let sections = null;
    if (doc && (text.match(SECTION_SCAN_RE) || []).length >= 2) {
      try {
        sections = splitSections(doc);
      } catch {
        sections = null;
      }
    }

    if (sections && sections.length >= 2) {
      sections.forEach((section, index) => {
        const title = section.title
          ? section.title
          : index === 0
            ? fallbackTitle
            : `${fallbackTitle} · ${index + 1}`;
        chapters.push({ title, path: item.path, section: index, mediaType: item.mediaType });
      });
    } else {
      chapters.push({ title: fallbackTitle, path: item.path, mediaType: item.mediaType });
    }
  }

  const cover = findCover(opf, manifest, files);

  return { files, opfPath, opfDir, title, author, chapters, toc, cover };
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** 把 CSS 中的相对 url(...) 改写成资源 URL。 */
export function rewriteCssUrls(css, baseDir, urlFor) {
  return String(css).replace(CSS_URL_RE, (match, quote, target) => {
    const value = target.trim();
    if (!value || /^(data:|blob:|https?:|#)/i.test(value)) return match;
    return `url("${urlFor(resolvePath(baseDir, value))}")`;
  });
}

const MEDIA_ATTRS = {
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  image: ['href', 'xlink:href'],
};

function rewriteNode(node, baseDir, urlFor) {
  if (node.name === '#text') return node;
  const name = localName(node.name).toLowerCase();
  if (name === 'script') return null; // 书里的脚本一律不执行

  const attrs = { ...node.attrs };
  for (const key of MEDIA_ATTRS[name] || []) {
    if (attrs[key]) attrs[key] = urlFor(resolvePath(baseDir, attrs[key]));
  }

  const children = node.children.map((child) => rewriteNode(child, baseDir, urlFor)).filter(Boolean);
  return { name: node.name, attrs, children };
}

function baseDocument(style, extraCss, bodyHtml) {
  const safe = (value) => String(value).replace(/[<>]/g, '');
  const background = safe(style.background || 'transparent');
  const css = `
html, body { margin: 0; padding: 0; background: ${background}; }
html { color-scheme: ${style.dark ? 'dark' : 'light'}; }
body {
  color: ${safe(style.color)};
  font-family: ${safe(style.fontFamily)};
  font-size: ${Number(style.fontSize) || 18}px;
  line-height: ${Number(style.lineHeight) || 1.9};
  text-align: justify;
  padding: 0 ${Number(style.margin) || 22}px 8px;
  max-width: 42rem;
  margin: 0 auto;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
p { margin: 0 0 0.85em; text-indent: 2em; }
img, svg, video { max-width: 100%; height: auto; }
h1, h2, h3, h4 { text-indent: 0; }
mark.search-hit { background: rgba(180, 85, 45, 0.38); color: inherit; border-radius: 3px; }
`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>${css}</style>
<style>${extraCss}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/**
 * 生成某一章的完整 HTML（用于 iframe srcdoc）。
 * @param {object} book openEpub 的返回值
 * @param {number} index 章节索引
 * @param {{style: object, urlFor: (path: string) => string}} options
 */
export function buildChapterHtml(book, index, { style, urlFor }) {
  const chapter = book.chapters[index];
  if (!chapter) {
    return baseDocument(style, '', `<p>${escapeText('（本章不存在）')}</p>`);
  }

  const text = readEntry(book.files, chapter.path);
  if (!text) {
    return baseDocument(style, '', `<p>${escapeText(`（未找到章节文件：${chapter.path}）`)}</p>`);
  }

  // 纯文本型章节：按 TXT 的规则重新分段
  if (typeof chapter.textSection === 'number') {
    const section = splitTextSections(chapterText(parseXml(text)))[chapter.textSection];
    const lines = (section?.body || '').split('\n').filter((line) => !DECORATION_RE.test(line));
    const paragraphs = linesToParagraphs(lines, 'indent');
    const bodyHtml = [
      section?.title ? `<h2>${escapeText(section.title)}</h2>` : '',
      ...paragraphs.map((paragraph) => `<p>${escapeText(paragraph)}</p>`),
    ].join('');
    return baseDocument(style, '', bodyHtml);
  }

  const doc = parseXml(text);
  const chapterDir = dirName(chapter.path);
  const styles = [];

  const head = findFirst(doc, (node) => localName(node.name) === 'head');
  if (head) {
    for (const node of head.children) {
      const name = localName(node.name).toLowerCase();
      if (name === 'link' && /stylesheet/i.test(getAttribute(node, 'rel') || '')) {
        const href = getAttribute(node, 'href');
        if (!href) continue;
        const cssPath = resolvePath(chapterDir, href);
        const css = readEntry(book.files, cssPath);
        if (css) styles.push(rewriteCssUrls(css, dirName(cssPath), urlFor));
      } else if (name === 'style') {
        styles.push(rewriteCssUrls(textOf(node), chapterDir, urlFor));
      }
    }
  }

  const body = findFirst(doc, (node) => localName(node.name) === 'body');
  let nodes;
  if (typeof chapter.section === 'number') {
    const sections = splitSections(doc);
    nodes = sections[chapter.section]?.nodes ?? [];
  } else {
    nodes = body ? body.children : doc.children;
  }
  const html = nodes
    .map((node) => rewriteNode(node, chapterDir, urlFor))
    .filter(Boolean)
    .map(serialize)
    .join('');

  return baseDocument(style, styles.join('\n'), html);
}
