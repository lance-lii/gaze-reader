/**
 * Calibrated gaze model: EyeFeatures → viewport CSS px.
 *
 * Pipeline (all fitted on the calibration samples, nothing hard-coded about
 * which features exist — the feature vector is treated as opaque):
 *
 *  1. Drop blinks (blink > maxBlink, default 0.5) and non-finite rows.
 *  2. z-score every feature (constant features are neutralized, not divided by ~0).
 *     Features named in GAZE_EXCLUDED_FEATURES (lid aperture, lid position,
 *     lid-referenced iris, blink scores; known from `featureNames`) are
 *     neutralized too: their standardized value is always 0, so they get zero
 *     weight and can never be picked below. Light changes the lids, and a model
 *     that reads vertical gaze from them moves by lines when a lamp is switched on.
 *  3. Pick the "dominant" gaze features: the ones most correlated with the
 *     target x or y, taken alternately per axis so the hard vertical axis gets
 *     its share, skipping near-duplicates of features already picked. Posture
 *     features (head pose, distance; known from `featureNames`) are never picked:
 *     they enter the design linearly only.
 *  4. Per target, reject samples > 2.5 robust SDs (MAD) from the target's
 *     median in any dominant feature (glances away, half-blinks, tracker
 *     glitches); then redo 2–3 on the clean data.
 *  5. Design = every feature linearly + squares and pairwise products of the
 *     dominant (eye) features, re-standardized so one ridge penalty fits all.
 *     A square of a head feature would turn a small posture change (many of
 *     calibration's tiny head SDs) into a shift of several lines on both axes.
 *  6. Two ridge regressions (x, y) sharing one factorization; λ chosen by
 *     leave-one-target-out cross-validation on mean Euclidean error.
 *
 * Predictions are computed in absolute screen coordinates (viewport px + the
 * window's screen position at calibration time) and converted back using the
 * *current* window position, so dragging the browser window doesn't break the
 * calibration. Quick recalibration stacks a per-axis affine correction in the
 * same screen space, so it also survives window moves.
 *
 * Distance: the eye features say where the eyes point relative to the camera, as an angle, and
 * that angle is the same at any distance from the screen. A reader who leans in after calibrating
 * therefore looks at points nearer the camera than the ridge maps say, by the ratio of the
 * distances. The prediction is scaled about the camera by that ratio, read from the size of the
 * face in the image (see {@link DepthCompensation}).
 *
 * Every model carries a CalibrationEnvironment: the lighting signature the
 * caller measured during calibration and an eyelid-appearance baseline
 * computed here from the samples, so the app can tell when the conditions
 * the calibration was made in no longer hold.
 */
import type {
  AppearanceBaseline,
  CalibrationEnvironment,
  CalibrationQuality,
  CalibrationReport,
  CalibrationSample,
  EyeFeatures,
  GazeModel,
  LightingComponent,
  LightingSignature,
  Point,
  SerializedGazeModel,
} from '../types';
import { readJSON, removeKey, writeJSON } from '../core/storage';
import { FEATURE_NAMES, type FeatureName } from './features';
import { cameraAnglesInHead } from './headPose';
import { RidgeNormalEquations, dot, ridgeFit } from './ridge';

export const GAZE_MODEL_VERSION = 1;
/**
 * Bumped whenever a saved model can no longer be used as-is. `gr-ridge-poly2`
 * (1.0) read vertical gaze from the lids; `-iris5` excludes them
 * (GAZE_EXCLUDED_FEATURES) and reads the 5-point, corner-referenced iris.
 */
export const GAZE_MODEL_KIND = 'gr-ridge-poly2-iris5';
/** Prefix every kind this module has ever written starts with. */
const GAZE_MODEL_KIND_FAMILY = 'gr-ridge';
export const CALIBRATION_STORAGE_KEY = 'calibration.v1';
export const DEFAULT_LAMBDAS: readonly number[] = Object.freeze([1e-3, 1e-2, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100]);
/** App default text: 22 px × 1.9 line height. */
export const DEFAULT_LINE_PITCH_PX = 22 * 1.9;
/**
 * Default cutoff: samples with a blink score above this are dropped. Callers
 * that already gate blinks over time (the calibration overlay uses the
 * runtime gaze source's BlinkGate) pass a higher `maxBlink`, because a
 * sustained moderate score is lowered lids — the reader looking at the bottom
 * of the screen — and the model must learn those frames, not extrapolate them.
 */
export const MAX_BLINK = 0.5;

const DEFAULT_QUADRATIC_FEATURES = 6;
const MIN_TARGETS = 3;
const MIN_SAMPLES = 6;
/** Standardized inputs are clamped before expansion so squares can't explode on wild frames. */
const Z_CLAMP = 6;
/** A dominant gaze feature this many calibration SDs out means a tracking glitch, not gaze. */
const Z_REJECT = 10;
/**
 * Head pose and distance. The head barely moves during calibration, so its SDs are tiny, and
 * a reader who leans back or slouches later is legitimately "10 SDs out". These features are
 * never grounds for rejecting a prediction (Z_CLAMP bounds their influence instead);
 * otherwise a head feature would silence the tracker for the rest of the session, reading as
 * "can't see you" with the face in plain view. They enter the model linearly only (never as
 * squares or products), as ARCHITECTURE.md specifies; models saved before that rule may still
 * carry posture terms in `quad`, which is why the glitch check still filters them.
 */
const POSTURE_FEATURES: ReadonlySet<string> = new Set<FeatureName>(['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale']);
/**
 * Features the gaze model never uses (their columns are neutralized: always 0 in the design, so
 * zero weight, never dominant, never a glitch check). They stay in the vector for the blink gate
 * and quality checks, and because FEATURE_NAMES is append-only.
 *
 * Everything here moves with the eyelids, and the lids move with the light: people squint a little
 * in bright light or glare and open their eyes wider in dim light. During calibration the upper lid
 * also follows vertical gaze, so a model that may use the lids learns "narrower = looking lower".
 * In the lighting simulation (bench/lighting, five brackets on MediaPipe's blendshapes) a 10 %
 * squint then read as 0.8–5 lines lower. The corner-referenced 5-point iris features (rightU5 …
 * meanVc5), the eyeLook* scores and posture carry the gaze instead: with this set excluded the same
 * squint moves the prediction 0.2–1.1 lines (a squint made by the upper lid alone: 0.5–2.8, from
 * the eyeLook* scores' own lid coupling), and the cross-validated calibration error is equal or
 * better in every world. The price: an iris reflection biasing the iris landmarks vertically now
 * moves the gaze 1.4–1.9× more (0.8–1.4 lines per 0.01 eye widths, about 0.3 px of iris), which
 * is left to the reading layer's drift tracking and the accuracy check / quick refresh.
 *
 * - eyeBlink*: the blendshape network's lid-closure score.
 * - rightOpen/leftOpen, rightLidY/leftLidY: lid aperture and lid midpoint.
 * - rightV/leftV/meanV: iris measured from the lid midpoint, so a lid move shifts them 3× more
 *   than gaze does.
 * - rightU/leftU/meanU: the single-point iris; superseded by the 5-point rightU5/leftU5/meanU5.
 * - yaw/pitch: head rotation. The eye corners sit close to the eyeball's centre of rotation in
 *   depth, so the corner-referenced iris already measures where the eyes point relative to the
 *   camera, head turn included. During calibration the head barely turns (tenths of a degree), so
 *   the weights fitted to yaw and pitch were mostly noise, and a reader who later sat with their
 *   chin 4° lower read 1.5–2.3 lines low (bench/lighting/posture.bench.test.ts). Without them the
 *   same 4° moves the gaze 1.0–1.4 lines (and a 4° turn 43 px instead of 70–120 px), and the
 *   cross-validated calibration error is equal or better in every world.
 * - roll, tx/ty/tz, faceScale: the rest of the head's pose. The same argument holds for them: the
 *   reader is asked to keep still while calibrating, so nothing in the samples says what a change
 *   of posture does to the gaze, and the weights a regression fits to a few millimetres of head
 *   movement are noise. They were then applied to centimetres: sitting 3 cm to one side moved the
 *   gaze 0.8–1.1 lines, and without those weights 0.2 (bench/lighting/posture.bench.test.ts). What
 *   a change of distance does is known from geometry instead, and is applied after the regression
 *   ({@link DepthCompensation}): leaning 6 cm in or back moved the gaze 0.6–1.2 lines (10 cm: 2)
 *   and now moves it 0.1–0.3. A sideways or up-and-down move needs no correction: the eye features
 *   measure the gaze against the line from the eye to the camera, which moves with the head.
 */
export const GAZE_EXCLUDED_FEATURES: ReadonlySet<string> = new Set<FeatureName>([
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'rightOpen',
  'leftOpen',
  'rightLidY',
  'leftLidY',
  'rightV',
  'leftV',
  'meanV',
  'rightU',
  'leftU',
  'meanU',
  'yaw',
  'pitch',
  'roll',
  'tx',
  'ty',
  'tz',
  'faceScale',
]);

/**
 * Distance compensation. The eye features (iris position between the eye corners, in eye widths)
 * measure the angle between where the eyes point and the line from the eye to the camera, and
 * don't change with the size of the face in the image. With the camera in the plane of the screen,
 * the point looked at is (distance to the screen) × that angle away from the camera. The ridge maps
 * learn that product at the calibration distance; at another distance the same features mean a
 * point nearer to or further from the camera by the ratio of the distances:
 *
 *     gaze = camera + (distance now / distance at calibration) × (ridge prediction − camera)
 *
 * The ratio comes from `faceScale` (the distance between the eyes in the image, inversely
 * proportional to the distance from the camera), divided by cos(yaw) because a turned head looks
 * narrower. The camera's place on the screen can't be measured from a web page; it is taken to be
 * just above the middle of the top edge of the screen the window is on, where laptops and most
 * monitor-mounted webcams have it. That guess doesn't need to be good: with the camera 4 cm from
 * where it is assumed, a 6 cm lean still moves the gaze 0.3–0.5 lines instead of 0.6–1.2. With a
 * camera somewhere else entirely (a laptop's, while reading on a second monitor) the correction is
 * about as wrong as having none.
 */
export interface DepthCompensation {
  /** faceScale / cos(yaw) the calibration was made at (the median over its samples). */
  ref: number;
  /** Where the camera is taken to be, in the model's screen space (viewport px + window origin at calibration). */
  camera: Point;
  /** Indices into the feature vector of faceScale and of head yaw (−1: no yaw correction). */
  scaleIndex: number;
  yawIndex: number;
}
/**
 * Head-pose compensation. The eye features measure the iris against the eye corners, and the
 * corners are not at the eyeball's centre of rotation: they sit a few millimetres in front of it.
 * When the head turns or moves across the camera's view while the eyes stay on the same word, the
 * corners shift against the eyeball as the camera sees them, and the iris seems to have moved: in
 * simulation a chin 4° lower reads as 1.0–1.4 lines lower, the head 2 cm lower as 0.5–0.8.
 *
 * How much depends on the reader's face (how deep-set the eyes are) and on how the tracker's pose
 * estimate is scaled, so it is measured, not assumed: at the end of a calibration the reader keeps
 * their eyes on one dot and moves their head (nods, turns, tilts). The gaze hasn't moved, so
 * whatever the prediction did is this effect, and a straight-line fit of it against the head's
 * pose gives the correction ({@link fitPoseCompensation}):
 *
 *     prediction += gain · (camera's direction in the head's frame, now − at calibration)
 *
 * The pose enters as {@link cameraAnglesInHead}: one quantity for a turn of the head and for a
 * move of the head, so what is learned from nodding also corrects sliding down in the chair.
 *
 * A tilt of the head (roll) is a different thing: the features are measured along the line through
 * the eye corners, so tilting rotates the measured gaze about the camera. That is undone by
 * rotating the prediction back, by `rollGain` × the tilt (learned as well: about ±1).
 *
 * A model fresh from training carries the reference pose with all gains 0 (nothing is corrected
 * until a fit), and so does one whose reader skipped the step.
 */
