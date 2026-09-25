/**
 * Full-screen calibration flow: positioning → targets → training →
 * validation → results. Self-contained (own <style>, `gr-cal-*` classes) and
 * mountable into a document or a ShadowRoot, so the extension can use it on
 * any page.
 *
 * Three modes:
 *  - standard: 13-point grid, training, 4 validation points.
 *  - quick: 5 points that re-centre `baseModel` (refineGazeModel). The results
 *    also say how far off the old model was on those dots, and how far off
 *    the refresh leaves it.
 *  - check: the accuracy check. 5 dots and no training: the offset of
 *    `baseModel` is measured (measureOffset) and put in plain words ("reads
 *    about 2 lines low"). "Correct it" applies a quick refresh fitted on those
 *    same dots; "Done" leaves the model alone.
 *
 * Positioning coaches distance, centring and light. Light comes from
 * FeatureFrame.lighting (measured by the camera side, in the web app and the
 * extension alike) through a LightingMonitor: the sclera for "dark", which
 * does not depend on skin tone, plus backlight, over-exposure, reflections,
 * side light and changing light. While the dots are shown, those
 * measurements are summarised into a LightingSignature stored with the model.
 *
 * Every phase is announced on the bus as a `calibration` event:
 *   start · positioning · point {index, total} · training ·
 *   validating {index, total} · done {report} · cancelled · failed {message}
 * `index` is 0-based. `point` / `validating` events may also carry
 * `message`: 'retry' (target repeated for lack of samples), 'paused',
 * 'face-lost' (auto-pause) or 'resumed'. The accuracy check's dots are
 * `validating` events (no `point`, no `training`).
 *
 * Quick and check runs also emit one `accuracy-check` per results screen,
 * when the reader decides (or cancels): the old model's offset on the dots,
 * and whether a correction was applied.
 */
import type {
  AppEvents,
  CalibrationQuality,
  CalibrationReport,
  CalibrationSample,
  EventBus,
  EyeFeatures,
  FeatureFrame,
  FeatureSource,
  GazeModel,
  LightingComponent,
  LightingFlag,
  LightingSignature,
  LightingStats,
  Mountable,
  Point,
  Unsubscribe,
} from '../types';
import { CSS_PREFIX, IGNORE_ATTR, Z } from '../core/constants';
import { OneEuroFilter2D } from '../signal/oneEuro';
import {
  DEFAULT_LINE_PITCH_PX,
  RidgeGazeModel,
  asRidgeGazeModel,
  currentScreenOrigin,
  evaluateModel,
  qualityFromError,
  refineGazeModel,
  trainGazeModel,
  type OffsetMeasurement,
} from '../gaze/calibrationModel';
import {
  LIGHTING_STAT_KEYS,
  LightingMonitor,
  buildLightingSignature,
  compareLightingSignatures,
  parseLightingSignature,
  type LightingSample,
} from '../gaze/lighting';
import { BlinkGate, DEFAULT_BLINK_GATE } from '../gaze/webcamGazeSource';
import { DOT_OFF_LINES, offsetVerdict, withinWords, type OffsetWords } from '../app/offsetWords';

// ─────────────────────────────── Public API ──────────────────────────────────

export type CalibrationMode = 'quick' | 'standard' | 'check';

export interface CalibrationOverlayOptions {
  /** Already started by the caller; the overlay only subscribes. */
  features: FeatureSource;
  bus: EventBus;
  /** The camera's video element; its stream is mirrored into the positioning preview. */
  video?: HTMLVideoElement | null;
  /**
   * quick = 5 points refining `baseModel`; standard = 13-point grid + 4 validation points;
   * check = 5 points measuring `baseModel` without training (see the file comment).
   * quick and check fall back to standard without a usable `baseModel`.
   */
  mode?: CalibrationMode;
  /**
   * The model in use. Pass it as it is used for reading (a wrapper is fine): the check measures
   * it through `predict`, while corrections are fitted on its ridge core (asRidgeGazeModel).
   */
  baseModel?: GazeModel | null;
  /** Line pitch of the reader's text, for "≈ N lines". Default 22 px × 1.9. */
  linePitchPx?: number | (() => number | null | undefined);
  /** FEATURE_NAMES, stored with the model so stale calibrations are detected on load. */
  featureNames?: readonly string[];
  /** Timing overrides (tests, accessibility needs). */
  timing?: Partial<CalibrationTiming>;
  /** Target-order randomness (tests). Default Math.random. */
  random?: () => number;
}

export interface CalibrationResult {
  model: GazeModel;
  report: CalibrationReport;
  /** Present after a quick refresh and after an accuracy check whose correction was applied. */
  check?: AccuracyCheckResult;
}

/** A systematic offset on a few dots, at the reader's line pitch. */
export interface OffsetSummary {
  /** Mean Euclidean error of the per-dot mean prediction, px. */
  meanErrorPx: number;
  /** Mean signed error (prediction − target), px; positive y = gaze reads lower than reality. */
  offsetXPx: number;
  offsetYPx: number;
  offsetYLines: number;
  /** offsetXPx as a fraction of the viewport width (> 0 = right); absent when unknown. */
  offsetXFrac?: number;
  /**
   * Largest vertical error of a single dot (|mean prediction − target|), lines; absent when
   * unknown. The mean offset hides a scale error on these symmetric dots; this doesn't.
   */
  maxDotYLines?: number;
  /** Dots that contributed. */
  targets: number;
}

/** How the reader's light compares with the light at calibration. */
export interface LightingChange {
  /** Signature distance (≥ 1 = changed meaningfully). */
  distance: number;
  changed: boolean;
  /** The component that moved most. */
  dominant: LightingComponent;
  /** Plain words for a changed light ("your eyes are more brightly lit"), null when unchanged. */
  text: string | null;
}

export interface AccuracyCheckResult {
  mode: 'check' | 'quick';
  /** The model in use before this run, measured on this run's dots. */
  before: OffsetSummary;
  /**
   * What the correction leaves (leave-one-dot-out when there are ≥ 3 dots), or null when no
   * correction could be fitted. For 'check' it is computed before the reader chooses.
   */
  after: OffsetSummary | null;
  /** Whether the correction was applied (the model in the result is the corrected one). */
  applied: boolean;
  /** Lighting measured while the dots were shown; null with too few lighting measurements. */
  lighting: LightingSignature | null;
  /** Compared with the calibration's lighting; null when either signature is unknown. */
  lightingChange: LightingChange | null;
}

export interface CalibrationTiming {
  /** Fade-in of the first target before its countdown starts. */
  appearMs: number;
  /** Travel time of the dot between targets. */
  glideMs: number;
  /** Duration of the shrinking ring; samples are collected during it. */
  targetMs: number;
  /** Discarded start of each target: saccade latency + settling. */
  settleMs: number;
  /** Little celebratory pop after each target. */
  popMs: number;
  /** Fewer valid samples than this → the target is repeated. */
  minSamples: number;
  /** Attempts per target before it is skipped. */
  maxAttempts: number;
  /** No usable frame for this long during targets → auto-pause. */
  faceLostMs: number;
  /** Usable frames for this long → auto-resume after a face-lost pause. */
  faceBackMs: number;
  /** Positioning checks must pass this long before "Start" lights up. */
  readyHoldMs: number;
  /** With a face in view, "Start anyway" becomes available after this long. */
  startAnywayMs: number;
  /** Minimum time the "learning" screen stays up (it reads as work, not a glitch). */
  minTrainingMs: number;
}

export const DEFAULT_CALIBRATION_TIMING: Readonly<CalibrationTiming> = Object.freeze({
  appearMs: 500,
  glideMs: 380,
  targetMs: 1600,
  settleMs: 450,
  popMs: 180,
  minSamples: 8,
  maxAttempts: 3,
  faceLostMs: 2000,
  faceBackMs: 700,
  readyHoldMs: 500,
  startAnywayMs: 8000,
  minTrainingMs: 700,
});

/** Target positions as fractions of the viewport. */
export const STANDARD_TARGETS: readonly Point[] = Object.freeze([
  ...[0.08, 0.36, 0.64, 0.92].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y }))),
  { x: 0.5, y: 0.5 },
]);
/** Off-grid points, so validation measures generalization rather than memory. */
export const VALIDATION_TARGETS: readonly Point[] = Object.freeze([
  { x: 0.25, y: 0.22 },
  { x: 0.75, y: 0.22 },
  { x: 0.25, y: 0.78 },
  { x: 0.75, y: 0.78 },
]);
export const QUICK_TARGETS: readonly Point[] = Object.freeze([
  { x: 0.5, y: 0.5 },
  { x: 0.15, y: 0.15 },
  { x: 0.85, y: 0.15 },
  { x: 0.15, y: 0.85 },
  { x: 0.85, y: 0.85 },
]);
/**
 * The accuracy check's dots: the quick refresh's, so "Correct it" can refine from them with the
 * geometry refineGazeModel was designed for (centre + four corners spread the scale fit).
 */
export const CHECK_TARGETS: readonly Point[] = QUICK_TARGETS;

// ─────────────────────────── Offsets in plain words ──────────────────────────
// The verdict lives in src/app/offsetWords.ts, so the toast after "Done" says what this screen says.

export {
  CORRECT_FROM_LINES,
  DOT_BIG_LINES,
  DOT_CORRECT_LINES,
  DOT_OFF_LINES,
  OFFSET_X_FRAC,
  ON_TARGET_LINES,
  describeOffset,
  offsetVerdict,
  type OffsetBadge,
  type OffsetVerdict,
  type OffsetWords,
} from '../app/offsetWords';

/**
 * Compares the lighting now with the lighting at calibration, in words the reader can act on.
 * All components are ratios (no absolute face brightness), so it does not depend on skin tone.
 */
export function describeLightingChange(reference: LightingSignature, current: LightingSignature): LightingChange {
  const cmp = compareLightingSignatures(reference, current);
  const changed = cmp.distance >= 1;
  const up = cmp.z[cmp.dominant] > 0;
  let text: string | null = null;
  if (changed) {
    switch (cmp.dominant) {
      case 'sclera':
        text = up ? 'your eyes are more brightly lit now' : 'your eyes are more dimly lit now';
        break;
      case 'backlight':
        // backlight = log2(sclera / background): lower means more light behind the reader.
        text = up ? 'there’s less light behind you now' : 'there’s more light behind you now';
        break;
      case 'side':
        text = Math.abs(current.c.side) >= Math.abs(reference.c.side) ? 'more of the light comes from one side now' : 'the light is more even across your face now';
        break;
      case 'shade':
        text = up ? 'there are fewer shadows around your eyes now' : 'there are more shadows around your eyes now';
        break;
      case 'glare':
        text = up ? 'there are more reflections on your glasses or eyes now' : 'there are fewer reflections on your glasses or eyes now';
        break;
      case 'range':
        text = up ? 'the light on your face is harsher now' : 'the light on your face is softer now';
        break;
    }
  }
  return { distance: cmp.distance, changed, dominant: cmp.dominant, text };
}

// ───────────────────────── Positioning assessment ────────────────────────────

export type PositionIssue =
  | 'no-face'
  | 'not-facing'
  | 'too-close'
  | 'too-far'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'light-changing'
  | 'backlit'
  | 'too-dark'
  | 'overexposed'
  | 'unsteady';

/** Lighting advice that doesn't hold up the start: it helps, but calibration works without it. */
export type LightingTip = 'glare' | 'side-lit';

export interface PositionMetrics {
  faceFound: boolean;
  /** Interocular distance in image widths (EyeFeatures.faceScale). */
  faceScale: number;
  /** Raw (not mirrored) image coordinates 0..1. */
  faceCenter: Point;
  /** Radians. */
  yaw: number;
  pitch: number;
  /** FeatureFrame.quality, 0..1. */
  quality: number;
  /**
   * LightingMonitor flags from FeatureFrame.lighting, or null when the light isn't being
   * measured (no measurements, or none for a few seconds).
   */
  lighting: readonly LightingFlag[] | null;
}

export interface PositionThresholds {
  minFaceScale: number;
  maxFaceScale: number;
  maxOffsetX: number;
  minCenterY: number;
  maxCenterY: number;
  maxYaw: number;
  maxPitch: number;
  minQuality: number;
}

/**
 * The face-scale band matches the tracker's own ideal band (≈ 25–75 cm with a
 * typical webcam) and yaw matches where its quality score starts to fall off
 * (20°). Pitch gets a little more room because webcams usually sit above the
 * screen, so a reader looking at the page is naturally pitched down a bit.
 */
export const DEFAULT_POSITION_THRESHOLDS: Readonly<PositionThresholds> = Object.freeze({
  minFaceScale: 0.07,
  maxFaceScale: 0.24,
  maxOffsetX: 0.17,
  minCenterY: 0.24,
  maxCenterY: 0.7,
  maxYaw: 0.35,
  maxPitch: 0.42,
  minQuality: 0.4,
});

export interface PositionAssessment {
  /** The single most important thing to fix, or null when all is well. */
  issue: PositionIssue | null;
  /** Lighting advice that doesn't block starting (shown when there is no issue), or null. */
  tip: LightingTip | null;
  checks: { face: boolean; distance: boolean; center: boolean; light: boolean };
}

/**
 * Pure coaching logic. Directions are from the reader's point of view: the
 * camera image is not mirrored, so a face on the image's right means the
 * reader sits too far to *their* left and should move right.
 *
 * Light comes from LightingMonitor flags (never from how bright the face is,
 * which depends on skin tone). Changing light, backlight, dark eyes and a
 * washed-out picture are issues; reflections and light from one side are tips.
 * Without lighting measurements the light check rests on tracking quality.
 */
