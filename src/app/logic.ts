/**
 * Pure helpers for the app shell. No DOM access, no timers, no globals:
 * everything takes time and state as arguments so it can be unit-tested in node.
 *
 * The UI modules render the data defined here (shortcut table, settings
 * schema, status pill vocabulary) so there is exactly one source of truth.
 */
import type {
  AppSettings,
  CommandName,
  Corner,
  GazeSourceKind,
  TextLine,
  Theme,
  TrackerErrorCode,
  TrackingState,
} from '../types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

// ───────────────────────────── Tracking state ──────────────────────────────

/** Lifecycle of the active gaze source, as seen by the controller. */
export type SourcePhase = 'off' | 'starting' | 'calibrating' | 'running' | 'error';

export interface TrackingThresholds {
  /** Invalid (or missing) samples for longer than this → `no-face`. */
  noFaceAfterMs: number;
  /** A continuous valid run this long is needed to leave `no-face` (prevents flicker). */
  recoverAfterMs: number;
  /** Smoothed confidence below this… */
  poorEnter: number;
  /**
   * …for this long → `poor`. Brief dips are normal: MediaPipe's blink score rises as the lids
   * lower to read the last lines of a page, which pulls confidence down on every page.
   */
  poorAfterMs: number;
  /** …and it must climb back above this to leave `poor` (hysteresis). */
  poorExit: number;
  /** Time constant of the confidence EMA. */
  confidenceTauMs: number;
}

export const DEFAULT_TRACKING_THRESHOLDS: Readonly<TrackingThresholds> = Object.freeze({
  noFaceAfterMs: 1000,
  recoverAfterMs: 200,
  poorEnter: 0.3,
  poorAfterMs: 2500,
  poorExit: 0.42,
  confidenceTauMs: 600,
});

export interface TrackingContext {
  phase: SourcePhase;
  kind: GazeSourceKind | null;
  autoScroll: boolean;
  /** Extra explanation for the `off` / `error` phases (e.g. "Camera access was blocked"). */
  detail?: string;
}

export interface TrackingStatus {
  state: TrackingState;
  detail?: string;
}

/** Minimal sample shape the state machine needs (a GazeSample satisfies it). */
export interface SampleLike {
  t: number;
  valid: boolean;
  confidence: number;
}

/**
 * Derives the user-facing tracking state from the source lifecycle and the
 * stream of gaze samples. `no-face` and `poor` only apply to the webcam: a
 * mouse pointer leaving the window or the demo reader idling is not a
 * tracking problem, and Dewey shouldn't fret about it.
 */
export class TrackingStateMachine {
  private readonly th: TrackingThresholds;
  private startedAt = 0;
  private lastValidAt = Number.NEGATIVE_INFINITY;
  private validRunStart: number | null = null;
  private confidence: number | null = null;
  private lastConfidenceT: number | null = null;
  /** When the smoothed confidence last dropped under poorEnter (null while it's above). */
  private lowSince: number | null = null;
  private noFace = false;
  private poor = false;

  constructor(thresholds: Partial<TrackingThresholds> = {}) {
    this.th = { ...DEFAULT_TRACKING_THRESHOLDS, ...thresholds };
  }

  /** Call when a source (re)starts running; gives it a grace period of `noFaceAfterMs`. */
  reset(now: number): void {
    this.startedAt = Number.isFinite(now) ? now : 0;
    this.lastValidAt = Number.NEGATIVE_INFINITY;
    this.validRunStart = null;
    this.confidence = null;
    this.lastConfidenceT = null;
    this.lowSince = null;
    this.noFace = false;
    this.poor = false;
  }

  push(s: SampleLike): void {
    if (!Number.isFinite(s.t)) return;
    if (!s.valid) {
      this.validRunStart = null;
      return;
    }
    this.lastValidAt = s.t;
    this.validRunStart ??= s.t;
    const c = Number.isFinite(s.confidence) ? clamp01(s.confidence) : 0;
    if (this.confidence === null || this.lastConfidenceT === null) {
      this.confidence = c;
    } else {
      const dt = Math.max(0, s.t - this.lastConfidenceT);
      const alpha = 1 - Math.exp(-dt / this.th.confidenceTauMs);
      this.confidence += alpha * (c - this.confidence);
    }
    this.lastConfidenceT = s.t;
    this.lowSince = this.confidence < this.th.poorEnter ? (this.lowSince ?? s.t) : null;
  }

