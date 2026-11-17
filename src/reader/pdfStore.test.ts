import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfSource } from './pdf';
import { asPdfSource, deletePdfSource, getPdfSource, hasPdfSource, resetPdfStoreForTests, savePdfSource } from './pdfStore';

const bytes = (n: number): ArrayBuffer => Uint8Array.from({ length: n }, (_, i) => i % 251).buffer;

function source(n = 64): PdfSource {
  return {
    bytes: bytes(n),
    pages: [
      { width: 612, height: 792, columns: false, lines: [{ x0: 72, x1: 500, y: 100, size: 12, text: 'A line of the page' }] },
      { width: 612, height: 792, columns: true, lines: [] },
    ],
  };
}

beforeEach(() => {
  resetPdfStoreForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pdfStore without IndexedDB (kept for the session)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', undefined);
  });

  it('keeps, finds and forgets a source', async () => {
    expect(await hasPdfSource('book-1')).toBe(false);
    expect(await getPdfSource('book-1')).toBeNull();
    expect(await savePdfSource('book-1', source())).toBe(false); // not on the device: this session only
    expect(await hasPdfSource('book-1')).toBe(true);
    const got = await getPdfSource('book-1');
    expect(got!.pages).toHaveLength(2);
    expect(new Uint8Array(got!.bytes)[5]).toBe(5);
    await deletePdfSource('book-1');
    expect(await hasPdfSource('book-1')).toBe(false);
    expect(await getPdfSource('book-1')).toBeNull();
  });

  it('holds only a few whole files in memory', async () => {
    for (let i = 0; i < 5; i++) await savePdfSource(`book-${i}`, source());
    expect(await hasPdfSource('book-0')).toBe(false);
    expect(await hasPdfSource('book-1')).toBe(false);
    expect(await hasPdfSource('book-4')).toBe(true);
  });

  it('refuses ids and sources that make no sense', async () => {
    expect(await savePdfSource('', source())).toBe(false);
    expect(await hasPdfSource('')).toBe(false);
    expect(await savePdfSource('book-1', { bytes: new ArrayBuffer(0), pages: source().pages })).toBe(false);
    expect(await hasPdfSource('book-1')).toBe(false);
    await expect(deletePdfSource('')).resolves.toBeUndefined();
  });
});

describe('pdfStore with IndexedDB', () => {
  /** A one-store IndexedDB that settles requests in microtasks and commits transactions after them. */
  function fakeIndexedDB(opts: { failPut?: boolean } = {}) {
    const records = new Map<string, unknown>();
    const stores = new Set<string>();
    const request = <T>(result: T) => ({ result });
    const db = {
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore: (n: string) => {
        stores.add(n);
      },
      close: () => undefined,
      transaction: () => {
        const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error?: unknown; objectStore: () => unknown } = {
          objectStore: () => ({
            put: (record: { id: string }) => {
              if (opts.failPut) {
                tx.error = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
                queueMicrotask(() => tx.onabort?.());
                return request(undefined);
              }
              records.set(record.id, structuredClone(record));
              return request(undefined);
            },
            get: (id: string) => request(records.get(id)),
            count: (id: string) => request(records.has(id) ? 1 : 0),
            delete: (id: string) => {
              records.delete(id);
              return request(undefined);
            },
          }),
        };
        queueMicrotask(() => queueMicrotask(() => (tx.error ? undefined : tx.oncomplete?.())));
        return tx;
      },
    };
    const factory = {
      open: () => {
        const req: { result: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: db };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    };
    return { factory, records };
  }

  it('stores the source on the device and reads back a checked copy', async () => {
    const fake = fakeIndexedDB();
    vi.stubGlobal('indexedDB', fake.factory);
    expect(await savePdfSource('book-1', source(128))).toBe(true);
    expect(fake.records.has('book-1')).toBe(true);
    expect(await hasPdfSource('book-1')).toBe(true);
    const got = await getPdfSource('book-1');
    expect(got!.bytes.byteLength).toBe(128);
    expect(got!.pages[0]!.lines[0]!.text).toBe('A line of the page');
    expect(got!.pages[1]!.columns).toBe(true);
    await deletePdfSource('book-1');
    expect(fake.records.has('book-1')).toBe(false);
    expect(await getPdfSource('book-1')).toBeNull();
  });

  it('a record someone else wrote there is checked before it is used', async () => {
    const fake = fakeIndexedDB();
    vi.stubGlobal('indexedDB', fake.factory);
    fake.records.set('book-x', { id: 'book-x', bytes: 'not bytes', pages: [] });
    expect(await getPdfSource('book-x')).toBeNull();
    fake.records.set('book-y', {
      id: 'book-y',
      bytes: bytes(8),
      pages: [{ width: 600, height: 800, columns: 'yes', lines: [{ x0: 10, x1: 300, y: 50, size: 10, text: 'kept' }, { x0: 10, x1: 5, y: 50, size: 10, text: 'backwards' }, { x0: 0, x1: 9e9, y: 60, size: 10, text: 'off the page' }, 'junk'] }],
    });
    const got = await getPdfSource('book-y');
    expect(got!.pages[0]!.columns).toBe(false);
    expect(got!.pages[0]!.lines.map((l) => l.text)).toEqual(['kept']);
  });

  it('a full disk keeps the source for the session instead of failing', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB({ failPut: true }).factory);
    expect(await savePdfSource('book-1', source())).toBe(false);
    expect(await hasPdfSource('book-1')).toBe(true);
    expect((await getPdfSource('book-1'))!.pages).toHaveLength(2);
  });
});

describe('asPdfSource', () => {
  it('accepts what the loader produces and nothing else', () => {
    expect(asPdfSource(source())).not.toBeNull();
    for (const bad of [null, 'x', {}, { bytes: bytes(4) }, { bytes: bytes(4), pages: [] }, { bytes: bytes(4), pages: [{ width: 0, height: 10, lines: [] }] }, { bytes: bytes(4), pages: [{ width: 10, height: 10 }] }, { bytes: [1, 2, 3], pages: source().pages }]) {
      expect(asPdfSource(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
    // Long text is cut, never rejected.
    const long = asPdfSource({ bytes: bytes(4), pages: [{ width: 100, height: 100, columns: false, lines: [{ x0: 1, x1: 90, y: 20, size: 10, text: 'y'.repeat(5000) }] }] });
    expect(long!.pages[0]!.lines[0]!.text).toHaveLength(400);
  });
});