export function assessPosition(
  m: PositionMetrics,
  t: PositionThresholds = DEFAULT_POSITION_THRESHOLDS,
): PositionAssessment {
  const finite = [m.faceScale, m.faceCenter.x, m.faceCenter.y, m.yaw, m.pitch].every(Number.isFinite);
  if (!m.faceFound || !finite) {
    return { issue: 'no-face', tip: null, checks: { face: false, distance: false, center: false, light: false } };
  }
  const tooClose = m.faceScale > t.maxFaceScale;
  const tooFar = m.faceScale < t.minFaceScale;
  const notFacing = Math.abs(m.yaw) > t.maxYaw || Math.abs(m.pitch) > t.maxPitch;
  const dx = m.faceCenter.x - 0.5;
  const horizontal: PositionIssue | null = dx > t.maxOffsetX ? 'move-right' : dx < -t.maxOffsetX ? 'move-left' : null;
  const vertical: PositionIssue | null =
    m.faceCenter.y < t.minCenterY ? 'move-down' : m.faceCenter.y > t.maxCenterY ? 'move-up' : null;
  const flags = m.lighting ?? [];
  const has = (f: LightingFlag): boolean => flags.includes(f);
  // Changing light first: the other flags may be the camera still adjusting. Backlight explains
  // dark eyes better than "add light" does, so it comes before 'too-dark'.
  const light: PositionIssue | null = has('unstable')
    ? 'light-changing'
    : has('backlit')
      ? 'backlit'
      : has('dark')
        ? 'too-dark'
        : has('overexposed')
          ? 'overexposed'
          : null;
  const tip: LightingTip | null = has('glare') ? 'glare' : has('side-lit') ? 'side-lit' : null;
  const shaky = m.quality < t.minQuality;
  const checks = {
    face: true,
    distance: !tooClose && !tooFar,
    center: !notFacing && !horizontal && !vertical,
    light: !light && !shaky,
  };
  const issue: PositionIssue | null = notFacing
    ? 'not-facing'
    : tooClose
      ? 'too-close'
      : tooFar
        ? 'too-far'
        : (horizontal ?? vertical ?? light ?? (shaky ? 'unsteady' : null));
  return { issue, tip, checks };
}

// ──────────────────────────────── Copy ───────────────────────────────────────

const COACH: Record<PositionIssue | 'ready' | 'waiting' | 'no-camera', string> = {
  waiting: 'Waiting for the camera…',
  'no-camera': 'Still waiting for the camera — is another app using it?',
  'no-face': 'I can’t see your face yet — sit in front of the camera.',
  'not-facing': 'Face the screen straight on.',
  'too-close': 'A little close — lean back a bit.',
  'too-far': 'A little far — come a bit closer.',
  'move-left': 'Move a little to your left.',
  'move-right': 'Move a little to your right.',
  'move-down': 'Tilt the screen back a little, or sit a bit lower.',
  'move-up': 'Tilt the screen forward a little, or sit up taller.',
  'light-changing': 'The light is changing — give the camera a moment to settle.',
  backlit: 'Bright light behind you puts your face in shadow — a lamp in front of you, or closing the blind behind you, will help.',
  'too-dark': 'Your eyes are a little hard to see — more light on your face will help.',
  overexposed: 'The picture looks washed out — a little less light on your face, or a dimmer screen, will help.',
  unsteady: 'Hold still for a moment — tracking is a little shaky.',
  ready: 'Perfect — you’re all set.',
};

const TIP_COPY: Record<LightingTip, string> = {
  glare: 'You’re all set. One tip: I see bright reflections on your glasses or eyes — tilting the screen a little or moving the lamp helps.',
  'side-lit': 'You’re all set. One tip: most of the light comes from one side — more even light on your face tracks best.',
};

const CHECK_STATE_TEXT: Record<'ok' | 'bad' | 'tip' | 'pending', string> = {
  ok: 'fine',
  bad: 'needs attention',
  tip: 'fine, with a tip',
  pending: 'not checked yet',
};

const QUALITY_COPY: Record<CalibrationQuality, { badge: string; title: string; advice: string }> = {
  excellent: {
    badge: 'Excellent',
    title: 'Spot on!',
    advice: 'Page turns should feel effortless. Keep a similar posture while you read.',
  },
  good: {
    badge: 'Good',
    title: 'Nice — that’s a good calibration',
    advice: 'Page turns should feel natural. Keep a similar posture while you read.',
  },
  fair: {
    badge: 'Fair',
    title: 'Usable, but a little rough',
    advice: 'Page turns will work but may come a touch late. Even light on your face and a steady head help — redo if you like.',
  },
  poor: {
    badge: 'Needs a redo',
    title: 'Hmm, that was a bit off',
    advice: 'Try more light on your face, sit about an arm’s length away and keep your head still, then redo.',
  },
};

const FAIL_TOO_FEW =
  'I couldn’t get a steady look at your eyes. More light on your face and keeping your head still usually fixes it.';
const FAIL_QUICK =
  'Your eyes look quite different from the saved calibration, so a quick refresh can’t fix it. Let’s do a full calibration instead.';
const FAIL_CHECK =
  'I couldn’t compare your eyes with the saved calibration, so this check can’t tell much. A full calibration will sort it out.';

const NEXT_COPY: Record<CalibrationMode, string> = {
  standard: `Next: ${STANDARD_TARGETS.length} dots, then ${VALIDATION_TARGETS.length} quick checks. Look right at the center of each dot until it disappears — move your eyes, not your head.`,
  quick: `Quick refresh: ${QUICK_TARGETS.length} dots, about 10 seconds. Look right at the center of each one until it disappears.`,
  check: `Accuracy check: ${CHECK_TARGETS.length} dots, about 10 seconds. Look right at the center of each one until it disappears — nothing changes unless you ask.`,
};

// ─────────────────────────────── Internals ───────────────────────────────────

type Phase = 'idle' | 'positioning' | 'targets' | 'training' | 'validating' | 'results' | 'failed';
/** use = "Use it" / "Correct it"; done = keep the model as it is (accuracy check). */
type Choice = 'use' | 'redo' | 'full' | 'done';
type PauseReason = 'user' | 'face';
type TargetKind = 'point' | 'validating';
type Coach = PositionIssue | LightingTip | 'ready' | 'waiting' | 'no-camera';
type CheckState = 'ok' | 'bad' | 'tip' | 'pending';
type CalibrationEvent = AppEvents['calibration'];

/** What a run ends with: the result run() resolves (null = nothing changed) and the report for 'done'. */
interface FlowOutcome {
  result: CalibrationResult | null;
  report: CalibrationReport;
}

/** Everything the results screen shows. */
interface ResultsView {
  mode: CalibrationMode;
  /** Drawn on the map and driving the live dot: the new model, or the checked one. */
  model: GazeModel;
  report: CalibrationReport;
  check: AccuracyCheckResult | null;
  /** Check mode: a correction was fitted and can be applied. */
  canCorrect: boolean;
  /** Check mode: offer a full calibration (no correction possible, or it would still be poor). */
  suggestFull: boolean;
}

const isTip = (c: Coach): c is LightingTip => c === 'glare' || c === 'side-lit';

/** Lighting flags are dropped when no measurement arrived for this long (the probe skips blinks and junk frames). */
const LIGHTING_STALE_MS = 3000;
/** Lighting samples for the signature are kept at most this often (measurements arrive at ~6–7 Hz)… */
const LIGHT_SAMPLE_GAP_MS = 100;
/** …and thinned by half whenever this many have piled up (a very long run). */
const MAX_LIGHT_SAMPLES = 1200;

const P = `${CSS_PREFIX}cal`;
const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * Frames the tracker itself rates below this are never used as samples —
 * except lowered lids, which its score also marks down but the blink gate has
 * already vetted.
 */
const MIN_FRAME_QUALITY = 0.15;
/**
 * Samples reach the model with blink scores up to here. Real blinks were
 * already dropped by the same BlinkGate the live gaze source uses; what is
 * left above its threshold is lowered lids (looking low on the screen), which
 * the live source keeps — so the model has to learn them, not extrapolate.
 */
const SAMPLE_MAX_BLINK = DEFAULT_BLINK_GATE.closedThreshold;
/** Keys whose default action scrolls: kept from scrolling the page behind the modal. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  ' ',
  'Spacebar',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const MIN_TARGETS_STANDARD = 9;
const MIN_TARGETS_QUICK = 3;
const MIN_VALIDATION_TARGETS = 2;
/** Interrupts the current target only (pause, resize) — not the whole run. */
const INTERRUPT = Symbol('interrupt');

let instanceCounter = 0;

interface Collector {
  target: Point;
  from: number;
  until: number;
  samples: CalibrationSample[];
}

interface PositioningState {
  enteredAt: number;
  lastFrameAt: number | null;
  noFaceSince: number | null;
  metrics: Omit<PositionMetrics, 'lighting' | 'faceFound'> | null;
  checks: PositionAssessment['checks'];
  candidate: Coach;
  candidateSince: number;
  shown: Coach;
  goodSince: number | null;
  canStart: boolean;
  ready: boolean;
}

interface Dom {
  style: HTMLStyleElement;
  stage: HTMLDivElement;
  target: HTMLDivElement;
  hudWrap: HTMLDivElement;
  hudLabel: HTMLSpanElement;
  hudCount: HTMLSpanElement;
  hudBar: HTMLSpanElement;
  toast: HTMLParagraphElement;
  pause: HTMLDivElement;
  pauseTitle: HTMLHeadingElement;
  pauseText: HTMLParagraphElement;
  positioning: HTMLDivElement;
  preview: HTMLDivElement;
  video: HTMLVideoElement;
  face: HTMLDivElement;
  status: HTMLParagraphElement;
  statusText: HTMLSpanElement;
  checks: Record<keyof PositionAssessment['checks'], HTMLLIElement>;
  next: HTMLParagraphElement;
  start: HTMLButtonElement;
  training: HTMLDivElement;
  results: HTMLDivElement;
  badge: HTMLSpanElement;
  resultTitle: HTMLHeadingElement;
  statPx: HTMLSpanElement;
  statPxLabel: HTMLSpanElement;
  statLines: HTMLSpanElement;
  statLinesUnit: HTMLSpanElement;
  statLinesLabel: HTMLSpanElement;
  map: SVGSVGElement;
  note: HTMLParagraphElement;
  advice: HTMLParagraphElement;
  tryit: HTMLParagraphElement;
  use: HTMLButtonElement;
  done: HTMLButtonElement;
  redo: HTMLButtonElement;
  live: HTMLDivElement;
  failed: HTMLDivElement;
  failTitle: HTMLHeadingElement;
  failText: HTMLParagraphElement;
  retry: HTMLButtonElement;
  sr: HTMLDivElement;
}

export class CalibrationOverlay implements Mountable {
  private readonly opts: CalibrationOverlayOptions;
  private readonly timing: CalibrationTiming;
  private readonly random: () => number;
  private readonly uid = ++instanceCounter;

  private root: HTMLDivElement | null = null;
  private dom: Dom | null = null;
  private phase: Phase = 'idle';
  private destroyed = false;

  private runPromise: Promise<CalibrationResult | null> | null = null;
  private runCtl: AbortController | null = null;
  private stepCtl: AbortController | null = null;
  private unsubscribeFrames: Unsubscribe | null = null;
  private listening = false;
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private returnFocus: Element | null = null;

  private pos: PositioningState | null = null;
  private positionTicker: ReturnType<typeof setInterval> | null = null;
  private previewActive = false;
  private onStart: (() => void) | null = null;
  /** The mode of the current pass (quick/check fall back to standard). */
  private runMode: CalibrationMode = 'standard';

  /** Smoothed lighting flags for the positioning coach (fed from FeatureFrame.lighting). */
  private readonly lightMonitor = new LightingMonitor();
  /** performance.now() of the latest lighting measurement. */
  private lightingAt = -Infinity;
  /** Lighting measured while this pass's dots are shown, for the calibration's signature. */
  private lightSamples: LightingSample[] = [];
  private lightSampleAt = -Infinity;
  private lightSampleGapMs = LIGHT_SAMPLE_GAP_MS;
  private lastCheck: AccuracyCheckResult | null = null;

  private collector: Collector | null = null;
  private progress: { kind: TargetKind; index: number; total: number } | null = null;
  private paused: PauseReason | null = null;
  private resumeWaiters: (() => void)[] = [];
  private lastValidAt = 0;
  private validSince: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastFeatureLength: number | null = null;
  /** The live gaze source's blink rule, so calibration keeps exactly the frames tracking will use. */
  private readonly blinkGate = new BlinkGate();

  private liveModel: GazeModel | null = null;
  private readonly liveFilter = new OneEuroFilter2D();
  private liveLastValid = -Infinity;
  private liveViewport = { width: 0, height: 0 };
  private onChoice: ((c: Choice) => void) | null = null;
  private onRetry: (() => void) | null = null;

  constructor(opts: CalibrationOverlayOptions) {
    this.opts = opts;
    this.timing = { ...DEFAULT_CALIBRATION_TIMING, ...(opts.timing ?? {}) };
    this.random = opts.random ?? Math.random;
  }

  /** True while run() is in progress. */
  get running(): boolean {
    return this.runPromise !== null;
  }