export interface PoseCompensation {
  /** The camera's direction in the head's frame and the head's roll at calibration (medians over its samples), radians. */
  ref: { a: number; b: number; roll: number };
  /** px of model space per radian: dx/da, dx/db, dy/da, dy/db. */
  gain: [number, number, number, number];
  /** Share of a change of roll undone as a rotation of the prediction about the camera. */
  rollGain: number;
  /** The corrections follow the pose this far from the reference (radians), and hold beyond it. */
  maxAngle: number;
  maxRoll: number;
  /** Where the camera is taken to be (as {@link DepthCompensation.camera}). */
  camera: Point;
  /** Indices into the feature vector of yaw, pitch, roll, tx, ty, tz. */
  index: [number, number, number, number, number, number];
}
/** Gains beyond this (px per radian) aren't an anatomy, they are a fit gone wrong: ≈ 3 lines per degree. */
const POSE_GAIN_MAX = 7000;
const POSE_ROLL_GAIN_MAX = 1.5;
/**
 * A head-movement step teaches a direction only if the head moved at least this much in it: half
 * the distance between the 10th and 90th percentiles, radians (1.5°). Percentiles, because the
 * head is still in a direction most of the time (it nods, then turns, then tilts), which a
 * median-based spread reads as "never moved"; and not the extremes, which one glitch can set.
 */
const POSE_MIN_SPREAD = 1.5 * (Math.PI / 180);
/** The correction follows the pose to this multiple of the largest movement it was fitted on, at most POSE_MAX_ANGLE. */
const POSE_RANGE_FACTOR = 1.5;
const POSE_MAX_ANGLE = 20 * (Math.PI / 180);
const POSE_MIN_SAMPLES = 30;
/** A fit is kept only if it explains this share of what the prediction did while the head moved. */
const POSE_MIN_GAIN_IN_ERROR = 0.2;
/** Frames averaged together when measuring that (about a quarter of a second). */
const POSE_ERROR_BLOCK = 8;

/** The distance ratio is clamped to this range: beyond it the reader has moved too far for the calibration anyway. */
const DEPTH_RATIO_MIN = 0.7;
const DEPTH_RATIO_MAX = 1.4;
/** |yaw| used for the foreshortening correction is capped (≈ 40°; frameQuality gives up at 35°). */
const DEPTH_MAX_YAW = 0.7;
/** The camera lens above the top edge of the screen (the bezel), CSS px: ≈ 8 mm. */
const CAMERA_ABOVE_SCREEN_PX = 36;
/** Browser chrome above the viewport when it can't be measured (an iframe, no window), CSS px. */
const ASSUMED_CHROME_TOP_PX = 100;
/**
 * The measured chrome height counts for at most this much, CSS px. Real toolbars are shorter; a
 * larger value is a zoomed page (browsers report the window's outer size in unzoomed px and the
 * viewport in zoomed ones, so at 150 % the difference reads as hundreds of px) or docked tools.
 */
const MAX_CHROME_TOP_PX = 200;
const MAD_TO_SD = 1.4826;
/** Leys et al. (2013) call 2.5 robust SDs "moderately conservative" — our default. */
const MAD_THRESHOLD = 2.5;
/** Floor for the per-target spread, in global SD units, so near-identical samples aren't flagged. */
const FEATURE_MAD_FLOOR = 0.05;
/** Same idea for predictions, in px. */
const PREDICTION_MAD_FLOOR_PX = 2;
const MAX_REJECT_FRACTION = 1 / 3;
/**
 * |r| a feature needs with target x or y to count as a gaze feature. A pure
 * noise feature's correlation has SD ≈ 1/√n (≈ 0.05 for a typical 13 × 30
 * calibration), so 0.25 is ~5σ — while any real gaze cue clears it easily.
 */
const MIN_DOMINANT_CORR = 0.25;
const REDUNDANT_CORR = 0.95;
/** Prefer the smoother model when a larger λ is within 2 % of the best CV error. */
const LAMBDA_TIE_TOLERANCE = 0.02;

/** Quick mode: per-axis scale is shrunk towards 1 (λ = κ·spread) and clamped. */
const DEFAULT_SCALE_SHRINKAGE = 2;
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.2;
/** Minimum RMS spread of the quick targets (px) before a scale is estimated at all. */
const MIN_SCALE_SPREAD_PX = 40;

// ────────────────────────────────── Types ────────────────────────────────────

export interface TrainOptions {
  /** Viewport size at calibration (CSS px). Default: window.inner*, else inferred from the targets. */
  viewport?: { width: number; height: number };
  /** Ridge λ grid for cross-validation. Default {@link DEFAULT_LAMBDAS}. */
  lambdas?: number[];
  /** How many dominant features get squares and pairwise products (default 6; fewer with few targets). */
  quadraticFeatures?: number;
  /** Per-target MAD outlier rejection (default true). */
  rejectOutliers?: boolean;
  /**
   * FEATURE_NAMES of the running build. Stored as a signature so a model from
   * a build whose features were reordered (same length!) is rejected on load.
   * Must have one name per vector entry.
   */
  featureNames?: readonly string[];
  /** Drop samples whose blink score exceeds this (default {@link MAX_BLINK}). */
  maxBlink?: number;
  /**
   * Feature names whose columns are neutralized (see {@link GAZE_EXCLUDED_FEATURES}, the
   * default). Needs `featureNames`; without names nothing is excluded. Pass `[]` to let the
   * model use every feature (the 1.0 behaviour, kept for comparisons).
   */
  excludedFeatures?: Iterable<string>;
  /** Conditions during calibration, stored with the model (see {@link CalibrationEnvironment}). */
  environment?: EnvironmentInput;
  /**
   * Scale predictions about the camera by the change of distance since calibration (see
   * {@link DepthCompensation}). Default: on when `featureNames` has `faceScale` and the regression
   * doesn't use it (it is excluded); a model that fits its own weight to faceScale gets none.
   */
  depthCompensation?: boolean;
  /** Keep the reference for head-pose compensation (default true; needs the pose features excluded). See {@link PoseCompensation}. */
  poseCompensation?: boolean;
  /** Where the camera is, in viewport px (default: just above the middle of the screen's top edge). */
  camera?: Point;
}

/** What the caller measured about the calibration conditions; the eyelid baseline is computed here. */
export interface EnvironmentInput {
  /** Lighting signature built during calibration, or null when it couldn't be measured. */
  lighting?: LightingSignature | null;
}

export interface EvaluateOptions {
  /** Ignore samples whose blink score exceeds this (default {@link MAX_BLINK}). */
  maxBlink?: number;
}

export interface TrainDiagnostics {
  /** Leave-one-target-out mean per-sample Euclidean error for every λ tried. */
  cv: { lambda: number; errorPx: number }[];
  /** Samples dropped for blinks or non-finite values. */
  droppedInvalid: number;
  /** Samples dropped by the per-target MAD rule. */
  rejectedOutliers: number;
  /** Indices (into EyeFeatures.vector) that received quadratic terms. */
  dominantFeatures: number[];
  /** Indices whose columns were neutralized (GAZE_EXCLUDED_FEATURES present in `featureNames`). */
  excludedFeatures: number[];
  /** Columns in the expanded design. */
  expandedDim: number;
  targets: number;
}

export interface TrainResult {
  model: RidgeGazeModel;
  /** Cross-validated: each target's predictions come from a model that never saw it. */
  report: CalibrationReport;
  diagnostics: TrainDiagnostics;
}

export interface RefineOptions {
  viewport?: { width: number; height: number };
  /** Also fit a (strongly shrunk) per-axis scale, not just an offset. Default true. */
  fitScale?: boolean;
  /** κ in λ = κ·Σ(p − p̄)²; the OLS scale correction is divided by (1 + κ). Default 2. */
  scaleShrinkage?: number;
  /** Drop samples whose blink score exceeds this (default {@link MAX_BLINK}). */
  maxBlink?: number;
  /**
   * Conditions during the refresh. They replace the stored environment: the refresh re-fits the
   * offset under today's light, so today's light becomes the reference. The eyelid baseline is
   * recomputed from the refresh samples; a lighting signature that isn't given becomes null.
   */
  environment?: EnvironmentInput;
}

/** Result of {@link measureOffset}. */
export interface OffsetMeasurement {
  /** Mean Euclidean error of the per-target mean prediction, px (as {@link evaluateModel}). */
  meanErrorPx: number;
  /** Mean signed error (prediction − target) over targets, px; positive y = gaze reads lower. */
  offsetXPx: number;
  offsetYPx: number;
  /** Samples that contributed after blink and per-target outlier filtering (0 → errors are NaN). */
  n: number;
  /** Targets that contributed. */
  targets: number;
}

/** What the running build expects of a stored model. */
export interface ModelCompatibility {
  featureLength?: number;
  featureNames?: readonly string[];
}

/** x' = sx·x + ox, y' = sy·y + oy, in absolute screen CSS px. */
export interface AxisAffine {
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

export interface GazeModelParams {
  featureLength: number;
  featureSignature: string | null;
  mean: Float64Array;
  std: Float64Array;
  /** Dominant feature indices, expanded as z_a·z_b for a ≤ b. */
  quad: readonly number[];
  /** The dominant features a Z_REJECT outlier on means a tracking glitch (no posture features). Default: quad. */
  glitchCheck?: readonly number[];
  /** Neutralized feature indices: their standardized value is forced to 0. Default: none. */
  excluded?: readonly number[];
  expMean: Float64Array;
  expStd: Float64Array;
  wx: Float64Array;
  bx: number;
  wy: Float64Array;
  by: number;
  lambda: number;
  viewport: { width: number; height: number };
  /** window.screenX/Y at calibration time. */
  origin: Point;
  /**
   * Browser chrome above the viewport at calibration (outerHeight − innerHeight), or null when
   * unknown (old models, iframes). The window origin says nothing about where the viewport sits
   * inside the window: entering fullscreen moves it up by the toolbar height with screenY
   * unchanged, so a change here means the calibration no longer lines up.
   */
  chromeTop?: number | null;
  /** devicePixelRatio when chromeTop was measured (a zoom change also changes it). */
  dprAtCalibration?: number | null;
  adjust: AxisAffine;
  /** Epoch ms (Date.now()) — persisted across sessions, so not performance.now(). */
  trainedAt: number;
  /** Lighting and eyelid appearance at calibration (or the last quick refresh); null when unknown. */
  environment?: CalibrationEnvironment | null;
  /** Distance compensation, applied to the ridge prediction before `adjust`; null/absent: none (older models). */
  depth?: DepthCompensation | null;
  /** Head-pose compensation; null/absent: none (older models). */
  pose?: PoseCompensation | null;
}

const IDENTITY: Readonly<AxisAffine> = Object.freeze({ sx: 1, ox: 0, sy: 1, oy: 0 });

// ─────────────────────────────── The model ───────────────────────────────────

export class RidgeGazeModel implements GazeModel {
  readonly viewport: { width: number; height: number };
  readonly trainedAt: number;
  readonly lambda: number;
  readonly featureLength: number;
  readonly featureSignature: string | null;
  readonly dominantFeatures: readonly number[];
  /** See GazeModelParams.chromeTop. */
  readonly chromeTop: number | null;
  readonly dprAtCalibration: number | null;
  /** Neutralized feature indices (see GAZE_EXCLUDED_FEATURES). */
  readonly excludedFeatures: readonly number[];
  /** Lighting and eyelid appearance at calibration (or the last quick refresh); null when unknown. */
  readonly environment: CalibrationEnvironment | null;
  /** Distance compensation in use, or null (see {@link DepthCompensation}). */
  readonly depthCompensation: Readonly<DepthCompensation> | null;
  /** Head-pose compensation carried by the model, or null (see {@link PoseCompensation}); its gains are 0 until a fit. */
  readonly poseCompensation: Readonly<PoseCompensation> | null;
  private readonly poseActive: boolean;
  private readonly params: GazeModelParams;
  private readonly glitchCheck: readonly number[];
  // Scratch buffers: predict runs at camera rate, so avoid per-call allocation.
  private readonly zBuf: Float64Array;
  private readonly phiBuf: Float64Array;