  /** Smoothed confidence of recent valid samples, or null before the first one. */
  get smoothedConfidence(): number | null {
    return this.confidence;
  }

  evaluate(now: number, ctx: TrackingContext): TrackingStatus {
    switch (ctx.phase) {
      case 'off':
        return withDetail('off', ctx.detail);
      case 'error':
        return withDetail('error', ctx.detail);
      case 'starting':
        return withDetail('starting', ctx.detail);
      case 'calibrating':
        return withDetail('calibrating', ctx.detail);
      case 'running':
        break;
    }

    if (ctx.kind === 'webcam') {
      this.updateFlags(now);
    } else {
      this.noFace = false;
      this.poor = false;
    }

    if (this.noFace) return { state: 'no-face', detail: 'Face not visible' };
    if (!ctx.autoScroll) return { state: 'paused', detail: 'Auto-scroll is paused' };
    if (this.poor) return { state: 'poor', detail: 'Low tracking confidence' };
    return { state: 'tracking' };
  }

  private updateFlags(now: number): void {
    const since = now - Math.max(this.lastValidAt, this.startedAt);
    if (!this.noFace) {
      if (since > this.th.noFaceAfterMs) this.noFace = true;
    } else if (
      this.validRunStart !== null &&
      this.lastValidAt - this.validRunStart >= this.th.recoverAfterMs &&
      since <= this.th.noFaceAfterMs
    ) {
      this.noFace = false;
    }

    const c = this.confidence;
    if (c === null) {
      this.poor = false;
    } else if (!this.poor && c < this.th.poorEnter && this.lowSince !== null && now - this.lowSince >= this.th.poorAfterMs) {
      this.poor = true;
    } else if (this.poor && c >= this.th.poorExit) {
      this.poor = false;
    }
  }
}

function withDetail(state: TrackingState, detail: string | undefined): TrackingStatus {
  return detail ? { state, detail } : { state };
}

export function sameStatus(a: TrackingStatus | null, b: TrackingStatus): boolean {
  return a !== null && a.state === b.state && (a.detail ?? '') === (b.detail ?? '');
}

// ─────────────────────────────── Status pill ───────────────────────────────

export type PillTone = 'ok' | 'info' | 'warn' | 'bad' | 'idle';

export interface PillView {
  label: string;
  tone: PillTone;
  /** Longer text for the tooltip / accessible description. */
  description: string;
}

/**
 * What the always-visible status pill says. With the camera on the pill must
 * make that obvious (privacy), so every webcam state mentions the camera in
 * its description.
 */
export function statusPill(state: TrackingState, kind: GazeSourceKind | null, cameraOn: boolean): PillView {
  const cam = cameraOn ? 'Camera on (video stays on this device). ' : '';
  if (state === 'paused') {
    return { label: 'Paused', tone: 'idle', description: `${cam}Auto-scroll is paused. Press P to resume.` };
  }
  if (kind === 'mouse' && (state === 'tracking' || state === 'no-face' || state === 'poor')) {
    return { label: 'Mouse', tone: 'info', description: 'Following your mouse pointer instead of your eyes.' };
  }
  if (kind === 'simulated' && (state === 'tracking' || state === 'no-face' || state === 'poor')) {
    return { label: 'Demo', tone: 'info', description: 'A simulated reader is reading this page.' };
  }
  switch (state) {
    case 'tracking':
      return { label: 'Tracking', tone: 'ok', description: `${cam}Following your eyes.` };
    case 'no-face':
      return { label: 'Looking for you', tone: 'warn', description: `${cam}Your face isn't visible to the camera.` };
    case 'poor':
      return { label: 'Low confidence', tone: 'warn', description: `${cam}Tracking is unsure: try more light on your face, about an arm’s length from the screen.` };
    case 'starting':
      return kind === 'webcam'
        ? { label: 'Starting camera', tone: 'info', description: `${cam}Getting the camera and face model ready.` }
        : { label: 'Starting', tone: 'info', description: 'Getting ready to follow along.' };
    case 'calibrating':
      return { label: 'Calibrating', tone: 'info', description: `${cam}Follow the dots with your eyes.` };
    case 'error':
      return { label: 'Camera off', tone: 'bad', description: "The camera couldn't be used. You can read with your mouse or watch a demo." };
    case 'off':
    default:
      return { label: 'Camera off', tone: 'idle', description: 'The camera is off.' };
  }
}