  /**
   * The latest accuracy measurement of this run (quick or check mode), with `applied` set once
   * the reader has decided; null before any. Also available after an accuracy check closed with
   * "Done", when run() resolves null.
   */
  get lastAccuracyCheck(): AccuracyCheckResult | null {
    return this.lastCheck;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    if (this.destroyed) return;
    if (!this.root) this.build(parent.ownerDocument ?? document);
    if (this.root) parent.appendChild(this.root);
  }

  /**
   * Resolves with the accepted model, or null when cancelled (Esc, cancel(), destroy()) — and
   * null when an accuracy check ends with "Done", since the model is unchanged then (the
   * measurement is in the 'accuracy-check' event and `lastAccuracyCheck`).
   */
  run(): Promise<CalibrationResult | null> {
    if (this.destroyed) return Promise.resolve(null);
    if (this.runPromise) {
      // A cancelled run is still unwinding: start fresh once it has.
      if (this.runCtl?.signal.aborted) return this.runPromise.then(() => this.run());
      return this.runPromise;
    }
    if (!this.root) {
      if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);
      this.mount(document.body);
    }
    const p = this.execute();
    this.runPromise = p;
    void p.then(() => {
      if (this.runPromise === p) this.runPromise = null;
    });
    return p;
  }

  cancel(): void {
    const ctl = this.runCtl;
    if (ctl && !ctl.signal.aborted) ctl.abort(new DOMException('Calibration cancelled', 'AbortError'));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.endRun();
    this.root?.remove();
    this.root = null;
    this.dom = null;
  }

  // ───────────────────────────────── Flow ────────────────────────────────────

  private async execute(): Promise<CalibrationResult | null> {
    const ctl = new AbortController();
    this.runCtl = ctl;
    const signal = ctl.signal;
    try {
      this.beginRun();
      // Tells Dewey (and anyone listening) that this is an accuracy check, not a calibration; the
      // same rule as flow(). A check that turns into a calibration then emits 'point' / 'training'.
      this.emit({ phase: 'start', ...(this.opts.mode === 'check' && this.opts.baseModel ? { message: 'check' } : {}) });
      const outcome = await this.flow(signal);
      this.endRun();
      this.emit({ phase: 'done', report: outcome.report });
      return outcome.result;
    } catch (err) {
      this.endRun();
      if (signal.aborted) {
        this.emit({ phase: 'cancelled' });
      } else {
        console.error('[calibration] unexpected error', err);
        this.emit({ phase: 'failed', message: errorMessage(err) });
      }
      return null;
    } finally {
      if (this.runCtl === ctl) this.runCtl = null;
    }
  }

  private async flow(signal: AbortSignal): Promise<FlowOutcome> {
    const current = this.opts.baseModel ?? null;
    const base = asRidgeGazeModel(current);
    const requested = this.opts.mode ?? 'standard';
    let mode: CalibrationMode = requested === 'quick' && base ? 'quick' : requested === 'check' && current ? 'check' : 'standard';
    for (;;) {
      this.runMode = mode;
      await this.positioning(signal, mode);
      // The saved model can't read today's features: only a full calibration helps.
      if (mode !== 'standard' && base && this.lastFeatureLength !== null && this.lastFeatureLength !== base.featureLength) {
        mode = 'standard';
        this.runMode = mode;
      }

      this.resetLightSamples();
      const plan = mode === 'standard' ? shuffle(STANDARD_TARGETS, this.random) : [...(mode === 'check' ? CHECK_TARGETS : QUICK_TARGETS)];
      const collected = await this.collectTargets(plan, mode === 'check' ? 'validating' : 'point', signal);
      if (collected.succeeded < (mode === 'standard' ? MIN_TARGETS_STANDARD : MIN_TARGETS_QUICK)) {
        await this.failure(FAIL_TOO_FEW, signal);
        continue;
      }
      // Skin-tone-independent summary of the light while the dots were shown (null when unmeasured).
      const lighting = buildLightingSignature(this.lightSamples);

      if (mode === 'check' && current) {
        const outcome = await this.accuracyCheck(current, base, collected.samples, lighting, signal);
        if (outcome) return outcome;
        mode = 'standard'; // "Full calibration" (chosen, or the only way forward)
        continue;
      }

      // A refresh starts by measuring how far off the model in use was on these same dots.
      const before = mode === 'quick' && current ? this.measure(current, collected.samples) : null;

      this.setPhase('training');
      this.emit({ phase: 'training' });
      const startedAt = performance.now();
      await this.sleep(60, signal); // let the "learning" screen paint before the synchronous fit
      const viewport = this.measureViewport();
      const maxBlink = SAMPLE_MAX_BLINK;
      const environment = { lighting };
      let trained: { model: GazeModel; report: CalibrationReport };
      try {
        trained =
          mode === 'quick' && base
            ? refineGazeModel(alignCore(current, base, collected.samples), collected.samples, { viewport, maxBlink, environment })
            : trainGazeModel(collected.samples, { viewport, maxBlink, featureNames: this.opts.featureNames, environment });
      } catch (err) {
        if (mode === 'quick') {
          // The saved model can't explain today's eyes; retrying the refresh would fail the same way.
          mode = 'standard';
          await this.failure(FAIL_QUICK, signal, 'Full calibration');
        } else {
          await this.failure(trainingFailureMessage(err), signal);
        }
        continue;
      }
      await this.sleep(this.timing.minTrainingMs - (performance.now() - startedAt), signal);

      let report = trained.report;
      if (mode === 'standard') {
        const val = await this.collectTargets(shuffle(VALIDATION_TARGETS, this.random), 'validating', signal);
        if (val.succeeded >= MIN_VALIDATION_TARGETS) {
          const checked = evaluateModel(trained.model, val.samples, { maxBlink });
          if (checked.sampleCount > 0) report = checked;
        }
      }
      // Grade at the reader's own text size, so the badge agrees with the "≈ N lines" stat.
      const pitch = this.linePitch();
      const vh = modelHeight(trained.model) || this.measureViewport().height;
      report = { ...report, quality: qualityFromError(report.meanErrorPx, vh, pitch) };

      const check: AccuracyCheckResult | null =
        before && before.targets > 0
          ? {
              mode: 'quick',
              before,
              after: offsetOfReport(trained.report, pitch, this.measureViewport().width), // leave-one-dot-out
              applied: false,
              lighting,
              lightingChange: this.lightingChange(current, base, lighting),
            }
          : null;
      if (check) this.lastCheck = check;
      const decided = await this.decide({ mode, model: trained.model, report, check, canCorrect: false, suggestFull: false }, signal);
      if (decided.choice === 'use') {
        return { result: { model: trained.model, report, ...(decided.check ? { check: decided.check } : {}) }, report };
      }
      if (decided.choice === 'full') mode = 'standard';
    }
  }

  /**
   * The accuracy check: measures `current` on the dots, fits (but doesn't apply) the correction,
   * and lets the reader choose. Null means "go to a full calibration".
   */
  private async accuracyCheck(
    current: GazeModel,
    base: RidgeGazeModel | null,
    samples: CalibrationSample[],
    lighting: LightingSignature | null,
    signal: AbortSignal,
  ): Promise<FlowOutcome | null> {
    const maxBlink = SAMPLE_MAX_BLINK;
    const pitch = this.linePitch();
    const viewport = this.measureViewport();
    const measured = evaluateModel(current, samples, { maxBlink });
    const before = offsetOfReport(measured, pitch, viewport.width);
    if (before.targets < MIN_TARGETS_QUICK) {
      // The model predicts nothing for these eyes (e.g. built for other features).
      await this.failure(FAIL_CHECK, signal, 'Full calibration');
      return null;
    }
    const report: CalibrationReport = {
      ...measured,
      quality: qualityFromError(measured.meanErrorPx, modelHeight(current) || viewport.height, pitch),
    };
    // Fitted now so the screen can say what it would leave; applied only on "Correct it".
    let corrected: { model: RidgeGazeModel; report: CalibrationReport } | null = null;
    if (base) {
      try {
        const r = refineGazeModel(alignCore(current, base, samples), samples, { viewport, maxBlink, environment: { lighting } });
        const vh = modelHeight(r.model) || viewport.height;
        corrected = { model: r.model, report: { ...r.report, quality: qualityFromError(r.report.meanErrorPx, vh, pitch) } };
      } catch {
        corrected = null;
      }
    }
    const after = corrected ? offsetOfReport(corrected.report, pitch, viewport.width) : null;
    const check: AccuracyCheckResult = {
      mode: 'check',
      before,
      after,
      applied: false,
      lighting,
      lightingChange: this.lightingChange(current, base, lighting),
    };
    this.lastCheck = check;
    const view: ResultsView = {
      mode: 'check',
      model: current,
      report,
      check,
      canCorrect: corrected !== null,
      // The correction is an offset plus a heavily shrunk scale: it removes only about a third of
      // a scale error. When a dot would still be a line off afterwards (leave-one-dot-out), a full
      // calibration is the better fix.
      suggestFull: corrected === null || corrected.report.quality === 'poor' || (after?.maxDotYLines ?? 0) >= DOT_OFF_LINES,
    };
    const decided = await this.decide(view, signal);
    if (decided.choice === 'use' && corrected) {
      return { result: { model: corrected.model, report: corrected.report, check: decided.check ?? check }, report: corrected.report };
    }
    if (decided.choice === 'full') return null;
    return { result: null, report };
  }

  /** Shows the results and waits for the reader; settles (and announces) the measurement either way. */
  private async decide(view: ResultsView, signal: AbortSignal): Promise<{ choice: Choice; check: AccuracyCheckResult | null }> {
    let choice: Choice;
    try {
      choice = await this.results(view, signal);
    } catch (err) {
      if (view.check) this.settleCheck(view.check, false);
      throw err;
    }
    const applied = choice === 'use' && (view.mode !== 'check' || view.canCorrect);
    return { choice, check: view.check ? this.settleCheck(view.check, applied) : null };
  }

  /** Records the reader's decision on a measurement and emits 'accuracy-check' (the old model's offset). */
  private settleCheck(check: AccuracyCheckResult, applied: boolean): AccuracyCheckResult {
    const settled: AccuracyCheckResult = { ...check, applied };
    this.lastCheck = settled;
    const b = check.before;
    this.opts.bus.emit('accuracy-check', {
      meanErrorPx: b.meanErrorPx,
      offsetXPx: b.offsetXPx,
      offsetYPx: b.offsetYPx,
      offsetYLines: b.offsetYLines,
      ...(b.offsetXFrac !== undefined && Number.isFinite(b.offsetXFrac) ? { offsetXFrac: b.offsetXFrac } : {}),
      ...(b.maxDotYLines !== undefined && Number.isFinite(b.maxDotYLines) ? { maxDotYLines: b.maxDotYLines } : {}),
      applied,
    });
    return settled;
  }

  /**
   * Offset of `model` on these samples, at the reader's line pitch: measureOffset's figures
   * (the same evaluateModel filtering), plus the worst dot.
   */
  private measure(model: GazeModel, samples: readonly CalibrationSample[]): OffsetSummary {
    return offsetOfReport(evaluateModel(model, samples, { maxBlink: SAMPLE_MAX_BLINK }), this.linePitch(), this.measureViewport().width);
  }

  /** Today's light against the calibration's (the ridge core carries it even when a wrapper doesn't). */
  private lightingChange(current: GazeModel | null, base: RidgeGazeModel | null, lighting: LightingSignature | null): LightingChange | null {
    if (!lighting) return null;
    const ref = parseLightingSignature(base?.environment?.lighting ?? current?.environment?.lighting ?? null);
    return ref ? describeLightingChange(ref, lighting) : null;
  }

  private positioning(signal: AbortSignal, mode: CalibrationMode): Promise<void> {
    signal.throwIfAborted();
    const now = performance.now();
    this.pos = {
      enteredAt: now,
      lastFrameAt: null,
      noFaceSince: null,
      metrics: null,
      checks: { face: false, distance: false, center: false, light: false },
      candidate: 'waiting',
      candidateSince: now,
      shown: 'waiting',
      goodSince: null,
      canStart: false,
      ready: false,
    };
    const dom = this.dom;
    if (dom) dom.next.textContent = NEXT_COPY[mode];
    this.setPhase('positioning');
    this.emit({ phase: 'positioning' });
    this.attachPreview();
    this.renderPositioning();

    this.positionTicker = this.every(200, () => this.evaluatePositioning(performance.now()));

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.onStart = null;
        this.clearEvery(this.positionTicker);
        this.positionTicker = null;
        this.detachPreview();
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.onStart = () => {
        cleanup();
        resolve();
      };
    });
  }

  private async collectTargets(
    fractions: readonly Point[],
    kind: TargetKind,
    signal: AbortSignal,
  ): Promise<{ samples: CalibrationSample[]; succeeded: number }> {
    this.setPhase(kind === 'point' ? 'targets' : 'validating');
    this.lastValidAt = performance.now();
    this.validSince = null;
    this.paused = null;
    this.startWatchdog();
    const samples: CalibrationSample[] = [];
    let succeeded = 0;
    const total = fractions.length;
    try {
      for (let index = 0; index < total; index++) {
        let attempts = 0;
        let announce = true;
        let appear = index === 0;
        for (;;) {
          await this.untilResumed(signal);
          this.progress = { kind, index, total };
          if (announce) {
            this.emit({ phase: kind, index, total, ...(attempts > 0 ? { message: 'retry' } : {}) });
            announce = false;
          }
          const got = await this.presentTarget(fractions[index], appear, signal);
          appear = false;
          if (got === null) continue; // interrupted: show the same target again, no attempt used
          attempts++;
          if (got.length >= this.timing.minSamples) {
            for (const s of got) samples.push(s);
            succeeded++;
            break;
          }
          if (attempts >= this.timing.maxAttempts) break;
          announce = true;
          this.showToast('Once more — keep your eyes on the dot.');
        }
      }
    } finally {
      this.stopWatchdog();
      this.collector = null;
      this.progress = null;
    }
    return { samples, succeeded };
  }

  /** One showing of one target. Null when interrupted (pause, resize). */
  private async presentTarget(frac: Point, appear: boolean, signal: AbortSignal): Promise<CalibrationSample[] | null> {
    signal.throwIfAborted();
    const step = new AbortController();
    const forward = (): void => step.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    this.stepCtl = step;
    try {
      const target = targetPoint(frac, this.measureViewport());
      this.placeTarget(target, appear);
      this.renderHud();
      await this.sleep(appear ? this.timing.appearMs : this.timing.glideMs, step.signal);

      this.startShrink();
      const t0 = performance.now();
      const collector: Collector = {
        target,
        from: t0 + this.timing.settleMs,
        until: t0 + this.timing.targetMs,
        samples: [],
      };
      this.collector = collector;
      await this.sleep(this.timing.targetMs, step.signal);
      this.collector = null;

      this.completeTarget();
      try {
        await this.sleep(this.timing.popMs, step.signal);
      } catch (err) {
        if (signal.aborted) throw err; // the samples are in; a pause during the pop is harmless
      }
      return collector.samples;
    } catch (err) {
      this.collector = null;
      if (signal.aborted) throw err;
      this.resetTarget();
      return null;
    } finally {
      signal.removeEventListener('abort', forward);
      if (this.stepCtl === step) this.stepCtl = null;
    }
  }

  private results(view: ResultsView, signal: AbortSignal): Promise<Choice> {
    signal.throwIfAborted();
    const primary = this.renderResults(view);
    this.setPhase('results');
    this.liveModel = view.model;
    this.liveFilter.reset();
    this.liveLastValid = -Infinity;
    this.liveViewport = this.measureViewport();
    if (primary) this.focusButton(primary);
    return new Promise<Choice>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.onChoice = null;
        this.liveModel = null;
        this.dom?.live.classList.remove('is-on');
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.onChoice = (c) => {
        cleanup();
        resolve(c);
      };
    });
  }

  private failure(message: string, signal: AbortSignal, retryLabel = 'Try again'): Promise<void> {
    signal.throwIfAborted();
    const dom = this.dom;
    if (dom) {
      dom.failTitle.textContent = this.runMode === 'check' ? 'The accuracy check didn’t work' : 'Calibration didn’t work';
      dom.failText.textContent = message;
      dom.retry.textContent = retryLabel;
    }
    this.setPhase('failed');
    this.emit({ phase: 'failed', message });
    if (dom) this.focusButton(dom.retry);
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.onRetry = null;
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.onRetry = () => {
        signal.removeEventListener('abort', onAbort);
        this.onRetry = null;
        resolve();
      };
    });
  }

  // ─────────────────────────────── Lifecycle ─────────────────────────────────

  private beginRun(): void {
    const root = this.root;
    if (!root) return;
    // A closed shadow root (the extension) hides its focus from the document; ask it directly.
    const node = root.getRootNode();
    const inOwnTree = node instanceof ShadowRoot ? node.activeElement : null;
    this.returnFocus = inOwnTree ?? deepActiveElement(root.ownerDocument);
    this.resolveTone();
    root.hidden = false;
    this.blinkGate.reset();
    this.lightMonitor.reset();
    this.lightingAt = -Infinity;
    this.resetLightSamples();
    this.lastCheck = null;
    this.unsubscribeFrames = this.opts.features.onFrame(this.handleFrame);
    const win = root.ownerDocument.defaultView;
    if (win && !this.listening) {
      win.addEventListener('keydown', this.handleKeydown, true);
      win.addEventListener('resize', this.handleResize);
      this.listening = true;
    }
    root.focus({ preventScroll: true });
  }

  /** Idempotent: safe from destroy() and from the run's own unwinding. */
  private endRun(): void {
    this.stepCtl?.abort(INTERRUPT);
    this.stepCtl = null;
    this.unsubscribeFrames?.();
    this.unsubscribeFrames = null;
    const win = this.root?.ownerDocument.defaultView ?? (typeof window === 'undefined' ? null : window);
    if (this.listening && win) {
      win.removeEventListener('keydown', this.handleKeydown, true);
      win.removeEventListener('resize', this.handleResize);
    }
    this.listening = false;
    for (const id of this.intervals) clearInterval(id);
    this.intervals.clear();
    this.positionTicker = null;
    this.watchdog = null;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.detachPreview();
    this.onStart = null;
    this.onChoice = null;
    this.onRetry = null;
    this.collector = null;
    this.paused = null;
    this.resumeWaiters = [];
    this.liveModel = null;
    this.pos = null;
    if (this.phase !== 'idle') this.setPhase('idle');
    if (this.root) this.root.hidden = true;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back && back.isConnected && typeof (back as HTMLElement).focus === 'function') {
      try {
        (back as HTMLElement).focus({ preventScroll: true });
      } catch {
        /* element refused focus */
      }
    }
  }

  // ──────────────────────────────── Events ───────────────────────────────────

  private readonly handleFrame = (frame: FeatureFrame): void => {
    if (!frame) return;
    const now = performance.now();
    // Every frame goes through the blink gate, whatever the phase, so blink episodes are timed right.
    const usable = this.usableFeatures(frame, now);
    if (frame.lighting !== undefined) this.noteLighting(frame, now);
    switch (this.phase) {
      case 'positioning':
        this.updatePositioning(frame, now);
        break;
      case 'targets':
      case 'validating':
        this.collectFrame(usable, now);
        break;
      case 'results':
        this.updateLive(usable, now);
        break;
      default:
        break;
    }
  };

  private readonly handleKeydown = (e: KeyboardEvent): void => {
    const root = this.root;
    if (!root || root.hidden || this.phase === 'idle') return;
    // The overlay is modal: shortcuts of the page behind (Space = next page…) must not fire.
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      this.cancel();
      return;
    }
    if (e.key === 'Tab') {
      this.trapFocus(e);
      return;
    }
    const focused = this.activeInside();
    const onButton = focused instanceof HTMLButtonElement;
    const space = e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
    // Space and Enter on a focused button activate that button (the browser's default).
    if (onButton && (space || e.key === 'Enter')) return;
    if (space && (this.phase === 'targets' || this.phase === 'validating')) {
      e.preventDefault();
      if (e.repeat) return;
      if (this.paused) this.resume();
      else this.pause('user');
      return;
    }
    if (e.key === 'Enter' && this.phase === 'positioning') {
      e.preventDefault();
      this.tryStart();
      return;
    }
    // Arrow/Page/Home/End/Space would scroll the page behind — unless focus sits in a card that can scroll itself.
    if ((space || SCROLL_KEYS.has(e.key)) && !isScrollable(focused?.closest<HTMLElement>(`.${P}-center`))) {
      e.preventDefault();
    }
  };

  private readonly handleResize = (): void => {
    if (this.phase === 'results') this.liveViewport = this.measureViewport();
    // Targets are placed in viewport fractions: restart the current one at its new spot.
    if ((this.phase === 'targets' || this.phase === 'validating') && !this.paused) this.stepCtl?.abort(INTERRUPT);
  };

  private readonly handleClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-action]') : null;
    const action = target?.dataset.action;
    if (!action || (target instanceof HTMLButtonElement && target.disabled)) return;
    switch (action) {
      case 'start':
        this.tryStart();
        break;
      case 'cancel':
        this.cancel();
        break;
      case 'continue':
        this.resume();
        break;
      case 'use':
        this.onChoice?.('use');
        break;
      case 'done':
        this.onChoice?.('done');
        break;
      case 'redo':
        this.onChoice?.(this.dom?.redo.dataset.choice === 'full' ? 'full' : 'redo');
        break;
      case 'retry':
        this.onRetry?.();
        break;
      default:
        break;
    }
  };

  /** Without a keyboard (tablets) a tap is the only way to reach Pause/Cancel mid-run. */
  private readonly handleStagePointer = (e: PointerEvent): void => {
    if (e.isPrimary === false || e.button > 0) return;
    if ((this.phase === 'targets' || this.phase === 'validating') && !this.paused) this.pause('user');
  };

  /** Keeps wheel/touch from scrolling the page behind; an overflowing card may still scroll itself. */
  private readonly blockScroll = (e: Event): void => {
    const panel = e.target instanceof Element ? e.target.closest<HTMLElement>(`.${P}-center`) : null;
    if (isScrollable(panel)) return; // overscroll-behavior stops chaining
    if (e.cancelable) e.preventDefault();
  };

  private emit(payload: CalibrationEvent): void {
    this.opts.bus.emit('calibration', payload);
  }

  // ────────────────────────────── Positioning ────────────────────────────────

  private updatePositioning(frame: FeatureFrame, now: number): void {
    const s = this.pos;
    if (!s) return;
    s.lastFrameAt = now;
    const f = frame.faceFound ? frame.features : null;
    if (f) {
      if (Array.isArray(f.vector)) this.lastFeatureLength = f.vector.length;
      const raw = {
        faceScale: f.faceScale,
        faceCenter: { x: f.faceCenter?.x, y: f.faceCenter?.y },
        yaw: f.headPose?.yaw,
        pitch: f.headPose?.pitch,
        quality: frame.quality,
      };
      if ([raw.faceScale, raw.faceCenter.x, raw.faceCenter.y, raw.yaw, raw.pitch, raw.quality].every(Number.isFinite)) {
        s.noFaceSince = null;
        const a = 0.35; // EMA: calm coaching text without feeling laggy
        const m = s.metrics;
        s.metrics = m
          ? {
              faceScale: m.faceScale + a * (raw.faceScale - m.faceScale),
              faceCenter: {
                x: m.faceCenter.x + a * (raw.faceCenter.x - m.faceCenter.x),
                y: m.faceCenter.y + a * (raw.faceCenter.y - m.faceCenter.y),
              },
              yaw: m.yaw + a * (raw.yaw - m.yaw),
              pitch: m.pitch + a * (raw.pitch - m.pitch),
              quality: m.quality + a * (raw.quality - m.quality),
            }
          : { ...raw, faceCenter: { x: raw.faceCenter.x, y: raw.faceCenter.y } };
      } else {
        s.noFaceSince ??= now;
      }
    } else {
      s.noFaceSince ??= now;
    }
    this.evaluatePositioning(now);
  }

  private evaluatePositioning(now: number): void {
    const s = this.pos;
    if (!s) return;
    if (s.noFaceSince !== null && now - s.noFaceSince > 400) s.metrics = null;

    let raw: Coach;
    if (s.lastFrameAt === null || now - s.lastFrameAt > 1500) {
      raw = now - s.enteredAt > 5000 ? 'no-camera' : 'waiting';
      s.checks = { face: false, distance: false, center: false, light: false };
    } else if (!s.metrics) {
      raw = 'no-face';
      s.checks = { face: false, distance: false, center: false, light: false };
    } else {
      const a = assessPosition({ ...s.metrics, faceFound: true, lighting: this.currentLightingFlags(now) });
      raw = a.issue ?? a.tip ?? 'ready';
      s.checks = a.checks;
    }

    if (raw !== s.candidate) {
      s.candidate = raw;
      s.candidateSince = now;
    }
    // Hysteresis: advice only changes once the new situation has held for a moment.
    if (s.shown === 'waiting' || raw === 'waiting' || now - s.candidateSince >= 300) s.shown = raw;

    // A tip is advice, not a problem: it doesn't hold up the start.
    s.goodSince = raw === 'ready' || isTip(raw) ? (s.goodSince ?? now) : null;
    s.ready = s.goodSince !== null && now - s.goodSince >= this.timing.readyHoldMs;
    const faceVisible = s.shown !== 'waiting' && s.shown !== 'no-camera' && s.shown !== 'no-face';
    s.canStart = s.ready || (faceVisible && now - s.enteredAt >= this.timing.startAnywayMs);
    this.renderPositioning();
  }

  private tryStart(): void {
    if (this.phase === 'positioning' && this.pos?.canStart) this.onStart?.();
  }

  private renderPositioning(): void {
    const s = this.pos;
    const dom = this.dom;
    if (!s || !dom) return;
    const shown = s.shown;
    const good = shown === 'ready' || isTip(shown);
    const text = good && !s.ready ? 'Great — hold that for a moment…' : isTip(shown) ? TIP_COPY[shown] : COACH[shown];
    if (dom.statusText.textContent !== text) dom.statusText.textContent = text;
    dom.status.dataset.state = s.ready ? 'good' : shown === 'waiting' || shown === 'no-camera' ? 'wait' : 'fix';
    dom.preview.dataset.state = s.ready ? 'good' : 'bad';

    const waiting = shown === 'waiting' || shown === 'no-camera';
    for (const key of Object.keys(dom.checks) as (keyof PositionAssessment['checks'])[]) {
      const state: CheckState = waiting
        ? 'pending'
        : s.checks[key]
          ? key === 'light' && isTip(shown)
            ? 'tip'
            : 'ok'
          : key !== 'face' && !s.checks.face
            ? 'pending'
            : 'bad';
      const li = dom.checks[key];
      if (li.dataset.state !== state) {
        li.dataset.state = state;
        const icon = li.querySelector(`.${P}-check-icon`);
        if (icon) icon.textContent = state === 'ok' ? '✓' : state === 'bad' ? '!' : state === 'tip' ? 'i' : '';
        const spoken = li.querySelector(`.${P}-check-state`);
        if (spoken) spoken.textContent = `: ${CHECK_STATE_TEXT[state]}`;
      }
    }

    const label = s.ready || !s.canStart ? 'Start' : 'Start anyway';
    if (dom.start.textContent !== label) dom.start.textContent = label;
    const wasDisabled = dom.start.disabled;
    dom.start.disabled = !s.canStart;
    if (wasDisabled && s.canStart && this.focusIsOnRoot()) this.focusButton(dom.start);

    if (!this.previewActive && s.metrics) {
      // No video (e.g. inside the extension): draw where the face is instead.
      const w = Math.min(Math.max(s.metrics.faceScale * 2.4, 0.08), 0.9);
      dom.face.style.width = `${w * 100}%`;
      dom.face.style.height = `${w * 100 * 1.3 * (4 / 3)}%`;
      dom.face.style.left = `${(1 - s.metrics.faceCenter.x) * 100}%`;
      dom.face.style.top = `${s.metrics.faceCenter.y * 100}%`;
      dom.face.dataset.visible = 'true';
    } else if (!this.previewActive) {
      dom.face.dataset.visible = 'false';
    }
  }

  private attachPreview(): void {
    const dom = this.dom;
    if (!dom) return;
    const source = this.opts.video;
    const stream = source && 'srcObject' in source ? source.srcObject : null;
    if (stream) {
      // Our own element on the same stream: moving the camera's element would pause it.
      dom.video.srcObject = stream;
      dom.video.hidden = false;
      dom.face.hidden = true;
      dom.preview.dataset.video = 'on';
      this.previewActive = true;
      try {
        const played = dom.video.play() as Promise<void> | undefined;
        if (played && typeof played.catch === 'function') played.catch(() => undefined);
      } catch {
        /* autoplay refused; the checklist still works */
      }
    } else {
      dom.video.hidden = true;
      dom.face.hidden = false;
      dom.preview.dataset.video = 'off';
      this.previewActive = false;
    }
  }

  private detachPreview(): void {
    if (!this.previewActive) return;
    this.previewActive = false;
    const v = this.dom?.video;
    if (!v) return;
    try {
      v.pause();
    } catch {
      /* ignore */
    }
    v.srcObject = null;
  }

  // ──────────────────────────────── Lighting ─────────────────────────────────

  /**
   * Takes a frame's lighting measurement: into the coaching monitor (every phase, so the advice
   * is continuous across a retry) and, while this pass's dots are shown, into the samples the
   * calibration's LightingSignature is built from. The camera side attaches it to ~6 frames a
   * second, skipping blinks and junk frames; in the extension it crosses the port as numbers.
   */
  private noteLighting(frame: FeatureFrame, now: number): void {
    const stats = frame.lighting;
    if (!isFiniteStats(stats)) return; // a NaN would poison the monitor's averages
    this.lightMonitor.update(now, stats);
    this.lightingAt = now;
    if ((this.phase !== 'targets' && this.phase !== 'validating') || this.paused) return;
    const pose = frame.faceFound ? frame.features?.headPose : null;
    if (!pose || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) return;
    if (now - this.lightSampleAt < this.lightSampleGapMs) return;
    this.lightSampleAt = now;
    this.lightSamples.push({ stats: { ...stats }, yaw: pose.yaw, pitch: pose.pitch });
    if (this.lightSamples.length >= MAX_LIGHT_SAMPLES) {
      // A very long run: keep an even spread over all of it rather than only its start or end.
      this.lightSamples = this.lightSamples.filter((_, i) => i % 2 === 0);
      this.lightSampleGapMs *= 2;
    }
  }

  private resetLightSamples(): void {
    this.lightSamples = [];
    this.lightSampleAt = -Infinity;
    this.lightSampleGapMs = LIGHT_SAMPLE_GAP_MS;
  }

  /** The monitor's flags, or null when the light isn't being measured (none recently). */
  private currentLightingFlags(now: number): readonly LightingFlag[] | null {
    return now - this.lightingAt <= LIGHTING_STALE_MS ? this.lightMonitor.flags : null;
  }

  // ──────────────────────────────── Targets ──────────────────────────────────

  /**
   * Features usable as a calibration sample, or null (no face, blink, junk frame,
   * non-finite vector). Call exactly once per frame: it advances the blink gate.
   */
  private usableFeatures(frame: FeatureFrame, now: number): EyeFeatures | null {
    const f = frame.faceFound ? frame.features : null;
    if (!f) {
      this.blinkGate.reset();
      return null;
    }
    if (this.blinkGate.update(now, f.blink, f.openness)) return null;
    const loweredLids = f.blink > DEFAULT_BLINK_GATE.threshold; // it passed the gate, so not a blink
    if (frame.quality < MIN_FRAME_QUALITY && !loweredLids) return null;
    if (!Array.isArray(f.vector) || f.vector.length === 0) return null;
    for (const v of f.vector) if (!Number.isFinite(v)) return null;
    return f;
  }

  private collectFrame(f: EyeFeatures | null, now: number): void {
    if (f) {
      this.lastFeatureLength = f.vector.length;
      this.lastValidAt = now;
      if (this.paused === 'face') {
        this.validSince ??= now;
        if (now - this.validSince >= this.timing.faceBackMs) this.resume();
      }
    } else {
      this.validSince = null;
    }
    const c = this.collector;
    if (!c || this.paused || !f || now < c.from || now > c.until) return;
    c.samples.push({ target: { x: c.target.x, y: c.target.y }, features: cloneFeatures(f), t: now });
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = this.every(250, () => {
      if (this.paused || (this.phase !== 'targets' && this.phase !== 'validating')) return;
      if (performance.now() - this.lastValidAt > this.timing.faceLostMs) this.pause('face');
    });
  }

  private stopWatchdog(): void {
    this.clearEvery(this.watchdog);
    this.watchdog = null;
  }

  private pause(reason: PauseReason): void {
    if (this.phase !== 'targets' && this.phase !== 'validating') return;
    if (this.paused) {
      // A deliberate pause outranks an automatic one: it must not auto-resume.
      if (reason === 'user' && this.paused === 'face') {
        this.paused = 'user';
        this.renderPause();
      }
      return;
    }
    this.paused = reason;
    this.validSince = null;
    this.stepCtl?.abort(INTERRUPT);
    this.renderPause();
    const p = this.progress;
    if (p) this.emit({ phase: p.kind, index: p.index, total: p.total, message: reason === 'face' ? 'face-lost' : 'paused' });
    this.announce(reason === 'face' ? 'Paused: I lost sight of your eyes.' : 'Paused.');
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = null;
    this.lastValidAt = performance.now();
    this.validSince = null;
    this.renderPause();
    const p = this.progress;
    if (p) this.emit({ phase: p.kind, index: p.index, total: p.total, message: 'resumed' });
    this.announce('Resumed.');
    for (const wake of this.resumeWaiters.splice(0)) wake();
    this.root?.focus({ preventScroll: true });
  }

  private untilResumed(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      this.resumeWaiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  private placeTarget(p: Point, appear: boolean): void {
    const el = this.dom?.target;
    if (!el) return;
    el.classList.remove('is-shrinking', 'is-done');
    el.classList.toggle('is-instant', appear);
    el.style.setProperty('--x', `${p.x}px`);
    el.style.setProperty('--y', `${p.y}px`);
    el.style.setProperty('--dur', `${this.timing.targetMs}ms`);
    el.style.setProperty('--glide', `${this.timing.glideMs}ms`);
    el.style.setProperty('--pop', `${this.timing.popMs}ms`);
    el.dataset.x = String(p.x);
    el.dataset.y = String(p.y);
    if (appear) {
      el.classList.remove('is-visible');
      void el.offsetWidth; // commit the instant jump before fading in
      el.classList.remove('is-instant');
    }
    el.classList.add('is-visible');
    this.root?.setAttribute('data-hud', p.y < this.measureViewport().height / 2 ? 'bottom' : 'top');
  }

  private startShrink(): void {
    const el = this.dom?.target;
    if (!el) return;
    el.classList.remove('is-shrinking');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('is-shrinking');
  }

  private completeTarget(): void {
    const el = this.dom?.target;
    if (!el) return;
    el.classList.remove('is-shrinking');
    el.classList.add('is-done');
  }

  private resetTarget(): void {
    this.dom?.target.classList.remove('is-shrinking', 'is-done');
  }

  private renderHud(): void {
    const dom = this.dom;
    const p = this.progress;
    if (!dom || !p) return;
    dom.hudLabel.textContent = p.kind === 'point' ? 'Calibrating' : this.runMode === 'check' ? 'Accuracy check' : 'Checking accuracy';
    dom.hudCount.textContent = `${p.index + 1} / ${p.total}`;
    dom.hudBar.style.setProperty('--p', String(p.index / p.total));
  }

  private renderPause(): void {
    const dom = this.dom;
    const root = this.root;
    if (!dom || !root) return;
    dom.pause.hidden = !this.paused;
    if (this.paused) root.setAttribute('data-paused', this.paused);
    else root.removeAttribute('data-paused');
    if (this.paused === 'face') {
      dom.pauseTitle.textContent = 'I lost sight of your eyes';
      dom.pauseText.textContent = 'Look back at the screen — we’ll pick up right where we left off.';
    } else if (this.paused === 'user') {
      dom.pauseTitle.textContent = 'Paused';
      dom.pauseText.textContent = 'Take your time — continue whenever you’re ready.';
    }
  }

  private showToast(text: string): void {
    const dom = this.dom;
    if (!dom) return;
    dom.toast.textContent = text;
    dom.toast.classList.add('is-on');
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.dom?.toast.classList.remove('is-on');
    }, 1800);
  }

  // ──────────────────────────────── Results ──────────────────────────────────

  /** Fills the results card for this view; returns the button that should get focus. */
  private renderResults(view: ResultsView): HTMLButtonElement | null {
    const dom = this.dom;
    if (!dom) return null;
    const { report, check } = view;
    const pitch = this.linePitch();
    const width = this.measureViewport().width;
    const verdictOf = (o: OffsetSummary) => offsetVerdict(o.offsetYLines, o.offsetXFrac ?? o.offsetXPx / width, o.maxDotYLines ?? Number.NaN);
    const words = (o: OffsetSummary): OffsetWords => verdictOf(o).words;
    const errorPx = Number.isFinite(report.meanErrorPx) ? `±${Math.round(report.meanErrorPx)}` : '—';
    const setButton = (b: HTMLButtonElement, label: string, visible: boolean, primary: boolean): void => {
      b.textContent = label;
      b.hidden = !visible;
      b.classList.toggle(`${P}-btn-primary`, primary);
      // The suggested action sits last, as everywhere else in the overlay; moving the element
      // (not CSS order) keeps the Tab order the same as the visual order.
      if (primary) b.parentElement?.append(b);
    };
    const notes: string[] = [];
    const light = check?.lightingChange;
    if (light?.changed && light.text) notes.push(`The light has changed since you calibrated: ${light.text}.`);
    this.drawMap(view.model, report);
    dom.statPx.textContent = errorPx;
    dom.statPxLabel.textContent = 'average error';

    if (view.mode === 'check' && check) {
      const b = check.before;
      // One verdict for this screen and the toast after "Done" (src/app/offsetWords.ts).
      const { words: w, badge, quality: tone } = verdictOf(b);
      const needs = w.worthCorrecting;
      dom.badge.textContent = badge;
      dom.badge.dataset.quality = tone;
      dom.resultTitle.textContent = w.onTarget ? 'Right on target' : `Tracking reads ${w.text}`;
      const lines = b.offsetYLines;
      dom.statLines.textContent = Number.isFinite(lines) ? Math.abs(lines).toFixed(1) : '—';
      dom.statLinesUnit.textContent = lines >= 0.05 ? 'lines low' : lines <= -0.05 ? 'lines high' : 'lines';
      dom.statLinesLabel.textContent = 'vertical offset at your text size';
      const after = check.after && Number.isFinite(check.after.offsetYLines) ? check.after : null;
      // The correction (leave-one-dot-out) would still leave a dot a line off: a full calibration
      // is the suggestion then, and "Correct it" isn't promised to fix it.
      const afterStillOff = (after?.maxDotYLines ?? 0) >= DOT_OFF_LINES;
      const fullFirst = needs && view.suggestFull && (!view.canCorrect || afterStillOff);
      const correct = needs && view.canCorrect && !fullFirst;
      if (needs && view.canCorrect && after) {
        const a = words(after);
        notes.push(`“Correct it” should bring it to ${a.vertical || a.horizontal ? a.text : withinWords(after.maxDotYLines)}.`);
      }
      const spreadOnly = w.spread && w.vertical === null && w.horizontal === null;
      let advice: string;
      if (w.onTarget) advice = 'Your calibration still fits — nothing needs changing.';
      else if (!needs) advice = 'That’s close enough — nothing needs changing, but you can correct it if you like.';
      else if (!view.canCorrect) advice = 'This calibration can’t be corrected in place — a full calibration will set it right.';
      else {
        advice = spreadOnly
          ? 'Tracking is off in opposite directions near the top and bottom of the screen, often from sitting nearer or further away than when you calibrated.'
          : 'Changes in light or posture can shift tracking. “Correct it” re-centers it from the dots you just looked at — no extra steps.';
        if (fullFirst) advice += ' A quick correction can’t take all of it out: a full calibration will set it right.';
        else if (view.suggestFull) advice += ' For the best accuracy, a full calibration will do better than a quick correction.';
      }
      dom.advice.textContent = advice;
      dom.tryit.textContent = 'The soft dot shows where I currently think you’re looking — glance around to see for yourself.';
      setButton(dom.use, 'Correct it', view.canCorrect, correct);
      setButton(dom.done, 'Done', true, !correct && !fullFirst);
      setButton(dom.redo, 'Full calibration', view.suggestFull, fullFirst);
      dom.redo.dataset.choice = 'full';
      dom.note.textContent = notes.join(' ');
      this.announce(`${badge}. ${dom.resultTitle.textContent}. ${dom.note.textContent}`.trim());
      return correct ? dom.use : fullFirst ? dom.redo : dom.done;
    }

    const copy = QUALITY_COPY[report.quality];
    dom.badge.textContent = copy.badge;
    dom.badge.dataset.quality = report.quality;
    dom.resultTitle.textContent = copy.title;
    dom.advice.textContent = copy.advice;
    dom.tryit.textContent = 'The soft dot shows where I think you’re looking — glance around to try it.';
    const lines = report.meanErrorYPx / pitch;
    dom.statLines.textContent = Number.isFinite(lines) ? `≈ ${lines.toFixed(1)}` : '—';
    dom.statLinesUnit.textContent = 'lines';
    dom.statLinesLabel.textContent = 'vertical error at your text size';
    if (check) {
      // Quick refresh: how far off the old model was on these dots, and what the refresh leaves.
      const after = check.after && Number.isFinite(check.after.offsetYLines) ? check.after : null;
      const said = (o: OffsetSummary): string => {
        const x = words(o);
        return x.onTarget ? withinWords(o.maxDotYLines) : x.text;
      };
      notes.unshift(`Before this refresh, tracking read ${said(check.before)}.${after ? ` Now: ${said(after)}.` : ''}`);
    }
    dom.note.textContent = notes.join(' ');
    const poor = report.quality === 'poor';
    const fullInstead = view.mode === 'quick' && poor;
    setButton(dom.use, 'Use it', true, true);
    setButton(dom.done, 'Done', false, false);
    setButton(dom.redo, fullInstead ? 'Full calibration' : 'Redo', true, false);
    dom.redo.dataset.choice = fullInstead ? 'full' : 'redo';
    this.announce(
      `${copy.badge} calibration. Average error ${Number.isFinite(report.meanErrorPx) ? Math.round(report.meanErrorPx) : 'unknown'} pixels. ${dom.note.textContent}`.trim(),
    );
    return poor ? dom.redo : dom.use;
  }

  /** A little map of the check points: where each one was vs where your gaze landed. */
  private drawMap(model: GazeModel, report: CalibrationReport): void {
    const svg = this.dom?.map;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const vp = model.viewport.width > 0 && model.viewport.height > 0 ? model.viewport : this.measureViewport();
    const W = vp.width;
    const H = vp.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const u = Math.max(W, H) / 100;
    const doc = svg.ownerDocument;
    const add = (tag: string, attrs: Record<string, string | number>): void => {
      const el = doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    };
    add('rect', { x: 0, y: 0, width: W, height: H, rx: u * 2, class: `${P}-map-frame` });
    for (const pt of report.perPoint) {
      const px = clamp(pt.meanPrediction.x, 0, W);
      const py = clamp(pt.meanPrediction.y, 0, H);
      add('line', { x1: pt.target.x, y1: pt.target.y, x2: px, y2: py, class: `${P}-map-link`, 'vector-effect': 'non-scaling-stroke' });
      add('circle', { cx: pt.target.x, cy: pt.target.y, r: u * 1.6, class: `${P}-map-target`, 'vector-effect': 'non-scaling-stroke' });
      add('circle', { cx: px, cy: py, r: u * 1.1, class: `${P}-map-gaze` });
    }
    const n = report.perPoint.length;
    svg.setAttribute(
      'aria-label',
      n > 0 ? `Map of ${n} check points: rings show where the dots were, filled dots where your gaze landed.` : 'No check points.',
    );
  }

  private updateLive(f: EyeFeatures | null, now: number): void {
    const dom = this.dom;
    const model = this.liveModel;
    if (!dom || !model) return;
    const p = f ? model.predict(f) : null;
    if (p) {
      const s = this.liveFilter.filter(p.x, p.y, now);
      this.liveLastValid = now;
      const vp = this.liveViewport;
      dom.live.style.transform = `translate3d(${clamp(s.x, 0, vp.width)}px, ${clamp(s.y, 0, vp.height)}px, 0)`;
      dom.live.classList.add('is-on');
    } else if (now - this.liveLastValid > 400) {
      dom.live.classList.remove('is-on');
      this.liveFilter.reset();
    }
  }

  // ──────────────────────────────── Helpers ──────────────────────────────────

  private setPhase(phase: Phase): void {
    this.phase = phase;
    const dom = this.dom;
    const root = this.root;
    if (!dom || !root) return;
    root.dataset.phase = phase;
    const targets = phase === 'targets' || phase === 'validating';
    dom.positioning.hidden = phase !== 'positioning';
    dom.training.hidden = phase !== 'training';
    dom.results.hidden = phase !== 'results';
    dom.failed.hidden = phase !== 'failed';
    dom.stage.hidden = !targets;
    dom.hudWrap.hidden = !targets;
    if (!targets) {
      dom.pause.hidden = true;
      root.removeAttribute('data-paused');
      dom.target.classList.remove('is-visible', 'is-shrinking', 'is-done');
      dom.toast.classList.remove('is-on');
    }
    if (phase !== 'results') dom.live.classList.remove('is-on');
    if (phase === 'targets' || phase === 'validating' || phase === 'training') root.focus({ preventScroll: true });
    const check = this.runMode === 'check';
    const spoken: Partial<Record<Phase, string>> = {
      positioning: check ? 'Accuracy check. Position yourself in front of the camera.' : 'Calibration. Position yourself in front of the camera.',
      targets: 'Look at the center of each dot until it disappears.',
      training: 'Learning how your eyes move.',
      validating: check
        ? 'Look at the center of each dot until it disappears. Nothing changes unless you ask.'
        : 'A few more dots to check accuracy.',
    };
    const text = spoken[phase];
    if (text) this.announce(text);
  }

  private announce(text: string): void {
    const sr = this.dom?.sr;
    if (sr) sr.textContent = text;
  }

  private measureViewport(): { width: number; height: number } {
    const r = this.root?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) return { width: r.width, height: r.height };
    const win = this.root?.ownerDocument.defaultView ?? (typeof window === 'undefined' ? null : window);
    if (win && win.innerWidth > 0 && win.innerHeight > 0) return { width: win.innerWidth, height: win.innerHeight };
    return { width: 1024, height: 768 };
  }

  private linePitch(): number {
    const o = this.opts.linePitchPx;
    let v: number | null | undefined;
    try {
      v = typeof o === 'function' ? o() : o;
    } catch {
      v = null;
    }
    return typeof v === 'number' && Number.isFinite(v) && v >= 8 ? v : DEFAULT_LINE_PITCH_PX;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(id);
        reject(signal.reason);
      };
      const id = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
    const id = setInterval(fn, ms);
    this.intervals.add(id);
    return id;
  }

  private clearEvery(id: ReturnType<typeof setInterval> | null): void {
    if (id === null) return;
    clearInterval(id);
    this.intervals.delete(id);
  }

  /**
   * Focuses one of our buttons without letting the browser scroll the page
   * behind, then scrolls its card (only) if the button is outside it — on a
   * short window the action row can sit below the fold.
   */
  private focusButton(el: HTMLElement): void {
    el.focus({ preventScroll: true });
    const box = el.closest<HTMLElement>(`.${P}-center`);
    if (!box || !isScrollable(box)) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const pad = 16;
    if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - b.bottom + pad;
    else if (r.top < b.top + pad) box.scrollTop -= b.top + pad - r.top;
  }

  /** The focused element if it is inside the overlay (works in open and closed shadow roots). */
  private activeInside(): Element | null {
    const root = this.root;
    if (!root) return null;
    const node = root.getRootNode();
    const active = node instanceof ShadowRoot ? node.activeElement : root.ownerDocument.activeElement;
    return active && root.contains(active) ? active : null;
  }

  private focusIsOnRoot(): boolean {
    const a = this.activeInside();
    return a === null || a === this.root;
  }

  private trapFocus(e: KeyboardEvent): void {
    const root = this.root;
    if (!root) return;
    const focusables = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => !b.disabled && b.closest('[hidden]') === null,
    );
    e.preventDefault();
    if (focusables.length === 0) {
      root.focus({ preventScroll: true });
      return;
    }
    const current = this.activeInside();
    const i = current instanceof HTMLButtonElement ? focusables.indexOf(current) : -1;
    const next =
      i < 0 ? (e.shiftKey ? focusables.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    this.focusButton(focusables[next]);
  }

  /**
   * Picks light/dark fallback colors. With the app's theme tokens present they
   * decide; otherwise (extension on some web page) we adopt the page's own
   * background, so the face is lit by the same screen brightness during
   * calibration as while reading.
   */
  private resolveTone(): void {
    const root = this.root;
    if (!root) return;
    let tone: 'light' | 'dark' = 'light';
    try {
      const win = root.ownerDocument.defaultView;
      if (win) {
        const token = win.getComputedStyle(root).getPropertyValue('--gr-bg').trim();
        let bg = token ? parseColor(token) : null;
        if (!token) {
          root.style.removeProperty('--gr-cal-host-bg');
          const doc = root.ownerDocument;
          for (const el of [doc.body, doc.documentElement]) {
            if (!el) continue;
            const c = parseColor(win.getComputedStyle(el).backgroundColor);
            if (c && c.a > 0.95) {
              bg = c;
              root.style.setProperty('--gr-cal-host-bg', `rgb(${c.r}, ${c.g}, ${c.b})`);
              break;
            }
          }
        }
        if (bg && relativeLuminance(bg) < 0.25) tone = 'dark';
      }
    } catch {
      /* keep the light fallbacks */
    }
    root.dataset.tone = tone;
  }

  // ────────────────────────────────── DOM ────────────────────────────────────

  private build(doc: Document): void {
    const id = (s: string): string => `${P}-${s}-${this.uid}`;
    const el = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      cls?: string,
      attrs?: Record<string, string>,
      ...children: (Node | string)[]
    ): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls.split(' ').map((c) => `${P}-${c}`).join(' ');
      if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      for (const c of children) node.append(c);
      return node;
    };
    const kbd = (key: string): HTMLElement => el('kbd', 'kbd', {}, key);
    const button = (label: string, action: string, primary = false, key?: string): HTMLButtonElement => {
      const b = el('button', primary ? 'btn btn-primary' : 'btn', { type: 'button', 'data-action': action }, label);
      if (key) b.append(' ', kbd(key));
      return b;
    };

    const root = doc.createElement('div');
    root.className = P;
    root.setAttribute(IGNORE_ATTR, '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Eye-tracking calibration');
    root.tabIndex = -1;
    root.hidden = true;
    root.dataset.phase = 'idle';
    root.dataset.tone = 'light';

    const style = doc.createElement('style');
    style.textContent = buildStyles();

    // Targets
    const target = el('div', 'target', { 'aria-hidden': 'true' }, el('span', 'halo'), el('span', 'ring'), el('span', 'dot'));
    const stage = el('div', 'stage', {}, target);
    const hudLabel = el('span', 'hud-label', {}, 'Calibrating');
    const hudCount = el('span', 'count', {}, '1 / 1');
    const hudBar = el('span', 'bar', { 'aria-hidden': 'true' }, el('span', 'bar-fill'));
    const hud = el('div', 'hud', {}, hudLabel, hudCount, hudBar);
    const hint = el('p', 'hint', {}, 'Keep your eyes on the dot · ', kbd('Space'), ' or tap to pause · ', kbd('Esc'), ' cancel');
    const toast = el('p', 'toast', { 'aria-live': 'polite' });
    const hudWrap = el('div', 'hudwrap', {}, hud, hint, toast);
    const pauseTitle = el('h2', 'title', { id: id('pause-title') }, 'Paused');
    const pauseText = el('p', 'lede');
    const pause = el(
      'div',
      'center pause',
      {},
      el(
        'div',
        'card card-small',
        { role: 'group', 'aria-labelledby': id('pause-title') },
        pauseTitle,
        pauseText,
        el('div', 'actions', {}, button('Cancel', 'cancel', false, 'Esc'), button('Continue', 'continue', true, 'Space')),
      ),
    );

    // Positioning
    const video = el('video', 'video', { playsinline: '', muted: '', 'aria-hidden': 'true' });
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    const face = el('div', 'face', { 'aria-hidden': 'true' });
    const preview = el(
      'div',
      'preview',
      { 'data-state': 'bad' },
      video,
      face,
      el('div', 'oval', { 'aria-hidden': 'true' }),
      el('p', 'novideo', {}, 'No camera preview here — the ring shows where I see your face.'),
    );
    const statusText = el('span', 'status-text', {}, COACH.waiting);
    const status = el('p', 'status', { role: 'status', 'aria-live': 'polite' }, el('span', 'status-dot', { 'aria-hidden': 'true' }), statusText);
    // The icon is decoration; the state is spelled out for screen readers.
    const check = (label: string): HTMLLIElement =>
      el(
        'li',
        'check',
        { 'data-state': 'pending' },
        el('span', 'check-icon', { 'aria-hidden': 'true' }),
        label,
        el('span', 'vh check-state', {}, `: ${CHECK_STATE_TEXT.pending}`),
      );
    const checks = { face: check('Face'), distance: check('Distance'), center: check('Centered'), light: check('Light') };
    const next = el('p', 'next');
    const start = button('Start', 'start', true);
    start.disabled = true;
    const positioning = el(
      'div',
      'center',
      {},
      el(
        'section',
        'card',
        { 'aria-labelledby': id('pos-title') },
        el('h2', 'title', { id: id('pos-title') }, 'Let’s find your eyes'),
        el('p', 'lede', {}, 'Sit at your usual reading distance and fit your face inside the oval.'),
        preview,
        status,
        el('ul', 'checks', { 'aria-label': 'Setup checklist' }, checks.face, checks.distance, checks.center, checks.light),
        next,
        el('div', 'actions', {}, button('Cancel', 'cancel', false, 'Esc'), start),
        el('p', 'privacy', {}, 'Your camera image never leaves this device.'),
      ),
    );

    // Training
    const training = el(
      'div',
      'center',
      {},
      el(
        'section',
        'card card-small card-centered',
        { role: 'status' },
        el('div', 'spinner', { 'aria-hidden': 'true' }),
        el('h2', 'title', {}, 'Learning how your eyes move…'),
        el('p', 'lede', {}, 'This only takes a second.'),
      ),
    );

    // Results
    const badge = el('span', 'badge', { 'data-quality': 'good' }, 'Good');
    const resultTitle = el('h2', 'title', { id: id('res-title') }, '');
    const statPx = el('span', 'stat-value', {}, '—');
    const statPxLabel = el('span', 'stat-label', {}, 'average error');
    const statLines = el('span', 'stat-value', {}, '—');
    const statLinesUnit = el('span', 'stat-unit', {}, 'lines');
    const statLinesLabel = el('span', 'stat-label', {}, 'vertical error at your text size');
    const map = doc.createElementNS(SVG_NS, 'svg');
    map.setAttribute('class', `${P}-map`);
    map.setAttribute('role', 'img');
    map.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const note = el('p', 'note');
    const advice = el('p', 'lede');
    const tryit = el('p', 'tryit', {}, 'The soft dot shows where I think you’re looking — glance around to try it.');
    const use = button('Use it', 'use', true);
    const done = button('Done', 'done');
    done.hidden = true;
    const redo = button('Redo', 'redo');
    const results = el(
      'div',
      'center',
      {},
      el(
        'section',
        'card',
        { 'aria-labelledby': id('res-title') },
        badge,
        resultTitle,
        el(
          'div',
          'stats',
          {},
          el('div', 'stat', {}, el('span', 'stat-line', {}, statPx, el('span', 'stat-unit', {}, 'px')), statPxLabel),
          el('div', 'stat', {}, el('span', 'stat-line', {}, statLines, statLinesUnit), statLinesLabel),
        ),
        map,
        note,
        advice,
        tryit,
        el('div', 'actions', {}, redo, done, use),
      ),
    );
    const live = el('div', 'live', { 'aria-hidden': 'true' });

    // Failure
    const failTitle = el('h2', 'title', { id: id('fail-title') }, 'Calibration didn’t work');
    const failText = el('p', 'lede failed-text');
    const retry = button('Try again', 'retry', true);
    const failed = el(
      'div',
      'center',
      {},
      el(
        'section',
        'card card-small',
        { role: 'alert', 'aria-labelledby': id('fail-title') },
        failTitle,
        failText,
        el('div', 'actions', {}, button('Cancel', 'cancel'), retry),
      ),
    );

    const sr = el('div', 'sr', { 'aria-live': 'polite' });

    root.append(style, stage, hudWrap, pause, positioning, training, results, failed, live, sr);
    for (const section of [stage, hudWrap, pause, positioning, training, results, failed]) section.hidden = true;

    root.addEventListener('click', this.handleClick);
    stage.addEventListener('pointerdown', this.handleStagePointer);
    root.addEventListener('wheel', this.blockScroll, { passive: false });
    root.addEventListener('touchmove', this.blockScroll, { passive: false });

    this.root = root;
    this.dom = {
      style,
      stage,
      target,
      hudWrap,
      hudLabel,
      hudCount,
      hudBar,
      toast,
      pause,
      pauseTitle,
      pauseText,
      positioning,
      preview,
      video,
      face,
      status,
      statusText,
      checks,
      next,
      start,
      training,
      results,
      badge,
      resultTitle,
      statPx,
      statPxLabel,
      statLines,
      statLinesUnit,
      statLinesLabel,
      map,
      note,
      advice,
      tryit,
      use,
      done,
      redo,
      live,
      failed,
      failTitle,
      failText,
      retry,
      sr,
    };
  }
}