  constructor(params: GazeModelParams) {
    this.params = params;
    this.viewport = { width: params.viewport.width, height: params.viewport.height };
    this.trainedAt = params.trainedAt;
    this.lambda = params.lambda;
    this.featureLength = params.featureLength;
    this.featureSignature = params.featureSignature;
    this.dominantFeatures = Object.freeze([...params.quad]);
    this.chromeTop = params.chromeTop ?? null;
    this.dprAtCalibration = params.dprAtCalibration ?? null;
    this.glitchCheck = Object.freeze([...(params.glitchCheck ?? params.quad)]);
    this.excludedFeatures = Object.freeze([...(params.excluded ?? [])]);
    this.environment = params.environment ? cloneEnvironment(params.environment) : null;
    this.depthCompensation = params.depth ? Object.freeze({ ...params.depth, camera: { ...params.depth.camera } }) : null;
    this.poseCompensation = params.pose ? Object.freeze(clonePose(params.pose)) : null;
    this.poseActive = !!params.pose && (params.pose.gain.some((g) => g !== 0) || params.pose.rollGain !== 0);
    this.zBuf = new Float64Array(params.featureLength);
    this.phiBuf = new Float64Array(params.expMean.length);
  }

  /** The screen-space correction stacked on top of the ridge maps (identity unless quick-refined). */
  get adjustment(): AxisAffine {
    return { ...this.params.adjust };
  }

  predict(features: EyeFeatures): Point | null {
    const s = this.predictScreen(features);
    if (!s) return null;
    const o = currentScreenOrigin();
    return { x: s.x - o.x, y: s.y - o.y };
  }

  /** Gaze in absolute screen CSS px (viewport px + window origin), or null. */
  predictScreen(features: EyeFeatures | null | undefined): Point | null {
    const v = features?.vector;
    return Array.isArray(v) ? this.predictScreenFromVector(v) : null;
  }