/**
 * Whether the pill must stay on screen while the top bar is auto-hidden:
 * always while the camera is on (privacy), during the demo (it explains the
 * moving dot), and whenever page turning isn't happening (paused, or the
 * camera failed) so the reader can see why.
 */
export function pillAlwaysVisible(state: TrackingState, kind: GazeSourceKind | null, cameraOn: boolean): boolean {
  return cameraOn || kind === 'simulated' || state === 'paused' || state === 'error';
}

// ─────────────────────────────── Page turning ───────────────────────────────

type LineLike = Pick<TextLine, 'docTop'>;
type VisibleLineLike = Pick<TextLine, 'fullyVisible'>;

/**
 * True when every remaining line of the book is already on screen, so a page
 * turn would only reveal the end-of-book padding.
 *
 * `textBottom` is the viewport y where the text ends (the bottom of the last
 * chapter), when the host can tell. Without it, fall back to the layout: it
 * includes every line within half a viewport below the reading area, so a fully
 * visible last line means no more text follows nearby.
 */
export function textEndsOnScreen(
  lines: readonly VisibleLineLike[],
  viewportBottom: number,
  textBottom: number | null = null,
): boolean {
  if (textBottom !== null && Number.isFinite(textBottom) && Number.isFinite(viewportBottom)) {
    return textBottom <= viewportBottom + 1;
  }
  const last = lines[lines.length - 1];
  return last !== undefined && last.fullyVisible;
}

/**
 * Where reading resumes after a page turn: the first line whose `docTop` lies
 * below the old `docTop` of the last line read. `docTop` is stable across
 * scrolling, but re-measurement can wobble by sub-pixel amounts, so the same
 * line must not count as "below itself" — hence the tolerance.
 *
 * Returns -1 when there are no lines. With an unknown target (`null`/NaN) it
 * falls back to the first fully visible line; when nothing lies below the
 * target it returns the last line.
 */
export function resumeLineIndex(
  lines: readonly (LineLike & Partial<VisibleLineLike>)[],
  targetDocTop: number | null,
  linePitch = 0,
): number {
  if (lines.length === 0) return -1;
  if (targetDocTop === null || !Number.isFinite(targetDocTop)) {
    const first = lines.findIndex((l) => l.fullyVisible === true);
    return first >= 0 ? first : 0;
  }
  const tolerance = Number.isFinite(linePitch) && linePitch > 0 ? Math.max(1, 0.3 * linePitch) : 1;
  for (let i = 0; i < lines.length; i++) {
    const top = lines[i]!.docTop;
    if (Number.isFinite(top) && top > targetDocTop + tolerance) return i;
  }
  return lines.length - 1;
}

/** Index of the last fully visible line, or -1. */
export function lastFullyVisibleIndex(lines: readonly VisibleLineLike[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.fullyVisible) return i;
  return -1;
}

/** Index of the first fully visible line, or -1. */
export function firstFullyVisibleIndex(lines: readonly VisibleLineLike[]): number {
  return lines.findIndex((l) => l.fullyVisible);
}

// ─────────────────────────── Reading time & WPM ────────────────────────────

/** Accumulates *active* reading time; a single step is capped so a sleeping laptop doesn't count. */
export class ReadingClock {
  private lastT: number | null = null;
  private activeMs = 0;

  constructor(private readonly maxStepMs = 2000) {}

  /** Returns the raw (capped) time step since the previous tick, whether or not it counted. */
  tick(now: number, active: boolean): number {
    if (!Number.isFinite(now)) return 0;
    let step = 0;
    if (this.lastT !== null) {
      step = clamp(now - this.lastT, 0, this.maxStepMs);
      if (active) this.activeMs += step;
    }
    this.lastT = now;
    return step;
  }

  get minutes(): number {
    return this.activeMs / 60_000;
  }

  reset(): void {
    this.lastT = null;
    this.activeMs = 0;
  }
}