// ─────────────────────────────── Utilities ───────────────────────────────────

/** True when the element's content overflows it, i.e. it can scroll itself. */
function isScrollable(el: HTMLElement | null | undefined): boolean {
  return !!el && el.scrollHeight > el.clientHeight + 1;
}

/** Sources may reuse buffers between frames; samples must own their data. */
function cloneFeatures(f: EyeFeatures): EyeFeatures {
  return {
    vector: f.vector.slice(),
    headPose: { ...f.headPose },
    blink: f.blink,
    openness: f.openness,
    faceScale: f.faceScale,
    faceCenter: { x: f.faceCenter?.x ?? Number.NaN, y: f.faceCenter?.y ?? Number.NaN },
    // The calibration's eyelid baseline (squint in bright light) is built from this.
    ...(f.squint !== undefined ? { squint: f.squint } : {}),
  };
}

/** Largest RMS residual (px) at which a wrapper counts as an exact affine map of its core. */
const WRAPPER_FIT_RMS_PX = 0.05;

/**
 * The ridge core of `current`, re-expressed so that it predicts what `current` predicts. A
 * wrapper — the extension's zoom-aware model scales the core's output by the page-zoom ratio —
 * would otherwise leave refineGazeModel to learn that scale from 5 dots, which its shrunk,
 * clamped scale fit can't (measured on the synthetic eye: at 1.25× zoom the corrected model
 * was off by 51 px against the wrapper's 10). The wrapper's per-axis map is fitted on these
 * samples and folded into the core's screen adjustment only when it is exact (a genuine affine
 * wrapper); anything else, or a plain RidgeGazeModel, returns `base` unchanged.
 */
