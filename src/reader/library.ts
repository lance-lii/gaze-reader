import type { Book, BookChapter, ReadingPosition } from '../types';

/**
 * The reader's bookshelf: IndexedDB database "gazeReader" with stores "books"
 * (full books), "progress" (reading positions) and "meta" (the few fields the
 * library screen lists, so listing never deserializes whole books). When
 * IndexedDB is missing or refuses to open (some private modes, jsdom), everything
 * transparently lives in memory for the session.
 */

export type LibraryBookMeta = Pick<Book, 'id' | 'title' | 'author' | 'wordCount' | 'format' | 'addedAt'>;
export type LibraryEntry = LibraryBookMeta & { fraction: number; lastReadAt: number | null };

export type LibraryErrorCode = 'invalid' | 'quota' | 'unavailable';

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LibraryError';
    this.code = code;
  }
}

const DB_NAME = 'gazeReader';
const DB_VERSION = 1;
const BOOKS = 'books';
const PROGRESS = 'progress';
const META = 'meta';
const OPEN_TIMEOUT_MS = 10_000;
const BOOK_FORMATS = new Set(['txt', 'md', 'html', 'epub', 'pdf', 'sample']);
const BOOK_SOURCES = new Set(['sample', 'file', 'paste', 'url']);

interface Backend {
  putBook(book: Book, meta: LibraryBookMeta): Promise<void>;
  getBook(id: string): Promise<unknown>;
  allMeta(): Promise<unknown[]>;
  allProgress(): Promise<unknown[]>;
  deleteBook(id: string): Promise<void>;
  putProgress(pos: ReadingPosition): Promise<void>;
  getProgress(bookId: string): Promise<unknown>;
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

class MemoryBackend implements Backend {
  private readonly books = new Map<string, Book>();
  private readonly meta = new Map<string, LibraryBookMeta>();
  private readonly progress = new Map<string, ReadingPosition>();

  async putBook(book: Book, meta: LibraryBookMeta): Promise<void> {
    this.books.set(book.id, clone(book));
    this.meta.set(book.id, clone(meta));
  }
  async getBook(id: string): Promise<unknown> {
    const b = this.books.get(id);
    return b ? clone(b) : null;
  }
  async allMeta(): Promise<unknown[]> {
    return [...this.meta.values()].map(clone);
  }
  async allProgress(): Promise<unknown[]> {
    return [...this.progress.values()].map(clone);
  }
  async deleteBook(id: string): Promise<void> {
    this.books.delete(id);
    this.meta.delete(id);
    this.progress.delete(id);
  }
  async putProgress(pos: ReadingPosition): Promise<void> {
    this.progress.set(pos.bookId, clone(pos));
  }
  async getProgress(bookId: string): Promise<unknown> {
    const p = this.progress.get(bookId);
    return p ? clone(p) : null;
  }
}

/** Runs `work` in one transaction and resolves with its result once the transaction has committed. */
function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let result: () => T;
    try {
      tx = db.transaction(stores, mode);
      result = work(tx);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

class IdbBackend implements Backend {
  constructor(private readonly db: IDBDatabase) {}

  putBook(book: Book, meta: LibraryBookMeta): Promise<void> {
    return transact(this.db, [BOOKS, META], 'readwrite', (tx) => {
      tx.objectStore(BOOKS).put(book);
      tx.objectStore(META).put(meta);
      return () => undefined;
    });
  }
  getBook(id: string): Promise<unknown> {
    return transact(this.db, [BOOKS], 'readonly', (tx) => {
      const req = tx.objectStore(BOOKS).get(id);
      return () => req.result ?? null;
    });
  }
  allMeta(): Promise<unknown[]> {
    return transact(this.db, [META], 'readonly', (tx) => {
      const req = tx.objectStore(META).getAll();
      return () => req.result ?? [];
    });
  }
  allProgress(): Promise<unknown[]> {
    return transact(this.db, [PROGRESS], 'readonly', (tx) => {
      const req = tx.objectStore(PROGRESS).getAll();
      return () => req.result ?? [];
    });
  }
  deleteBook(id: string): Promise<void> {
    return transact(this.db, [BOOKS, META, PROGRESS], 'readwrite', (tx) => {
      tx.objectStore(BOOKS).delete(id);
      tx.objectStore(META).delete(id);
      tx.objectStore(PROGRESS).delete(id);
      return () => undefined;
    });
  }
  putProgress(pos: ReadingPosition): Promise<void> {
    return transact(this.db, [PROGRESS], 'readwrite', (tx) => {
      tx.objectStore(PROGRESS).put(pos);
      return () => undefined;
    });
  }
  getProgress(bookId: string): Promise<unknown> {
    return transact(this.db, [PROGRESS], 'readonly', (tx) => {
      const req = tx.objectStore(PROGRESS).get(bookId);
      return () => req.result ?? null;
    });
  }
}

let backendPromise: Promise<Backend> | null = null;
let warned = false;

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB took too long to open')), OPEN_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PROGRESS)) db.createObjectStore(PROGRESS, { keyPath: 'bookId' });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      // Let another tab upgrade the schema; we reopen lazily on the next call.
      db.onversionchange = () => {
        db.close();
        backendPromise = null;
      };
      db.onclose = () => {
        backendPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error('IndexedDB failed to open'));
    };
  });
}

