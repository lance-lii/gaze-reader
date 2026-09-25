/**
 * Tracking diagnostics recorder (web app: Settings › Advanced › "Record tracking
 * diagnostics (no video)").
 *
 * Beta testers report things like "with a lamp on, it sometimes thinks I'm
 * reading lower than I am". A recording lets that be replayed through the
 * reading layer on a developer's machine (bench/replay/, `GR_REPLAY=file.json
 * npm run bench`) and measured instead of guessed.
 *
 * What is recorded, for up to 10 minutes, as numbers only:
 *  - every camera frame's eye features (the model's input vector, quality,
 *    blink, openness, squint, head pose) and the lighting statistics attached
 *    to some frames (ratios and levels; never pixels, and not the face's own
 *    brightness, faceLuma / faceLin, which depends on skin tone);
 *  - every gaze sample and whether the reading pipeline consumed it;
 *  - every call the controller makes into the reading layer (layouts with their
 *    line boxes, page-turn resume lines, resets, scroll cooldowns, appearance
 *    changes), in call order, so a replay re-executes the pipeline exactly;
 *  - compact line estimates, fixations, page-end decisions and page turns;
 *  - lighting-state, appearance-changed and accuracy-check events;
 *  - the calibration model (JSON) and report, the settings, and the
 *    environment: browser, screen, device pixel ratio, camera settings and the
 *    camera's name as the system reports it (usually its model, with USB ids).
 *
 * Never recorded: video, images, the book's text or title, how light or dark the
 * reader's skin is. The recording stays in memory until the reader downloads it
 * (a JSON file); nothing is uploaded. PRIVACY.md ("Tracking diagnostics") and
 * DIAGNOSTICS_PRIVACY_TEXT (src/ui/settingsPanel.ts) say the same in plain words:
 * keep all three in step.
 */
import type {
  AppEvents,
  AppSettings,
  CalibrationReport,
  FeatureFrame,
  GazeModel,
  GazeSample,
  GazeSourceKind,
  LayoutChangeReason,
  LightingStats,
  LineEstimate,
  LineLayout,
  Rect,
  SaccadeKind,
  Sensitivity,
  SerializedGazeModel,
  TextLine,
} from '../types';
import { isTrackedLineEstimate } from '../reading/lineTracker';

export const DIAGNOSTICS_FORMAT = 'gaze-reader-diagnostics';
export const DIAGNOSTICS_VERSION = 1;
/** Recordings stop by themselves after this long. */
export const DIAGNOSTICS_LIMIT_MS = 10 * 60_000;

/** Hard caps, so a 60 fps camera or a runaway loop can't grow a recording without bound. */
const MAX_FRAMES = 40_000;
const MAX_INPUTS = 90_000;
const MAX_ESTIMATES = 40_000;
const MAX_EVENTS = 20_000;
const MAX_MODELS = 20;

// ─────────────────────────────── Format ───────────────────────────────

/** One camera frame. Short keys: 18 000 of these fill 10 minutes at 30 fps. */
export interface RecordedFrame {
  t: number;
  /** Face found. */
  f: 0 | 1;
  /** Quality 0..1. */
  q: number;
  /** Blink, openness, squint (when a face was found). */
  b?: number;
  o?: number;
  s?: number;
  /** EyeFeatures.vector (FEATURE_NAMES order, see `build.featureNames`). */
  v?: number[];
  /** Head pose: yaw, pitch, roll (radians), tx, ty, tz. */
  hp?: [number, number, number, number, number, number];
  /** Face scale and centre (normalized image units). */
  fs?: number;
  fc?: [number, number];
  /** Lighting statistics measured on this frame, without the skin-tone-dependent face brightness. */
  l?: RecordedLighting;
}

/**
 * LightingStats as recorded: faceLuma and faceLin (the face's mean brightness) depend on skin
 * tone and are for live coaching only (src/types.ts), so they are left out. frameLin is the
 * whole frame's exposure and stays.
 */
export type RecordedLighting = Omit<LightingStats, 'faceLuma' | 'faceLin'>;

/** A measured line: [top, bottom, left, right, centerY, docTop, charCount, fullyVisible]. */
export type RecordedLine = [number, number, number, number, number, number, number, 0 | 1];

