/**
 * Shared contracts for Gaze Reader.
 *
 * Every module codes against these types. They are the seams between the gaze
 * pipeline, the reading model, the reader UI, Dewey (the buddy) and the browser
 * extension. Treat a change here as an architectural change.
 *
 * Conventions (see docs/ARCHITECTURE.md):
 *  - Time is `performance.now()` milliseconds everywhere.
 *  - Screen positions are viewport CSS pixels (clientX/clientY space) unless a
 *    field says otherwise.
 */

export type Unsubscribe = () => void;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ─────────────────────────────── Face tracking ───────────────────────────────

export interface HeadPose {
  /** Radians. Derived from MediaPipe's facial transformation matrix. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Translation from the facial transformation matrix (MediaPipe canonical units, ~cm). */
  tx: number;
  ty: number;
  tz: number;
}

export interface EyeFeatures {
  /**
   * Calibration-model input. Fixed length for a given build (FEATURE_NAMES in
   * src/gaze/features.ts); every entry is finite.
   */
  vector: number[];
  headPose: HeadPose;
  /** 0..1 — max blink score of the two eyes. */
  blink: number;
  /** Mean lid aperture / eye width across both eyes. */
  openness: number;
  /** Interocular distance in normalized image units — proxy for viewing distance. */
  faceScale: number;
  /** Face center in normalized image coordinates (0..1), NOT mirrored. */
  faceCenter: Point;
  /**
   * 0..1 mean of MediaPipe's eyeSquint blendshapes (0 when blendshapes are missing).
   * Used to notice light-driven squinting; never a gaze-model input.
   */
  squint?: number;
}

export interface FeatureFrame {
  /** performance.now() ms at which the video frame was processed. */
  t: number;
  faceFound: boolean;
  features: EyeFeatures | null;
  /** 0..1 heuristic tracking quality (face present, big enough, roughly frontal, eyes open). */
  quality: number;
  /** Aggregate lighting measurements (never pixels), attached to roughly 5–7 frames per second. */
  lighting?: LightingStats;
}

// ───────────────────────────────── Lighting ──────────────────────────────────

/**
 * Lighting measured from the camera frame in regions defined by the face
 * landmarks (src/gaze/lighting.ts). Luma values are 0..1; "Lin" values are
 * linear-light means; ratios are log2 stops. Only these numbers ever leave the
 * measurement code.
 */
export interface LightingStats {
  /** Face-oval mean luma (gamma-encoded). Depends on skin tone: live coaching only, never stored. */
  faceLuma: number;
  faceLin: number;
  /** log2(p90 / p10) of face luma: how contrasty the lighting on the face is. */
  faceRange: number;
  /** Fraction of clipped face pixels. */
  faceClip: number;
  frameLin: number;
  /** Background (frame minus the head-and-torso column) linear mean and clipped fraction. */
  bgLin: number;
  bgClip: number;
  /** Sclera brightness (p85 of non-saturated lid-aperture pixels), linear. Skin-tone independent. */
  scleraR: number;
  scleraL: number;
  /** log2(mean sclera / bgLin): strongly negative when a light or window is behind the reader. */
  backlight: number;
  /** log2(cheek L / cheek R): side lighting. */
  side: number;
  /** log2(eye-box non-saturated mean / cheek mean): shadowed or bright eye sockets. */
  shade: number;
  /** Near-saturated fraction in each eye box (glasses reflections). */
  glareR: number;
  glareL: number;
  /** Near-saturated fraction inside each iris disk (reflections on the eye itself). */
  irisGlintR: number;
  irisGlintL: number;
  /** Pixels measured in the face oval (resolution of the measurement). */
  facePx: number;
}

export type LightingFlag = 'dark' | 'overexposed' | 'glare' | 'backlit' | 'side-lit' | 'unstable';

export type LightingComponent = 'sclera' | 'backlight' | 'side' | 'shade' | 'glare' | 'range';

/** Compact, skin-tone-independent description of the lighting, stored with a calibration. */
export interface LightingSignature {
  v: 1;
  /** Samples it was built from. */
  n: number;
  /** Median head yaw/pitch (radians) while it was captured. */
  yaw: number;
  pitch: number;
  /** Median of each component. */
  c: Record<LightingComponent, number>;
  /** Robust spread (1.4826 × MAD) of each component. */
  sd: Record<LightingComponent, number>;
}

