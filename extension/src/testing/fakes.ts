/**
 * In-memory stand-ins for chrome.runtime ports and chrome.storage, used by tests.
 * Delivery is asynchronous (a microtask) and JSON-serialized, like Chrome's.
 */
import type { ListenerSet, PortLike } from '../ports';
import type { ExtStorage, StorageChangeListener, StorageChanges } from '../extStorage';

export class FakeEvent<F extends (...args: never[]) => void> implements ListenerSet<F> {
  readonly listeners = new Set<F>();
  addListener(cb: F): void {
    this.listeners.add(cb);
  }
  removeListener(cb: F): void {
    this.listeners.delete(cb);
  }
  emit(...args: Parameters<F>): void {
    for (const cb of [...this.listeners]) cb(...args);
  }
}

const later = (fn: () => void) => void Promise.resolve().then(fn);

export class FakePort implements PortLike {
  peer: FakePort | null = null;
  connected = true;
  /** Every message this end posted (already JSON round-tripped). */
  readonly sent: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error('Attempting to use a disconnected port object');
    const copy: unknown = JSON.parse(JSON.stringify(message));
    this.sent.push(copy);
    const peer = this.peer;
    later(() => {
      if (peer?.connected) peer.onMessage.emit(copy);
    });
  }

  /** Like Chrome: onDisconnect fires only on the *other* end. */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    const peer = this.peer;
    if (peer?.connected) {
      peer.connected = false;
      later(() => peer.onDisconnect.emit());
    }
  }

  /** Simulates the far side vanishing (e.g. the service worker being stopped). */
  drop(): void {
    this.peer?.disconnect();
  }

  sentOfType(type: string): unknown[] {
    return this.sent.filter((m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === type);
  }
}

export function portPair(name: string): [FakePort, FakePort] {
  const a = new FakePort(name);
  const b = new FakePort(name);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Let queued deliveries (microtasks) run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

export class FakeStorage implements ExtStorage {
  readonly data = new Map<string, unknown>();
  readonly onChanged = new FakeEvent<StorageChangeListener>();
  failWrites = false;

  readonly area = {
    get: async (keys: string[]): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
      return out;
    },
    set: async (items: Record<string, unknown>): Promise<void> => {
      if (this.failWrites) throw new Error('QUOTA_BYTES quota exceeded');
      const changes: StorageChanges = {};
      for (const [k, v] of Object.entries(items)) {
        const newValue: unknown = JSON.parse(JSON.stringify(v));
        changes[k] = { oldValue: this.data.get(k), newValue };
        this.data.set(k, newValue);
      }
      later(() => this.onChanged.emit(structuredClone(changes), 'local'));
    },
    remove: async (keys: string[]): Promise<void> => {
      const changes: StorageChanges = {};
      for (const k of keys) {
        if (!this.data.has(k)) continue;
        changes[k] = { oldValue: this.data.get(k) };
        this.data.delete(k);
      }
      later(() => this.onChanged.emit(changes, 'local'));
    },
  };
}