/**
 * Counts words the reader has advanced through, from the scroll fraction.
 * Backwards moves and big jumps (dragging the scrollbar, opening a chapter)
 * don't count as reading.
 */
export class ProgressMeter {
  private last: number | null = null;
  private advanced = 0;
  private minutesAtAdvance = 0;

  constructor(
    private readonly wordCount: number,
    private readonly maxJumpWords = 900,
  ) {}

  /**
   * @param minutes the reading clock's active minutes now. Recorded whenever words are added,
   * so a rate can use words and time sampled at the same moments (see minutesAtLastAdvance).
   */
  update(fraction: number, minutes?: number): void {
    if (!Number.isFinite(fraction)) return;
    const f = clamp01(fraction);
    if (this.last !== null && Number.isFinite(this.wordCount) && this.wordCount > 0) {
      const words = (f - this.last) * this.wordCount;
      if (words > 0 && words <= this.maxJumpWords) {
        this.advanced += words;
        if (minutes !== undefined && Number.isFinite(minutes)) this.minutesAtAdvance = minutes;
      }
    }
    this.last = f;
  }

  get wordsAdvanced(): number {
    return this.advanced;
  }

  /**
   * Active minutes at the last forward advance. Words only advance at page turns while the
   * clock runs continuously, so dividing by the live clock would make the rate (and "N min
   * left") drift through every page and jump at each turn.
   */
  get minutesAtLastAdvance(): number {
    return this.minutesAtAdvance;
  }
}

export interface WpmOptions {
  minMinutes: number;
  minWords: number;
  /** Rates above this are skimming or jumping, not reading. */
  maxWpm: number;
}

/** Words per active minute, or null while there isn't enough data (or it's implausible). */
export function computeWpm(words: number, minutes: number, opts: Partial<WpmOptions> = {}): number | null {
  const { minMinutes = 0.5, minWords = 50, maxWpm = 1500 } = opts;
  if (!Number.isFinite(words) || !Number.isFinite(minutes)) return null;
  if (minutes < minMinutes || words < minWords) return null;
  const wpm = words / minutes;
  if (!Number.isFinite(wpm) || wpm > maxWpm) return null;
  return Math.round(wpm);
}

/** Estimated minutes to finish at `wpm`; null when unknown. */
export function minutesLeft(fraction: number, wordCount: number, wpm: number): number | null {
  if (![fraction, wordCount, wpm].every(Number.isFinite) || wordCount <= 0 || wpm <= 0) return null;
  return ((1 - clamp01(fraction)) * wordCount) / wpm;
}

/** Typical adult silent-reading rate, used until we have measured the reader's own. */
export const TYPICAL_WPM = 238;

/**
 * Break reminder (the 20-20-20 habit). Counts active reading time; a long
 * enough idle stretch counts as a break and restarts the count.
 */
export class BreakTimer {
  private sinceBreakMs = 0;
  private idleMs = 0;

  constructor(private readonly restResetMs = 5 * 60_000) {}

  /** Returns true exactly once each time a break becomes due. */
  tick(dtMs: number, active: boolean, intervalMin: number, enabled: boolean): boolean {
    if (!enabled || !Number.isFinite(dtMs) || dtMs <= 0) {
      if (!enabled) this.sinceBreakMs = 0;
      return false;
    }
    if (!active) {
      this.idleMs += dtMs;
      if (this.idleMs >= this.restResetMs) this.sinceBreakMs = 0;
      return false;
    }
    this.idleMs = 0;
    this.sinceBreakMs += dtMs;
    const intervalMs = Math.max(1, intervalMin) * 60_000;
    if (this.sinceBreakMs >= intervalMs) {
      this.sinceBreakMs = 0;
      return true;
    }
    return false;
  }

  reset(): void {
    this.sinceBreakMs = 0;
    this.idleMs = 0;
  }
}

// ────────────────────────────────── Keyboard ─────────────────────────────────

/** A command, or `escape` (close the top-most panel), which isn't a bus command. */
export type ShortcutAction = CommandName | 'escape';