function alignCore(current: GazeModel | null, base: RidgeGazeModel, samples: readonly CalibrationSample[]): RidgeGazeModel {
  if (!current || current === base || current instanceof RidgeGazeModel) return base;
  const xs: [number, number][] = [];
  const ys: [number, number][] = [];
  for (const s of samples) {
    let b: Point | null = null;
    let c: Point | null = null;
    try {
      b = base.predict(s.features);
      c = current.predict(s.features);
    } catch {
      continue;
    }
    if (!b || !c || ![b.x, b.y, c.x, c.y].every(Number.isFinite)) continue;
    xs.push([b.x, c.x]);
    ys.push([b.y, c.y]);
  }
  const fx = fitLine(xs);
  const fy = fitLine(ys);
  if (!fx || !fy || fx.rms > WRAPPER_FIT_RMS_PX || fy.rms > WRAPPER_FIT_RMS_PX) return base;
  const identity = (f: { a: number; c: number }): boolean => Math.abs(f.a - 1) < 1e-9 && Math.abs(f.c) < 1e-6;
  if (identity(fx) && identity(fy)) return base;
  if (![fx.a, fy.a].every((a) => a > 0.2 && a < 5)) return base;
  // current = a·(core − origin) + c in viewport px, i.e. a·core + c + (1 − a)·origin on screen.
  const o = currentScreenOrigin();
  const adj = base.adjustment;
  return base.withAdjustment(
    {
      sx: fx.a * adj.sx,
      ox: fx.a * adj.ox + fx.c + (1 - fx.a) * o.x,
      sy: fy.a * adj.sy,
      oy: fy.a * adj.oy + fy.c + (1 - fy.a) * o.y,
    },
    { viewport: base.viewport, trainedAt: base.trainedAt },
  );
}

