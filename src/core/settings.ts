import type { AppSettings, EventBus } from '../types';
import { readJSON, writeJSON } from './storage';
import { IS_ARTIFACT } from './target';

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  // The Artifact build has no camera: it starts with the demo reader.
  gazeSource: IS_ARTIFACT ? 'simulated' : 'webcam',
  autoScroll: true,
  sensitivity: 'balanced',
  overlapLines: 1,
  scrollDurationMs: 650,
  glanceDownToTurn: true,

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

/** Coerces untrusted input (storage, extension messages) into valid settings. */
export function sanitizeSettings(input: unknown): AppSettings {
  const s: AppSettings = { ...DEFAULT_SETTINGS };
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
}

/**
 * Settings live in one place. Anyone may request a change by emitting
 * `settings-patch` on the bus; the store validates, persists and re-broadcasts.
 */
export function createSettingsStore(bus: EventBus, opts: { persist?: boolean; initial?: unknown } = {}): SettingsStore {
  const persist = opts.persist ?? true;
  let current = sanitizeSettings(opts.initial ?? (persist ? readJSON<unknown>(KEY, null) : null));

  function update(patch: Partial<AppSettings>): void {
    const next = sanitizeSettings({ ...current, ...patch });
    const changed = (Object.keys(next) as (keyof AppSettings)[]).filter((k) => next[k] !== current[k]);
    if (changed.length === 0) return;
    current = next;
    if (persist) writeJSON(KEY, current);
    bus.emit('settings-changed', { settings: current, changed });
  }

  bus.on('settings-patch', (patch) => update(patch));

  return {
    get: () => current,
    update,
    reset: () => update({ ...DEFAULT_SETTINGS }),
  };
}
