/**
 * IndexedDB 封装：
 * - books：书目与解析结果（章节标题、封面、元数据）
 * - files：EPUB 原始文件（单独存储，书架列表不必加载大文件）
 * - progress：阅读进度
 * - bookmarks：书签
 * - search：全文搜索索引（按书缓存）
 */

const DB_NAME = 'haha-reader';
const DB_VERSION = 3;

let dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains('bookmarks')) {
          const store = db.createObjectStore('bookmarks', { keyPath: 'id' });
          store.createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains('search')) {
          db.createObjectStore('search', { keyPath: 'bookId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function objectStore(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

/** 保存一本书；EPUB 需同时保存原始文件。 */
export async function saveBook(book, fileBytes = null) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const stores = fileBytes ? ['books', 'files'] : ['books'];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore('books').put(book);
    if (fileBytes) tx.objectStore('files').put({ bookId: book.id, bytes: fileBytes });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('写入被中断'));
  });
  return book;
}

export async function getBook(bookId) {
  const store = await objectStore('books', 'readonly');
  return requestToPromise(store.get(bookId));
}

export async function getBookFile(bookId) {
  const store = await objectStore('files', 'readonly');
  const row = await requestToPromise(store.get(bookId));
  return row?.bytes ?? null;
}

export async function listBooks() {
  const store = await objectStore('books', 'readonly');
  return requestToPromise(store.getAll());
}

/** 删除书：连带进度、原始文件、书签与搜索索引。 */
export async function deleteBook(bookId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'progress', 'files', 'bookmarks', 'search'], 'readwrite');
    tx.objectStore('books').delete(bookId);
    tx.objectStore('progress').delete(bookId);
    tx.objectStore('files').delete(bookId);
    tx.objectStore('search').delete(bookId);

    const bookmarks = tx.objectStore('bookmarks');
    const index = bookmarks.index('bookId');
    index.openKeyCursor(IDBKeyRange.only(bookId)).onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        bookmarks.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProgress(bookId) {
  const store = await objectStore('progress', 'readonly');
  return requestToPromise(store.get(bookId));
}

export async function getProgressMap() {
  const store = await objectStore('progress', 'readonly');
  const rows = await requestToPromise(store.getAll());
  return new Map(rows.map((row) => [row.bookId, row]));
}

export async function saveProgress(progress) {
  const store = await objectStore('progress', 'readwrite');
  await requestToPromise(store.put(progress));
  return progress;
}

// —— 书签 ——

export async function addBookmark(bookmark) {
  const store = await objectStore('bookmarks', 'readwrite');
  await requestToPromise(store.put(bookmark));
  return bookmark;
}

export async function listBookmarks(bookId) {
  const db = await openDb();
  const store = db.transaction('bookmarks', 'readonly').objectStore('bookmarks');
  const rows = await requestToPromise(store.index('bookId').getAll(bookId));
  return rows.sort((a, b) => a.chapterIndex - b.chapterIndex || a.ratio - b.ratio);
}

export async function deleteBookmark(id) {
  const store = await objectStore('bookmarks', 'readwrite');
  await requestToPromise(store.delete(id));
}

// —— 搜索索引 ——

export async function saveSearchIndex(record) {
  const store = await objectStore('search', 'readwrite');
  await requestToPromise(store.put(record));
  return record;
}

export async function getSearchIndex(bookId) {
  const store = await objectStore('search', 'readonly');
  return requestToPromise(store.get(bookId));
}