/** Least-squares y = a·x + c over pairs, with the residual RMS; null without spread in x. */
function fitLine(pairs: readonly [number, number][]): { a: number; c: number; rms: number } | null {
  const n = pairs.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pairs) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) * (x - mx);
    sxy += (x - mx) * (y - my);
  }
  if (!(sxx > 1e-6 * n)) return null;
  const a = sxy / sxx;
  const c = my - a * mx;
  let ss = 0;
  for (const [x, y] of pairs) ss += (y - (a * x + c)) ** 2;
  const rms = Math.sqrt(ss / n);
  return Number.isFinite(a) && Number.isFinite(c) && Number.isFinite(rms) ? { a, c, rms } : null;
}

function isFiniteStats(s: LightingStats | undefined): s is LightingStats {
  if (!s || typeof s !== 'object') return false;
  for (const k of LIGHTING_STAT_KEYS) if (!Number.isFinite(s[k])) return false;
  return true;
}

function modelHeight(model: GazeModel): number {
  const h = model.viewport?.height;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 0;
}

function summarizeOffset(m: OffsetMeasurement, linePitch: number, viewportWidth: number, maxDotYPx: number): OffsetSummary {
  const out: OffsetSummary = {
    meanErrorPx: m.meanErrorPx,
    offsetXPx: m.offsetXPx,
    offsetYPx: m.offsetYPx,
    offsetYLines: m.offsetYPx / linePitch,
    targets: m.targets,
  };
  if (Number.isFinite(m.offsetXPx) && viewportWidth > 0) out.offsetXFrac = m.offsetXPx / viewportWidth;
  if (Number.isFinite(maxDotYPx)) out.maxDotYLines = maxDotYPx / linePitch;
  return out;
}