export interface ShortcutDef {
  /** Key caps as shown in the help dialog. */
  keys: readonly string[];
  action: ShortcutAction;
  label: string;
  /** Only meaningful while a book is open. */
  readerOnly: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { keys: ['Space', 'Page Down'], action: 'page-forward', label: 'Next page', readerOnly: true },
  { keys: ['Shift + Space', 'Page Up'], action: 'page-back', label: 'Previous page', readerOnly: true },
  { keys: ['U'], action: 'undo-turn', label: 'Undo the last page turn', readerOnly: true },
  { keys: ['P'], action: 'toggle-autoscroll', label: 'Pause or resume auto-scroll', readerOnly: true },
  { keys: ['C'], action: 'recalibrate', label: 'Recalibrate the camera', readerOnly: true },
  { keys: ['D'], action: 'toggle-debug', label: 'Show or hide the debug overlay', readerOnly: false },
  { keys: ['G'], action: 'toggle-gaze-dot', label: 'Show or hide the gaze dot', readerOnly: false },
  { keys: ['S'], action: 'open-settings', label: 'Settings', readerOnly: false },
  { keys: ['L'], action: 'open-library', label: 'Back to the library', readerOnly: true },
  { keys: ['?'], action: 'show-help', label: 'This help', readerOnly: false },
  { keys: ['Esc'], action: 'escape', label: 'Close panels', readerOnly: false },
];

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

const LETTER_ACTIONS: Readonly<Record<string, ShortcutAction>> = {
  u: 'undo-turn',
  p: 'toggle-autoscroll',
  c: 'recalibrate',
  d: 'toggle-debug',
  g: 'toggle-gaze-dot',
  s: 'open-settings',
  l: 'open-library',
};

/** Maps a key press to an action. Modified chords belong to the browser; auto-repeat is ignored. */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape' || e.key === 'Esc') return 'escape';
  if (e.repeat) return null;
  switch (e.key) {
    case ' ':
    case 'Spacebar':
      return e.shiftKey ? 'page-back' : 'page-forward';
    case 'PageDown':
      return 'page-forward';
    case 'PageUp':
      return 'page-back';
    case '?':
      return 'show-help';
  }
  if (e.key.length === 1) return LETTER_ACTIONS[e.key.toLowerCase()] ?? null;
  return null;
}

/** Minimal element shape so key-target classification is testable without a DOM. */
export interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
  getAttribute?(name: string): string | null;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
const ACTIVATABLE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider']);

/**
 * - `editable`: the user is typing → ignore every shortcut.
 * - `activatable`: Space/Enter already mean "press this" → ignore Space-based shortcuts.
 * - `other`: shortcuts apply.
 */
export function keyTargetKind(t: KeyTargetLike | null | undefined): 'editable' | 'activatable' | 'other' {
  if (!t) return 'other';
  if (t.isContentEditable) return 'editable';
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'editable';
  if (tag === 'INPUT') {
    const type = (t.type ?? 'text').toLowerCase();
    return NON_TEXT_INPUTS.has(type) ? 'activatable' : 'editable';
  }
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return 'activatable';
  const role = t.getAttribute?.('role');
  if (role && ACTIVATABLE_ROLES.has(role)) return 'activatable';
  return 'other';
}

/** Whether a shortcut should be swallowed because of where focus is. */
export function shouldIgnoreShortcut(e: KeyLike, target: KeyTargetLike | null | undefined): boolean {
  const kind = keyTargetKind(target);
  if (kind === 'editable') return e.key !== 'Escape' && e.key !== 'Esc';
  if (kind === 'activatable') return e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter';
  return false;
}

// ─────────────────────────────── Error handling ─────────────────────────────

/** A human-readable message from anything thrown or rejected. */
export function errorMessage(err: unknown, fallback = 'Something unexpected happened.'): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m.trim();
  }
  return fallback;
}

/**
 * Global errors not worth bothering the reader about: the browser's benign
 * ResizeObserver loop warning, opaque cross-origin "Script error.", and
 * anything thrown by a browser extension's injected script.
 */
export function isBenignGlobalError(message: string, filename = ''): boolean {
  if (/ResizeObserver loop/i.test(message)) return true;
  if (message === 'Script error.' || message === 'Script error') return true;
  return /^(chrome|moz|safari(-web)?)-extension:/i.test(filename);
}

// ─────────────────────────────── Camera errors ──────────────────────────────