  predictScreenFromVector(v: ArrayLike<number>): Point | null {
    const P = this.params;
    const raw = this.ridgeAt(v);
    if (!raw) return null;
    let sx = raw.x;
    let sy = raw.y;
    // The head's pose since calibration: what it did to the eye features, taken back out.
    const pose = this.poseCompensation;
    let turn = 0;
    if (pose && this.poseActive) {
      const now = poseAngles(v, pose.index);
      if (now) {
        const da = clamp(now.a - pose.ref.a, -pose.maxAngle, pose.maxAngle);
        const db = clamp(now.b - pose.ref.b, -pose.maxAngle, pose.maxAngle);
        sx += pose.gain[0] * da + pose.gain[1] * db;
        sy += pose.gain[2] * da + pose.gain[3] * db;
        turn = pose.rollGain * clamp(now.roll - pose.ref.roll, -pose.maxRoll, pose.maxRoll);
      }
    }
    const depth = this.depthCompensation;
    if (depth) {
      const k = depthRatio(depth, v);
      sx = depth.camera.x + k * (sx - depth.camera.x);
      sy = depth.camera.y + k * (sy - depth.camera.y);
    }
    if (pose && turn !== 0) {
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const dx = sx - pose.camera.x;
      const dy = sy - pose.camera.y;
      sx = pose.camera.x + c * dx - s * dy;
      sy = pose.camera.y + s * dx + c * dy;
    }
    const x = P.adjust.sx * sx + P.adjust.ox;
    const y = P.adjust.sy * sy + P.adjust.oy;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  /** The ridge maps' own answer in screen space: before the pose and distance corrections and `adjust`. */
  private ridgeAt(v: ArrayLike<number>): Point | null {
    const P = this.params;
    if (v.length !== P.featureLength) return null;
    const z = this.zBuf;
    for (let j = 0; j < P.featureLength; j++) {
      const x = v[j];
      if (!Number.isFinite(x)) return null;
      z[j] = (x - P.mean[j]) / P.std[j];
    }
    for (const q of this.glitchCheck) if (Math.abs(z[q]) > Z_REJECT) return null;
    for (let j = 0; j < P.featureLength; j++) z[j] = clamp(z[j], -Z_CLAMP, Z_CLAMP);
    for (const j of this.excludedFeatures) z[j] = 0;

    const phi = this.phiBuf;
    expandInto(z, P.quad, phi);
    for (let k = 0; k < phi.length; k++) phi[k] = (phi[k] - P.expMean[k]) / P.expStd[k];

    const sx = P.bx + dot(P.wx, phi) + P.origin.x;
    const sy = P.by + dot(P.wy, phi) + P.origin.y;
    return Number.isFinite(sx) && Number.isFinite(sy) ? { x: sx, y: sy } : null;
  }

  /**
   * A copy whose pose compensation is fitted to `samples`: frames of the reader looking at one or
   * a few fixed targets while moving their head (see {@link PoseCompensation}). Not ok when the
   * model carries no pose reference, or the samples teach nothing (too few, the head hardly moved,
   * or the fit explains too little): the model is then best left as it is.
   */
  withPoseFit(samples: readonly CalibrationSample[], opts: { maxBlink?: number } = {}): PoseFitOutcome {
    const P = this.params;
    const pose = this.poseCompensation;
    if (!pose) return { ok: false, reason: 'no-reference' };
    let rows: Row[];
    try {
      rows = prepareRows(samples as CalibrationSample[], P.featureLength, opts.maxBlink).rows;
    } catch {
      return { ok: false, reason: 'too-few' };
    }
    const origin = currentScreenOrigin();
    const depth = this.depthCompensation;
    interface Obs {
      key: string;
      da: number;
      db: number;
      dr: number;
      /** What the prediction is short of the target by, in the ridge maps' space (before the distance scaling). */
      rx: number;
      ry: number;
      /** The prediction's place relative to the camera (the arm a tilt turns it on). */
      lx: number;
      ly: number;
    }
    const obs: Obs[] = [];
    for (const row of rows) {
      const raw = this.ridgeAt(row.x);
      const now = poseAngles(row.x, pose.index);
      if (!raw || !now) continue;
      // The target, taken back through `adjust` and the distance scaling into the ridge maps' space.
      let tx = (row.target.x + origin.x - P.adjust.ox) / P.adjust.sx;
      let ty = (row.target.y + origin.y - P.adjust.oy) / P.adjust.sy;
      if (depth) {
        const k = depthRatio(depth, row.x);
        tx = depth.camera.x + (tx - depth.camera.x) / k;
        ty = depth.camera.y + (ty - depth.camera.y) / k;
      }
      obs.push({ key: row.key, da: now.a - pose.ref.a, db: now.b - pose.ref.b, dr: now.roll - pose.ref.roll, rx: tx - raw.x, ry: ty - raw.y, lx: raw.x - pose.camera.x, ly: raw.y - pose.camera.y });
    }
    if (obs.length < POSE_MIN_SAMPLES) return { ok: false, reason: 'too-few' };
    const spread = (values: number[]): number => {
      const sorted = [...values].sort((x, y) => x - y);
      const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
      return (at(0.9) - at(0.1)) / 2;
    };
    const learnA = spread(obs.map((o) => o.da)) >= POSE_MIN_SPREAD;
    const learnB = spread(obs.map((o) => o.db)) >= POSE_MIN_SPREAD;
    const learnRoll = spread(obs.map((o) => o.dr)) >= POSE_MIN_SPREAD;
    if (!learnA && !learnB && !learnRoll) return { ok: false, reason: 'still' };

    // Unknowns: the four gains, the roll gain, and one constant per target and axis (where the
    // reader's eyes really rested on that dot, and the calibration's own error there: not the
    // head's doing, and not to be explained by it).
    const keys = [...new Set(obs.map((o) => o.key))];
    const n = 5 + 2 * keys.length;
    const solve = (use: readonly Obs[]): Float64Array | null => {
      const A = new Float64Array(n * n);
      const y = new Float64Array(n);
      const add = (cols: readonly number[], vals: readonly number[], target: number): void => {
        for (let i = 0; i < cols.length; i++) {
          y[cols[i]] += vals[i] * target;
          for (let j = 0; j < cols.length; j++) A[cols[i] * n + cols[j]] += vals[i] * vals[j];
        }
      };
      for (const o of use) {
        const k = 5 + 2 * keys.indexOf(o.key);
        const a = learnA ? o.da : 0;
        const b = learnB ? o.db : 0;
        const r = learnRoll ? o.dr : 0;
        // x: g0·da + g1·db − rollGain·dr·ly + cx ;  y: g2·da + g3·db + rollGain·dr·lx + cy
        add([0, 1, 4, k], [a, b, -r * o.ly, 1], o.rx);
        add([2, 3, 4, k + 1], [a, b, r * o.lx, 1], o.ry);
      }
      // A whisper of shrinkage keeps the unused columns (and near-collinear ones) solvable.
      for (let i = 0; i < 4; i++) A[i * n + i] += 1e-6 * use.length;
      A[4 * n + 4] += 1e-3 * use.length;
      for (let i = 5; i < n; i++) A[i * n + i] += 1e-9;
      return solveSymmetric(A, y, n);
    };
    const residualOf = (w: Float64Array | null, o: Obs): Point => {
      const k = 5 + 2 * keys.indexOf(o.key);
      return {
        x: o.rx - (w ? w[0] * o.da + w[1] * o.db - w[4] * o.dr * o.ly + w[k] : 0),
        y: o.ry - (w ? w[2] * o.da + w[3] * o.db + w[4] * o.dr * o.lx + w[k + 1] : 0),
      };
    };
    const residual = (w: Float64Array | null, o: Obs): number => {
      const e = residualOf(w, o);
      return Math.hypot(e.x, e.y);
    };
    // The same, over a few frames in a row at a time (the frames come in the order they were
    // taken): the head moves slowly and the tracker's noise doesn't, so this is what the head did
    // to the prediction, with most of the frame-to-frame noise averaged away.
    const smoothed = (w: Float64Array | null, use: readonly Obs[]): number => {
      const sizes: number[] = [];
      for (let i = 0; i < use.length; ) {
        let j = i;
        let x = 0;
        let y = 0;
        while (j < use.length && j - i < POSE_ERROR_BLOCK && use[j].key === use[i].key) {
          const e = residualOf(w, use[j++]);
          x += e.x;
          y += e.y;
        }
        sizes.push(Math.hypot(x, y) / (j - i));
        i = j;
      }
      return mean(sizes);
    };
    let w = solve(obs);
    if (!w) return { ok: false, reason: 'unclear' };
    // Once more without the frames that don't fit (a glance away from the dot, a tracker glitch).
    const first = w;
    const errs = obs.map((o) => residual(first, o));
    const cut = median(errs) + MAD_THRESHOLD * Math.max(robustSd(errs), PREDICTION_MAD_FLOOR_PX);
    const kept = obs.filter((_, i) => errs[i] <= cut);
    if (kept.length >= POSE_MIN_SAMPLES && kept.length < obs.length) w = solve(kept) ?? w;
    if (![w[0], w[1], w[2], w[3]].every((g) => Number.isFinite(g) && Math.abs(g) <= POSE_GAIN_MAX) || !Number.isFinite(w[4])) return { ok: false, reason: 'unclear' };

    // What the head's movement did to the prediction, with and without the fit: against each
    // target's own mean, so neither is charged for where the eyes rested.
    const used = kept.length >= POSE_MIN_SAMPLES ? kept : obs;
    const constants = new Float64Array(n);
    for (const key of keys) {
      const of = used.filter((o) => o.key === key);
      const k = 5 + 2 * keys.indexOf(key);
      constants[k] = mean(of.map((o) => o.rx));
      constants[k + 1] = mean(of.map((o) => o.ry));
    }
    const before = smoothed(constants, used);
    const after = smoothed(w, used);
    if (!(before > 0) || !(after <= (1 - POSE_MIN_GAIN_IN_ERROR) * before)) return { ok: false, reason: 'unclear' };

    const span = (values: number[]): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const next: PoseCompensation = {
      ...clonePose(pose),
      gain: [learnA ? w[0] : 0, learnB ? w[1] : 0, learnA ? w[2] : 0, learnB ? w[3] : 0],
      rollGain: learnRoll ? clamp(w[4], -POSE_ROLL_GAIN_MAX, POSE_ROLL_GAIN_MAX) : 0,
      maxAngle: Math.min(POSE_MAX_ANGLE, POSE_RANGE_FACTOR * Math.max(span(used.map((o) => o.da)), span(used.map((o) => o.db)))),
      maxRoll: Math.min(POSE_MAX_ANGLE, POSE_RANGE_FACTOR * span(used.map((o) => o.dr))),
    };
    return {
      ok: true,
      model: new RidgeGazeModel({ ...P, pose: next }),
      fit: { samples: used.length, learned: { a: learnA, b: learnB, roll: learnRoll }, errorBeforePx: before, errorAfterPx: after },
    };
  }

  /** A copy with a different screen-space correction (quick recalibration). Omitted meta fields are kept. */
  withAdjustment(
    adjust: AxisAffine,
    meta: {
      viewport: { width: number; height: number };
      trainedAt: number;
      chromeTop?: number | null;
      dprAtCalibration?: number | null;
      environment?: CalibrationEnvironment | null;
    },
  ): RidgeGazeModel {
    return new RidgeGazeModel({
      ...this.params,
      adjust: { ...adjust },
      viewport: { ...meta.viewport },
      trainedAt: meta.trainedAt,
      ...(meta.chromeTop !== undefined ? { chromeTop: meta.chromeTop } : {}),
      ...(meta.dprAtCalibration !== undefined ? { dprAtCalibration: meta.dprAtCalibration } : {}),
      ...(meta.environment !== undefined ? { environment: meta.environment } : {}),
    });
  }

  toJSON(): SerializedGazeModel {
    const P = this.params;
    return {
      version: GAZE_MODEL_VERSION,
      kind: GAZE_MODEL_KIND,
      featureLength: P.featureLength,
      featureSignature: P.featureSignature,
      mean: Array.from(P.mean),
      std: Array.from(P.std),
      quad: [...P.quad],
      glitchCheck: [...this.glitchCheck],
      excluded: [...this.excludedFeatures],
      expMean: Array.from(P.expMean),
      expStd: Array.from(P.expStd),
      wx: Array.from(P.wx),
      bx: P.bx,
      wy: Array.from(P.wy),
      by: P.by,
      lambda: P.lambda,
      viewport: { width: P.viewport.width, height: P.viewport.height },
      origin: { x: P.origin.x, y: P.origin.y },
      chromeTop: this.chromeTop,
      dprAtCalibration: this.dprAtCalibration,
      adjust: { ...P.adjust },
      trainedAt: P.trainedAt,
      environment: this.environment ? cloneEnvironment(this.environment) : null,
      depth: this.depthCompensation ? { ...this.depthCompensation, camera: { ...this.depthCompensation.camera } } : null,
      pose: this.poseCompensation ? clonePose(this.poseCompensation) : null,
    };
  }
}

/** What a head-movement step taught (see {@link fitPoseCompensation}). */
export interface PoseFit {
  /** Frames the fit rests on. */
  samples: number;
  /** Which movements were large enough to learn from: across (a turn), up-down (a nod), a tilt. */
  learned: { a: boolean; b: boolean; roll: boolean };
  /** How far the prediction strayed from each dot's mean while the head moved, before and with the fit (mean over quarter-seconds, px). */
  errorBeforePx: number;
  errorAfterPx: number;
}

/**
 * Fits the model's head-pose compensation to frames of the reader looking at fixed targets while
 * moving their head. Returns the model to use and what was learned, or why nothing was.
 */
export function fitPoseCompensation(model: GazeModel, samples: readonly CalibrationSample[], opts: { maxBlink?: number } = {}): PoseFitOutcome {
  return asRidgeGazeModel(model)?.withPoseFit(samples, opts) ?? { ok: false, reason: 'no-reference' };
}

/**
 * Why a head-movement step taught nothing: the model has no pose reference (an older calibration);
 * too few usable frames; the head hardly moved; or the fit doesn't explain what the prediction did
 * (the eyes left the dot, or the tracker lost the face on the way).
 */
export type PoseFitFailure = 'no-reference' | 'too-few' | 'still' | 'unclear';
export type PoseFitOutcome = { ok: true; model: RidgeGazeModel; fit: PoseFit } | { ok: false; reason: PoseFitFailure };

function clonePose(p: Readonly<PoseCompensation>): PoseCompensation {
  return { ref: { ...p.ref }, gain: [...p.gain], rollGain: p.rollGain, maxAngle: p.maxAngle, maxRoll: p.maxRoll, camera: { ...p.camera }, index: [...p.index] };
}

/** The camera's direction in the head's frame and the head's roll, from a feature vector; null when the pose is unusable. */
function poseAngles(v: ArrayLike<number>, index: readonly number[]): { a: number; b: number; roll: number } | null {
  const pose = { yaw: v[index[0]], pitch: v[index[1]], roll: v[index[2]], tx: v[index[3]], ty: v[index[4]], tz: v[index[5]] };
  const angles = cameraAnglesInHead(pose);
  return angles ? { a: angles.a, b: angles.b, roll: pose.roll } : null;
}

const mean = (values: readonly number[]): number => (values.length ? values.reduce((x, y) => x + y, 0) / values.length : NaN);

/** Solves A·x = y for a symmetric positive-definite A (n×n, row-major) by Cholesky; null when it isn't. */
function solveSymmetric(A: Float64Array, y: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = y[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k];
    z[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Distance now / distance at calibration, from the face's size in the image; 1 when it can't be read. */
function depthRatio(depth: Readonly<DepthCompensation>, v: ArrayLike<number>): number {
  const scale = effectiveFaceScale(v, depth.scaleIndex, depth.yawIndex);
  return scale > 0 ? clamp(depth.ref / scale, DEPTH_RATIO_MIN, DEPTH_RATIO_MAX) : 1;
}

/** faceScale with the foreshortening of a turned head taken out; NaN when unusable. */
function effectiveFaceScale(v: ArrayLike<number>, scaleIndex: number, yawIndex: number): number {
  const s = v[scaleIndex];
  if (!(s > 0) || !Number.isFinite(s)) return NaN;
  const yaw = yawIndex >= 0 ? v[yawIndex] : 0;
  return Number.isFinite(yaw) ? s / Math.cos(clamp(yaw, -DEPTH_MAX_YAW, DEPTH_MAX_YAW)) : s;
}

// ──────────────────────────────── Training ───────────────────────────────────

interface Row {
  target: Point;
  x: Float64Array;
  key: string;
  /** The sample the row came from (for the eyelid-appearance baseline). */
  source: CalibrationSample;
}

interface Group {
  target: Point;
  /** Indices into the row array the group was built from. */
  rows: number[];
}

interface ColumnStats {
  mean: Float64Array;
  std: Float64Array;
  constant: Uint8Array;
  /** Neutralized columns: standardized to 0 whatever the value. */
  excluded: Uint8Array;
}

export function trainGazeModel(samples: CalibrationSample[], opts: TrainOptions = {}): TrainResult {
  const prepared = prepareRows(samples, undefined, opts.maxBlink);
  const p = prepared.featureLength;
  // A signature over the wrong number of names would make every reload reject the model.
  if (opts.featureNames && opts.featureNames.length !== p) {
    throw new RangeError(`featureNames lists ${opts.featureNames.length} features but the vectors have ${p}.`);
  }
  let rows = prepared.rows;
  const initialGroups = groupRows(rows);
  if (initialGroups.length < MIN_TARGETS) {
    throw new Error(`Need at least ${MIN_TARGETS} calibration points with usable samples (got ${initialGroups.length}).`);
  }
  const qWanted = Math.max(0, Math.floor(opts.quadraticFeatures ?? DEFAULT_QUADRATIC_FEATURES));
  // Quadratic terms need several distinct targets to be identifiable at all.
  const qMax = Math.min(qWanted, Math.max(0, initialGroups.length - 3));

  // Posture features enter linearly only (see POSTURE_FEATURES); excluded ones not at all.
  const excluded = excludedMask(p, opts.featureNames, opts.excludedFeatures);
  const noQuad = Uint8Array.from(excluded);
  if (opts.featureNames) {
    opts.featureNames.forEach((name, j) => {
      if (POSTURE_FEATURES.has(name)) noQuad[j] = 1;
    });
  }

  let stats = columnStats(rows, p, excluded);
  let dominant = selectDominant(rows, stats, qMax, noQuad);
  let rejected = 0;
  if (opts.rejectOutliers !== false && dominant.length > 0) {
    const keep = rejectOutliers(rows, initialGroups, stats, dominant);
    rejected = rows.length - keep.length;
    if (rejected > 0) {
      rows = keep.map((i) => rows[i]);
      stats = columnStats(rows, p, excluded);
      dominant = selectDominant(rows, stats, qMax, noQuad);
    }
  }
  const groups = groupRows(rows);
  if (groups.length < MIN_TARGETS || rows.length < MIN_SAMPLES) {
    throw new Error('Not enough usable calibration samples — keep your eyes on the dots and try again.');
  }

  // Expanded, standardized design matrix (row-major n × D).
  const n = rows.length;
  const D = p + (dominant.length * (dominant.length + 1)) / 2;
  const design = new Float64Array(n * D);
  const z = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    standardizeInto(rows[i].x, stats, z);
    expandInto(z, dominant, design.subarray(i * D, (i + 1) * D));
  }
  const exp = standardizeColumns(design, n, D);

  const groupEqs = groups.map((g) => {
    const eq = new RidgeNormalEquations(D, 2);
    const y = new Float64Array(2);
    for (const i of g.rows) {
      y[0] = rows[i].target.x;
      y[1] = rows[i].target.y;
      eq.add(design.subarray(i * D, (i + 1) * D), y);
    }
    return eq;
  });
  const total = new RidgeNormalEquations(D, 2);
  for (const eq of groupEqs) total.merge(eq);
  const folds = groupEqs.map((eq) => total.clone().merge(eq, -1));

  const lambdas = sanitizeLambdas(opts.lambdas);
  const cv = lambdas.map((lambda) => {
    let sum = 0;
    for (let g = 0; g < groups.length; g++) {
      const sol = folds[g].solve(lambda);
      let err = 0;
      for (const i of groups[g].rows) {
        const off = i * D;
        const px = sol.bias[0] + dotAt(sol.weights[0], design, off, D);
        const py = sol.bias[1] + dotAt(sol.weights[1], design, off, D);
        err += Math.hypot(px - rows[i].target.x, py - rows[i].target.y);
      }
      sum += err / groups[g].rows.length;
    }
    return { lambda, errorPx: sum / groups.length };
  });
  const lambda = chooseLambda(cv);

  const final = total.solve(lambda);
  const viewport = resolveViewport(opts.viewport, rows);
  const trainedAt = Date.now();
  const excludedIndices = maskIndices(excluded);
  const origin = currentScreenOrigin();
  const model = new RidgeGazeModel({
    featureLength: p,
    featureSignature: opts.featureNames ? featureSignature(opts.featureNames) : null,
    mean: stats.mean,
    std: stats.std,
    quad: dominant,
    glitchCheck: glitchCheckFor(dominant, opts.featureNames),
    excluded: excludedIndices,
    expMean: exp.mean,
    expStd: exp.std,
    wx: final.weights[0],
    bx: final.bias[0],
    wy: final.weights[1],
    by: final.bias[1],
    lambda,
    viewport,
    origin,
    chromeTop: currentChromeTop(),
    dprAtCalibration: currentDevicePixelRatio(),
    adjust: { ...IDENTITY },
    trainedAt,
    depth: depthCompensationFor(rows, excluded, viewport, origin, opts),
    pose: poseReferenceFor(rows, excluded, viewport, origin, opts),
    environment: {
      lighting: sanitizeLightingSignature(opts.environment?.lighting ?? null),
      // From the samples the model was fitted on (blinks and glances away already dropped).
      appearance: computeAppearanceBaseline(
        rows.map((r) => r.source),
        viewport.height,
      ),
      capturedAt: trainedAt,
    },
  });

  // Honest report: every target predicted by the fold that held it out.
  const points = groups.map((g, gi) => {
    const sol = folds[gi].solve(lambda);
    const preds = g.rows.map((i) => {
      const off = i * D;
      return {
        x: sol.bias[0] + dotAt(sol.weights[0], design, off, D),
        y: sol.bias[1] + dotAt(sol.weights[1], design, off, D),
      };
    });
    return { target: g.target, preds };
  });
  const report = buildReport(points, lambda, viewport.height, false);

  return {
    model,
    report,
    diagnostics: {
      cv,
      droppedInvalid: prepared.dropped,
      rejectedOutliers: rejected,
      dominantFeatures: [...dominant],
      excludedFeatures: excludedIndices,
      expandedDim: D,
      targets: groups.length,
    },
  };
}

/**
 * Quick recalibration: keeps the base model's ridge maps and fits only a
 * screen-space offset (plus, optionally, a heavily shrunk per-axis scale) from
 * a handful of targets — enough to absorb "I'm sitting a bit differently
 * today". The report is leave-one-target-out when there are ≥ 3 targets.
 */
export function refineGazeModel(
  base: GazeModel,
  samples: CalibrationSample[],
  opts: RefineOptions = {},
): { model: RidgeGazeModel; report: CalibrationReport } {
  const inner = asRidgeGazeModel(base);
  if (!inner) throw new Error('This calibration can’t be refined — please run a full calibration.');
  const { rows } = prepareRows(samples, inner.featureLength, opts.maxBlink);
  const origin = currentScreenOrigin();
  const fitScale = opts.fitScale ?? true;
  const kappa = Math.max(0, opts.scaleShrinkage ?? DEFAULT_SCALE_SHRINKAGE);

  const obs: RefinePoint[] = [];
  for (const g of groupRows(rows)) {
    const preds: Point[] = [];
    for (const i of g.rows) {
      const s = inner.predictScreenFromVector(rows[i].x);
      if (s) preds.push(s);
    }
    const kept = robustPoints(preds);
    if (kept.length === 0) continue;
    obs.push({
      target: g.target,
      targetScreen: { x: g.target.x + origin.x, y: g.target.y + origin.y },
      preds: kept,
      mean: meanPoint(kept),
    });
  }
  if (obs.length === 0) throw new Error('No usable samples for a quick calibration.');

  const fit = fitAffine(obs, fitScale, kappa);
  const old = inner.adjustment;
  const composed: AxisAffine = {
    sx: fit.sx * old.sx,
    ox: fit.sx * old.ox + fit.ox,
    sy: fit.sy * old.sy,
    oy: fit.sy * old.oy + fit.oy,
  };
  const viewport = resolveViewport(opts.viewport, rows);
  const trainedAt = Date.now();
  // The refresh re-fits the offset in the current window layout and light, so both are the new reference.
  const model = inner.withAdjustment(composed, {
    viewport,
    trainedAt,
    chromeTop: currentChromeTop(),
    dprAtCalibration: currentDevicePixelRatio(),
    environment: {
      lighting: sanitizeLightingSignature(opts.environment?.lighting ?? null),
      appearance: computeAppearanceBaseline(
        rows.map((r) => r.source),
        viewport.height,
      ),
      capturedAt: trainedAt,
    },
  });

  const points = obs.map((o, h) => {
    const f = obs.length >= 3 ? fitAffine(obs.filter((_, k) => k !== h), fitScale, kappa) : fit;
    return {
      target: o.target,
      preds: o.preds.map((p) => ({ x: f.sx * p.x + f.ox - origin.x, y: f.sy * p.y + f.oy - origin.y })),
    };
  });
  return { model, report: buildReport(points, inner.lambda, viewport.height, false) };
}

/**
 * Accuracy of `model` on `samples` (e.g. validation targets it never saw).
 * Per target, predictions are robustly filtered (same 2.5-MAD rule) and
 * averaged; the error is the distance of that mean from the target — the
 * standard "accuracy" measure in eye tracking. With nothing evaluable the
 * errors are NaN, `sampleCount` is 0 and quality is 'poor'.
 */
export function evaluateModel(model: GazeModel, samples: readonly CalibrationSample[], opts: EvaluateOptions = {}): CalibrationReport {
  const maxBlink = blinkCutoff(opts.maxBlink);
  const groups = new Map<string, { target: Point; preds: Point[] }>();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || !isFinitePoint(s.target) || !s.features) continue;
    if (s.features.blink > maxBlink) continue;
    let p: Point | null = null;
    try {
      p = model.predict(s.features);
    } catch {
      p = null;
    }
    if (!p || !isFinitePoint(p)) continue;
    const key = targetKey(s.target);
    let g = groups.get(key);
    if (!g) {
      g = { target: { x: s.target.x, y: s.target.y }, preds: [] };
      groups.set(key, g);
    }
    g.preds.push({ x: p.x, y: p.y });
  }
  const vh = model.viewport && Number.isFinite(model.viewport.height) ? model.viewport.height : 0;
  return buildReport([...groups.values()], modelLambda(model), vh, true);
}

/**
 * Systematic offset of `model` on a few fixation targets (the accuracy check): the mean over
 * targets of (mean prediction − target), plus the mean error. Each target's predictions are
 * filtered like {@link evaluateModel} (blinks by `maxBlink`, then the 2.5-MAD rule), so a few
 * glances away or tracker glitches don't move it. With nothing evaluable everything is NaN, n 0.
 */
export function measureOffset(model: GazeModel, samples: readonly CalibrationSample[], opts: EvaluateOptions = {}): OffsetMeasurement {
  const report = evaluateModel(model, samples, opts);
  const k = report.perPoint.length;
  if (k === 0) return { meanErrorPx: NaN, offsetXPx: NaN, offsetYPx: NaN, n: 0, targets: 0 };
  let dx = 0;
  let dy = 0;
  for (const p of report.perPoint) {
    dx += p.meanPrediction.x - p.target.x;
    dy += p.meanPrediction.y - p.target.y;
  }
  return { meanErrorPx: report.meanErrorPx, offsetXPx: dx / k, offsetYPx: dy / k, n: report.sampleCount, targets: k };
}

/** Fewer samples than this with a usable lid aperture: no appearance baseline. */
const MIN_APPEARANCE_SAMPLES = 10;

/**
 * How the reader's eyelids looked while calibrating, so that squinting (bright light, glare) or
 * wide eyes (dim light) can be recognised later. Lid aperture also follows vertical gaze (the
 * upper lid drops as the eyes look down), so openness is fitted as a line in the target's
 * height on the page: openness ≈ opennessAt0 + opennessSlope × (target.y / viewportHeight).
 *
 * Robust throughout: each target contributes the median openness of its samples (blinks and
 * half-blinks don't move a median), the slope is the Theil–Sen median of pairwise slopes between
 * targets at different heights, the intercept is the median of what each target implies, and
 * the spreads are 1.4826 × MAD. `opennessResidualSd` is per frame (a median over m frames
 * varies ~1.25/√m of it). `squintMedian`/`squintSd` come from EyeFeatures.squint (0 and 0 when
 * no sample carries one). Null without a positive viewport height or with fewer than
 * {@link MIN_APPEARANCE_SAMPLES} samples.
 */
export function computeAppearanceBaseline(samples: readonly CalibrationSample[], viewportHeight: number): AppearanceBaseline | null {
  if (!Array.isArray(samples) || !isPositive(viewportHeight)) return null;
  const byTarget = new Map<string, { y: number; open: number[] }>();
  const points: { y: number; open: number }[] = [];
  const squints: number[] = [];
  for (const s of samples as readonly unknown[]) {
    if (!isRecord(s) || !isFinitePoint(s.target) || !isRecord(s.features)) continue;
    const open = s.features.openness;
    if (!isFiniteNumber(open) || open < 0) continue;
    const y = s.target.y / viewportHeight;
    points.push({ y, open });
    const key = targetKey(s.target);
    let g = byTarget.get(key);
    if (!g) {
      g = { y, open: [] };
      byTarget.set(key, g);
    }
    g.open.push(open);
    const squint = s.features.squint;
    if (isFiniteNumber(squint)) squints.push(clamp(squint, 0, 1));
  }
  if (points.length < MIN_APPEARANCE_SAMPLES) return null;

  const targets = [...byTarget.values()].map((g) => ({ y: g.y, open: median(g.open) }));
  const slopes: number[] = [];
  for (let a = 0; a < targets.length; a++) {
    for (let b = a + 1; b < targets.length; b++) {
      const dy = targets[b].y - targets[a].y;
      // Targets on the same row say nothing about the slope.
      if (Math.abs(dy) > 0.02) slopes.push((targets[b].open - targets[a].open) / dy);
    }
  }
  const slope = slopes.length > 0 ? median(slopes) : 0;
  const at0 = median(targets.map((t) => t.open - slope * t.y));
  const residuals = points.map((p) => p.open - (at0 + slope * p.y));
  const squintMedian = squints.length > 0 ? median(squints) : 0;
  return {
    v: 1,
    n: points.length,
    opennessAt0: at0,
    opennessSlope: slope,
    opennessResidualSd: robustSd(residuals),
    squintMedian,
    squintSd: squints.length > 0 ? robustSd(squints) : 0,
  };
}

/**
 * Maps a mean error to a quality badge.
 *
 * Two yardsticks, and the worse one wins:
 *
 * • Lines of text at the reader's line pitch (`linePitchPx`; 22 px × 1.9 ≈ 42 px,
 *   the app default, when it is unknown). At a normal laptop
 *   viewing distance one line is roughly 1° of visual angle, about the best a
 *   webcam tracker can do.
 *   – excellent ≤ 1.25 lines: raw gaze alone nearly pins the line.
 *   – good ≤ 2.25 lines: well inside the line tracker's comfort zone (its σ_y
 *     starts at 0.9 lines and adapts up to 3), return sweeps do the rest.
 *   – fair ≤ 3.5 lines: tracking leans on reading structure and the
 *     bottom-dwell / glance-down fallbacks; page turns work but may lag.
 *   – beyond that the HMM can no longer tell neighbouring lines apart: poor.
 *
 * • Fraction of the viewport height (7 % / 13 % / 22 %). Page-end detection
 *   must separate "the last lines" from "the middle of the page"; on a short
 *   window the same pixel error covers more of the page. The two scales agree
 *   near a 720 px viewport (~17 lines), so on bigger screens the line rule
 *   governs and on small windows the viewport rule does.
 */
export function qualityFromError(
  errorPx: number,
  viewportHeight: number,
  linePitchPx: number = DEFAULT_LINE_PITCH_PX,
): CalibrationQuality {
  if (!Number.isFinite(errorPx) || errorPx < 0) return 'poor';
  const pitch = Number.isFinite(linePitchPx) && linePitchPx >= 8 ? linePitchPx : DEFAULT_LINE_PITCH_PX;
  const lines = errorPx / pitch;
  let rank = lines <= 1.25 ? 0 : lines <= 2.25 ? 1 : lines <= 3.5 ? 2 : 3;
  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    const frac = errorPx / viewportHeight;
    rank = Math.max(rank, frac <= 0.07 ? 0 : frac <= 0.13 ? 1 : frac <= 0.22 ? 2 : 3);
  }
  return QUALITY_BY_RANK[rank];
}