export interface RecordedLayout {
  lines: RecordedLine[];
  viewport: Rect;
  column: Rect;
  linePitch: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  measuredAt: number;
}

/**
 * Inputs to the reading layer, in the order the controller made them. `t` is the
 * performance.now() time of the call (the gaze sample's own time for 'gaze').
 */
export type PipelineInput =
  | { k: 'gaze'; t: number; x: number; y: number; rx: number; ry: number; v: 0 | 1; c: number; src: GazeSourceKind; fed: 0 | 1 }
  /**
   * resetPipeline(full): fixations and page-end reset; with `full` the line tracker too
   * (reset({ calibrated: true }) when `calibrated`: a new calibration just ran).
   */
  | { k: 'pipeline-reset'; t: number; full: boolean; keepDrift: boolean; calibrated?: boolean }
  /** FixationDetector.reset(); `unblock` also clears the "pipeline was blocked" latch. */
  | { k: 'fixations-reset'; t: number; unblock: boolean }
  | { k: 'layout'; t: number; reason: LayoutChangeReason; layout: RecordedLayout }
  | { k: 'resume'; t: number; line: number }
  | { k: 'scrolled'; t: number }
  | { k: 'page-end-reset'; t: number }
  | { k: 'configure'; t: number; sensitivity: Sensitivity; glanceDownToTurn: boolean }
  /** LineTracker.appearanceChangedAt(at). */
  | { k: 'appearance'; t: number; at: number }
  /** LineTracker.reset(...) outside resetPipeline (a new calibration, a new gaze source). */
  | { k: 'tracker-reset'; t: number; keepDrift: boolean };

export type PipelineControl = Exclude<PipelineInput, { k: 'gaze' } | { k: 'layout' }>;

/** A line estimate, compactly: line, probability, drift and its belief range (px). */
export interface RecordedEstimate {
  t: number;
  i: number;
  p: number;
  x: number;
  dy: number;
  /** σ_y, drift belief 2 % / 98 % quantiles and SD, px (tracked estimates only). */
  sg?: number;
  lo?: number;
  hi?: number;
  sd?: number;
  n: number;
  s: SaccadeKind | null;
  /** Emitted after a completed fixation (1), or a live update from a gaze sample (0). */
  fx: 0 | 1;
}

export type RecordedEventName =
  | 'fixation'
  | 'page-end'
  | 'page-turn'
  | 'page-turn-undone'
  | 'tracking-state'
  | 'calibration'
  | 'lighting-state'
  | 'appearance-changed'
  | 'accuracy-check';

export const RECORDED_EVENTS: readonly RecordedEventName[] = Object.freeze([
  'fixation',
  'page-end',
  'page-turn',
  'page-turn-undone',
  'tracking-state',
  'calibration',
  'lighting-state',
  'appearance-changed',
  'accuracy-check',
] satisfies RecordedEventName[]);

export type RecordedEvent = { [K in RecordedEventName]: { t: number; type: K; data: AppEvents[K] } }[RecordedEventName];

export interface ModelSnapshot {
  t: number;
  /** 'start': the model in use when recording began; 'calibration': a new or refreshed one. */
  reason: 'start' | 'calibration';
  model: SerializedGazeModel | null;
  report: CalibrationReport | null;
}

export interface DiagnosticsEnvironment {
  userAgent: string;
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number } | null;
  devicePixelRatio: number | null;
  viewport: { width: number; height: number } | null;
  /** Browser chrome above the viewport (outerHeight − innerHeight), px. */
  chromeTop: number | null;
  hardwareConcurrency: number | null;
  /**
   * The camera's reported settings (resolution, frame rate, exposure…) and its name (`label`,
   * e.g. "Integrated Webcam (0bda:5634)": usually the model, with its USB vendor and product
   * ids). No deviceId or groupId.
   */
  camera: Record<string, string | number | boolean> | null;
  /** How lighting is measured on this device ('copy', 'canvas', 'off'). */
  lightingBackend: string | null;
}

export type StopReason = 'user' | 'limit' | 'closed';