const TRACKER_CODES: readonly TrackerErrorCode[] = [
  'camera-denied',
  'no-camera',
  'camera-in-use',
  'insecure-context',
  'model-load-failed',
  'unknown',
];

/** FeatureSource.start() rejects with an Error carrying a `code`; anything else is `unknown`. */
export function trackerErrorCode(err: unknown): TrackerErrorCode {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && (TRACKER_CODES as readonly string[]).includes(code)) {
      return code as TrackerErrorCode;
    }
  }
  return 'unknown';
}

export interface CameraErrorInfo {
  title: string;
  message: string;
  /** What Dewey says (short, kind, ≤ 90 chars). */
  buddyLine: string;
  /** Whether "Try again" is likely to help without the user changing something first. */
  retryable: boolean;
}

export function cameraErrorInfo(code: TrackerErrorCode): CameraErrorInfo {
  switch (code) {
    case 'camera-denied':
      return {
        title: 'Camera access is blocked',
        message: "Allow the camera for this site in your browser's settings, or read with your mouse for now.",
        buddyLine: "No camera, no problem. Want to try the mouse, or watch me read?",
        retryable: false,
      };
    case 'no-camera':
      return {
        title: 'No camera found',
        message: 'Plug in a webcam and try again, or read with your mouse or the demo.',
        buddyLine: "I couldn't find a camera. The mouse works nicely too!",
        retryable: true,
      };
    case 'camera-in-use':
      return {
        title: 'Your camera is busy',
        message: 'Another app or tab is using it. Close that, then try again.',
        buddyLine: 'Someone else is using the camera. I can wait!',
        retryable: true,
      };
    case 'insecure-context':
      return {
        title: 'The camera needs a secure page',
        message: 'Open Gaze Reader over https (or localhost) to use eye tracking.',
        buddyLine: 'Browsers only share cameras with secure (https) pages.',
        retryable: false,
      };
    case 'model-load-failed':
      return {
        title: "Couldn't load the face model",
        message: 'The webcam needs a connection the first time it starts in a tab (the model is about 4 MB; the browser caches it). Check your connection and try again.',
        buddyLine: "The face model didn't arrive. Maybe the network is napping?",
        retryable: true,
      };
    case 'unknown':
    default:
      return {
        title: "The camera couldn't start",
        message: 'Try again, or read with your mouse or the demo in the meantime.',
        buddyLine: 'Hmm, the camera hiccupped. Shall we try the mouse?',
        retryable: true,
      };
  }
}

// ────────────────────────────── Calibration fit ─────────────────────────────

/**
 * A saved model maps features to viewport px for the viewport it was trained
 * on. If the window has changed size substantially (or the zoom changed), a
 * quick 5-point refresh is worth the 10 seconds.
 */
export function calibrationFitsViewport(
  trained: { width: number; height: number },
  current: { width: number; height: number },
  tolerance = 0.12,
): boolean {
  const ok = (a: number, b: number) =>
    Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= tolerance;
  return ok(trained.width, current.width) && ok(trained.height, current.height);
}

/** Chrome-height change (CSS px) tolerated when the line pitch is unknown. */
export const ORIGIN_TOLERANCE_PX = 20;

/**
 * The calibration maps gaze to screen px and assumes the viewport sits at the same place inside
 * the window. Entering or leaving fullscreen, or toggling the bookmarks bar, moves it by the
 * toolbar height with the window origin unchanged, which shifts every prediction by lines.
 * False when the browser chrome above the viewport changed by more than half a line.
 * Unknown values (old models, iframes) always fit.
 */
export function calibrationOriginFits(
  trainedTop: number | null | undefined,
  currentTop: number | null | undefined,
  pitchPx?: number | null,
): boolean {
  if (trainedTop == null || currentTop == null) return true;
  if (!Number.isFinite(trainedTop) || !Number.isFinite(currentTop)) return true;
  const tolerance = pitchPx != null && Number.isFinite(pitchPx) && pitchPx > 0 ? 0.5 * pitchPx : ORIGIN_TOLERANCE_PX;
  return Math.abs(currentTop - trainedTop) <= tolerance;
}

// ─────────────────────────────── Theme & layout ─────────────────────────────

export type ResolvedTheme = 'light' | 'sepia' | 'dark';

