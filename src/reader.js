import {
  getBook,
  getBookFile,
  getProgress,
  saveProgress,
  listBookmarks,
  addBookmark,
  deleteBookmark,
  getSearchIndex,
  saveSearchIndex,
} from './db.js';
import {
  applySettings,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  readerStyle,
  FONTS,
  THEMES,
} from './settings.js';
import { clamp, percentOf, formatPercent, formatDate, escapeHtml } from './format.js';
import { openEpub, buildChapterHtml } from './epub.js';
import { mountChapterFrame, guessMediaType } from './epub-view.js';
import { buildIndex, search as searchText } from './search.js';
import { toast } from './ui.js';

export async function openReader(root, bookId, signal) {
  const book = await getBook(bookId);
  if (!book) {
    toast('这本书已经不在书架上了');
    location.hash = '#/';
    return;
  }

  const isEpub = book.format === 'epub';
  let epub = null;

  if (isEpub) {
    const bytes = await getBookFile(bookId);
    if (!bytes) {
      toast('找不到这本书的文件，请重新导入');
      location.hash = '#/';
      return;
    }
    try {
      epub = await openEpub(bytes);
    } catch (error) {
      console.error(error);
      toast(`EPUB 解析失败：${error.message || '未知错误'}`);
      location.hash = '#/';
      return;
    }
  }

  const chapters = isEpub ? epub.chapters : book.chapters?.length ? book.chapters : [{ title: '正文', paragraphs: [] }];
  const chapterCount = chapters.length || 1;
  const saved = (await getProgress(bookId)) || {};

  let settings = applySettings(loadSettings());
  let chapterIndex = clamp(Math.floor(Number(saved.chapterIndex) || 0), 0, chapterCount - 1);
  let ratio = clamp(Number(saved.ratio) || 0, 0, 1);
  let saveTimer = 0;
  let disposeFrame = null;

  // EPUB 资源 → blob URL（离开阅读器时统一释放）
  const urlCache = new Map();
  const urlFor = (path) => {
    if (!path) return '';
    if (urlCache.has(path)) return urlCache.get(path);
    const data = epub?.files.get(path);
    if (!data) return path;
    const url = URL.createObjectURL(new Blob([data], { type: guessMediaType(path) }));
    urlCache.set(path, url);
    return url;
  };
  signal?.addEventListener('abort', () => {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
    disposeFrame?.();
  });

  root.innerHTML = `
    <div class="reader-shell">
      <header class="reader-head">
        <button class="icon-btn" data-action="back" title="返回书架">←</button>
        <div class="reader-title">
          <div class="book-name" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>
          <div class="chapter-name" id="chapter-name"></div>
        </div>
        <span class="reader-percent" id="reader-percent"></span>
        <button class="icon-btn" data-action="search" title="全书搜索">搜</button>
        <button class="icon-btn" data-action="bookmarks" title="书签">☆</button>
        <button class="icon-btn" data-action="toc">目录</button>
        <button class="icon-btn" data-action="settings">Aa</button>
        <div class="reader-progress" id="reader-progress"></div>
      </header>

      <main class="reader-scroll" id="reader-scroll">
        <article class="chapter" id="chapter-body"></article>
        <nav class="chapter-pager">
          <button id="prev-chapter" data-action="prev-chapter">上一章</button>
          <span id="chapter-index"></span>
          <button id="next-chapter" data-action="next-chapter">下一章</button>
        </nav>
      </main>

      <aside class="panel" id="toc-panel" hidden>
        <div class="panel-head">
          <span>目录</span>
          <button class="panel-close" data-action="close-panel" aria-label="关闭">×</button>
        </div>
        <div class="panel-body" id="toc-list"></div>
      </aside>

      <aside class="panel" id="settings-panel" hidden>
        <div class="panel-head">
          <span>阅读设置</span>
          <button class="panel-close" data-action="close-panel" aria-label="关闭">×</button>
        </div>
        <div class="panel-body" id="settings-body">
          <div class="field">
            <label for="set-font-size">字号</label>
            <input id="set-font-size" type="range" min="14" max="30" step="1" value="${settings.fontSize}" />
            <span class="field-value" id="set-font-size-value">${settings.fontSize}px</span>
          </div>
          <div class="field">
            <label for="set-line-height">行距</label>
            <input id="set-line-height" type="range" min="1.4" max="2.4" step="0.1" value="${settings.lineHeight}" />
            <span class="field-value" id="set-line-height-value">${settings.lineHeight}</span>
          </div>
          <div class="field">
            <label for="set-margin">页边距</label>
            <input id="set-margin" type="range" min="12" max="48" step="2" value="${settings.margin}" />
            <span class="field-value" id="set-margin-value">${settings.margin}px</span>
          </div>
          <div class="field">
            <label for="set-font">字体</label>
            <select id="set-font">
              ${FONTS.map((font) => `<option value="${font.id}" ${font.id === settings.font ? 'selected' : ''}>${font.label}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>主题</label></div>
          <div class="theme-row">
            ${THEMES.map(
              (theme) =>
                `<button class="theme-chip ${theme.id === settings.theme ? 'active' : ''}" data-theme-id="${theme.id}">${theme.label}</button>`,
            ).join('')}
          </div>
        </div>
      </aside>

      <aside class="panel" id="bookmark-panel" hidden>
        <div class="panel-head">
          <span>书签</span>
          <button class="panel-close" data-action="close-panel" aria-label="关闭">×</button>
        </div>
        <div class="panel-body">
          <button class="btn bookmark-add" data-action="add-bookmark">＋ 收藏当前位置</button>
          <div id="bookmark-list"></div>
        </div>
      </aside>

      <aside class="panel" id="search-panel" hidden>
        <div class="panel-head">
          <span>全书搜索</span>
          <button class="panel-close" data-action="close-panel" aria-label="关闭">×</button>
        </div>
        <div class="panel-body">
          <div class="search-box">
            <input id="search-input" type="search" placeholder="输入关键词，回车搜索" />
            <button class="btn" data-action="do-search">搜索</button>
          </div>
          <div class="search-status" id="search-status"></div>
          <div id="search-results"></div>
        </div>
      </aside>
    </div>
  `;

  const scrollEl = root.querySelector('#reader-scroll');
  const bodyEl = root.querySelector('#chapter-body');
  const chapterNameEl = root.querySelector('#chapter-name');
  const percentEl = root.querySelector('#reader-percent');
  const progressBarEl = root.querySelector('#reader-progress');
  const pagerIndexEl = root.querySelector('#chapter-index');
  const prevBtn = root.querySelector('#prev-chapter');
  const nextBtn = root.querySelector('#next-chapter');
  const tocPanel = root.querySelector('#toc-panel');
  const tocListEl = root.querySelector('#toc-list');
  const settingsPanel = root.querySelector('#settings-panel');
  const bookmarkPanel = root.querySelector('#bookmark-panel');
  const bookmarkListEl = root.querySelector('#bookmark-list');
  const searchPanel = root.querySelector('#search-panel');
  const searchInput = root.querySelector('#search-input');
  const searchStatusEl = root.querySelector('#search-status');
  const searchResultsEl = root.querySelector('#search-results');

  tocListEl.innerHTML = chapters
    .map((chapter, index) => `<button class="toc-item" data-index="${index}">${escapeHtml(chapter.title)}</button>`)
    .join('');
  const tocItems = [...tocListEl.querySelectorAll('.toc-item')];

  const persist = () => {
    clearTimeout(saveTimer);
    return saveProgress({ bookId, chapterIndex, ratio, updatedAt: Date.now() }).catch((error) =>
      console.error('保存进度失败', error),
    );
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };

  const updateProgressUI = () => {
    const percent = percentOf(chapterIndex, ratio, chapterCount);
    percentEl.textContent = formatPercent(percent);
    progressBarEl.style.width = `${percent.toFixed(2)}%`;
  };

  const updatePager = () => {
    pagerIndexEl.textContent = `${chapterIndex + 1} / ${chapterCount}`;
    prevBtn.disabled = chapterIndex <= 0;
    nextBtn.disabled = chapterIndex >= chapterCount - 1;
    tocItems.forEach((item, index) => item.classList.toggle('active', index === chapterIndex));
  };

  const restoreScroll = () => {
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    scrollEl.scrollTop = ratio > 0 && max > 0 ? ratio * max : 0;
  };

  const renderChapter = (index, restoreRatio = 0, focus = null) => {
    chapterIndex = clamp(index, 0, chapterCount - 1);
    const chapter = chapters[chapterIndex];
    chapterNameEl.textContent = chapter.title;
    ratio = clamp(restoreRatio, 0, 1);

    disposeFrame?.();
    disposeFrame = null;

    if (isEpub) {
      const html = buildChapterHtml(epub, chapterIndex, { style: readerStyle(settings), urlFor });
      bodyEl.classList.add('chapter--epub');
      disposeFrame = mountChapterFrame(bodyEl, html, () => {
        restoreScroll();
        if (focus) focusEpubMatch(focus);
      });
    } else {
      bodyEl.classList.remove('chapter--epub');
      bodyEl.innerHTML = chapter.paragraphs?.length
        ? chapter.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')
        : '<p class="chapter-empty">（本章没有正文）</p>';
      requestAnimationFrame(() => {
        restoreScroll();
        if (focus) focusTextMatch(focus);
      });
    }

    updatePager();
    updateProgressUI();
    scheduleSave();
  };

  const goToChapter = (index) => renderChapter(index, 0);

  const closePanels = () => {
    tocPanel.hidden = true;
    settingsPanel.hidden = true;
    bookmarkPanel.hidden = true;
    searchPanel.hidden = true;
  };

  // —— 命中定位与高亮 ——

  const highlightMatch = (rootNode, query, nth = 0) => {
    if (!rootNode || !query) return null;
    const needle = String(query).toLowerCase();
    const walker = rootNode.ownerDocument.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    let seen = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.nodeValue || '';
      const index = value.toLowerCase().indexOf(needle);
      if (index === -1) continue;
      if (seen !== nth) {
        seen += 1;
        continue;
      }
      const range = rootNode.ownerDocument.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const mark = rootNode.ownerDocument.createElement('mark');
      mark.className = 'search-hit';
      try {
        range.surroundContents(mark);
      } catch {
        return null;
      }
      return mark;
    }
    return null;
  };

  const scrollToElement = (element) => {
    if (!element) return;
    const target = element.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    scrollEl.scrollTop = Math.max(0, target - 80);
  };

  const focusTextMatch = (focus) => {
    const mark = highlightMatch(bodyEl, focus.query, focus.nth || 0);
    if (mark) scrollToElement(mark);
  };

  const focusEpubMatch = (focus) => {
    const frame = bodyEl.querySelector('.epub-frame');
    const doc = frame?.contentDocument;
    if (!doc) return;
    const mark = highlightMatch(doc.body, focus.query, focus.nth || 0);
    if (!mark) return;
    const frameTop = frame.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    const offset = frameTop + mark.getBoundingClientRect().top + scrollEl.scrollTop;
    scrollEl.scrollTop = Math.max(0, offset - 80);
  };

  // —— 书签 ——

  let bookmarks = [];

  const bookmarkId = () =>
    globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const renderBookmarks = () => {
    if (bookmarks.length === 0) {
      bookmarkListEl.innerHTML = '<p class="empty-hint">还没有书签。读到想记住的地方，点上面的按钮。</p>';
      return;
    }
    bookmarkListEl.innerHTML = bookmarks
      .map(
        (item) => `
        <div class="bookmark-item" data-id="${escapeHtml(item.id)}" data-chapter="${item.chapterIndex}" data-ratio="${item.ratio}">
          <div class="bookmark-main">
            <div class="bookmark-title">${escapeHtml(item.chapterTitle)}</div>
            <div class="bookmark-meta">${escapeHtml(item.percent)} · ${escapeHtml(formatDate(item.createdAt))}</div>
          </div>
          <button class="bookmark-del" data-action="delete-bookmark" data-id="${escapeHtml(item.id)}" aria-label="删除书签">×</button>
        </div>`,
      )
      .join('');
  };

  const loadBookmarks = async () => {
    bookmarks = await listBookmarks(bookId);
    renderBookmarks();
  };

  const handleAddBookmark = async () => {
    await addBookmark({
      id: bookmarkId(),
      bookId,
      chapterIndex,
      ratio,
      chapterTitle: chapters[chapterIndex].title,
      percent: formatPercent(percentOf(chapterIndex, ratio, chapterCount)),
      createdAt: Date.now(),
    });
    await loadBookmarks();
    toast('已添加书签');
  };

  const jumpToBookmark = (chapter, bookmarkRatio) => {
    closePanels();
    renderChapter(Number(chapter), Number(bookmarkRatio) || 0);
  };

  // —— 全文搜索 ——

  let searchTexts = null;
  let searchSeq = 0;
  let lastQuery = '';

  const ensureSearchIndex = async () => {
    if (searchTexts) return searchTexts;
    const cached = await getSearchIndex(bookId);
    if (cached?.texts?.length === chapterCount) {
      searchTexts = cached.texts;
      return searchTexts;
    }
    searchStatusEl.textContent = '首次搜索，正在建立索引…';
    const texts = await buildIndex(book, { chapters, epub }, {
      signal,
      onProgress: (done, total) => {
        searchStatusEl.textContent = `正在建立索引 ${done}/${total}`;
      },
    });
    searchTexts = texts;
    await saveSearchIndex({ bookId, texts, builtAt: Date.now() });
    return texts;
  };

  const runSearch = async () => {
    const query = searchInput.value.trim();
    if (!query) return;
    lastQuery = query;
    const seq = ++searchSeq;

    searchStatusEl.textContent = '搜索中…';
    searchResultsEl.innerHTML = '';

    try {
      const texts = await ensureSearchIndex();
      if (seq !== searchSeq) return;
      const results = searchText(texts, query);

      if (results.length === 0) {
        searchStatusEl.textContent = `没有找到「${query}」`;
        return;
      }
      searchStatusEl.textContent =
        results.length >= 120 ? '命中很多，先显示前 120 条' : `找到 ${results.length} 处`;      searchResultsEl.innerHTML = results
        .map(
          (result) => `
          <button class="search-result" data-chapter="${result.chapterIndex}" data-nth="${result.nth}">
            <span class="sr-chapter">${escapeHtml(chapters[result.chapterIndex].title)}</span>
            <span class="sr-text">${escapeHtml(result.snippet.before)}<mark>${escapeHtml(result.snippet.match)}</mark>${escapeHtml(result.snippet.after)}</span>
          </button>`,
        )
        .join('');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error(error);
      searchStatusEl.textContent = '搜索失败，请重试';
    }
  };

  const jumpToResult = (chapter, nth) => {
    closePanels();
    renderChapter(Number(chapter), 0, { query: lastQuery, nth: Number(nth) });
  };

  const leaveReader = async () => {
    await persist();
    location.hash = '#/';
  };

  const applySettingsLive = (next) => {
    const before = ratio;
    settings = applySettings(next);
    saveSettings(settings);
    if (isEpub) {
      renderChapter(chapterIndex, before);
      return;
    }
    requestAnimationFrame(() => {
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = before > 0 && max > 0 ? before * max : scrollEl.scrollTop;
      updateProgressUI();
    });
  };

  // —— 滚动与进度 ——
  scrollEl.addEventListener(
    'scroll',
    () => {
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      ratio = max > 0 ? clamp(scrollEl.scrollTop / max, 0, 1) : 0;
      updateProgressUI();
      scheduleSave();
    },
    { passive: true, signal },
  );

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) persist();
    },
    { signal },
  );
  window.addEventListener('pagehide', persist, { signal });
  window.addEventListener('resize', restoreScroll, { signal });

  // —— 点击 ——
  root.addEventListener(
    'click',
    (event) => {
      const target = event.target.closest('[data-action], [data-index], [data-theme-id]');
      if (!target) return;

      if (target.dataset.themeId) {
        applySettingsLive({ ...settings, theme: target.dataset.themeId });
        root.querySelectorAll('.theme-chip').forEach((chip) => {
          chip.classList.toggle('active', chip.dataset.themeId === target.dataset.themeId);
        });
        return;
      }

      if (target.dataset.index !== undefined && target.classList.contains('toc-item')) {
        goToChapter(Number(target.dataset.index));
        closePanels();
        return;
      }

      switch (target.dataset.action) {
        case 'back':
          leaveReader();
          break;
        case 'toc':
          settingsPanel.hidden = true;
          bookmarkPanel.hidden = true;
          searchPanel.hidden = true;
          tocPanel.hidden = !tocPanel.hidden;
          break;
        case 'settings':
          tocPanel.hidden = true;
          bookmarkPanel.hidden = true;
          searchPanel.hidden = true;
          settingsPanel.hidden = !settingsPanel.hidden;
          break;
        case 'search':
          tocPanel.hidden = true;
          settingsPanel.hidden = true;
          bookmarkPanel.hidden = true;
          searchPanel.hidden = !searchPanel.hidden;
          if (!searchPanel.hidden) searchInput.focus();
          break;
        case 'bookmarks':
          tocPanel.hidden = true;
          settingsPanel.hidden = true;
          searchPanel.hidden = true;
          bookmarkPanel.hidden = !bookmarkPanel.hidden;
          if (!bookmarkPanel.hidden) loadBookmarks();
          break;
        case 'add-bookmark':
          handleAddBookmark();
          break;
        case 'do-search':
          runSearch();
          break;
        case 'close-panel':
          closePanels();
          break;
        case 'prev-chapter':
          goToChapter(chapterIndex - 1);
          break;
        case 'next-chapter':
          goToChapter(chapterIndex + 1);
          break;
        default:
          break;
      }
    },
    { signal },
  );

  // —— 书签与搜索结果点击 ——
  bookmarkListEl.addEventListener(
    'click',
    async (event) => {
      const del = event.target.closest('[data-action="delete-bookmark"]');
      if (del) {
        event.stopPropagation();
        await deleteBookmark(del.dataset.id);
        await loadBookmarks();
        toast('已删除书签');
        return;
      }
      const item = event.target.closest('.bookmark-item');
      if (item) jumpToBookmark(item.dataset.chapter, item.dataset.ratio);
    },
    { signal },
  );

  searchResultsEl.addEventListener(
    'click',
    (event) => {
      const result = event.target.closest('.search-result');
      if (result) jumpToResult(result.dataset.chapter, result.dataset.nth);
    },
    { signal },
  );

  searchInput.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearch();
      }
    },
    { signal },
  );

  // —— 设置面板 ——
  const fontSizeInput = root.querySelector('#set-font-size');
  const lineHeightInput = root.querySelector('#set-line-height');
  const marginInput = root.querySelector('#set-margin');
  const fontSelect = root.querySelector('#set-font');

  fontSizeInput.addEventListener(
    'input',
    () => {
      root.querySelector('#set-font-size-value').textContent = `${fontSizeInput.value}px`;
      applySettingsLive(sanitizeSettings({ ...settings, fontSize: Number(fontSizeInput.value) }));
    },
    { signal },
  );
  lineHeightInput.addEventListener(
    'input',
    () => {
      root.querySelector('#set-line-height-value').textContent = lineHeightInput.value;
      applySettingsLive(sanitizeSettings({ ...settings, lineHeight: Number(lineHeightInput.value) }));
    },
    { signal },
  );
  marginInput.addEventListener(
    'input',
    () => {
      root.querySelector('#set-margin-value').textContent = `${marginInput.value}px`;
      applySettingsLive(sanitizeSettings({ ...settings, margin: Number(marginInput.value) }));
    },
    { signal },
  );
  fontSelect.addEventListener(
    'change',
    () => applySettingsLive(sanitizeSettings({ ...settings, font: fontSelect.value })),
    { signal },
  );

  // —— 键盘 ——
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (chapterIndex > 0) goToChapter(chapterIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (chapterIndex < chapterCount - 1) goToChapter(chapterIndex + 1);
      } else if (event.key === 'Escape') {
        if (!tocPanel.hidden || !settingsPanel.hidden || !bookmarkPanel.hidden || !searchPanel.hidden) closePanels();
        else leaveReader();
      }
    },
    { signal },
  );

  renderChapter(chapterIndex, ratio);
}
