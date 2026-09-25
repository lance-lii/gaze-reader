/**
 * Structural stand-ins for chrome.runtime.Port and chrome events, so the
 * messaging logic can run against in-memory fakes in tests.
 * `chrome.runtime.Port` is assignable to `PortLike`.
 */

export interface ListenerSet<F> {
  addListener(cb: F): void;
  removeListener(cb: F): void;
}

export interface PortLike {
  readonly name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: ListenerSet<(message: unknown) => void>;
  readonly onDisconnect: ListenerSet<() => void>;
}

/** Posts without throwing. Returns false when the port is already dead. */
export function safePost(port: PortLike, message: unknown): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Disconnects without throwing (disconnecting a dead port is harmless but may throw in some Chrome versions). */
export function safeDisconnect(port: PortLike): void {
  try {
    port.disconnect();
  } catch {
    /* already gone */
  }
}

/**
 * Exponential backoff with ±20 % jitter, so a service-worker restart doesn't
 * make every open tab reconnect in the same millisecond.
 */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
  const jitter = 0.8 + 0.4 * random();
  return Math.round(Math.min(maxMs, base * jitter));
}

/** True while this script's extension context is alive (false after the extension is reloaded or removed). */
export function extensionContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
  } catch {
    return false;
  }
}