/**
 * The theme to paint. "auto" follows the host page's explicit choice when there
 * is one (the Artifact frame stamps data-theme on the root), else the system.
 * An explicit app choice always wins.
 */
export function resolveTheme(theme: Theme, prefersDark: boolean, hostTheme: 'light' | 'dark' | null = null): ResolvedTheme {
  if (theme !== 'auto') return theme;
  return hostTheme ?? (prefersDark ? 'dark' : 'light');
}

/** The camera preview sits in the bottom corner Dewey isn't using. */
export function previewCorner(buddyCorner: Corner): 'bottom-left' | 'bottom-right' {
  return buddyCorner === 'bottom-left' ? 'bottom-right' : 'bottom-left';
}

// ──────────────────────────────── URL input ────────────────────────────────

/**
 * Accepts "example.com/book.txt" or full http(s) URLs; rejects everything
 * else. Used for instant inline feedback in the "Open from URL" form (the
 * loader validates again before fetching).
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // "host:8080/…" is a host and port, not a scheme: a scheme's colon is never followed by a digit.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw);
  let candidate: string | null = raw;
  if (!hasScheme) {
    // Local servers rarely speak https; everything else gets it by default.
    if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(raw)) candidate = `http://${raw}`;
    else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw)) candidate = `https://${raw}`;
    else candidate = null;
  }
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

// ──────────────────────────────── Formatting ────────────────────────────────

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  // Floor so "100%" only shows when the reader is truly at the end.
  return `${Math.floor(clamp01(fraction) * 100 + 1e-9)}%`;
}

export function formatMinutes(min: number | null): string {
  if (min === null || !Number.isFinite(min) || min < 0) return '';
  if (min < 1) return 'under a minute';
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function relativeTime(ts: number | null, now: number): string {
  if (ts === null || !Number.isFinite(ts) || !Number.isFinite(now)) return '';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 30) {
    const w = Math.floor(d / 7);
    return w === 1 ? 'last week' : `${w} weeks ago`;
  }
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo === 1 ? 'last month' : `${mo} months ago`;
  const y = Math.floor(d / 365);
  return y <= 1 ? 'a year ago' : `${y} years ago`;
}

// ────────────────────────────── Settings schema ─────────────────────────────

type KeysOfType<T, V> = { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T];
export type BooleanSettingKey = KeysOfType<AppSettings, boolean>;
export type NumberSettingKey = KeysOfType<AppSettings, number>;
export type ChoiceSettingKey = Exclude<keyof AppSettings, BooleanSettingKey | NumberSettingKey>;

export type SettingControl =
  | { kind: 'toggle'; key: BooleanSettingKey; label: string; hint?: string }
  | {
      kind: 'range';
      key: NumberSettingKey;
      label: string;
      hint?: string;
      min: number;
      max: number;
      step: number;
      format: (v: number) => string;
    }
  | {
      [K in ChoiceSettingKey]: {
        kind: 'choice';
        key: K;
        label: string;
        hint?: string;
        /** Segmented buttons read better for a few short options; a select for longer lists. */
        display: 'segmented' | 'select';
        options: readonly { value: AppSettings[K]; label: string }[];
      };
    }[ChoiceSettingKey];

export interface SettingsGroup {
  id: 'tracking' | 'turning' | 'reading' | 'dewey' | 'advanced';
  title: string;
  controls: readonly SettingControl[];
}

const px = (v: number) => `${Math.round(v)} px`;