/**
 * How the reader's eyelids looked during calibration, so squinting (bright
 * light, glare) or wide eyes (dim light) can be recognised later. Lid aperture
 * also follows vertical gaze, so it is modelled against the gaze position.
 */
export interface AppearanceBaseline {
  v: 1;
  n: number;
  /** openness ≈ opennessAt0 + opennessSlope × (y / viewport height), fitted on calibration samples. */
  opennessAt0: number;
  opennessSlope: number;
  /** Robust SD of the residual openness around that line. */
  opennessResidualSd: number;
  /** Median and robust SD of EyeFeatures.squint. */
  squintMedian: number;
  squintSd: number;
}

/** Conditions at calibration time, stored with the gaze model. */
export interface CalibrationEnvironment {
  lighting: LightingSignature | null;
  appearance: AppearanceBaseline | null;
  capturedAt: number;
}

export type TrackerErrorCode =
  | 'camera-denied'
  | 'no-camera'
  | 'camera-in-use'
  | 'insecure-context'
  | 'model-load-failed'
  | 'unknown';

/** Anything that produces per-frame eye features (local camera, or a remote port in the extension). */
export interface FeatureSource {
  /** Rejects with an Error whose `code` property is a TrackerErrorCode. */
  start(): Promise<void>;
  stop(): void;
  onFrame(cb: (frame: FeatureFrame) => void): Unsubscribe;
  readonly running: boolean;
}

// ─────────────────────────────────── Gaze ────────────────────────────────────

export type GazeSourceKind = 'webcam' | 'mouse' | 'simulated';

export interface GazeSample {
  /** performance.now() ms */
  t: number;
  /** Smoothed gaze point, viewport CSS px. May lie outside the viewport. */
  x: number;
  y: number;
  /** Unsmoothed estimate, viewport CSS px. */
  rawX: number;
  rawY: number;
  /** False when the face is lost, the eyes are closed, or there is no model. x/y are then stale. */
  valid: boolean;
  /** 0..1 */
  confidence: number;
  source: GazeSourceKind;
}

export interface GazeSource {
  readonly kind: GazeSourceKind;
  start(): Promise<void>;
  stop(): void;
  onSample(cb: (sample: GazeSample) => void): Unsubscribe;
  readonly running: boolean;
}

// ──────────────────────────────── Calibration ────────────────────────────────

export interface CalibrationSample {
  /** Where the user was asked to look, viewport CSS px. */
  target: Point;
  features: EyeFeatures;
  t: number;
}

/** Opaque, JSON-safe model snapshot (owned by src/gaze/calibrationModel.ts). */
export interface SerializedGazeModel {
  version: number;
  [key: string]: unknown;
}

export interface GazeModel {
  /**
   * Predicts the gaze point in viewport CSS px for the *current* window
   * position (implementations compensate for window moves since calibration).
   * Returns null if the features are unusable.
   */
  predict(features: EyeFeatures): Point | null;
  /** Viewport size (CSS px) at calibration time. */
  readonly viewport: { width: number; height: number };
  readonly trainedAt: number;
  /** Lighting and eyelid appearance at calibration; null or absent when unknown. */
  readonly environment?: CalibrationEnvironment | null;
  toJSON(): SerializedGazeModel;
}

export type CalibrationQuality = 'excellent' | 'good' | 'fair' | 'poor';

export interface CalibrationReport {
  meanErrorPx: number;
  meanErrorXPx: number;
  meanErrorYPx: number;
  perPoint: { target: Point; meanPrediction: Point; errorPx: number; samples: number }[];
  /** Ridge regularization strength chosen by cross-validation. */
  lambda: number;
  sampleCount: number;
  quality: CalibrationQuality;
}

// ───────────────────────────── Fixations & lines ─────────────────────────────

export interface Fixation {
  id: number;
  start: number;
  end: number;
  /** Mean position, viewport CSS px. */
  x: number;
  y: number;
  sampleCount: number;
}

export type SaccadeKind = 'forward' | 'regression' | 'return-sweep' | 'jump';