const QUALITY_BY_RANK: readonly CalibrationQuality[] = ['excellent', 'good', 'fair', 'poor'];

// ───────────────────────────── Persistence ───────────────────────────────────

/** Validates untrusted JSON (storage, extension messages). Null if invalid or incompatible. */
export function deserializeGazeModel(json: unknown, expect: ModelCompatibility = {}): RidgeGazeModel | null {
  try {
    if (!isRecord(json) || json.version !== GAZE_MODEL_VERSION || json.kind !== GAZE_MODEL_KIND) return null;
    const featureLength = json.featureLength;
    if (typeof featureLength !== 'number' || !Number.isInteger(featureLength) || featureLength < 1) return null;
    if (expect.featureLength !== undefined && expect.featureLength !== featureLength) return null;

    const sig = json.featureSignature;
    if (sig !== undefined && sig !== null && typeof sig !== 'string') return null;
    if (expect.featureNames) {
      if (expect.featureNames.length !== featureLength) return null;
      if (typeof sig === 'string' && sig !== featureSignature(expect.featureNames)) return null;
    }

    const mean = finiteVector(json.mean, featureLength);
    const std = finiteVector(json.std, featureLength, true);
    const quad = indexList(json.quad, featureLength);
    if (!mean || !std || !quad) return null;
    // Models saved before the field existed: derive it from the running build's feature names.
    const glitchCheck = json.glitchCheck === undefined ? glitchCheckFor(quad, expect.featureNames) : indexList(json.glitchCheck, featureLength);
    if (!glitchCheck) return null;
    const excluded = json.excluded === undefined ? [] : indexList(json.excluded, featureLength);
    if (!excluded) return null;
    const D = featureLength + (quad.length * (quad.length + 1)) / 2;
    const expMean = finiteVector(json.expMean, D);
    const expStd = finiteVector(json.expStd, D, true);
    const wx = finiteVector(json.wx, D);
    const wy = finiteVector(json.wy, D);
    if (!expMean || !expStd || !wx || !wy) return null;

    const bx = json.bx;
    const by = json.by;
    const lambda = json.lambda;
    const trainedAt = json.trainedAt;
    if (!isFiniteNumber(bx) || !isFiniteNumber(by) || !isFiniteNumber(trainedAt)) return null;
    if (!isFiniteNumber(lambda) || lambda < 0) return null;

    const vp = json.viewport;
    if (!isRecord(vp) || !isPositive(vp.width) || !isPositive(vp.height)) return null;
    const origin = json.origin;
    if (!isRecord(origin) || !isFiniteNumber(origin.x) || !isFiniteNumber(origin.y)) return null;

    // Models saved before these fields existed: null, which skips the window-layout check.
    const chromeTop = isFiniteNumber(json.chromeTop) && json.chromeTop >= 0 ? json.chromeTop : null;
    const dprAtCalibration = isPositive(json.dprAtCalibration) ? json.dprAtCalibration : null;

    let adjust: AxisAffine = { ...IDENTITY };
    if (json.adjust !== undefined) {
      const a = json.adjust;
      if (!isRecord(a) || !isPositive(a.sx) || !isPositive(a.sy) || !isFiniteNumber(a.ox) || !isFiniteNumber(a.oy)) {
        return null;
      }
      adjust = { sx: a.sx, ox: a.ox, sy: a.sy, oy: a.oy };
    }

    return new RidgeGazeModel({
      featureLength,
      featureSignature: typeof sig === 'string' ? sig : null,
      mean,
      std,
      quad,
      glitchCheck,
      excluded,
      expMean,
      expStd,
      wx,
      bx,
      wy,
      by,
      lambda,
      viewport: { width: vp.width, height: vp.height },
      origin: { x: origin.x, y: origin.y },
      chromeTop,
      dprAtCalibration,
      adjust,
      trainedAt,
      // Unknown, missing or damaged conditions never cost the reader their calibration.
      environment: sanitizeEnvironment(json.environment),
      depth: sanitizeDepth(json.depth, featureLength),
      pose: sanitizePose(json.pose, featureLength),
    });
  } catch {
    return null;
  }
}

