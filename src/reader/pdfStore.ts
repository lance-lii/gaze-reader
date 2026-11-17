import type { PdfLineBox, PdfPageLayout, PdfSource } from './pdf';

/**
 * Keeps the original file of a PDF book (and its pages' line boxes) on this device, so the pages
 * can be shown as they are (the pages view) and not only as extracted text.
 *
 * A database of its own (`gazeReaderPdf`), beside the library's: a PDF is many megabytes where a
 * book's text is kilobytes, and adding a store to the library's database would mean a schema
 * upgrade of the data people already have. Like the library, everything here is a convenience:
 * when the browser has no IndexedDB, or it is full, sources are kept for the session only and the
 * book itself still opens.
 *
 * What is read back is treated as untrusted (other pages on the same origin can write here):
 * the numbers are checked, the text only ever becomes text content, and the bytes go to pdf.js
 * like any file the reader picks.
 */

const DB_NAME = 'gazeReaderPdf';
const DB_VERSION = 1;
const STORE = 'sources';
const OPEN_TIMEOUT_MS = 10_000;
/** Limits on what is read back: more than this is not a page layout this app wrote. */
const MAX_PAGES = 5000;
const MAX_LINES_PER_PAGE = 2000;
const MAX_LINE_TEXT = 400;
/** Sources kept in memory when IndexedDB is unavailable (each is a whole file). */
const MAX_MEMORY_SOURCES = 3;

interface StoredSource extends PdfSource {
  id: string;
  savedAt: number;
}

const memory = new Map<string, PdfSource>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function idbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  const factory = idbFactory();
  if (!factory) return Promise.resolve(null);
  return new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null): void => {
      if (settled) {
        db?.close(); // we gave up waiting: don't hold a connection nobody uses
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      done(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const lost = (): void => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        lost();
      };
      db.onclose = lost;
      done(db);
    };
    request.onerror = () => done(null);
    request.onblocked = () => done(null);
  });
}

function database(): Promise<IDBDatabase | null> {
  dbPromise ??= openDatabase();
  return dbPromise;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let request: IDBRequest<T> | null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction([STORE], mode);
      request = work(tx.objectStore(STORE));
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(request ? (request.result ?? null) : null);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function asLine(v: unknown, page: { width: number; height: number }): PdfLineBox | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  if (!isFiniteNumber(l.x0) || !isFiniteNumber(l.x1) || !isFiniteNumber(l.y) || !isFiniteNumber(l.size) || typeof l.text !== 'string') return null;
  if (!(l.size > 0) || !(l.x1 > l.x0) || l.x0 < 0 || l.x1 > page.width + 1 || l.y < 0 || l.y > page.height + l.size) return null;
  return { x0: l.x0, x1: l.x1, y: l.y, size: l.size, text: l.text.slice(0, MAX_LINE_TEXT) };
}

function asPage(v: unknown): PdfPageLayout | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!isFiniteNumber(p.width) || !isFiniteNumber(p.height) || !(p.width > 0) || !(p.height > 0) || !Array.isArray(p.lines)) return null;
  const page = { width: p.width, height: p.height };
  const lines: PdfLineBox[] = [];
  for (const raw of p.lines.slice(0, MAX_LINES_PER_PAGE)) {
    const line = asLine(raw, page);
    if (line) lines.push(line);
  }
  return { ...page, columns: p.columns === true, lines };
}

/** A validated copy of a stored source, or null when it isn't one. */
export function asPdfSource(v: unknown): PdfSource | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (!(s.bytes instanceof ArrayBuffer) || s.bytes.byteLength === 0 || !Array.isArray(s.pages) || s.pages.length === 0 || s.pages.length > MAX_PAGES) return null;
  const pages: PdfPageLayout[] = [];
  for (const raw of s.pages) {
    const page = asPage(raw);
    if (!page) return null;
    pages.push(page);
  }
  return { bytes: s.bytes, pages };
}

function remember(bookId: string, source: PdfSource): void {
  memory.delete(bookId);
  memory.set(bookId, source);
  while (memory.size > MAX_MEMORY_SOURCES) memory.delete(memory.keys().next().value as string);
}

/**
 * Keeps `source` for the book. Resolves true when it was stored on the device, false when it is
 * only kept for this session (no IndexedDB, or the browser's storage is full).
 */
export async function savePdfSource(bookId: string, source: PdfSource): Promise<boolean> {
  if (typeof bookId !== 'string' || !bookId) return false;
  const clean = asPdfSource(source);
  if (!clean) return false;
  const db = await database();
  if (db) {
    try {
      const record: StoredSource = { id: bookId, savedAt: Date.now(), ...clean };
      await run(db, 'readwrite', (store) => {
        store.put(record);
        return null;
      });
      memory.delete(bookId);
      return true;
    } catch (err) {
      console.warn('[pdf] could not keep the PDF for the pages view on this device; keeping it for this session.', err);
    }
  }
  remember(bookId, clean);
  return false;
}

/** The source kept for the book, or null. */
export async function getPdfSource(bookId: string): Promise<PdfSource | null> {
  if (typeof bookId !== 'string' || !bookId) return null;
  const held = memory.get(bookId);
  if (held) return held;
  const db = await database();
  if (!db) return null;
  try {
    return asPdfSource(await run<unknown>(db, 'readonly', (store) => store.get(bookId) as IDBRequest<unknown>));
  } catch (err) {
    console.warn('[pdf] could not read the stored PDF.', err);
    return null;
  }
}

/** Whether a source is kept for the book (without reading the file back). */
export async function hasPdfSource(bookId: string): Promise<boolean> {
  if (typeof bookId !== 'string' || !bookId) return false;
  if (memory.has(bookId)) return true;
  const db = await database();
  if (!db) return false;
  try {
    return ((await run<number>(db, 'readonly', (store) => store.count(bookId))) ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Forgets the source kept for the book (when the book is removed). Never rejects. */
export async function deletePdfSource(bookId: string): Promise<void> {
  if (typeof bookId !== 'string' || !bookId) return;
  memory.delete(bookId);
  const db = await database();
  if (!db) return;
  try {
    await run(db, 'readwrite', (store) => {
      store.delete(bookId);
      return null;
    });
  } catch (err) {
    console.warn('[pdf] could not remove the stored PDF.', err);
  }
}

/** Test seam: forget the connection and the in-memory sources. */
export function resetPdfStoreForTests(): void {
  dbPromise = null;
  memory.clear();
}