export interface TextLine {
  /** Position in LineLayout.lines (0 = top-most measured line). */
  index: number;
  /** Viewport CSS px at measurement time. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  centerY: number;
  /** Top in scroll-content coordinates: (top - viewport.top) + scrollTop. Stable across scrolling. */
  docTop: number;
  /** Approximate characters on the line. */
  charCount: number;
  /** Entirely inside the reading viewport. */
  fullyVisible: boolean;
}

export interface LineLayout {
  /** Sorted by top. Only lines intersecting the reading viewport (plus a small margin). */
  lines: TextLine[];
  /** Visible reading area, viewport CSS px. */
  viewport: Rect;
  /** Union bounding box of `lines`. */
  column: Rect;
  /** Median distance between consecutive line centers, px. */
  linePitch: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  measuredAt: number;
}

export type LayoutChangeReason = 'initial' | 'scroll' | 'page-turn' | 'resize' | 'content';

export interface LineEstimate {
  t: number;
  /** Most likely line (index into the current layout), or -1 if unknown. */
  lineIndex: number;
  /** Posterior probability of lineIndex. */
  probability: number;
  /** Posterior per line; same length as the current layout's lines. */
  posterior: number[];
  /** 0..1 horizontal progress along lineIndex, from the latest gaze/fixation x. */
  progressX: number;
  lastSaccade: SaccadeKind | null;
  /** Estimated vertical bias of the gaze signal (measured − true), px. Consumed by the reading layer only. */
  driftY: number;
  /** Fixations since the last page turn / layout reset. */
  fixationsOnPage: number;
}

export type PageEndReason = 'line-tracker' | 'bottom-dwell' | 'glance-down' | 'none';

export interface PageEndDecision {
  trigger: boolean;
  reason: PageEndReason;
  /** 0..1 */
  confidence: number;
  /** The last line read (index into the layout) — it anchors the scroll target. -1 if unknown. */
  targetLineIndex: number;
  /** Human-readable explanation for the debug overlay. */
  detail: string;
}

// ────────────────────────────────── Books ────────────────────────────────────

export type BookFormat = 'txt' | 'md' | 'html' | 'epub' | 'pdf' | 'sample';

export interface BookChapter {
  title: string | null;
  /** Sanitized HTML: only the allowlist in src/reader/sanitize.ts survives. */
  html: string;
}

export interface Book {
  /** Stable id derived from a content hash. */
  id: string;
  title: string;
  author: string | null;
  chapters: BookChapter[];
  wordCount: number;
  source: 'sample' | 'file' | 'paste' | 'url';
  format: BookFormat;
  addedAt: number;
}

export interface ReadingPosition {
  bookId: string;
  /** 0..1 scroll fraction through the whole book. */
  fraction: number;
  /** Optional stable anchor such as a paragraph id ("c3-p17") for precise restore. */
  anchor?: string;
  updatedAt: number;
}

// ───────────────────────────────── Settings ──────────────────────────────────

export type Sensitivity = 'relaxed' | 'balanced' | 'eager';
export type Theme = 'auto' | 'light' | 'sepia' | 'dark';
export type Chattiness = 'quiet' | 'normal' | 'chatty';
export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface AppSettings {
  gazeSource: GazeSourceKind;
  autoScroll: boolean;
  sensitivity: Sensitivity;
  /** Lines of already-read text kept visible at the top after a page turn (0..3). */
  overlapLines: number;
  scrollDurationMs: number;
  /** Looking at/below the bottom edge for a moment turns the page. */
  glanceDownToTurn: boolean;

  fontSizePx: number;
  lineHeight: number;
  fontFamily: 'serif' | 'sans' | 'mono';
  columnWidthCh: number;
  theme: Theme;

  showGazeDot: boolean;
  showDebugOverlay: boolean;
  showCameraPreview: boolean;
  /** Gaussian jitter (px) injected in mouse mode to mimic a webcam tracker. */
  mouseNoisePx: number;
  /** Reading speed of the simulated reader (demo mode). */
  simulatedWpm: number;

  buddyEnabled: boolean;
  buddyChattiness: Chattiness;
  buddyCorner: Corner;
  breakReminders: boolean;
  breakIntervalMin: number;
}

// ────────────────────────────────── Events ───────────────────────────────────

