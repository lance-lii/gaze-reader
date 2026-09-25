/**
 * Extension storage. Everything lives in chrome.storage.local — never in the
 * host page's localStorage, which belongs to the website.
 *
 * Settings are shared by the popup and every enabled tab. Each writer tags its
 * writes with a per-context `origin` and a sequence number, so a context can
 * recognise the echo of its own write and never bounces a change back.
 */
import type { AppSettings, EventBus, SerializedGazeModel, Unsubscribe } from '../../src/types';
import { DEFAULT_SETTINGS, sanitizeSettings, type SettingsStore } from '../../src/core/settings';

export const KEYS = {
  settings: 'gr.settings.v1',
  calibration: 'gr.calibration.v1',
  /** Date.now() of the last time the setup page obtained camera permission. */
  cameraGrantedAt: 'gr.cameraGrantedAt',
  /** Extension-only settings (not part of the app's AppSettings): see ExtSettings. */
  extSettings: 'gr.ext.v1',
} as const;

export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export type StorageChanges = Record<string, { newValue?: unknown; oldValue?: unknown }>;
export type StorageChangeListener = (changes: StorageChanges, areaName: string) => void;

export interface StorageChangedEventLike {
  addListener(cb: StorageChangeListener): void;
  removeListener(cb: StorageChangeListener): void;
}

export interface ExtStorage {
  area: StorageAreaLike;
  onChanged: StorageChangedEventLike;
}

/** chrome.storage.local behind the structural interfaces above. */
export function chromeLocalStorage(): ExtStorage {
  const local = chrome.storage.local;
  return {
    area: {
      get: (keys) => local.get(keys),
      set: (items) => local.set(items),
      remove: (keys) => local.remove(keys),
    },
    onChanged: {
      addListener: (cb) => chrome.storage.onChanged.addListener(cb),
      removeListener: (cb) => chrome.storage.onChanged.removeListener(cb),
    },
  };
}

/** A short random id for tagging writes (crypto.randomUUID is unavailable on insecure pages). */
export function makeOrigin(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ───────────────────────────────── Settings ──────────────────────────────────

interface SettingsRecord {
  v: 1;
  settings: AppSettings;
  origin: string;
  seq: number;
}

function parseSettingsRecord(x: unknown): { settings: AppSettings; origin: string | null; seq: number } | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (!r.settings || typeof r.settings !== 'object') return null;
  return {
    settings: sanitizeSettings(r.settings),
    origin: typeof r.origin === 'string' ? r.origin : null,
    seq: typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : 0,
  };
}

export async function loadSettings(area: StorageAreaLike): Promise<AppSettings> {
  try {
    const got = await area.get([KEYS.settings]);
    return parseSettingsRecord(got[KEYS.settings])?.settings ?? { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Two-way sync between a settings store and chrome.storage.local.
 *
 *  - local `settings-changed` → write (unless we are applying a remote change);
 *  - storage change → apply to the store, except the echo of one of our own
 *    writes that a newer write of ours has already superseded.
 *
 * Changes arrive in write order, so applying everything else makes every
 * context converge on whatever was written last, with no ping-pong.
 */
export function syncSettings(opts: {
  bus: EventBus;
  store: SettingsStore;
  storage: ExtStorage;
  origin: string;
  onWriteError?: (err: unknown) => void;
}): Unsubscribe {
  const { bus, store, storage, origin } = opts;
  let seq = 0;
  let applying = false;

  const offBus = bus.on('settings-changed', ({ settings }) => {
    if (applying) return;
    seq += 1;
    const record: SettingsRecord = { v: 1, settings, origin, seq };
    storage.area.set({ [KEYS.settings]: record }).catch((err: unknown) => opts.onWriteError?.(err));
  });

  const onChange: StorageChangeListener = (changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[KEYS.settings];
    if (!change) return;
    const parsed = parseSettingsRecord(change.newValue);
    if (parsed && parsed.origin === origin && parsed.seq < seq) return;
    const next = parsed?.settings ?? { ...DEFAULT_SETTINGS }; // key removed → defaults
    applying = true;
    try {
      store.update(next);
    } finally {
      applying = false;
    }
  };
  storage.onChanged.addListener(onChange);

  return () => {
    offBus();
    storage.onChanged.removeListener(onChange);
  };
}

// ───────────────────────── Extension-only settings ───────────────────────────

/**
 * How a page turn moves the page.
 *  - `auto`: scroll, except in page mode (a canvas/image reader with no text
 *    lines to measure) on a page that doesn't scroll, where the next-page key is sent;
 *  - `scroll`: always scroll the page's main scroller;
 *  - `keys`: always send ArrowRight + PageDown to the page, as if pressed.
 */
export type PageTurnMethod = 'auto' | 'scroll' | 'keys';
export const PAGE_TURN_METHODS: readonly PageTurnMethod[] = ['auto', 'scroll', 'keys'];

export function isPageTurnMethod(x: unknown): x is PageTurnMethod {
  return typeof x === 'string' && (PAGE_TURN_METHODS as readonly string[]).includes(x);
}

/** Settings only the extension has. Stored under KEYS.extSettings, beside the shared AppSettings record. */
export interface ExtSettings {
  pageTurn: PageTurnMethod;
}

export const DEFAULT_EXT_SETTINGS: Readonly<ExtSettings> = Object.freeze({ pageTurn: 'auto' });

/** Anything stored (or nothing) → valid ExtSettings; unknown values fall back to the defaults. */
export function parseExtSettings(x: unknown): ExtSettings {
  const r = x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  return { pageTurn: isPageTurnMethod(r.pageTurn) ? r.pageTurn : DEFAULT_EXT_SETTINGS.pageTurn };
}

export async function loadExtSettings(area: StorageAreaLike): Promise<ExtSettings> {
  try {
    return parseExtSettings((await area.get([KEYS.extSettings]))[KEYS.extSettings]);
  } catch {
    return { ...DEFAULT_EXT_SETTINGS };
  }
}

export async function saveExtSettings(area: StorageAreaLike, settings: ExtSettings): Promise<boolean> {
  try {
    await area.set({ [KEYS.extSettings]: parseExtSettings(settings) });
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────── Calibration ────────────────────────────────

export function isSerializedGazeModel(x: unknown): x is SerializedGazeModel {
  return (
    typeof x === 'object' &&
    x !== null &&
    !Array.isArray(x) &&
    typeof (x as Record<string, unknown>).version === 'number' &&
    Number.isFinite((x as Record<string, unknown>).version)
  );
}

export async function loadCalibrationJSON(area: StorageAreaLike): Promise<SerializedGazeModel | null> {
  try {
    const got = await area.get([KEYS.calibration]);
    const value = got[KEYS.calibration];
    return isSerializedGazeModel(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveCalibrationJSON(area: StorageAreaLike, json: SerializedGazeModel): Promise<boolean> {
  try {
    await area.set({ [KEYS.calibration]: json });
    return true;
  } catch {
    return false;
  }
}

export async function clearCalibrationJSON(area: StorageAreaLike): Promise<void> {
  try {
    await area.remove([KEYS.calibration]);
  } catch {
    /* nothing stored */
  }
}

/** Calls `cb(newValue)` whenever `key` changes in chrome.storage.local. */
export function watchKey(storage: ExtStorage, key: string, cb: (newValue: unknown) => void): Unsubscribe {
  const listener: StorageChangeListener = (changes, areaName) => {
    if (areaName === 'local' && key in changes) cb(changes[key]?.newValue);
  };
  storage.onChanged.addListener(listener);
  return () => storage.onChanged.removeListener(listener);
}