/**
 * True when `json` is a gaze model this app saved but the running build can no longer use: an
 * older (or newer) model kind or version, or a different feature layout. The app then explains
 * "the tracker was upgraded, please calibrate once more" instead of silently starting over.
 * False for nothing, garbage, foreign JSON and current models. Works on the extension's stored
 * JSON too (extra fields are ignored).
 */
export function calibrationUpgradeNeeded(json: unknown): boolean {
  if (!isRecord(json) || typeof json.version !== 'number') return false;
  const kind = json.kind;
  if (typeof kind !== 'string' || !kind.startsWith(GAZE_MODEL_KIND_FAMILY)) return false;
  if (kind !== GAZE_MODEL_KIND || json.version !== GAZE_MODEL_VERSION) return true;
  if (typeof json.featureLength === 'number' && json.featureLength !== FEATURE_NAMES.length) return true;
  return typeof json.featureSignature === 'string' && json.featureSignature !== featureSignature(FEATURE_NAMES);
}

/** {@link calibrationUpgradeNeeded} for the calibration saved by {@link saveCalibration}. */
export function savedCalibrationNeedsUpgrade(): boolean {
  return calibrationUpgradeNeeded(readJSON<unknown>(CALIBRATION_STORAGE_KEY, null));
}

export function saveCalibration(model: GazeModel): void {
  writeJSON(CALIBRATION_STORAGE_KEY, model.toJSON());
}

/** Loads the saved model; null when missing, corrupt or built for different features. */
export function loadCalibration(expect: ModelCompatibility = {}): RidgeGazeModel | null {
  return deserializeGazeModel(readJSON<unknown>(CALIBRATION_STORAGE_KEY, null), expect);
}

export function clearCalibration(): void {
  removeKey(CALIBRATION_STORAGE_KEY);
}

/** The model as our concrete class (directly or via a JSON round trip), or null. */
export function asRidgeGazeModel(model: GazeModel | null | undefined): RidgeGazeModel | null {
  if (!model) return null;
  if (model instanceof RidgeGazeModel) return model;
  try {
    return deserializeGazeModel(model.toJSON());
  } catch {
    return null;
  }
}

