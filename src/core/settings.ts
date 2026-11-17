import type { AppSettings, EventBus } from '../types';
import { readJSON, storageKey, writeJSON } from './storage';
import { IS_ARTIFACT } from './target';

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  // The Artifact build has no camera: it starts with the demo reader.
  gazeSource: IS_ARTIFACT ? 'simulated' : 'webcam',
  autoScroll: true,
  sensitivity: 'balanced',
  overlapLines: 2,
  scrollDurationMs: 650,
  glanceDownToTurn: true,
  // Off until asked for: a gesture nobody meant to make turns a page.
  headGestures: false,

  fontSizePx: 22,
  // Generous leading makes lines easier to tell apart for a webcam tracker.
  lineHeight: 1.9,
  fontFamily: 'serif',
  columnWidthCh: 62,
  theme: 'auto',

  showGazeDot: false,
  showDebugOverlay: false,
  showCameraPreview: true,
  mouseNoisePx: 0,
  simulatedWpm: 260,

  buddyEnabled: true,
  buddyChattiness: 'normal',
  buddyCorner: 'bottom-right',
  breakReminders: true,
  breakIntervalMin: 20,
} satisfies AppSettings);

const KEY = 'settings.v1';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Coerces untrusted input (storage, extension messages) into valid settings. A key that is missing
 * or invalid takes its value from `base` (the defaults, or the settings a patch is applied to).
 */
export function sanitizeSettings(input: unknown, base: Readonly<AppSettings> = DEFAULT_SETTINGS): AppSettings {
  const s: AppSettings = { ...base };
  if (!input || typeof input !== 'object') return s;
  const src = input as Record<string, unknown>;
  const pick = <K extends keyof AppSettings>(k: K, ok: (v: unknown) => boolean) => {
    if (k in src && ok(src[k])) s[k] = src[k] as AppSettings[K];
  };
  const oneOf = (...vals: string[]) => (v: unknown) => typeof v === 'string' && vals.includes(v);
  const num = (lo: number, hi: number) => (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const bool = (v: unknown) => typeof v === 'boolean';

  pick('gazeSource', IS_ARTIFACT ? oneOf('mouse', 'simulated') : oneOf('webcam', 'mouse', 'simulated'));
  pick('autoScroll', bool);
  pick('sensitivity', oneOf('relaxed', 'balanced', 'eager'));
  pick('overlapLines', num(0, 3));
  pick('scrollDurationMs', num(0, 2000));
  pick('glanceDownToTurn', bool);
  pick('headGestures', bool);
  pick('fontSizePx', num(12, 40));
  pick('lineHeight', num(1.2, 3));
  pick('fontFamily', oneOf('serif', 'sans', 'mono'));
  pick('columnWidthCh', num(30, 120));
  pick('theme', oneOf('auto', 'light', 'sepia', 'dark'));
  pick('showGazeDot', bool);
  pick('showDebugOverlay', bool);
  pick('showCameraPreview', bool);
  pick('mouseNoisePx', num(0, 200));
  pick('simulatedWpm', num(60, 1000));
  pick('buddyEnabled', bool);
  pick('buddyChattiness', oneOf('quiet', 'normal', 'chatty'));
  pick('buddyCorner', oneOf('bottom-right', 'bottom-left', 'top-right', 'top-left'));
  pick('breakReminders', bool);
  pick('breakIntervalMin', num(5, 120));

  s.overlapLines = Math.round(clamp(s.overlapLines, 0, 3));
  return s;
}

export interface SettingsStore {
  get(): AppSettings;
  /** Applies a patch, persists it and emits `settings-changed` with the keys that actually changed. */
  update(patch: Partial<AppSettings>): void;
  reset(): void;
  /** Stops following changes made in other tabs (the app's store; absent elsewhere). */
  dispose?(): void;
}

/**
 * Settings live in one place. Anyone may request a change by emitting
 * `settings-patch` on the bus; the store validates, persists and re-broadcasts.
 */
export function createSettingsStore(bus: EventBus, opts: { persist?: boolean; initial?: unknown } = {}): SettingsStore {
  const persist = opts.persist ?? true;
  let current = sanitizeSettings(opts.initial ?? (persist ? readJSON<unknown>(KEY, null) : null));

  /** Makes `next` the settings and tells everyone what changed. */
  function adopt(next: AppSettings): boolean {
    const changed = (Object.keys(next) as (keyof AppSettings)[]).filter((k) => next[k] !== current[k]);
    if (changed.length === 0) return false;
    current = next;
    bus.emit('settings-changed', { settings: current, changed });
    return true;
  }

  function update(patch: Partial<AppSettings>): void {
    // An invalid value in a patch leaves that setting as it is (it used to reset it to its default).
    if (adopt(sanitizeSettings({ ...current, ...patch }, current)) && persist) writeJSON(KEY, current);
  }

  bus.on('settings-patch', (patch) => update(patch));

  // Another tab of the app changed the settings: take them over, so that this tab shows them and
  // its next change doesn't write its own stale copy of everything else back over them.
  let dispose: (() => void) | undefined;
  if (persist && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== storageKey(KEY) || e.newValue === null) return;
      adopt(sanitizeSettings(readJSON<unknown>(KEY, null)));
    };
    window.addEventListener('storage', onStorage);
    dispose = () => window.removeEventListener('storage', onStorage);
  }

  return {
    get: () => current,
    update,
    reset: () => update({ ...DEFAULT_SETTINGS }),
    ...(dispose ? { dispose } : {}),
  };
}
