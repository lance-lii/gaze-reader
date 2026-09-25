import { STORAGE_PREFIX } from './constants';

/**
 * localStorage helpers that never throw (private windows, blocked storage and
 * quota errors all degrade to "nothing stored").
 */
export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
}