/** Every AppSettings field appears exactly once (enforced by a test). */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'tracking',
    title: 'Eye tracking',
    controls: [
      {
        kind: 'choice',
        key: 'gazeSource',
        label: 'Follow',
        display: 'segmented',
        options: [
          { value: 'webcam', label: 'My eyes' },
          { value: 'mouse', label: 'Mouse' },
          { value: 'simulated', label: 'Demo' },
        ],
      },
      { kind: 'toggle', key: 'showCameraPreview', label: 'Camera preview', hint: 'A small mirrored thumbnail, only you can see it.' },
      { kind: 'toggle', key: 'showGazeDot', label: 'Gaze dot', hint: 'Show where the tracker thinks you are looking.' },
    ],
  },
  {
    id: 'turning',
    title: 'Page turning',
    controls: [
      { kind: 'toggle', key: 'autoScroll', label: 'Auto-scroll', hint: 'Turn the page when you reach the bottom. While reading, P pauses and resumes.' },
      {
        kind: 'choice',
        key: 'sensitivity',
        label: 'Sensitivity',
        hint: 'Eager turns sooner; relaxed waits until it is sure.',
        display: 'segmented',
        options: [
          { value: 'relaxed', label: 'Relaxed' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'eager', label: 'Eager' },
        ],
      },
      { kind: 'toggle', key: 'glanceDownToTurn', label: 'Glance down to turn', hint: 'Look below the page for a moment to turn it.' },
      {
        kind: 'range',
        key: 'overlapLines',
        label: 'Lines kept for context',
        min: 0,
        max: 3,
        step: 1,
        format: (v) => (v === 0 ? 'None' : v === 1 ? '1 line' : `${v} lines`),
      },
      {
        kind: 'range',
        key: 'scrollDurationMs',
        label: 'Page-turn animation',
        hint: 'How long each turn takes to scroll. Instant jumps straight there.',
        min: 0,
        max: 1500,
        step: 50,
        format: (v) => (v === 0 ? 'Instant' : `${(v / 1000).toFixed(2)} s`),
      },
    ],
  },
  {
    id: 'reading',
    title: 'Reading',
    controls: [
      {
        kind: 'choice',
        key: 'theme',
        label: 'Theme',
        display: 'segmented',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'light', label: 'Light' },
          { value: 'sepia', label: 'Sepia' },
          { value: 'dark', label: 'Dark' },
        ],
      },
      {
        kind: 'choice',
        key: 'fontFamily',
        label: 'Typeface',
        display: 'segmented',
        options: [
          { value: 'serif', label: 'Serif' },
          { value: 'sans', label: 'Sans' },
          { value: 'mono', label: 'Mono' },
        ],
      },
      { kind: 'range', key: 'fontSizePx', label: 'Text size', min: 14, max: 36, step: 1, format: px },
      { kind: 'range', key: 'lineHeight', label: 'Line spacing', hint: 'Roomier lines are easier to track.', min: 1.3, max: 2.6, step: 0.05, format: (v) => v.toFixed(2) },
      { kind: 'range', key: 'columnWidthCh', label: 'Column width', min: 40, max: 90, step: 2, format: (v) => `${Math.round(v)} ch` },
    ],
  },
  {
    id: 'dewey',
    title: 'Dewey',
    controls: [
      { kind: 'toggle', key: 'buddyEnabled', label: 'Show Dewey' },
      {
        kind: 'choice',
        key: 'buddyChattiness',
        label: 'Chattiness',
        display: 'segmented',
        options: [
          { value: 'quiet', label: 'Quiet' },
          { value: 'normal', label: 'Normal' },
          { value: 'chatty', label: 'Chatty' },
        ],
      },
      {
        kind: 'choice',
        key: 'buddyCorner',
        label: 'Corner',
        display: 'select',
        options: [
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'top-right', label: 'Top right' },
          { value: 'top-left', label: 'Top left' },
        ],
      },
      { kind: 'toggle', key: 'breakReminders', label: 'Eye-break reminders', hint: 'Every so often: look at something far away for 20 seconds.' },
      { kind: 'range', key: 'breakIntervalMin', label: 'Remind me every', min: 10, max: 60, step: 5, format: (v) => `${Math.round(v)} min` },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    controls: [
      { kind: 'toggle', key: 'showDebugOverlay', label: 'Debug overlay', hint: 'Lines, fixations and the page-end detector at work.' },
      { kind: 'range', key: 'mouseNoisePx', label: 'Mouse jitter', hint: 'Adds webcam-like noise in mouse mode.', min: 0, max: 80, step: 2, format: px },
      { kind: 'range', key: 'simulatedWpm', label: 'Demo reading speed', min: 100, max: 600, step: 10, format: (v) => `${Math.round(v)} wpm` },
    ],
  },
];

/**
 * "Reset to defaults" keeps the gaze source: resetting shouldn't silently
 * switch someone reading with the mouse over to the camera.
 */
export function resetPatch(defaults: Readonly<AppSettings>, current: Readonly<AppSettings>): Partial<AppSettings> {
  return { ...defaults, gazeSource: current.gazeSource };
}
