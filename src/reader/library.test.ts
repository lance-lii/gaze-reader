import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book, ReadingPosition } from '../types';

type LibraryModule = typeof import('./library');

function book(id: string, overrides: Partial<Book> = {}): Book {
  return {
    id,
    title: `Book ${id}`,
    author: 'An Author',
    chapters: [{ title: 'One', html: '<p>Hello</p>' }],
    wordCount: 1,
    source: 'file',
    format: 'txt',
    addedAt: 1000,
    ...overrides,
  };
}

/** Fresh module state per test: the backend is chosen once per module instance. */
async function freshLibrary(): Promise<LibraryModule> {
  vi.resetModules();
  return import('./library');
}

function behavesLikeALibrary(setup: () => Promise<LibraryModule>): void {
  it('saves, gets and lists books with their progress, most recent first', async () => {
    const lib = await setup();
    await lib.saveBook(book('a', { addedAt: 1000 }));
    await lib.saveBook(book('b', { addedAt: 2000, title: 'Second' }));
    await lib.saveProgress({ bookId: 'a', fraction: 0.25, anchor: 'c0-p3', updatedAt: 5000 });

    expect(await lib.getBook('a')).toMatchObject({ id: 'a', title: 'Book a', chapters: [{ title: 'One', html: '<p>Hello</p>' }] });
    expect(await lib.getBook('missing')).toBeNull();
    const list = await lib.listBooks();
    expect(list.map((e) => e.id)).toEqual(['a', 'b']); // read at 5000 beats added at 2000
    expect(list[0]).toEqual({
      id: 'a',
      title: 'Book a',
      author: 'An Author',
      wordCount: 1,
      format: 'txt',
      addedAt: 1000,
      fraction: 0.25,
      lastReadAt: 5000,
    });
    expect(list[1]).toMatchObject({ id: 'b', fraction: 0, lastReadAt: null });
    expect(await lib.getProgress('a')).toEqual({ bookId: 'a', fraction: 0.25, anchor: 'c0-p3', updatedAt: 5000 });
    expect(await lib.getProgress('b')).toBeNull();
  });

  it('stores copies, not references', async () => {
    const lib = await setup();
    const b = book('copy');
    await lib.saveBook(b);
    b.title = 'mutated after saving';
    const loaded = await lib.getBook('copy');
    expect(loaded?.title).toBe('Book copy');
    if (loaded) loaded.chapters[0].html = 'mutated after loading';
    expect((await lib.getBook('copy'))?.chapters[0].html).toBe('<p>Hello</p>');
  });

  it('replaces a book saved twice and deletes a book together with its progress', async () => {
    const lib = await setup();
    await lib.saveBook(book('x'));
    await lib.saveBook(book('x', { title: 'Updated' }));
    await lib.saveProgress({ bookId: 'x', fraction: 0.5, updatedAt: 1 });
    expect((await lib.listBooks()).map((e) => e.title)).toEqual(['Updated']);
    await lib.deleteBook('x');
    expect(await lib.getBook('x')).toBeNull();
    expect(await lib.getProgress('x')).toBeNull();
    expect(await lib.listBooks()).toEqual([]);
  });

  it('validates what it stores', async () => {
    const lib = await setup();
    await expect(lib.saveBook({ ...book(''), id: '' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(lib.saveBook({ ...book('z'), chapters: [{ title: 1, html: 2 }] } as unknown as Book)).rejects.toBeInstanceOf(
      lib.LibraryError,
    );
    await expect(lib.saveProgress({ bookId: 'z', fraction: Number.NaN, updatedAt: 1 })).rejects.toMatchObject({ code: 'invalid' });
    await lib.saveProgress({ bookId: 'z', fraction: 7, anchor: 'x'.repeat(500), updatedAt: 1 } as ReadingPosition);
    expect(await lib.getProgress('z')).toEqual({ bookId: 'z', fraction: 1, updatedAt: 1 }); // clamped, oversize anchor dropped
    // Extra fields never reach storage.
    await lib.saveBook({ ...book('extra'), secret: 'nope' } as Book);
    expect(await lib.getBook('extra')).not.toHaveProperty('secret');
  });
}

// ─────────────────────────────── in-memory fallback ───────────────────────────────

describe('library — in-memory fallback (no IndexedDB)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  behavesLikeALibrary(freshLibrary);

  it('keeps data for the lifetime of the page only', async () => {
    const lib = await freshLibrary();
    await lib.saveBook(book('session'));
    expect(await lib.getBook('session')).not.toBeNull();
    const reloaded = await freshLibrary();
    expect(await reloaded.getBook('session')).toBeNull();
  });
});

// ─────────────────────────────── fake IndexedDB ───────────────────────────────

/**
 * Just enough of IndexedDB for library.ts: async request callbacks, transactions
 * that complete after their last request, keyPath stores, getAll, and quota errors.
 */
interface FakeConnection {
  closed: boolean;
  onversionchange?: (() => void) | null;
  onclose?: (() => void) | null;
}

class FakeIDB {
  readonly databases = new Map<string, { version: number; stores: Map<string, { keyPath: string; data: Map<string, unknown> }> }>();
  failOpen = false;
  quotaBytes = Infinity;
  opens = 0;
  openDelayMs = 0;
  readonly connections: FakeConnection[] = [];

  open(name: string, version: number): IDBOpenDBRequest {
    this.opens++;
    const req = { result: undefined as unknown, error: null as DOMException | null } as Record<string, unknown>;
    setTimeout(() => {
      if (this.failOpen) {
        req.error = new DOMException('The user denied permission', 'InvalidStateError');
        (req.onerror as (() => void) | undefined)?.();
        return;
      }
      let db = this.databases.get(name);
      const upgrading = !db || db.version < version;
      if (!db) {
        db = { version, stores: new Map() };
        this.databases.set(name, db);
      }
      req.result = this.connection(db);
      if (upgrading) {
        db.version = version;
        (req.onupgradeneeded as (() => void) | undefined)?.();
      }
      (req.onsuccess as (() => void) | undefined)?.();
    }, this.openDelayMs);
    return req as unknown as IDBOpenDBRequest;
  }

  private connection(db: { stores: Map<string, { keyPath: string; data: Map<string, unknown> }> }): IDBDatabase {
    const fake = this;
    const conn = {
      closed: false,
      objectStoreNames: { contains: (n: string) => db.stores.has(n) },
      createObjectStore(name: string, opts: { keyPath: string }) {
        db.stores.set(name, { keyPath: opts.keyPath, data: new Map() });
      },
      close() {
        conn.closed = true;
      },
      transaction(names: string[], mode: string) {
        const tx: Record<string, unknown> = { error: null };
        let pending = 0;
        let finished = false;
        const staged: (() => void)[] = [];
        const settle = (): void => {
          setTimeout(() => {
            if (pending > 0 || finished) return;
            finished = true;
            for (const apply of staged) apply();
            (tx.oncomplete as (() => void) | undefined)?.();
          }, 0);
        };
        const request = (run: () => unknown): IDBRequest => {
          const req: Record<string, unknown> = { result: undefined, error: null };
          pending++;
          queueMicrotask(() => {
            try {
              req.result = run();
              (req.onsuccess as (() => void) | undefined)?.();
            } catch (err) {
              req.error = err;
              tx.error = err;
              finished = true;
              (tx.onerror as (() => void) | undefined)?.();
              (tx.onabort as (() => void) | undefined)?.();
            }
            pending--;
            settle();
          });
          return req as unknown as IDBRequest;
        };
        tx.objectStore = (name: string) => {
          if (!names.includes(name)) throw new DOMException('not in scope', 'NotFoundError');
          const store = db.stores.get(name);
          if (!store) throw new DOMException('no store', 'NotFoundError');
          return {
            put: (value: Record<string, unknown>) =>
              request(() => {
                if (mode !== 'readwrite') throw new DOMException('read only', 'ReadOnlyError');
                if (JSON.stringify(value).length > fake.quotaBytes) throw new DOMException('full', 'QuotaExceededError');
                const copy = structuredClone(value);
                staged.push(() => store.data.set(String(value[store.keyPath]), copy));
                return value[store.keyPath];
              }),
            get: (key: string) => request(() => (store.data.has(key) ? structuredClone(store.data.get(key)) : undefined)),
            getAll: () => request(() => [...store.data.values()].map((v) => structuredClone(v))),
            delete: (key: string) =>
              request(() => {
                staged.push(() => store.data.delete(key));
                return undefined;
              }),
          };
        };
        return tx as unknown as IDBTransaction;
      },
    };
    this.connections.push(conn);
    return conn as unknown as IDBDatabase;
  }
}

describe('library — IndexedDB', () => {
  let fake: FakeIDB;
  beforeEach(() => {
    fake = new FakeIDB();
    vi.stubGlobal('indexedDB', fake);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  behavesLikeALibrary(freshLibrary);

  it('creates the gazeReader database with books, meta and progress stores, and persists across reloads', async () => {
    const lib = await freshLibrary();
    await lib.saveBook(book('persist'));
    await lib.saveProgress({ bookId: 'persist', fraction: 0.4, updatedAt: 9 });
    const db = fake.databases.get('gazeReader');
    expect([...(db?.stores.keys() ?? [])].sort()).toEqual(['books', 'meta', 'progress']);
    expect(db?.stores.get('meta')?.data.get('persist')).toEqual({
      id: 'persist',
      title: 'Book persist',
      author: 'An Author',
      wordCount: 1,
      format: 'txt',
      addedAt: 1000,
    });
    const reloaded = await freshLibrary();
    expect((await reloaded.listBooks()).map((e) => [e.id, e.fraction])).toEqual([['persist', 0.4]]);
  });

  it('opens the database once and reuses the connection', async () => {
    const lib = await freshLibrary();
    await Promise.all([lib.listBooks(), lib.getBook('a'), lib.getProgress('a')]);
    await lib.listBooks();
    expect(fake.opens).toBe(1);
  });

  it('reports a full disk with a friendly quota error', async () => {
    const lib = await freshLibrary();
    fake.quotaBytes = 10;
    await expect(lib.saveBook(book('big'))).rejects.toMatchObject({ code: 'quota', message: expect.stringMatching(/full/) });
    fake.quotaBytes = Infinity;
    expect(await lib.getBook('big')).toBeNull(); // the failed transaction wrote nothing
  });

  it('closes a connection that opens after the timeout, and keeps the memory fallback it replaced', async () => {
    // Regression: the late connection used to stay open (blocking other tabs' upgrades) and its
    // versionchange/close handlers could reset the backend, silently dropping this session's books.
    vi.useFakeTimers();
    try {
      fake.openDelayMs = 15_000;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const lib = await freshLibrary();
      const saved = lib.saveBook(book('kept'));
      await vi.advanceTimersByTimeAsync(10_000); // the open gives up: memory fallback
      await saved;
      await vi.advanceTimersByTimeAsync(5_000); // …and then the database answers after all
      expect(fake.connections).toHaveLength(1);
      expect(fake.connections[0].closed).toBe(true);
      expect(fake.connections[0].onversionchange ?? null).toBeNull();
      expect(fake.connections[0].onclose ?? null).toBeNull();
      expect(await lib.getBook('kept')).not.toBeNull();
      expect(fake.opens).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens after a version change, and a stale connection closing later changes nothing', async () => {
    const lib = await freshLibrary();
    await lib.saveBook(book('a'));
    const first = fake.connections[0];
    first.onversionchange?.(); // another tab upgrades the schema
    expect(first.closed).toBe(true);
    await lib.listBooks();
    expect(fake.opens).toBe(2);
    first.onclose?.(); // the old connection finally reports its close
    await lib.listBooks();
    expect(fake.opens).toBe(2); // the current connection is kept
    expect((await lib.listBooks()).map((e) => e.id)).toEqual(['a']);
  });

  it('falls back to memory when IndexedDB refuses to open', async () => {
    fake.failOpen = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lib = await freshLibrary();
    await lib.saveBook(book('mem'));
    expect(await lib.getBook('mem')).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