export interface DiagnosticsRecording {
  format: typeof DIAGNOSTICS_FORMAT;
  version: typeof DIAGNOSTICS_VERSION;
  /** Wall-clock start (ISO 8601). */
  startedAt: string;
  /** performance.now() at the start; every `t` is on that clock. */
  t0: number;
  durationMs: number;
  stoppedBy: StopReason | null;
  /** A cap was hit and some records were dropped. */
  truncated: boolean;
  build: { featureNames: string[]; target: string };
  environment: DiagnosticsEnvironment;
  settings: AppSettings;
  frames: RecordedFrame[];
  inputs: PipelineInput[];
  estimates: RecordedEstimate[];
  events: RecordedEvent[];
  models: ModelSnapshot[];
  /** Settings changed while recording. */
  settingsChanges: { t: number; changed: Partial<AppSettings> }[];
}

// ─────────────────────────────── Rounding ───────────────────────────────

const round = (v: number, digits: number): number => {
  if (!Number.isFinite(v)) return 0;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
/** Timestamps and CSS px: 0.1. */
const r1 = (v: number): number => round(v, 1);
/** Probabilities, lines: 0.001. */
const r3 = (v: number): number => round(v, 3);
/** Normalized features: 1e-5. */
const r5 = (v: number): number => round(v, 5);

/** Rounded lighting statistics, without faceLuma / faceLin (see RecordedLighting). */
function recordLighting(s: LightingStats): RecordedLighting {
  const out: Partial<LightingStats> = { ...s };
  delete out.faceLuma;
  delete out.faceLin;
  const kept = out as RecordedLighting;
  for (const k of Object.keys(kept) as (keyof RecordedLighting)[]) kept[k] = k === 'facePx' ? Math.round(kept[k]) : round(kept[k], 4);
  return kept;
}

export function recordLayout(l: LineLayout): RecordedLayout {
  return {
    lines: l.lines.map((x): RecordedLine => [r1(x.top), r1(x.bottom), r1(x.left), r1(x.right), r1(x.centerY), r1(x.docTop), Math.round(x.charCount), x.fullyVisible ? 1 : 0]),
    viewport: { ...l.viewport },
    column: { ...l.column },
    linePitch: r3(l.linePitch),
    scrollTop: r1(l.scrollTop),
    scrollHeight: r1(l.scrollHeight),
    clientHeight: r1(l.clientHeight),
    measuredAt: r1(l.measuredAt),
  };
}

/** The LineLayout a recorded layout describes (lines re-indexed in order). */
export function restoreLayout(r: RecordedLayout): LineLayout {
  const lines: TextLine[] = r.lines.map(([top, bottom, left, right, centerY, docTop, charCount, fullyVisible], index) => ({
    index,
    top,
    bottom,
    left,
    right,
    centerY,
    docTop,
    charCount,
    fullyVisible: fullyVisible === 1,
  }));
  return {
    lines,
    viewport: { ...r.viewport },
    column: { ...r.column },
    linePitch: r.linePitch,
    scrollTop: r.scrollTop,
    scrollHeight: r.scrollHeight,
    clientHeight: r.clientHeight,
    measuredAt: r.measuredAt,
  };
}

export function recordEstimate(e: LineEstimate, afterFixation: boolean): RecordedEstimate {
  const out: RecordedEstimate = {
    t: r1(e.t),
    i: e.lineIndex,
    p: r3(e.probability),
    x: r3(e.progressX),
    dy: r1(e.driftY),
    n: e.fixationsOnPage,
    s: e.lastSaccade,
    fx: afterFixation ? 1 : 0,
  };
  if (isTrackedLineEstimate(e)) {
    out.sg = r1(e.sigmaYPx);
    if (e.driftLowY !== undefined && Number.isFinite(e.driftLowY)) out.lo = r1(e.driftLowY);
    if (e.driftHighY !== undefined && Number.isFinite(e.driftHighY)) out.hi = r1(e.driftHighY);
    if (e.driftSdY !== undefined && Number.isFinite(e.driftSdY)) out.sd = r1(e.driftSdY);
  }
  return out;
}

// ─────────────────────────────── Environment ───────────────────────────────

/** Camera settings worth knowing when tracking misbehaves; device and group ids are left out. */
const CAMERA_KEYS: readonly string[] = [
  'width',
  'height',
  'frameRate',
  'aspectRatio',
  'facingMode',
  'resizeMode',
  'exposureMode',
  'exposureTime',
  'exposureCompensation',
  'whiteBalanceMode',
  'colorTemperature',
  'brightness',
  'contrast',
  'saturation',
  'sharpness',
  'focusMode',
  'iso',
  'zoom',
  'backgroundBlur',
];

/** The camera track of a `<video>` showing it, if any. */
export function videoTrackOf(video: HTMLVideoElement | null | undefined): MediaStreamTrack | null {
  try {
    const stream = video?.srcObject;
    if (typeof MediaStream === 'undefined' || !(stream instanceof MediaStream)) return null;
    return stream.getVideoTracks()[0] ?? null;
  } catch {
    return null;
  }
}

export function cameraSettings(track: MediaStreamTrack | null | undefined): Record<string, string | number | boolean> | null {
  if (!track || typeof track.getSettings !== 'function') return null;
  let raw: Record<string, unknown>;
  try {
    raw = { ...track.getSettings() } as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: Record<string, string | number | boolean> = {};
  for (const k of CAMERA_KEYS) {
    const v = raw[k];
    if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' || typeof v === 'boolean') out[k] = v as string | number | boolean;
  }
  // The model name ("Integrated Webcam (0bda:5634)") says which camera behaves how. Disclosed as
  // "the camera's name" in PRIVACY.md and DIAGNOSTICS_PRIVACY_TEXT.
  if (typeof track.label === 'string' && track.label) out.label = track.label.slice(0, 120);
  return out;
}

export function describeEnvironment(opts: { track?: MediaStreamTrack | null; lightingBackend?: string | null } = {}): DiagnosticsEnvironment {
  const g = globalThis as typeof globalThis & Partial<Window>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const scr = g.screen;
  const inner = num(g.innerHeight);
  const outer = num(g.outerHeight);
  return {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    screen: scr
      ? { width: scr.width, height: scr.height, availWidth: scr.availWidth, availHeight: scr.availHeight, colorDepth: scr.colorDepth }
      : null,
    devicePixelRatio: num(g.devicePixelRatio),
    viewport: num(g.innerWidth) !== null && inner !== null ? { width: g.innerWidth as number, height: inner } : null,
    chromeTop: inner !== null && outer !== null && outer >= inner ? outer - inner : null,
    hardwareConcurrency: typeof navigator !== 'undefined' ? num(navigator.hardwareConcurrency) : null,
    camera: cameraSettings(opts.track ?? null),
    lightingBackend: opts.lightingBackend ?? null,
  };
}

// ─────────────────────────────── Recorder ───────────────────────────────

export interface DiagnosticsRecorderOptions {
  /** Default {@link DIAGNOSTICS_LIMIT_MS}. */
  limitMs?: number;
  /** Clock (performance.now by default). */
  now?: () => number;
  /** Wall clock for `startedAt` (Date.now by default). */
  wallClock?: () => number;
  /** Called once when a recording stops because it reached its time limit. */
  onLimit?: () => void;
}

export interface DiagnosticsStart {
  settings: AppSettings;
  environment: DiagnosticsEnvironment;
  featureNames: readonly string[];
  target?: string;
  model: GazeModel | null;
  report: CalibrationReport | null;
}

function serializeModel(model: GazeModel | null): SerializedGazeModel | null {
  if (!model) return null;
  try {
    return JSON.parse(JSON.stringify(model.toJSON())) as SerializedGazeModel;
  } catch {
    return null;
  }
}

/**
 * Collects a recording in memory. Every method is a cheap no-op while not recording, so the
 * controller can call them unconditionally. Stops by itself after `limitMs`.
 */
export class DiagnosticsRecorder {
  private readonly o: Required<Omit<DiagnosticsRecorderOptions, 'onLimit'>> & Pick<DiagnosticsRecorderOptions, 'onLimit'>;
  private data: DiagnosticsRecording | null = null;
  private active = false;
  private endedAt = 0;

  constructor(opts: DiagnosticsRecorderOptions = {}) {
    this.o = {
      limitMs: opts.limitMs ?? DIAGNOSTICS_LIMIT_MS,
      now: opts.now ?? (() => performance.now()),
      wallClock: opts.wallClock ?? (() => Date.now()),
      onLimit: opts.onLimit,
    };
  }

  get recording(): boolean {
    return this.active;
  }

  /** A finished (or running) recording is available. */
  get hasData(): boolean {
    return this.data !== null;
  }

  get limitMs(): number {
    return this.o.limitMs;
  }

  get elapsedMs(): number {
    const d = this.data;
    if (!d) return 0;
    return Math.max(0, (this.active ? this.o.now() : this.endedAt) - d.t0);
  }

  start(init: DiagnosticsStart): void {
    const t0 = this.o.now();
    this.data = {
      format: DIAGNOSTICS_FORMAT,
      version: DIAGNOSTICS_VERSION,
      startedAt: new Date(this.o.wallClock()).toISOString(),
      t0: r1(t0),
      durationMs: 0,
      stoppedBy: null,
      truncated: false,
      build: { featureNames: [...init.featureNames], target: init.target ?? 'web' },
      environment: init.environment,
      settings: { ...init.settings },
      frames: [],
      inputs: [],
      estimates: [],
      events: [],
      models: [{ t: r1(t0), reason: 'start', model: serializeModel(init.model), report: init.report }],
      settingsChanges: [],
    };
    this.active = true;
  }

  stop(reason: StopReason = 'user'): void {
    if (!this.active || !this.data) return;
    this.active = false;
    this.endedAt = this.o.now();
    this.data.durationMs = r1(this.endedAt - this.data.t0);
    this.data.stoppedBy = reason;
  }

  /** Drops the recording (after it was downloaded, or to start afresh). */
  discard(): void {
    this.active = false;
    this.data = null;
  }

  /** Checks the time limit; true when this call stopped the recording. */
  tick(): boolean {
    const d = this.data;
    if (!this.active || !d) return false;
    if (this.o.now() - d.t0 < this.o.limitMs) return false;
    this.stop('limit');
    this.o.onLimit?.();
    return true;
  }

  frame(f: FeatureFrame): void {
    const d = this.live();
    if (!d) return;
    if (d.frames.length >= MAX_FRAMES) return this.truncate();
    const out: RecordedFrame = { t: r1(f.t), f: f.faceFound ? 1 : 0, q: r3(f.quality) };
    const e = f.features;
    if (e) {
      out.b = r3(e.blink);
      out.o = r5(e.openness);
      if (e.squint !== undefined && Number.isFinite(e.squint)) out.s = r3(e.squint);
      out.v = e.vector.map(r5);
      const h = e.headPose;
      out.hp = [r5(h.yaw), r5(h.pitch), r5(h.roll), r3(h.tx), r3(h.ty), r3(h.tz)];
      out.fs = r5(e.faceScale);
      out.fc = [r5(e.faceCenter.x), r5(e.faceCenter.y)];
    }
    if (f.lighting) out.l = recordLighting(f.lighting);
    d.frames.push(out);
  }

  /** A gaze sample, and whether the reading pipeline consumed it (it was not blocked). */
  gaze(s: GazeSample, fed: boolean): void {
    this.push({
      k: 'gaze',
      t: r1(s.t),
      x: r1(s.x),
      y: r1(s.y),
      rx: r1(s.rawX),
      ry: r1(s.rawY),
      v: s.valid ? 1 : 0,
      c: r3(s.confidence),
      src: s.source,
      fed: fed ? 1 : 0,
    });
  }

  layout(layout: LineLayout, reason: LayoutChangeReason, t: number): void {
    if (!this.live()) return;
    this.push({ k: 'layout', t: r1(t), reason, layout: recordLayout(layout) });
  }

  /** Any other reading-layer call (see PipelineInput). */
  input(entry: PipelineControl): void {
    if (!this.live()) return;
    this.push({ ...entry, t: r1(entry.t) } as PipelineInput);
  }

  estimate(e: LineEstimate, afterFixation: boolean): void {
    const d = this.live();
    if (!d) return;
    if (d.estimates.length >= MAX_ESTIMATES) return this.truncate();
    d.estimates.push(recordEstimate(e, afterFixation));
  }

  event<K extends RecordedEventName>(type: K, data: AppEvents[K], t: number): void {
    const d = this.live();
    if (!d) return;
    if (d.events.length >= MAX_EVENTS) return this.truncate();
    d.events.push({ t: r1(t), type, data: JSON.parse(JSON.stringify(data)) as AppEvents[K] } as RecordedEvent);
  }

  model(model: GazeModel | null, report: CalibrationReport | null, t: number): void {
    const d = this.live();
    if (!d) return;
    if (d.models.length >= MAX_MODELS) return this.truncate();
    d.models.push({ t: r1(t), reason: 'calibration', model: serializeModel(model), report });
  }

  settingsChanged(changed: Partial<AppSettings>, t: number): void {
    const d = this.live();
    if (!d) return;
    if (d.settingsChanges.length >= MAX_EVENTS) return this.truncate();
    d.settingsChanges.push({ t: r1(t), changed: { ...changed } });
  }

  /** The recording so far (a snapshot), or null. */
  toJSON(): DiagnosticsRecording | null {
    const d = this.data;
    if (!d) return null;
    return { ...d, durationMs: r1(this.elapsedMs) };
  }

  private live(): DiagnosticsRecording | null {
    if (!this.active || !this.data) return null;
    if (this.tick()) return null;
    return this.data;
  }

  private push(entry: PipelineInput): void {
    const d = this.live();
    if (!d) return;
    if (d.inputs.length >= MAX_INPUTS) return this.truncate();
    d.inputs.push(entry);
  }

  private truncate(): void {
    if (this.data) this.data.truncated = true;
  }
}

// ─────────────────────────────── Files ───────────────────────────────

/** "gaze-reader-diagnostics-2026-09-25-1412.json" (local time). */
export function recordingFileName(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `gaze-reader-diagnostics-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}

/** Saves a recording as a JSON download. Web app only (the Artifact frame has no downloads). */
export function downloadRecording(rec: DiagnosticsRecording, doc: Document = document): boolean {
  try {
    const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = recordingFileName(new Date(Date.parse(rec.startedAt) || Date.now()));
    a.rel = 'noopener';
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch (err) {
    console.warn('[diagnostics] could not save the recording', err);
    return false;
  }
}

/** Approximate size of a recording as a download, bytes. */
export function recordingSize(rec: DiagnosticsRecording): number {
  return JSON.stringify(rec).length;
}

// ─────────────────────────────── Parsing ───────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Validates a recording read from a file: the format tag, the version and the shape of every
 * top-level field (entries are trusted to be what the recorder wrote). Null when it isn't one.
 */
export function parseRecording(x: unknown): DiagnosticsRecording | null {
  if (!isObj(x) || x.format !== DIAGNOSTICS_FORMAT || x.version !== DIAGNOSTICS_VERSION) return null;
  if (typeof x.t0 !== 'number' || typeof x.startedAt !== 'string') return null;
  for (const k of ['frames', 'inputs', 'estimates', 'events', 'models'] as const) if (!Array.isArray(x[k])) return null;
  if (!isObj(x.settings) || !isObj(x.build) || !Array.isArray(x.build.featureNames)) return null;
  if (!(x.inputs as unknown[]).every((e) => isObj(e) && typeof e.k === 'string' && typeof e.t === 'number')) return null;
  return {
    ...(x as unknown as DiagnosticsRecording),
    settingsChanges: Array.isArray(x.settingsChanges) ? (x.settingsChanges as DiagnosticsRecording['settingsChanges']) : [],
    environment: isObj(x.environment) ? (x.environment as unknown as DiagnosticsEnvironment) : describeEmpty(),
  };
}

function describeEmpty(): DiagnosticsEnvironment {
  return {
    userAgent: '',
    screen: null,
    devicePixelRatio: null,
    viewport: null,
    chromeTop: null,
    hardwareConcurrency: null,
    camera: null,
    lightingBackend: null,
  };
}
