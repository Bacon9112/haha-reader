/**
 * 全文搜索：按章建立纯文本索引，进程内扫描；索引按书缓存在 IndexedDB。
 */
import { chapterText, isTextDump, splitSections, splitTextSections } from './epub.js';
import { parseXml, textOf, findFirst, localName } from './xml.js';

const MAX_RESULTS = 120;
const MAX_PER_CHAPTER = 4;
const YIELD_EVERY = 20;

function decode(bytes) {
  if (!bytes) return '';
  let view = bytes;
  if (view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) view = view.subarray(3);
  return new TextDecoder('utf-8').decode(view);
}

/**
 * 提取每章纯文本。
 * @param {object} book 书目记录
 * @param {{epub?: object, chapters: object[]}} view 阅读器解析出的章节视图
 */
export async function buildIndex(book, view, { signal, onProgress } = {}) {
  const chapters = view.chapters;
  const texts = new Array(chapters.length).fill('');
  const sectionCache = new Map(); // 同一个文件的多回共享一次解析

  const sectionsFor = (chapter) => {
    if (sectionCache.has(chapter.path)) return sectionCache.get(chapter.path);
    const text = decode(view.epub?.files.get(chapter.path));
    let sections = [];
    if (text) {
      const doc = parseXml(text);
      if (isTextDump(doc, text)) {
        // 纯文本型：与 openEpub 一致，使用文本级切分
        sections = splitTextSections(chapterText(doc)).map((section) => section.body);
      } else {
        // DOM 切分：取每个小节的正文文本
        sections = splitSections(doc).map((section) =>
          section.nodes.map((node) => (node.name === '#text' ? node.value : textOf(node))).join('\n'),
        );
      }
    }
    sectionCache.set(chapter.path, sections);
    return sections;
  };

  for (let index = 0; index < chapters.length; index += 1) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const chapter = chapters[index];

    if (book.format !== 'epub') {
      texts[index] = (chapter.paragraphs || []).join('\n');
    } else if (typeof chapter.textSection === 'number') {
      texts[index] = sectionsFor(chapter)[chapter.textSection] || '';
    } else {
      const text = decode(view.epub?.files.get(chapter.path));
      if (text) {
        const doc = parseXml(text);
        const body = findFirst(doc, (node) => localName(node.name) === 'body');
        texts[index] = body ? textOf(body) : '';
      }
    }

    // 大书分片让出主线程，避免长任务卡住页面
    if (index % YIELD_EVERY === YIELD_EVERY - 1) {
      onProgress?.(index + 1, chapters.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return texts;
}

export function makeSnippet(text, offset, length, radius = 28) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + length + radius);
  const before = text.slice(start, offset).replace(/\s+/g, ' ');
  const match = text.slice(offset, offset + length);
  const after = text.slice(offset + length, end).replace(/\s+/g, ' ');
  return {
    before: (start > 0 ? '…' : '') + before,
    match,
    after: after + (end < text.length ? '…' : ''),
  };
}

/**
 * 在索引里搜索。
 * @returns {{chapterIndex: number, offset: number, nth: number, snippet: object}[]}
 */
export function search(texts, query, { limit = MAX_RESULTS, perChapter = MAX_PER_CHAPTER } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];

  const results = [];
  for (let chapterIndex = 0; chapterIndex < texts.length; chapterIndex += 1) {
    const text = texts[chapterIndex] || '';
    if (!text) continue;
    const haystack = text.toLowerCase();
    let from = 0;
    let nth = 0;

    while (results.length < limit) {
      const offset = haystack.indexOf(needle, from);
      if (offset === -1) break;

      if (nth < perChapter) {
        results.push({ chapterIndex, offset, nth, snippet: makeSnippet(text, offset, needle.length) });
        nth += 1;
      } else {
        // 本章命中过多时只保留前几条，避免噪声
        break;
      }
      from = offset + needle.length;
    }

    if (results.length >= limit) break;
  }

  return results;
}