/** Stable signature of a feature-name list (FNV-1a over the names, plus the count). */
export function featureSignature(names: readonly string[]): string {
  let h = 0x811c9dc5;
  const text = names.join('\u001f');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}:${names.length}`;
}

/** window.screenX/Y (CSS px), or 0,0 when there is no window (tests, workers). */
export function currentScreenOrigin(): Point {
  if (typeof window === 'undefined' || !window) return { x: 0, y: 0 };
  const w: Partial<Pick<Window, 'screenX' | 'screenY' | 'screenLeft' | 'screenTop'>> = window;
  return { x: firstFinite(w.screenX, w.screenLeft), y: firstFinite(w.screenY, w.screenTop) };
}

/**
 * Height of the browser chrome above the viewport (tab strip, toolbar, bookmarks bar), in CSS
 * px: outerHeight − innerHeight. Null in iframes (the frame's position is unknown) or when the
 * browser reports nothing usable. Only used to *detect* a moved viewport, never to compensate.
 */
export function currentChromeTop(): number | null {
  if (typeof window === 'undefined' || !window) return null;
  try {
    if (window.top !== window) return null;
  } catch {
    return null;
  }
  const d = window.outerHeight - window.innerHeight;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/**
 * Where the camera is taken to be, in the model's screen space (viewport px + `origin`): just above
 * the middle of the top edge of the screen the window is on. The model's space puts the viewport's
 * top at `origin.y` (the window's top), so the chrome height is taken off as well. Without a
 * window (tests, benches) or a usable screen: above the middle of the viewport.
 */
function assumedCameraPoint(viewport: { width: number; height: number }, origin: Point): Point {
  const fallback = { x: origin.x + viewport.width / 2, y: origin.y - ASSUMED_CHROME_TOP_PX - CAMERA_ABOVE_SCREEN_PX };
  if (typeof window === 'undefined' || !window) return fallback;
  const sc: Partial<Pick<Screen, 'width'>> & { availLeft?: number; availTop?: number } = window.screen ?? {};
  const chrome = currentChromeTop();
  return {
    x: isPositive(sc.width) ? firstFinite(sc.availLeft) + sc.width / 2 : fallback.x,
    y: chrome !== null ? firstFinite(sc.availTop) - Math.min(chrome, MAX_CHROME_TOP_PX) - CAMERA_ABOVE_SCREEN_PX : fallback.y,
  };
}

/** The distance compensation a freshly trained model gets, or null (see TrainOptions.depthCompensation). */
function depthCompensationFor(
  rows: readonly Row[],
  excluded: Uint8Array,
  viewport: { width: number; height: number },
  origin: Point,
  opts: TrainOptions,
): DepthCompensation | null {
  const names = opts.featureNames;
  if (!names || opts.depthCompensation === false) return null;
  const scaleIndex = names.indexOf('faceScale');
  // A regression that fits its own weight to faceScale would be corrected twice.
  if (scaleIndex < 0 || (!excluded[scaleIndex] && opts.depthCompensation !== true)) return null;
  const yawIndex = names.indexOf('yaw');
  const scales: number[] = [];
  for (const r of rows) {
    const s = effectiveFaceScale(r.x, scaleIndex, yawIndex);
    if (s > 0) scales.push(s);
  }
  const ref = median(scales);
  if (!isPositive(ref)) return null;
  const c = opts.camera;
  const camera = c && isFinitePoint(c) ? { x: c.x + origin.x, y: c.y + origin.y } : assumedCameraPoint(viewport, origin);
  return { ref, camera, scaleIndex, yawIndex };
}

/** The pose reference a freshly trained model gets (gains 0: see {@link PoseCompensation}), or null. */
function poseReferenceFor(
  rows: readonly Row[],
  excluded: Uint8Array,
  viewport: { width: number; height: number },
  origin: Point,
  opts: TrainOptions,
): PoseCompensation | null {
  const names = opts.featureNames;
  if (!names || opts.poseCompensation === false) return null;
  const index = (['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz'] as const).map((n) => names.indexOf(n));
  // A regression that fits its own weights to the pose would be corrected twice.
  if (index.some((i) => i < 0 || !excluded[i])) return null;
  const a: number[] = [];
  const b: number[] = [];
  const roll: number[] = [];
  for (const r of rows) {
    const now = poseAngles(r.x, index);
    if (!now) continue;
    a.push(now.a);
    b.push(now.b);
    roll.push(now.roll);
  }
  if (a.length < MIN_SAMPLES) return null;
  const c = opts.camera;
  const camera = c && isFinitePoint(c) ? { x: c.x + origin.x, y: c.y + origin.y } : assumedCameraPoint(viewport, origin);
  return {
    ref: { a: median(a), b: median(b), roll: median(roll) },
    gain: [0, 0, 0, 0],
    rollGain: 0,
    maxAngle: 0,
    maxRoll: 0,
    camera,
    index: index as PoseCompensation['index'],
  };
}

/** A validated copy of a stored pose compensation; null when absent or damaged (never a reason to drop the model). */
function sanitizePose(v: unknown, featureLength: number): PoseCompensation | null {
  if (!isRecord(v) || !isRecord(v.ref) || !isFinitePoint(v.camera)) return null;
  const { a, b, roll } = v.ref;
  if (!isFiniteNumber(a) || !isFiniteNumber(b) || !isFiniteNumber(roll)) return null;
  const index = v.index;
  if (!Array.isArray(index) || index.length !== 6 || !index.every((i) => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < featureLength)) return null;
  const gain = v.gain;
  if (!Array.isArray(gain) || gain.length !== 4 || !gain.every((g) => isFiniteNumber(g) && Math.abs(g) <= POSE_GAIN_MAX)) return null;
  if (!isFiniteNumber(v.rollGain) || Math.abs(v.rollGain) > POSE_ROLL_GAIN_MAX) return null;
  if (!isFiniteNumber(v.maxAngle) || v.maxAngle < 0 || !isFiniteNumber(v.maxRoll) || v.maxRoll < 0) return null;
  return {
    ref: { a, b, roll },
    gain: gain as PoseCompensation['gain'],
    rollGain: v.rollGain,
    maxAngle: Math.min(v.maxAngle, POSE_MAX_ANGLE),
    maxRoll: Math.min(v.maxRoll, POSE_MAX_ANGLE),
    camera: { x: v.camera.x, y: v.camera.y },
    index: index as PoseCompensation['index'],
  };
}

/** A validated copy of a stored distance compensation; null when absent or damaged (never a reason to drop the model). */
function sanitizeDepth(v: unknown, featureLength: number): DepthCompensation | null {
  if (!isRecord(v) || !isPositive(v.ref) || !isFinitePoint(v.camera)) return null;
  const { scaleIndex, yawIndex } = v;
  if (typeof scaleIndex !== 'number' || !Number.isInteger(scaleIndex) || scaleIndex < 0 || scaleIndex >= featureLength) return null;
  if (typeof yawIndex !== 'number' || !Number.isInteger(yawIndex) || yawIndex < -1 || yawIndex >= featureLength) return null;
  return { ref: v.ref, camera: { x: v.camera.x, y: v.camera.y }, scaleIndex, yawIndex };
}

function currentDevicePixelRatio(): number | null {
  if (typeof window === 'undefined' || !window) return null;
  const r = window.devicePixelRatio;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The chrome height the model was calibrated with, when it is still comparable with
 * {@link currentChromeTop}: null for old models, other model classes, or after a zoom
 * change ({@link modelZoomChanged} covers that case).
 */
export function modelChromeTop(model: GazeModel | null | undefined): number | null {
  if (!(model instanceof RidgeGazeModel) || model.chromeTop === null) return null;
  const dpr = currentDevicePixelRatio();
  if (model.dprAtCalibration !== null && dpr !== null && Math.abs(dpr - model.dprAtCalibration) > 1e-3) return null;
  return model.chromeTop;
}

/**
 * True when the page zoom (or the screen's scale) is not the one the model was calibrated at: the
 * device pixel ratio changed. Predictions are in calibration-time CSS px, so one zoom step (90 %,
 * 110 %) scales them by about a tenth about the viewport's corner, while the viewport size changes
 * by less than the size check tolerates. False for old models and other model classes.
 */
export function modelZoomChanged(model: GazeModel | null | undefined): boolean {
  if (!(model instanceof RidgeGazeModel) || model.dprAtCalibration === null) return false;
  const dpr = currentDevicePixelRatio();
  return dpr !== null && Math.abs(dpr - model.dprAtCalibration) > 1e-3;
}

// ─────────────────────────────── Internals ───────────────────────────────────

function prepareRows(
  samples: readonly CalibrationSample[],
  expectedLength?: number,
  maxBlinkOption?: number,
): { rows: Row[]; featureLength: number; dropped: number } {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('No calibration samples.');
  const maxBlink = blinkCutoff(maxBlinkOption);
  let len = expectedLength ?? -1;
  const rows: Row[] = [];
  let dropped = 0;
  for (const s of samples) {
    const v: unknown = s?.features?.vector;
    if (!Array.isArray(v)) {
      dropped++;
      continue;
    }
    if (len < 0) len = v.length;
    if (v.length !== len) {
      throw new RangeError(
        expectedLength !== undefined
          ? `Feature vector has ${v.length} entries but the model expects ${expectedLength}.`
          : `Calibration samples have inconsistent feature lengths (${v.length} vs ${len}).`,
      );
    }
    // A missing (NaN) blink score compares false and keeps the sample.
    if (!isFinitePoint(s.target) || s.features.blink > maxBlink) {
      dropped++;
      continue;
    }
    const x = new Float64Array(len);
    let ok = true;
    for (let j = 0; j < len; j++) {
      const value: unknown = v[j];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        ok = false;
        break;
      }
      x[j] = value;
    }
    if (!ok) {
      dropped++;
      continue;
    }
    rows.push({ target: { x: s.target.x, y: s.target.y }, x, key: targetKey(s.target), source: s });
  }
  if (len <= 0) throw new Error('Calibration samples carry no features.');
  return { rows, featureLength: len, dropped };
}

/** A caller's blink cutoff, or MAX_BLINK when absent/NaN (Infinity keeps everything). */
function blinkCutoff(v: number | undefined): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : MAX_BLINK;
}

function targetKey(t: Point): string {
  return `${Math.round(t.x)},${Math.round(t.y)}`;
}

function groupRows(rows: readonly Row[]): Group[] {
  const map = new Map<string, Group>();
  rows.forEach((r, i) => {
    let g = map.get(r.key);
    if (!g) {
      g = { target: { x: r.target.x, y: r.target.y }, rows: [] };
      map.set(r.key, g);
    }
    g.rows.push(i);
  });
  return [...map.values()];
}

/** 1 for every feature the gaze model must not use: named in `excluded` (default GAZE_EXCLUDED_FEATURES). */
function excludedMask(p: number, names: readonly string[] | undefined, excluded: Iterable<string> | undefined): Uint8Array {
  const mask = new Uint8Array(p);
  if (!names) return mask;
  const set: ReadonlySet<string> = excluded === undefined ? GAZE_EXCLUDED_FEATURES : new Set(excluded);
  names.forEach((name, j) => {
    if (j < p && set.has(name)) mask[j] = 1;
  });
  return mask;
}

function maskIndices(mask: Uint8Array): number[] {
  const out: number[] = [];
  mask.forEach((v, j) => {
    if (v) out.push(j);
  });
  return out;
}

function columnStats(rows: readonly Row[], p: number, excluded: Uint8Array): ColumnStats {
  const n = rows.length;
  const mean = new Float64Array(p);
  const std = new Float64Array(p);
  const constant = new Uint8Array(p);
  for (const r of rows) for (let j = 0; j < p; j++) mean[j] += r.x[j];
  for (let j = 0; j < p; j++) mean[j] /= Math.max(n, 1);
  for (const r of rows) {
    for (let j = 0; j < p; j++) {
      const d = r.x[j] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < p; j++) {
    const sd = Math.sqrt(std[j] / Math.max(n, 1));
    // A (numerically) constant feature carries no information; dividing by
    // its ~0 SD would turn rounding noise into huge z-scores.
    if (!(sd > 1e-9 * Math.max(1, Math.abs(mean[j])))) {
      std[j] = 1;
      constant[j] = 1;
    } else {
      std[j] = sd;
    }
  }
  return { mean, std, constant, excluded };
}

function standardizeInto(x: ArrayLike<number>, stats: ColumnStats, out: Float64Array): void {
  for (let j = 0; j < out.length; j++) {
    out[j] = stats.excluded[j] ? 0 : clamp((x[j] - stats.mean[j]) / stats.std[j], -Z_CLAMP, Z_CLAMP);
  }
}

/** [z, z_a·z_b for a ≤ b over the dominant features] → out (length p + q(q+1)/2). */
function expandInto(z: Float64Array, quad: readonly number[], out: Float64Array): void {
  out.set(z);
  let k = z.length;
  for (let a = 0; a < quad.length; a++) {
    const za = z[quad[a]];
    for (let b = a; b < quad.length; b++) out[k++] = za * z[quad[b]];
  }
}

/** Standardizes the columns of a row-major n × D matrix in place; returns the column stats. */
function standardizeColumns(m: Float64Array, n: number, D: number): { mean: Float64Array; std: Float64Array } {
  const mean = new Float64Array(D);
  const std = new Float64Array(D);
  for (let i = 0; i < n; i++) for (let k = 0; k < D; k++) mean[k] += m[i * D + k];
  for (let k = 0; k < D; k++) mean[k] /= n;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < D; k++) {
      const d = m[i * D + k] - mean[k];
      std[k] += d * d;
    }
  }
  for (let k = 0; k < D; k++) {
    const sd = Math.sqrt(std[k] / n);
    std[k] = sd > 1e-9 * Math.max(1, Math.abs(mean[k])) ? sd : 1;
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < D; k++) m[i * D + k] = (m[i * D + k] - mean[k]) / std[k];
  }
  return { mean, std };
}

/**
 * Chooses up to `q` features for quadratic terms: alternately the strongest
 * remaining correlate of target x and of target y (so the vertical axis —
 * the hard one for webcams — always gets its share), skipping features that
 * are near-duplicates (|r| > 0.95) of one already chosen.
 */
function selectDominant(rows: readonly Row[], stats: ColumnStats, q: number, noQuad: Uint8Array): number[] {
  const n = rows.length;
  const p = stats.mean.length;
  if (q <= 0 || n < 2) return [];
  const z = rows.map((r) => {
    const out = new Float64Array(p);
    standardizeInto(r.x, stats, out);
    return out;
  });
  const corrWithTarget = (axis: 'x' | 'y'): Float64Array => {
    const t = rows.map((r) => r.target[axis]);
    const tm = t.reduce((a, b) => a + b, 0) / n;
    const ts = Math.sqrt(t.reduce((a, b) => a + (b - tm) ** 2, 0) / n);
    const r = new Float64Array(p);
    if (!(ts > 0)) return r;
    for (let i = 0; i < n; i++) {
      const tc = (t[i] - tm) / ts;
      for (let j = 0; j < p; j++) r[j] += z[i][j] * tc;
    }
    // A score of 0 is below MIN_DOMINANT_CORR, so constant and posture features are never picked.
    for (let j = 0; j < p; j++) r[j] = stats.constant[j] || noQuad[j] ? 0 : Math.abs(r[j] / n);
    return r;
  };
  const score = { x: corrWithTarget('x'), y: corrWithTarget('y') };
  const order = {
    x: [...Array(p).keys()].sort((a, b) => score.x[b] - score.x[a]),
    y: [...Array(p).keys()].sort((a, b) => score.y[b] - score.y[a]),
  };
  const featureCorr = (a: number, b: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += z[i][a] * z[i][b];
    return Math.abs(s / n);
  };

  const chosen: number[] = [];
  const cursor = { x: 0, y: 0 };
  const exhausted = { x: false, y: false };
  let axis: 'x' | 'y' = 'x';
  while (chosen.length < q && !(exhausted.x && exhausted.y)) {
    if (!exhausted[axis]) {
      let picked = false;
      while (cursor[axis] < p) {
        const j = order[axis][cursor[axis]++];
        if (score[axis][j] < MIN_DOMINANT_CORR) {
          cursor[axis] = p;
          break;
        }
        if (chosen.includes(j) || chosen.some((c) => featureCorr(c, j) > REDUNDANT_CORR)) continue;
        chosen.push(j);
        picked = true;
        break;
      }
      if (!picked) exhausted[axis] = true;
    }
    axis = axis === 'x' ? 'y' : 'x';
  }
  return chosen;
}

/** Row indices that survive the per-target MAD rule on the dominant features. */
function rejectOutliers(rows: readonly Row[], groups: readonly Group[], stats: ColumnStats, dominant: readonly number[]): number[] {
  const keep: number[] = [];
  for (const g of groups) {
    const cols = dominant.map((j) =>
      Float64Array.from(g.rows, (i) => clamp((rows[i].x[j] - stats.mean[j]) / stats.std[j], -Z_CLAMP * 4, Z_CLAMP * 4)),
    );
    for (const k of robustKeep(cols, g.rows.length, FEATURE_MAD_FLOOR)) keep.push(g.rows[k]);
  }
  return keep.sort((a, b) => a - b);
}

/**
 * Indices (ascending) of the points to keep: a point is an outlier when, in
 * any dimension, it lies more than MAD_THRESHOLD robust SDs from the median.
 * Needs ≥ 5 points to say anything; never drops more than a third (the most
 * extreme first), because a target that is mostly "outliers" is really a
 * target whose median we don't trust either.
 *
 * With 6 dominant features the per-feature rule also trims ~5–9 % of clean
 * Gaussian samples. That is deliberate and cheap: symmetric tail trimming
 * doesn't bias the per-target mean, and on synthetic data the robust fit
 * matched a fit on uncontaminated samples to within 0.2 px.
 */
function robustKeep(columns: readonly ArrayLike<number>[], m: number, floor: number): number[] {
  const all = [...Array(m).keys()];
  if (m < 5 || columns.length === 0) return all;
  const dist = new Float64Array(m);
  for (const col of columns) {
    const values = Array.from({ length: m }, (_, i) => col[i]);
    const med = median(values);
    const scale = Math.max(MAD_TO_SD * median(values.map((v) => Math.abs(v - med))), floor);
    for (let i = 0; i < m; i++) dist[i] = Math.max(dist[i], Math.abs(values[i] - med) / scale);
  }
  const flagged = all.filter((i) => dist[i] > MAD_THRESHOLD).sort((a, b) => dist[b] - dist[a]);
  const drop = new Set(flagged.slice(0, Math.floor(m * MAX_REJECT_FRACTION)));
  return all.filter((i) => !drop.has(i));
}

function robustPoints(preds: readonly Point[]): Point[] {
  const keep = robustKeep(
    [preds.map((p) => p.x), preds.map((p) => p.y)],
    preds.length,
    PREDICTION_MAD_FLOOR_PX,
  );
  return keep.map((i) => preds[i]);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 1.4826 × median absolute deviation from the median (the SD for Gaussian data). */
function robustSd(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const m = median(values);
  return MAD_TO_SD * median(values.map((v) => Math.abs(v - m)));
}

// ─────────────────────────── Environment validation ──────────────────────────

/** Every LightingComponent (a Record literal, so the compiler checks the list is complete). */
const LIGHTING_COMPONENTS = Object.keys({
  sclera: true,
  backlight: true,
  side: true,
  shade: true,
  glare: true,
  range: true,
} satisfies Record<LightingComponent, true>) as LightingComponent[];

/** A fresh, validated copy of a lighting signature, or null when it isn't one. */
function sanitizeLightingSignature(v: unknown): LightingSignature | null {
  if (!isRecord(v) || v.v !== 1) return null;
  const { n, yaw, pitch, c, sd } = v;
  if (!isPositive(n) || !isFiniteNumber(yaw) || !isFiniteNumber(pitch) || !isRecord(c) || !isRecord(sd)) return null;
  const centre = {} as Record<LightingComponent, number>;
  const spread = {} as Record<LightingComponent, number>;
  for (const k of LIGHTING_COMPONENTS) {
    const ck = c[k];
    const sk = sd[k];
    if (!isFiniteNumber(ck) || !isFiniteNumber(sk) || sk < 0) return null;
    centre[k] = ck;
    spread[k] = sk;
  }
  return { v: 1, n, yaw, pitch, c: centre, sd: spread };
}

function sanitizeAppearance(v: unknown): AppearanceBaseline | null {
  if (!isRecord(v) || v.v !== 1) return null;
  const { n, opennessAt0, opennessSlope, opennessResidualSd, squintMedian, squintSd } = v;
  if (!isPositive(n) || !isFiniteNumber(opennessAt0) || !isFiniteNumber(opennessSlope)) return null;
  if (!isFiniteNumber(opennessResidualSd) || opennessResidualSd < 0) return null;
  if (!isFiniteNumber(squintMedian) || !isFiniteNumber(squintSd) || squintSd < 0) return null;
  return { v: 1, n, opennessAt0, opennessSlope, opennessResidualSd, squintMedian, squintSd };
}

/** A validated copy of stored conditions; null when absent or damaged (never a reason to drop the model). */
function sanitizeEnvironment(v: unknown): CalibrationEnvironment | null {
  if (!isRecord(v) || !isFiniteNumber(v.capturedAt)) return null;
  return { lighting: sanitizeLightingSignature(v.lighting), appearance: sanitizeAppearance(v.appearance), capturedAt: v.capturedAt };
}

function cloneEnvironment(e: CalibrationEnvironment): CalibrationEnvironment | null {
  return sanitizeEnvironment(e);
}

function sanitizeLambdas(input: readonly number[] | undefined): number[] {
  const clean = (input ?? DEFAULT_LAMBDAS).filter((l) => Number.isFinite(l) && l >= 0);
  const unique = [...new Set(clean)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_LAMBDAS];
}

/** Largest λ whose CV error is within LAMBDA_TIE_TOLERANCE of the best (a light one-SE rule). */
function chooseLambda(cv: readonly { lambda: number; errorPx: number }[]): number {
  const finite = cv.filter((c) => Number.isFinite(c.errorPx));
  if (finite.length === 0) return 1;
  const best = Math.min(...finite.map((c) => c.errorPx));
  let chosen = finite[0].lambda;
  for (const c of finite) if (c.errorPx <= best * (1 + LAMBDA_TIE_TOLERANCE) + 1e-9) chosen = Math.max(chosen, c.lambda);
  return chosen;
}

function dotAt(w: Float64Array, m: Float64Array, offset: number, D: number): number {
  let s = 0;
  for (let k = 0; k < D; k++) s += w[k] * m[offset + k];
  return s;
}

interface RefinePoint {
  target: Point;
  targetScreen: Point;
  preds: Point[];
  mean: Point;
}

function fitAffine(obs: readonly RefinePoint[], fitScale: boolean, kappa: number): AxisAffine {
  const x = fitAxis(obs.map((o) => o.mean.x), obs.map((o) => o.targetScreen.x), fitScale, kappa);
  const y = fitAxis(obs.map((o) => o.mean.y), obs.map((o) => o.targetScreen.y), fitScale, kappa);
  return { sx: x.s, ox: x.o, sy: y.s, oy: y.o };
}

/** t ≈ s·p + o with s shrunk towards 1. */
function fitAxis(p: readonly number[], t: readonly number[], fitScale: boolean, kappa: number): { s: number; o: number } {
  const n = p.length;
  const pm = p.reduce((a, b) => a + b, 0) / n;
  const spread = p.reduce((a, b) => a + (b - pm) ** 2, 0);
  let s = 1;
  if (fitScale && n >= 3 && spread > n * MIN_SCALE_SPREAD_PX ** 2) {
    // Regress the residual (t − p) on p: its slope is (s − 1), and ridge
    // shrinks exactly that slope while leaving the offset unpenalized.
    const { weights } = ridgeFit(
      p.map((v) => [v]),
      t.map((v, i) => v - p[i]),
      kappa * spread,
    );
    s = clamp(1 + weights[0], SCALE_MIN, SCALE_MAX);
  }
  const o = t.reduce((acc, v, i) => acc + (v - s * p[i]), 0) / n;
  return { s, o };
}

function buildReport(
  points: readonly { target: Point; preds: readonly Point[] }[],
  lambda: number,
  viewportHeight: number,
  robust: boolean,
): CalibrationReport {
  const perPoint: CalibrationReport['perPoint'] = [];
  let sampleCount = 0;
  for (const pt of points) {
    const preds = robust ? robustPoints(pt.preds) : pt.preds;
    if (preds.length === 0) continue;
    const m = meanPoint(preds);
    perPoint.push({
      target: { x: pt.target.x, y: pt.target.y },
      meanPrediction: m,
      errorPx: Math.hypot(m.x - pt.target.x, m.y - pt.target.y),
      samples: preds.length,
    });
    sampleCount += preds.length;
  }
  if (perPoint.length === 0) {
    return { meanErrorPx: NaN, meanErrorXPx: NaN, meanErrorYPx: NaN, perPoint, lambda, sampleCount: 0, quality: 'poor' };
  }
  const k = perPoint.length;
  const meanErrorPx = perPoint.reduce((a, p) => a + p.errorPx, 0) / k;
  const meanErrorXPx = perPoint.reduce((a, p) => a + Math.abs(p.meanPrediction.x - p.target.x), 0) / k;
  const meanErrorYPx = perPoint.reduce((a, p) => a + Math.abs(p.meanPrediction.y - p.target.y), 0) / k;
  return {
    meanErrorPx,
    meanErrorXPx,
    meanErrorYPx,
    perPoint,
    lambda,
    sampleCount,
    quality: qualityFromError(meanErrorPx, viewportHeight),
  };
}

function meanPoint(ps: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ps) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ps.length, y: y / ps.length };
}

function modelLambda(model: GazeModel): number {
  if (model instanceof RidgeGazeModel) return model.lambda;
  try {
    const l = model.toJSON().lambda;
    return isFiniteNumber(l) ? l : 0;
  } catch {
    return 0;
  }
}

function resolveViewport(v: { width: number; height: number } | undefined, rows: readonly Row[]): { width: number; height: number } {
  if (v && isPositive(v.width) && isPositive(v.height)) return { width: v.width, height: v.height };
  if (typeof window !== 'undefined' && window && isPositive(window.innerWidth) && isPositive(window.innerHeight)) {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  // Calibration grids are symmetric (e.g. 10 %…90 %), so min + max ≈ the extent.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rows) {
    minX = Math.min(minX, r.target.x);
    maxX = Math.max(maxX, r.target.x);
    minY = Math.min(minY, r.target.y);
    maxY = Math.max(maxY, r.target.y);
  }
  const width = Math.max(1, maxX + Math.max(0, minX));
  const height = Math.max(1, maxY + Math.max(0, minY));
  return { width: Number.isFinite(width) ? width : 1, height: Number.isFinite(height) ? height : 1 };
}

function finiteVector(v: unknown, length: number, positive = false): Float64Array | null {
  if (!Array.isArray(v) || v.length !== length) return null;
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const x: unknown = v[i];
    if (!isFiniteNumber(x) || (positive && !(x > 0))) return null;
    out[i] = x;
  }
  return out;
}

/** The dominant features whose wild values mean a tracking glitch: all of them, minus posture when the names are known. */
function glitchCheckFor(quad: readonly number[], names: readonly string[] | undefined): number[] {
  return names && names.length > 0 ? quad.filter((j) => !POSTURE_FEATURES.has(names[j] ?? '')) : [...quad];
}

function indexList(v: unknown, bound: number): number[] | null {
  if (!Array.isArray(v) || v.length > bound) return null;
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= bound || seen.has(x)) return null;
    seen.add(x);
  }
  return [...seen];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositive(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function isFinitePoint(p: unknown): p is Point {
  return isRecord(p) && isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

function firstFinite(...values: (number | undefined)[]): number {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
