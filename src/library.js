import { listBooks, getProgressMap, saveBook, deleteBook } from './db.js';
import { percentOf, formatPercent, formatBytes, formatDate, escapeHtml, stripExtension } from './format.js';
import { decodeText, splitChapters } from './txt.js';
import { openEpub } from './epub.js';
import { guessMediaType } from './epub-view.js';
import { toast } from './ui.js';

const MAX_FILE_BYTES = 40 * 1024 * 1024;

export async function renderShelf(root, signal) {
  root.innerHTML = `
    <div class="shelf-shell">
      <header class="shelf-head">
        <div class="brand">
          <span class="brand-mark">哈</span>
          <h1>哈哈阅读</h1>
        </div>
        <label class="btn btn-primary" for="file-input">导入书籍</label>
        <input id="file-input" type="file" accept=".txt,.epub,text/plain,application/epub+zip" multiple hidden />
      </header>
      <p class="shelf-hint">支持 TXT 与 EPUB，可拖拽到页面。书籍只保存在本机浏览器，不会上传。</p>
      <ul class="book-list" id="book-list"></ul>
      <p class="shelf-empty" id="shelf-empty" hidden>书架还是空的，先导入一本 TXT 或 EPUB 吧。</p>
    </div>
  `;

  const listEl = root.querySelector('#book-list');
  const emptyEl = root.querySelector('#shelf-empty');
  const inputEl = root.querySelector('#file-input');

  let coverUrls = [];
  const revokeCovers = () => {
    coverUrls.forEach((url) => URL.revokeObjectURL(url));
    coverUrls = [];
  };
  signal?.addEventListener('abort', revokeCovers);

  const refresh = async () => {
    const [books, progressMap] = await Promise.all([listBooks(), getProgressMap()]);
    books.sort((a, b) => {
      const ta = progressMap.get(a.id)?.updatedAt ?? a.addedAt ?? 0;
      const tb = progressMap.get(b.id)?.updatedAt ?? b.addedAt ?? 0;
      return tb - ta;
    });
    revokeCovers();
    listEl.innerHTML = books.map((book) => bookCard(book, progressMap.get(book.id), coverUrls)).join('');
    emptyEl.hidden = books.length > 0;
    return books;
  };

  const importFiles = async (fileList) => {
    const files = [...fileList].filter((file) => /\.(txt|epub)$/i.test(file.name));
    if (files.length === 0) {
      toast('只支持 .txt 和 .epub 文件');
      return;
    }

    const existing = await listBooks();
    let imported = 0;

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        toast(`${file.name} 超过 40MB，先跳过`);
        continue;
      }
      const sourceName = file.name;
      if (existing.some((book) => book.sourceName === sourceName && book.size === file.size)) {
        toast(`《${sourceName}》已在书架中`);
        continue;
      }

      try {
        const buffer = await file.arrayBuffer();
        const book = /\.epub$/i.test(file.name)
          ? await importEpub(file, buffer)
          : await importTxt(file, buffer);
        await saveBook(book, book.format === 'epub' ? buffer : null);
        existing.push(book);
        imported += 1;
      } catch (error) {
        console.error(error);
        toast(`${file.name} 导入失败：${error.message || '未知错误'}`);
      }
    }

    if (imported > 0) toast(`已导入 ${imported} 本书`);
    await refresh();
  };

  inputEl.addEventListener(
    'change',
    async () => {
      await importFiles(inputEl.files);
      inputEl.value = '';
    },
    { signal },
  );

  listEl.addEventListener(
    'click',
    async (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const card = button.closest('[data-id]');
      const bookId = card?.dataset.id;
      if (!bookId) return;

      if (button.dataset.action === 'open') {
        location.hash = `#/read/${encodeURIComponent(bookId)}`;
        return;
      }
      if (button.dataset.action === 'delete') {
        const title = button.dataset.title || '这本书';
        if (!confirm(`删除《${title}》？阅读进度也会一起清除。`)) return;
        await deleteBook(bookId);
        toast(`已删除《${title}》`);
        await refresh();
      }
    },
    { signal },
  );

  root.addEventListener(
    'dragover',
    (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    { signal },
  );

  root.addEventListener(
    'drop',
    (event) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) importFiles(files);
    },
    { signal },
  );

  await refresh();
}

async function importTxt(file, buffer) {
  return {
    id: createId(),
    title: stripExtension(file.name),
    author: '',
    sourceName: file.name,
    size: file.size,
    format: 'txt',
    chapters: splitChapters(decodeText(buffer)),
    cover: null,
    coverType: '',
    addedAt: Date.now(),
  };
}

async function importEpub(file, buffer) {
  const epub = await openEpub(buffer);
  return {
    id: createId(),
    title: epub.title || stripExtension(file.name),
    author: epub.author || '',
    sourceName: file.name,
    size: file.size,
    format: 'epub',
    chapters: epub.chapters.map((chapter) => ({ title: chapter.title, path: chapter.path })),
    cover: epub.cover?.bytes ?? null,
    coverType: epub.cover?.mediaType || guessMediaType(epub.cover?.path || ''),
    addedAt: Date.now(),
  };
}

function bookCard(book, progress, coverUrls) {
  const chapterCount = book.chapters?.length ?? 0;
  const percent = progress ? percentOf(progress.chapterIndex, progress.ratio, chapterCount) : 0;
  const updatedAt = progress?.updatedAt ?? book.addedAt;
  const isEpub = book.format === 'epub';

  let coverUrl = '';
  if (book.cover?.byteLength) {
    try {
      coverUrl = URL.createObjectURL(new Blob([book.cover], { type: book.coverType || 'image/png' }));
      coverUrls.push(coverUrl);
    } catch {
      coverUrl = '';
    }
  }

  const coverHtml = coverUrl
    ? `<img src="${coverUrl}" alt="" loading="lazy" />`
    : `<span class="book-cover-fallback">${escapeHtml(book.title.slice(0, 1))}</span>`;

  const meta = [
    isEpub ? 'EPUB' : 'TXT',
    book.author ? book.author : '',
    `${chapterCount} 章`,
    formatBytes(book.size),
    percent > 0 ? `已读 ${formatPercent(percent)}` : '未开始',
    formatDate(updatedAt),
  ].filter(Boolean);

  return `
    <li class="book-card" data-id="${escapeHtml(book.id)}">
      <div class="book-main">
        <div class="book-cover">${coverHtml}</div>
        <div class="book-info">
          <h2 class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</h2>
          <div class="book-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
          <div class="book-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
            <span style="width:${percent.toFixed(2)}%"></span>
          </div>
        </div>
      </div>
      <div class="book-actions">
        <button class="btn" data-action="open">${percent > 0 ? '继续阅读' : '开始阅读'}</button>
        <button class="btn btn-danger" data-action="delete" data-title="${escapeHtml(book.title)}">删除</button>
      </div>
    </li>
  `;
}

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