export type TrackingState =
  | 'off'
  | 'starting'
  | 'calibrating'
  | 'tracking'
  | 'no-face'
  | 'poor'
  | 'paused'
  | 'error';

export type CommandName =
  | 'toggle-autoscroll'
  | 'pause'
  | 'resume'
  | 'recalibrate'
  | 'open-settings'
  | 'close-settings'
  | 'page-forward'
  | 'page-back'
  | 'undo-turn'
  | 'toggle-debug'
  | 'toggle-gaze-dot'
  | 'open-library'
  | 'show-help'
  | 'check-accuracy';

export type BuddyMood =
  | 'idle'
  | 'reading'
  | 'happy'
  | 'excited'
  | 'thinking'
  | 'worried'
  | 'sleepy'
  | 'celebrating';

export type SpeechPriority = 'low' | 'normal' | 'high';

export type CalibrationPhase =
  | 'start'
  | 'positioning'
  | 'point'
  | 'training'
  | 'validating'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface AppEvents {
  /** Every gaze sample from the active source. High frequency (30–60 Hz). */
  gaze: GazeSample;
  /** A completed fixation. */
  fixation: Fixation;
  'line-estimate': LineEstimate;
  layout: LineLayout;
  /** The page-end detector fired (emitted before the scroll starts). */
  'page-end': PageEndDecision;
  /** A page turn started. `pageIndex` counts turns in this session, from 1. */
  'page-turn': { from: number; to: number; auto: boolean; reason: string; pageIndex: number };
  'page-turn-undone': { from: number; to: number };
  'tracking-state': { state: TrackingState; detail?: string };
  calibration: {
    phase: CalibrationPhase;
    index?: number;
    total?: number;
    report?: CalibrationReport;
    message?: string;
  };
  'book-opened': { id: string; title: string; author: string | null; wordCount: number; resumed: boolean };
  'book-progress': {
    fraction: number;
    wordsRead: number;
    wpm: number | null;
    pagesTurned: number;
    minutesReading: number;
  };
  'book-finished': { title: string; minutesReading: number; pagesTurned: number };
  'break-due': { minutesReading: number };
  'settings-changed': { settings: AppSettings; changed: (keyof AppSettings)[] };
  /** Request a settings change from anywhere (buddy drag, extension popup…). The settings store applies it. */
  'settings-patch': Partial<AppSettings>;
  command: { name: CommandName };
  /** Ask Dewey to say something. */
  'buddy-say': { text: string; priority?: SpeechPriority; durationMs?: number; mood?: BuddyMood };
  'buddy-poke': Record<string, never>;
  error: { code: string; message: string };
  /** Live lighting assessment (about once a second while the camera runs). */
  'lighting-state': {
    flags: LightingFlag[];
    /** Signature distance to the calibration's lighting (≥ 1 means changed), or null when unknown. */
    distance: number | null;
    changedSinceCalibration: boolean;
    /** The component that moved most, when changed. */
    dominant: LightingComponent | null;
  };
  /**
   * The eyes' appearance changed in a way that biases gaze (light switched on or
   * off, squinting, glare). The reading layer re-learns its vertical offset for
   * fixations starting at or after `t`.
   */
  'appearance-changed': { t: number; reason: 'lighting' | 'lids' | 'refresh' | 'manual'; detail: string };
  /** Result of an accuracy check: a few dots measured without changing the model. */
  'accuracy-check': {
    meanErrorPx: number;
    /** Mean signed error (prediction − target), px; positive y = gaze reads lower than reality. */
    offsetXPx: number;
    offsetYPx: number;
    offsetYLines: number;
    /** Whether the measured offset was applied as a quick correction. */
    applied: boolean;
  };
}

export type EventName = keyof AppEvents;

export interface EventBus {
  on<K extends EventName>(type: K, cb: (payload: AppEvents[K]) => void): Unsubscribe;
  once<K extends EventName>(type: K, cb: (payload: AppEvents[K]) => void): Unsubscribe;
  emit<K extends EventName>(type: K, payload: AppEvents[K]): void;
  /** Remove every listener (used on teardown). */
  clear(): void;
}

/** Something that renders into a host element or a shadow root (so it also works inside the extension). */
export interface Mountable {
  mount(parent: HTMLElement | ShadowRoot): void;
  destroy(): void;
}