/**
 * The mean signed error (prediction − target) over a report's points, like measureOffset, and
 * the worst dot's vertical error. For a refinement's leave-one-dot-out report, that is what the
 * correction would leave on a dot it wasn't fitted on.
 */
function offsetOfReport(report: CalibrationReport, linePitch: number, viewportWidth: number): OffsetSummary {
  const k = report.perPoint.length;
  let dx = 0;
  let dy = 0;
  let maxDy = 0;
  for (const p of report.perPoint) {
    dx += p.meanPrediction.x - p.target.x;
    dy += p.meanPrediction.y - p.target.y;
    maxDy = Math.max(maxDy, Math.abs(p.meanPrediction.y - p.target.y));
  }
  return summarizeOffset(
    k > 0
      ? { meanErrorPx: report.meanErrorPx, offsetXPx: dx / k, offsetYPx: dy / k, n: report.sampleCount, targets: k }
      : { meanErrorPx: NaN, offsetXPx: NaN, offsetYPx: NaN, n: 0, targets: 0 },
    linePitch,
    viewportWidth,
    k > 0 ? maxDy : Number.NaN,
  );
}

function targetPoint(frac: Point, vp: { width: number; height: number }): Point {
  const margin = (size: number): number => Math.min(40, size / 4);
  return {
    x: clamp(frac.x * vp.width, margin(vp.width), vp.width - margin(vp.width)),
    y: clamp(frac.y * vp.height, margin(vp.height), vp.height - margin(vp.height)),
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const r = random();
    const j = Math.min(i, Math.floor((Number.isFinite(r) ? Math.abs(r) % 1 : 0) * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function deepActiveElement(doc: Document): Element | null {
  let a: Element | null = doc.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong during calibration.';
}

function trainingFailureMessage(err: unknown): string {
  if (err instanceof RangeError) return 'The eye tracker’s data changed part-way through. Please try again.';
  return errorMessage(err);
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(text: string): Rgba | null {
  const s = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const c = { r: +m[1], g: +m[2], b: +m[3], a: alpha };
    return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? c : null;
  }
  return null;
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function buildStyles(): string {
  const p = P;
  return `
.${p} {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: ${Z.calibration};
  display: block;
  pointer-events: auto;
  overflow: hidden;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  --c-bg: var(--gr-bg, var(--gr-cal-host-bg, #f7f5f0));
  --c-fg: var(--gr-fg, #1a1d23);
  --c-muted: var(--gr-muted, #575d68);
  --c-accent: var(--gr-accent, #2a64d6);
  --c-accent-fg: var(--gr-accent-fg, #ffffff);
  --c-surface: var(--gr-surface, #ffffff);
  --c-border: var(--gr-border, rgba(26, 29, 35, 0.14));
  --c-shadow: var(--gr-shadow, 0 24px 60px rgba(15, 18, 25, 0.16));
  --c-font: var(--gr-font-ui, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  --c-good: #1c7c44;
  --c-info: #2a64d6;
  --c-warn: #9a5700;
  --c-bad: #b3261e;
  --c-on-status: #ffffff;
  --c-tint: rgba(26, 29, 35, 0.05);
  background: var(--c-bg);
  color: var(--c-fg);
  font: 16px/1.5 var(--c-font);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.${p}[data-tone="dark"] {
  --c-bg: var(--gr-bg, var(--gr-cal-host-bg, #14161b));
  --c-fg: var(--gr-fg, #eceef2);
  --c-muted: var(--gr-muted, #a5abb6);
  --c-accent: var(--gr-accent, #7ea8ff);
  --c-accent-fg: var(--gr-accent-fg, #0c1220);
  --c-surface: var(--gr-surface, #1e2128);
  --c-border: var(--gr-border, rgba(236, 238, 242, 0.16));
  --c-shadow: var(--gr-shadow, 0 24px 60px rgba(0, 0, 0, 0.5));
  --c-good: #52c98f;
  --c-info: #7ea8ff;
  --c-warn: #f2b53c;
  --c-bad: #ff8a80;
  --c-on-status: #0c1016;
  --c-tint: rgba(236, 238, 242, 0.06);
}
.${p}[hidden], .${p} [hidden] { display: none !important; }
.${p} *, .${p} *::before, .${p} *::after { box-sizing: border-box; }
.${p}[data-phase="targets"], .${p}[data-phase="validating"] { cursor: none; }
.${p}[data-paused] { cursor: auto; }

/* ── targets ── */
.${p}-stage { position: absolute; inset: 0; }
.${p}[data-paused] .${p}-stage { opacity: 0.25; }
.${p}-target {
  position: absolute; left: 0; top: 0; width: 0; height: 0;
  transform: translate3d(var(--x, 50vw), var(--y, 50vh), 0);
  transition: transform var(--glide, 380ms) cubic-bezier(0.45, 0.05, 0.2, 1), opacity 260ms ease;
  opacity: 0;
  will-change: transform;
}
.${p}-target.is-visible { opacity: 1; }
.${p}-target.is-instant { transition: none; }
.${p}-halo, .${p}-ring, .${p}-dot {
  position: absolute; left: 0; top: 0; border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.${p}-halo {
  width: 116px; height: 116px;
  background: radial-gradient(circle, rgba(42, 100, 214, 0.2) 0%, transparent 68%);
  background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 24%, transparent) 0%, transparent 68%);
  animation: ${p}-pulse 1.5s ease-in-out infinite;
}
.${p}-ring { width: 70px; height: 70px; border: 3px solid var(--c-accent); }
.${p}-target.is-shrinking .${p}-ring { animation: ${p}-shrink var(--dur, 1600ms) cubic-bezier(0.3, 0, 0.25, 1) forwards; }
.${p}-target.is-done .${p}-ring, .${p}-target.is-done .${p}-halo { opacity: 0; transition: opacity 140ms ease; }
.${p}-dot {
  width: 12px; height: 12px;
  background: var(--c-fg);
  box-shadow: 0 0 0 3px var(--c-bg);
}
.${p}-target.is-done .${p}-dot { animation: ${p}-pop var(--pop, 220ms) ease-out forwards; }
@keyframes ${p}-shrink {
  from { transform: translate(-50%, -50%) scale(1); }
  to { transform: translate(-50%, -50%) scale(0.17); }
}
@keyframes ${p}-pulse {
  0%, 100% { transform: translate(-50%, -50%) scale(0.9); opacity: 0.65; }
  50% { transform: translate(-50%, -50%) scale(1.08); opacity: 1; }
}
@keyframes ${p}-pop {
  0% { transform: translate(-50%, -50%) scale(1); }
  45% { transform: translate(-50%, -50%) scale(1.7); background: var(--c-accent); }
  100% { transform: translate(-50%, -50%) scale(0.4); opacity: 0; background: var(--c-accent); }
}
@keyframes ${p}-fade { from { opacity: 1; } to { opacity: 0.2; } }
@keyframes ${p}-spin { to { transform: rotate(360deg); } }

/* ── progress, hint, toast ── */
.${p}-hudwrap {
  position: absolute; left: 0; right: 0; top: 22px;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  pointer-events: none;
}
.${p}[data-hud="bottom"] .${p}-hudwrap { top: auto; bottom: 22px; flex-direction: column-reverse; }
.${p}-hud {
  display: inline-flex; align-items: center; gap: 12px;
  padding: 7px 16px; border-radius: 999px;
  background: var(--c-surface); border: 1px solid var(--c-border);
  color: var(--c-muted); font-size: 14px; font-variant-numeric: tabular-nums;
}
.${p}-count { color: var(--c-fg); font-weight: 700; }
.${p}-bar { display: block; width: 96px; height: 4px; border-radius: 2px; background: var(--c-border); overflow: hidden; }
.${p}-bar-fill {
  display: block; height: 100%; width: 100%; background: var(--c-accent);
  transform-origin: left center; transform: scaleX(var(--p, 0)); transition: transform 300ms ease;
}
.${p}-hint { margin: 0; color: var(--c-muted); font-size: 14px; text-align: center; padding: 0 16px; }
.${p}-toast {
  margin: 0; padding: 7px 16px; border-radius: 999px;
  background: var(--c-fg); color: var(--c-bg); font-size: 14px; font-weight: 600;
  opacity: 0; transition: opacity 200ms ease;
}
.${p}-toast.is-on { opacity: 1; }
.${p}-toast:empty { display: none; }

/* ── cards ── */
.${p}-center {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  padding: 24px; overflow: auto; overscroll-behavior: contain;
}
.${p}-card {
  width: min(540px, 100%);
  display: flex; flex-direction: column; gap: 16px;
  padding: 28px 28px 22px;
  background: var(--c-surface); color: var(--c-fg);
  border: 1px solid var(--c-border); border-radius: 22px;
  box-shadow: var(--c-shadow);
  user-select: text; -webkit-user-select: text;
}
.${p}-card-small { width: min(440px, 100%); }
.${p}-card-centered { align-items: center; text-align: center; }
.${p}-title { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; color: var(--c-fg); }
.${p}-lede, .${p}-next, .${p}-tryit, .${p}-privacy { margin: 0; color: var(--c-muted); }
.${p}-next { font-size: 15px; }
.${p}-tryit { font-size: 14px; }
.${p}-privacy { font-size: 13px; text-align: center; }
.${p}-actions { display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap; margin-top: 4px; }
.${p}-btn {
  appearance: none; -webkit-appearance: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; min-width: 96px; padding: 0 20px;
  font: 600 15px/1 var(--c-font);
  color: var(--c-fg); background: transparent;
  border: 1px solid var(--c-border); border-radius: 12px;
  cursor: pointer;
  transition: background-color 150ms ease, opacity 150ms ease, transform 80ms ease;
}
.${p}-btn:hover { background: var(--c-tint); }
.${p}-btn:active { transform: translateY(1px); }
.${p}-btn:focus-visible { outline: 3px solid var(--c-accent); outline-offset: 2px; }
.${p}-btn-primary { background: var(--c-accent); border-color: var(--c-accent); color: var(--c-accent-fg); }
.${p}-btn-primary:hover { background: var(--c-accent); filter: brightness(1.08); }
.${p}-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; filter: none; }
.${p}-kbd {
  display: inline-block; padding: 3px 6px; border-radius: 6px;
  border: 1px solid currentColor; font: 600 11px/1 var(--c-font); opacity: 0.75;
}

/* ── positioning ── */
.${p}-preview {
  /* Shrinks with the viewport height so the whole card fits without scrolling. */
  position: relative; width: min(100%, 420px, max(220px, calc((100vh - 420px) * 4 / 3))); align-self: center; flex: none;
  aspect-ratio: 4 / 3; border-radius: 16px; overflow: hidden;
  background: #0c0e12; isolation: isolate;
}
.${p}-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
.${p}-oval {
  position: absolute; left: 50%; top: 46%; width: 36%; height: 64%;
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 3px dashed rgba(255, 255, 255, 0.8);
  box-shadow: 0 0 0 100vmax rgba(8, 10, 14, 0.42);
  transition: border-color 200ms ease;
}
.${p}-preview[data-state="good"] .${p}-oval { border-style: solid; border-color: #52c98f; }
.${p}-face {
  position: absolute; transform: translate(-50%, -50%);
  border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.1);
  transition: left 120ms linear, top 120ms linear, width 120ms linear, height 120ms linear;
}
.${p}-face[data-visible="false"] { opacity: 0; }
.${p}-novideo {
  position: absolute; left: 0; right: 0; bottom: 0; margin: 0; padding: 8px 12px;
  font-size: 12px; line-height: 1.35; text-align: center; color: rgba(255, 255, 255, 0.78);
}
.${p}-preview[data-video="on"] .${p}-novideo { display: none; }
.${p}-status { display: flex; align-items: center; gap: 10px; margin: 0; min-height: 1.5em; font-weight: 600; }
.${p}-status-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--c-muted); }
.${p}-status[data-state="good"] .${p}-status-dot { background: var(--c-good); }
.${p}-status[data-state="fix"] .${p}-status-dot { background: var(--c-warn); }
.${p}-status[data-state="wait"] .${p}-status-dot { animation: ${p}-fade 0.9s ease-in-out infinite alternate; }
.${p}-checks { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.${p}-check {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 7px 6px; border-radius: 10px; border: 1px solid var(--c-border);
  color: var(--c-muted); font-size: 13px; font-weight: 600; white-space: nowrap;
}
.${p}-check-icon {
  display: inline-grid; place-items: center; flex: none;
  width: 18px; height: 18px; border-radius: 50%;
  border: 1.5px solid currentColor; font-size: 11px; line-height: 1;
}
.${p}-check[data-state="ok"] { color: var(--c-fg); border-color: var(--c-good); }
.${p}-check[data-state="ok"] .${p}-check-icon { background: var(--c-good); border-color: var(--c-good); color: var(--c-on-status); }
.${p}-check[data-state="bad"] { color: var(--c-fg); border-color: var(--c-warn); }
.${p}-check[data-state="bad"] .${p}-check-icon { background: var(--c-warn); border-color: var(--c-warn); color: var(--c-on-status); }
.${p}-check[data-state="tip"] { color: var(--c-fg); border-color: var(--c-info); }
.${p}-check[data-state="tip"] .${p}-check-icon { background: var(--c-info); border-color: var(--c-info); color: var(--c-on-status); font-style: italic; font-weight: 700; }

/* ── training ── */
.${p}-spinner {
  width: 44px; height: 44px; border-radius: 50%;
  border: 4px solid var(--c-border); border-top-color: var(--c-accent);
  animation: ${p}-spin 0.9s linear infinite;
}

/* ── results ── */
.${p}-badge {
  align-self: flex-start; padding: 4px 12px; border-radius: 999px;
  font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--c-on-status); background: var(--c-good);
}
.${p}-badge[data-quality="good"] { background: var(--c-info); }
.${p}-badge[data-quality="fair"] { background: var(--c-warn); }
.${p}-badge[data-quality="poor"] { background: var(--c-bad); }
.${p}-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.${p}-stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border-radius: 14px; background: var(--c-tint); }
.${p}-stat-line { display: flex; align-items: baseline; gap: 4px; }
.${p}-stat-value { font-size: 30px; line-height: 1.1; font-weight: 750; font-variant-numeric: tabular-nums; color: var(--c-fg); }
.${p}-stat-unit { font-size: 15px; font-weight: 600; color: var(--c-muted); }
.${p}-stat-label { font-size: 13px; color: var(--c-muted); }
.${p}-map { display: block; width: 100%; height: clamp(110px, 22vh, 170px); }
.${p}-map-frame { fill: var(--c-tint); stroke: var(--c-border); }
.${p}-map-link { stroke: var(--c-muted); stroke-width: 1.5; stroke-dasharray: 3 3; }
.${p}-map-target { fill: none; stroke: var(--c-fg); stroke-width: 2; }
.${p}-map-gaze { fill: var(--c-accent); }
.${p}-note {
  margin: 0; padding: 10px 14px; border-radius: 12px;
  background: var(--c-tint); border-left: 3px solid var(--c-info);
  color: var(--c-fg); font-size: 14px; line-height: 1.45;
}
.${p}-note:empty { display: none; }
.${p}-live {
  position: absolute; left: 0; top: 0; width: 30px; height: 30px; margin: -15px 0 0 -15px;
  border-radius: 50%; pointer-events: none; opacity: 0; transition: opacity 200ms ease;
  background: radial-gradient(circle, rgba(42, 100, 214, 0.75) 0 28%, rgba(42, 100, 214, 0.22) 56%, transparent 72%);
  background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 78%, transparent) 0 28%, color-mix(in srgb, var(--c-accent) 24%, transparent) 56%, transparent 72%);
}
.${p}-live.is-on { opacity: 1; }

.${p}-sr, .${p}-vh {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.${p}-check { position: relative; }

@media (max-height: 760px) {
  .${p}-center { padding: 16px; }
  .${p}-card { gap: 12px; padding: 22px 24px 18px; }
  .${p}-title { font-size: 21px; }
}
@media (max-width: 520px) {
  .${p}-card { padding: 22px 18px 18px; gap: 14px; border-radius: 18px; }
  .${p}-title { font-size: 21px; }
  .${p}-checks { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .${p}-stat-value { font-size: 26px; }
}
@media (prefers-reduced-motion: reduce) {
  .${p}-target { transition: opacity 120ms linear; }
  .${p}-halo { animation: none; }
  .${p}-target.is-shrinking .${p}-ring { animation: ${p}-fade var(--dur, 1600ms) linear forwards; }
  .${p}-target.is-done .${p}-dot { animation: none; opacity: 0; }
  .${p}-spinner { animation: none; border-top-color: var(--c-border); }
  .${p}-status[data-state="wait"] .${p}-status-dot { animation: none; }
  .${p}-live, .${p}-face, .${p}-bar-fill { transition: none; }
}
@media (prefers-contrast: more) {
  .${p} { --c-muted: var(--c-fg); --c-border: currentColor; }
  .${p}-ring { border-width: 4px; }
}
@media (forced-colors: active) {
  .${p}-dot { forced-color-adjust: none; background: CanvasText; box-shadow: 0 0 0 3px Canvas; }
  .${p}-ring { border-color: Highlight; }
  .${p}-live { forced-color-adjust: none; background: Highlight; }
}
`;
}