async function createBackend(): Promise<Backend> {
  const factory = typeof indexedDB === 'undefined' ? null : indexedDB;
  if (!factory) return new MemoryBackend();
  try {
    return new IdbBackend(await openDatabase(factory));
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[library] IndexedDB is unavailable; books are kept for this session only.', err);
    }
    return new MemoryBackend();
  }
}

function backend(): Promise<Backend> {
  backendPromise ??= createBackend();
  return backendPromise;
}

function storageError(err: unknown): LibraryError {
  if (err instanceof LibraryError) return err;
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'QuotaExceededError') {
    return new LibraryError('quota', 'Your browser’s storage for Gaze Reader is full. Remove a book from your library to make room.', {
      cause: err,
    });
  }
  return new LibraryError('unavailable', 'Your library couldn’t be read or saved right now.', { cause: err });
}

async function withBackend<T>(fn: (b: Backend) => Promise<T>): Promise<T> {
  try {
    return await fn(await backend());
  } catch (err) {
    throw storageError(err);
  }
}

// ───────────────────────────── Validation ─────────────────────────────

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function asChapters(v: unknown): BookChapter[] | null {
  if (!Array.isArray(v)) return null;
  const out: BookChapter[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') return null;
    const { title, html } = c as Record<string, unknown>;
    if (typeof html !== 'string' || (title !== null && typeof title !== 'string')) return null;
    out.push({ title: title as string | null, html });
  }
  return out;
}

/** Copies only the known fields of a Book (drops anything that can't or shouldn't be stored). */
function asBook(v: unknown): Book | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const chapters = asChapters(b.chapters);
  if (typeof b.id !== 'string' || !b.id || typeof b.title !== 'string' || !chapters) return null;
  if (typeof b.format !== 'string' || !BOOK_FORMATS.has(b.format)) return null;
  if (typeof b.source !== 'string' || !BOOK_SOURCES.has(b.source)) return null;
  return {
    id: b.id,
    title: b.title,
    author: typeof b.author === 'string' ? b.author : null,
    chapters,
    wordCount: isFiniteNumber(b.wordCount) && b.wordCount >= 0 ? Math.round(b.wordCount) : 0,
    source: b.source as Book['source'],
    format: b.format as Book['format'],
    addedAt: isFiniteNumber(b.addedAt) ? b.addedAt : Date.now(),
  };
}

function asMeta(v: unknown): LibraryBookMeta | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.title !== 'string') return null;
  return {
    id: m.id,
    title: m.title,
    author: typeof m.author === 'string' ? m.author : null,
    wordCount: isFiniteNumber(m.wordCount) ? m.wordCount : 0,
    format: typeof m.format === 'string' && BOOK_FORMATS.has(m.format) ? (m.format as Book['format']) : 'txt',
    addedAt: isFiniteNumber(m.addedAt) ? m.addedAt : 0,
  };
}

function asPosition(v: unknown): ReadingPosition | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (typeof p.bookId !== 'string' || !p.bookId || !isFiniteNumber(p.fraction)) return null;
  const pos: ReadingPosition = {
    bookId: p.bookId,
    fraction: Math.min(1, Math.max(0, p.fraction)),
    updatedAt: isFiniteNumber(p.updatedAt) ? p.updatedAt : Date.now(),
  };
  if (typeof p.anchor === 'string' && p.anchor && p.anchor.length <= 200) pos.anchor = p.anchor;
  return pos;
}

// ───────────────────────────── Public API ─────────────────────────────

/** Adds (or replaces) a book in the library. */
export async function saveBook(book: Book): Promise<void> {
  const clean = asBook(book);
  if (!clean) throw new LibraryError('invalid', 'That book is missing required information and can’t be saved.');
  const meta: LibraryBookMeta = {
    id: clean.id,
    title: clean.title,
    author: clean.author,
    wordCount: clean.wordCount,
    format: clean.format,
    addedAt: clean.addedAt,
  };
  await withBackend((b) => b.putBook(clean, meta));
}

export async function getBook(id: string): Promise<Book | null> {
  if (typeof id !== 'string' || !id) return null;
  return asBook(await withBackend((b) => b.getBook(id)));
}

/** Library listing, most recently read (or added) first. */
export async function listBooks(): Promise<LibraryEntry[]> {
  const [metas, positions] = await withBackend((b) => Promise.all([b.allMeta(), b.allProgress()]));
  const progress = new Map<string, ReadingPosition>();
  for (const raw of positions) {
    const p = asPosition(raw);
    if (p) progress.set(p.bookId, p);
  }
  const entries: LibraryEntry[] = [];
  for (const raw of metas) {
    const m = asMeta(raw);
    if (!m) continue;
    const p = progress.get(m.id);
    entries.push({ ...m, fraction: p?.fraction ?? 0, lastReadAt: p?.updatedAt ?? null });
  }
  return entries.sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt));
}

/** Removes a book and its reading position. */
export async function deleteBook(id: string): Promise<void> {
  if (typeof id !== 'string' || !id) return;
  await withBackend((b) => b.deleteBook(id));
}

export async function saveProgress(pos: ReadingPosition): Promise<void> {
  const clean = asPosition(pos);
  if (!clean) throw new LibraryError('invalid', 'Invalid reading position.');
  await withBackend((b) => b.putProgress(clean));
}

export async function getProgress(bookId: string): Promise<ReadingPosition | null> {
  if (typeof bookId !== 'string' || !bookId) return null;
  return asPosition(await withBackend((b) => b.getProgress(bookId)));
}
