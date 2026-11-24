/**
 * The live accuracy test: what it records and how a recording is scored.
 *
 * The session (src/ui/accuracyTestOverlay.ts) shows dots at known places while the reader sits
 * still, then with the head turned, leaning back and sitting lower. It keeps the eye features of
 * every frame: numbers, never video. This module turns such a recording into scores: each way of
 * calibrating is fitted on the recording's calibration dots, exactly as the app would fit it, and
 * then asked where the reader was looking at every test dot. All variants see the same frames, so
 * they differ by the calibration alone.
 *
 * Nothing here touches the DOM: the app scores a session with it right after recording, and
 * `npm run bench:live` scores saved recordings with the same code.
 */
import type { CalibrationSample, EyeFeatures, FeatureFrame, GazeModel, Point } from '../types';
import { GAZE_EXCLUDED_FEATURES, fitPoseCompensation, trainGazeModel, type TrainOptions } from './calibrationModel';
import { FEATURE_NAMES } from './features';
import type { GazePriorWeights } from './gazePrior';

export const ACCURACY_TEST_KIND = 'gaze-reader-accuracy-test';
export const ACCURACY_TEST_VERSION = 1;

// ─────────────────────────────────── plan ────────────────────────────────────

export type PostureId = 'still' | 'turned' | 'back' | 'low' | 'again';

export interface Posture {
  id: PostureId;
  /** Column heading in the results. */
  short: string;
  /** Card title before the block. */
  title: string;
  /** What to do, on the card. */
  instruction: string;
  /** The reader changed how they sit for this block. */
  moved: boolean;
}

/** The test blocks, in the order they are shown. */
export const POSTURES: readonly Posture[] = Object.freeze([
  { id: 'still', short: 'Still', title: 'Sit as you are', instruction: 'Don’t move from how you sat for the calibration. Follow each dot with your eyes.', moved: false },
  {
    id: 'turned',
    short: 'Head turned',
    title: 'Turn your head a little',
    instruction: 'Turn your head slightly to one side, as if the screen sat a little off-centre, and keep it there. Follow the dots with your eyes only.',
    moved: true,
  },
  {
    id: 'back',
    short: 'Leaning back',
    title: 'Lean back',
    instruction: 'Face the screen again and lean back in your chair, about a hand’s width further away. Stay there and follow the dots.',
    moved: true,
  },
  {
    id: 'low',
    short: 'Sitting lower',
    title: 'Sit lower',
    instruction: 'Slide down in your chair a little, the way you sit after reading for a while. Stay there and follow the dots.',
    moved: true,
  },
  {
    id: 'again',
    short: 'Back to start',
    title: 'Sit up again',
    instruction: 'Go back to how you sat for the calibration, as well as you can. Follow the dots one last time.',
    moved: false,
  },
]);

/**
 * The test dots, as fractions of the viewport. None is a calibration dot, so the test measures
 * how the calibration carries between its dots, and every posture uses the same nine, so postures
 * are compared on the same places.
 */
export const TEST_TARGETS: readonly Point[] = Object.freeze([
  { x: 0.25, y: 0.2 },
  { x: 0.5, y: 0.22 },
  { x: 0.75, y: 0.2 },
  { x: 0.25, y: 0.5 },
  { x: 0.5, y: 0.47 },
  { x: 0.75, y: 0.5 },
  { x: 0.25, y: 0.8 },
  { x: 0.5, y: 0.78 },
  { x: 0.75, y: 0.8 },
]);

/** A dot needs this many usable frames to count. */
export const MIN_FRAMES_PER_DOT = 8;
/** Line pitch assumed when the recording has none, CSS px. */
export const FALLBACK_LINE_PITCH_PX = 30;

// ───────────────────────────────── recording ─────────────────────────────────

/** "gaze-reader-accuracy-2026-11-23-1412.json" */
export function accuracyRecordingFileName(recordedAt: string): string {
  const parsed = Date.parse(recordedAt);
  const d = new Date(Number.isFinite(parsed) ? parsed : Date.now());
  const p = (n: number): string => String(n).padStart(2, '0');
  return `gaze-reader-accuracy-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** One camera frame's numbers. Short keys: a session holds about 3,000 of these. */
export interface RecordedFrame {
  /** ms since the session started. */
  t: number;
  /** Tracker quality, 0..1. */
  q: number;
  /** The feature vector (see `featureNames` in the recording). */
  v: number[];
  /** Head pose: yaw, pitch, roll, tx, ty, tz. */
  h: [number, number, number, number, number, number];
  /** blink, openness, faceScale, face centre x, face centre y. */
  e: [number, number, number, number, number];
  /** squint and brow raise, where the tracker gave them. */
  s?: [number | null, number | null];
  /** The eye-picture network's answer for the frame, when one was running (see `eyeNet` in the recording). */
  n?: [number, number];
}

export interface RecordedTrial {
  /** Where the dot was, viewport CSS px. */
  target: Point;
  /** Head-movement step only: which movement was asked for. */
  label?: string;
  frames: RecordedFrame[];
}

export type RecordedBlock =
  | { kind: 'calibrate'; trials: RecordedTrial[] }
  | { kind: 'head'; trials: RecordedTrial[] }
  | { kind: 'test'; posture: PostureId; trials: RecordedTrial[] };

export interface AccuracyRecording {
  kind: typeof ACCURACY_TEST_KIND;
  version: typeof ACCURACY_TEST_VERSION;
  /** Gaze Reader version that recorded it. */
  app: string;
  /** ISO date and time the session started. */
  recordedAt: string;
  featureNames: string[];
  viewport: { width: number; height: number };
  /** Where the app took the camera to be, viewport CSS px. */
  camera: Point;
  /** The window's place on the screen at the start and the end, CSS px. */
  windowOrigin: { start: Point; end: Point };
  /** Line pitch of the text the reader had open, CSS px. */
  linePitchPx: number;
  /** Frames with a blink value above this are not used, as in the app's calibration. */
  maxBlink: number;
  /** The id of the eye-picture network whose answers the frames carry (`n`); absent when none was running. */
  eyeNet?: string;
  blocks: RecordedBlock[];
}

const round = (n: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};

/** A frame as the recording keeps it, or null when the tracker had no face in it. */
export function recordFrame(frame: FeatureFrame, sessionStart: number): RecordedFrame | null {
  const f = frame.features;
  if (!frame.faceFound || !f || !Array.isArray(f.vector)) return null;
  const out: RecordedFrame = {
    t: Math.round(frame.t - sessionStart),
    q: round(frame.quality, 3),
    v: f.vector.map((n) => (Number.isFinite(n) ? round(n, 6) : 0)),
    h: [round(f.headPose.yaw, 6), round(f.headPose.pitch, 6), round(f.headPose.roll, 6), round(f.headPose.tx, 5), round(f.headPose.ty, 5), round(f.headPose.tz, 5)],
    e: [round(f.blink, 4), round(f.openness, 5), round(f.faceScale, 6), round(f.faceCenter.x, 5), round(f.faceCenter.y, 5)],
  };
  if (f.squint !== undefined || f.browRaise !== undefined) {
    out.s = [f.squint === undefined ? null : round(f.squint, 4), f.browRaise === undefined ? null : round(f.browRaise, 4)];
  }
  if (f.eyeNet && Number.isFinite(f.eyeNet.x) && Number.isFinite(f.eyeNet.y)) out.n = [round(f.eyeNet.x, 6), round(f.eyeNet.y, 6)];
  return f.vector.every((n) => Number.isFinite(n)) ? out : null;
}

/** The eye features a recorded frame stands for; `eyeNet` names the network its answer (`n`) came from. */
export function featuresOf(f: RecordedFrame, eyeNet?: string): EyeFeatures {
  const out: EyeFeatures = {
    vector: f.v,
    headPose: { yaw: f.h[0], pitch: f.h[1], roll: f.h[2], tx: f.h[3], ty: f.h[4], tz: f.h[5] },
    blink: f.e[0],
    openness: f.e[1],
    faceScale: f.e[2],
    faceCenter: { x: f.e[3], y: f.e[4] },
  };
  if (f.s) {
    if (f.s[0] !== null) out.squint = f.s[0];
    if (f.s[1] !== null) out.browRaise = f.s[1];
  }
  if (eyeNet && f.n) out.eyeNet = { id: eyeNet, x: f.n[0], y: f.n[1] };
  return out;
}

function samplesOf(trials: readonly RecordedTrial[], eyeNet?: string): CalibrationSample[] {
  return trials.flatMap((trial) => trial.frames.map((f) => ({ target: trial.target, features: featuresOf(f, eyeNet), t: f.t })));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is Point => isObj(v) && isNum(v.x) && isNum(v.y);
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isTuple = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNum);

function checkTrial(v: unknown, featureLength: number): string | null {
  if (!isObj(v) || !isPoint(v.target) || !Array.isArray(v.frames)) return 'a dot is missing its place or its frames';
  if (v.label !== undefined && typeof v.label !== 'string') return 'a dot has a label that is not text';
  for (const f of v.frames as unknown[]) {
    if (!isObj(f) || !isNum(f.t) || !isNum(f.q) || !isTuple(f.v, featureLength) || !isTuple(f.h, 6) || !isTuple(f.e, 5)) return 'a frame is damaged';
    if (f.s !== undefined && !(Array.isArray(f.s) && f.s.length === 2 && f.s.every((n) => n === null || isNum(n)))) return 'a frame is damaged';
    if (f.n !== undefined && !isTuple(f.n, 2)) return 'a frame is damaged';
  }
  return null;
}

export type ParsedRecording = { ok: true; recording: AccuracyRecording } | { ok: false; problem: string };

/** Checks a recording read from a file. The app's own recordings always pass. */
export function parseRecording(json: unknown): ParsedRecording {
  const bad = (problem: string): ParsedRecording => ({ ok: false, problem });
  if (!isObj(json) || json.kind !== ACCURACY_TEST_KIND) return bad('This is not a Gaze Reader accuracy test recording.');
  if (json.version !== ACCURACY_TEST_VERSION) return bad(`This recording is format ${String(json.version)}; this version reads format ${ACCURACY_TEST_VERSION}.`);
  const names = json.featureNames;
  if (!Array.isArray(names) || names.length !== FEATURE_NAMES.length || names.some((n, i) => n !== FEATURE_NAMES[i])) {
    return bad('This recording was made with a different set of eye features, so this version cannot replay it.');
  }
  const vp = json.viewport;
  if (!isObj(vp) || !isNum(vp.width) || !isNum(vp.height) || vp.width <= 0 || vp.height <= 0) return bad('The recording has no usable window size.');
  const origin = json.windowOrigin;
  if (!isPoint(json.camera) || !isObj(origin) || !isPoint(origin.start) || !isPoint(origin.end)) return bad('The recording does not say where the window and camera were.');
  if (!isNum(json.linePitchPx) || !isNum(json.maxBlink) || typeof json.app !== 'string' || typeof json.recordedAt !== 'string') return bad('The recording is missing its header.');
  if (json.eyeNet !== undefined && (typeof json.eyeNet !== 'string' || json.eyeNet === '')) return bad('The recording does not say which eye-picture network it used.');
  if (!Array.isArray(json.blocks)) return bad('The recording has no blocks.');
  const ids = new Set(POSTURES.map((p) => p.id as string));
  for (const b of json.blocks as unknown[]) {
    if (!isObj(b) || !Array.isArray(b.trials)) return bad('A block of the recording is damaged.');
    if (b.kind !== 'calibrate' && b.kind !== 'head' && b.kind !== 'test') return bad(`The recording has a block of an unknown kind (${String(b.kind)}).`);
    if (b.kind === 'test' && !(typeof b.posture === 'string' && ids.has(b.posture))) return bad(`The recording has a test block for an unknown posture (${String(b.posture)}).`);
    for (const t of b.trials as unknown[]) {
      const problem = checkTrial(t, FEATURE_NAMES.length);
      if (problem) return bad(`The recording is damaged: ${problem}.`);
    }
  }
  return { ok: true, recording: json as unknown as AccuracyRecording };
}

// ────────────────────────────────── variants ─────────────────────────────────

export interface Variant {
  id: string;
  label: string;
  /** One line on what it is. */
  note: string;
  /** Training options on top of the app's. */
  train: Partial<TrainOptions>;
  /** Fitted on the head-movement step too, as the app does since 1.2. */
  headStep: boolean;
  /** Needs the real-face weights. */
  needsPrior?: boolean;
  /** Calibrated on the eye-picture network's answers: scored only for a recording that has them. */
  needsEyeNet?: boolean;
}

/** Head position and size: 1.1 fed them to the gaze fit, 1.2 does not. */
const HEAD_FEATURES: readonly string[] = ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale'];

export const DEFAULT_VARIANT = 'default';
export const REAL_FACE_VARIANT = 'real-face';
export const EYE_NET_VARIANT = 'eye-net';

export const VARIANTS: readonly Variant[] = Object.freeze([
  { id: DEFAULT_VARIANT, label: 'Default calibration', note: 'What the app uses unless you change a setting.', train: {}, headStep: true },
  { id: REAL_FACE_VARIANT, label: 'Real-face model', note: 'Settings → Eye tracking → Real-face model (experimental).', train: {}, headStep: true, needsPrior: true },
  { id: EYE_NET_VARIANT, label: 'Eye-picture network', note: 'Settings → Advanced → Eye-picture network (a file you load).', train: {}, headStep: true, needsEyeNet: true },
  { id: 'no-head-step', label: 'Default, no head-movement step', note: 'The default with the nod/turn/tilt step skipped.', train: {}, headStep: false },
  { id: 'no-distance', label: 'Default, no distance correction', note: 'The default without the correction for leaning in or back.', train: { depthCompensation: false }, headStep: true },
  {
    id: 'v1.1',
    label: '1.1 features',
    note: 'Head pose fed to the gaze fit, as in version 1.1.',
    train: { excludedFeatures: [...GAZE_EXCLUDED_FEATURES].filter((n) => !HEAD_FEATURES.includes(n)) },
    headStep: false,
  },
  { id: 'v1.0', label: '1.0 features', note: 'Every feature, eyelids included, as in version 1.0.', train: { excludedFeatures: [] }, headStep: false },
]);

// ────────────────────────────────── scoring ──────────────────────────────────

export interface DotScore {
  posture: PostureId;
  target: Point;
  /** Median prediction over the dot's frames; null when too few frames gave one. */
  prediction: Point | null;
  /** Frames that gave a prediction. */
  frames: number;
  /** Distance from the dot, px; NaN without a prediction. */
  errorPx: number;
}

export interface GroupScore {
  /** Dots shown, and dots that could be scored. */
  dots: number;
  scored: number;
  /** Median distance from the dot, px. */
  medianErrorPx: number;
  /** Median up/down miss, px, and the same in lines of text. */
  medianVerticalPx: number;
  medianVerticalLines: number;
  /** Median signed miss, px: positive = the tracker reads to the right / too low. */
  biasXPx: number;
  biasYPx: number;
  /** Share of scored dots read on the right line (within half a line), 0..1. */
  onLine: number;
  /** Largest distance from a dot, px. */
  worstErrorPx: number;
}

export interface VariantScore {
  id: string;
  label: string;
  note: string;
  /** False when this calibration could not be fitted on the recording. */
  ok: boolean;
  /** Why not. */
  problem?: string;
  /** What the head-movement step came to: 'learned', 'not used', or why it taught nothing. */
  headStep: string;
  /** How well the fit reproduces its own calibration dots, px. */
  fitErrorPx: number;
  postures: { posture: PostureId; score: GroupScore }[];
  /** Every test dot. */
  overall: GroupScore;
  /** The dots of the postures where the reader had moved. */
  moved: GroupScore;
  dots: DotScore[];
}

export interface Comparison {
  /** Variant ids: `a` is the reference. */
  a: string;
  b: string;
  /** Dots both could be scored on. */
  dots: number;
  /** Dots on which each was closer. */
  aCloser: number;
  bCloser: number;
  /** Median of (a's error − b's error), px: positive = b is closer. */
  medianGainPx: number;
  /** Two-sided sign test on aCloser vs bCloser. Dots of one posture share errors, so read it as a rough guide. */
  p: number;
}

export interface AccuracyScores {
  recordedAt: string;
  app: string;
  viewport: { width: number; height: number };
  linePitchPx: number;
  /** Frames recorded, and the calibration dots and frames. */
  frames: number;
  calibrationDots: number;
  variants: VariantScore[];
  /** Each other variant against the default. */
  comparisons: Comparison[];
  /** Things that make the numbers less trustworthy. */
  warnings: string[];
  /** One or two sentences on what the session shows. */
  verdict: string;
}

export interface ScoreOptions {
  /** The real-face weights; without them that variant is left out. */
  prior?: GazePriorWeights | null;
  /** Score only these variant ids. */
  only?: readonly string[];
}

export function median(values: readonly number[]): number {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Two-sided sign test: how likely a split at least this uneven is when neither side is better. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let term = 0.5 ** n; // C(n, 0) / 2^n
  let tail = term;
  for (let i = 1; i <= k; i++) {
    term *= (n - i + 1) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

function groupScore(dots: readonly DotScore[], linePitchPx: number): GroupScore {
  const scored = dots.filter((d) => d.prediction !== null);
  const dx = scored.map((d) => (d.prediction as Point).x - d.target.x);
  const dy = scored.map((d) => (d.prediction as Point).y - d.target.y);
  const vertical = median(dy.map(Math.abs));
  return {
    dots: dots.length,
    scored: scored.length,
    medianErrorPx: median(scored.map((d) => d.errorPx)),
    medianVerticalPx: vertical,
    medianVerticalLines: vertical / linePitchPx,
    biasXPx: median(dx),
    biasYPx: median(dy),
    onLine: scored.length ? dy.filter((d) => Math.abs(d) <= linePitchPx / 2).length / scored.length : NaN,
    worstErrorPx: scored.length ? Math.max(...scored.map((d) => d.errorPx)) : NaN,
  };
}

function scoreDot(model: GazeModel, posture: PostureId, trial: RecordedTrial, maxBlink: number, eyeNet?: string): DotScore {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of trial.frames) {
    if (f.e[0] > maxBlink) continue;
    const p = model.predict(featuresOf(f, eyeNet));
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    xs.push(p.x);
    ys.push(p.y);
  }
  if (xs.length < MIN_FRAMES_PER_DOT) return { posture, target: trial.target, prediction: null, frames: xs.length, errorPx: NaN };
  const prediction = { x: median(xs), y: median(ys) };
  return { posture, target: trial.target, prediction, frames: xs.length, errorPx: Math.hypot(prediction.x - trial.target.x, prediction.y - trial.target.y) };
}

const HEAD_STEP_TEXT: Record<string, string> = {
  'no-reference': 'nothing learned (no pose reference)',
  'too-few': 'nothing learned (too few usable frames)',
  still: 'nothing learned (the head hardly moved)',
  unclear: 'nothing learned (the eyes left the dot, or the face was lost)',
};

function scoreVariant(v: Variant, rec: AccuracyRecording, prior: GazePriorWeights | null, linePitchPx: number): VariantScore {
  const empty = groupScore([], linePitchPx);
  const failed = (problem: string): VariantScore => ({ id: v.id, label: v.label, note: v.note, ok: false, problem, headStep: 'not used', fitErrorPx: NaN, postures: [], overall: empty, moved: empty, dots: [] });

  const calibration = samplesOf(rec.blocks.filter((b) => b.kind === 'calibrate').flatMap((b) => b.trials), rec.eyeNet);
  let model: GazeModel;
  let fitErrorPx: number;
  try {
    // The camera is passed in: the app works it out from the window, which a replay doesn't have.
    const trained = trainGazeModel(calibration, {
      viewport: rec.viewport,
      featureNames: FEATURE_NAMES,
      maxBlink: rec.maxBlink,
      camera: rec.camera,
      ...(v.needsPrior ? { prior } : {}),
      ...(v.needsEyeNet ? { eyeNet: rec.eyeNet } : {}),
      ...v.train,
    });
    model = trained.model;
    fitErrorPx = trained.report.meanErrorPx;
  } catch (e) {
    return failed(e instanceof Error ? e.message : 'The calibration could not be fitted.');
  }

  let headStep = 'not used';
  if (v.headStep) {
    const head = samplesOf(rec.blocks.filter((b) => b.kind === 'head').flatMap((b) => b.trials), rec.eyeNet);
    if (head.length === 0) headStep = 'not recorded';
    else {
      const fitted = fitPoseCompensation(model, head, { maxBlink: rec.maxBlink });
      if (fitted.ok) {
        model = fitted.model;
        headStep = 'learned';
      } else headStep = HEAD_STEP_TEXT[fitted.reason] ?? 'nothing learned';
    }
  }

  const dots: DotScore[] = [];
  for (const b of rec.blocks) {
    if (b.kind !== 'test') continue;
    for (const trial of b.trials) dots.push(scoreDot(model, b.posture, trial, rec.maxBlink, rec.eyeNet));
  }
  const movedIds = new Set(POSTURES.filter((p) => p.moved).map((p) => p.id));
  return {
    id: v.id,
    label: v.label,
    note: v.note,
    ok: true,
    headStep,
    fitErrorPx,
    postures: POSTURES.filter((p) => dots.some((d) => d.posture === p.id)).map((p) => ({ posture: p.id, score: groupScore(dots.filter((d) => d.posture === p.id), linePitchPx) })),
    overall: groupScore(dots, linePitchPx),
    moved: groupScore(dots.filter((d) => movedIds.has(d.posture)), linePitchPx),
    dots,
  };
}

/** Dot by dot, which of two variants was closer. The dots line up: both scored the same recording. */
export function compareVariants(a: VariantScore, b: VariantScore): Comparison {
  let aCloser = 0;
  let bCloser = 0;
  const gains: number[] = [];
  const n = Math.min(a.dots.length, b.dots.length);
  for (let i = 0; i < n; i++) {
    const ea = a.dots[i].errorPx;
    const eb = b.dots[i].errorPx;
    if (!Number.isFinite(ea) || !Number.isFinite(eb)) continue;
    gains.push(ea - eb);
    if (eb < ea) bCloser++;
    else if (ea < eb) aCloser++;
  }
  return { a: a.id, b: b.id, dots: gains.length, aCloser, bCloser, medianGainPx: median(gains), p: signTest(aCloser, bCloser) };
}

/**
 * Several sessions together: each other variant against the default over every dot of every
 * session. Sessions of one person on one day are not independent, so more people and more days
 * count for more than more sessions.
 */
export function poolComparisons(sessions: readonly AccuracyScores[]): Comparison[] {
  const out: Comparison[] = [];
  for (const variant of VARIANTS) {
    if (variant.id === DEFAULT_VARIANT) continue;
    let aCloser = 0;
    let bCloser = 0;
    const gains: number[] = [];
    for (const s of sessions) {
      const a = s.variants.find((v) => v.id === DEFAULT_VARIANT);
      const b = s.variants.find((v) => v.id === variant.id);
      if (!a?.ok || !b?.ok) continue;
      const n = Math.min(a.dots.length, b.dots.length);
      for (let i = 0; i < n; i++) {
        const ea = a.dots[i].errorPx;
        const eb = b.dots[i].errorPx;
        if (!Number.isFinite(ea) || !Number.isFinite(eb)) continue;
        gains.push(ea - eb);
        if (eb < ea) bCloser++;
        else if (ea < eb) aCloser++;
      }
    }
    if (gains.length > 0) out.push({ a: DEFAULT_VARIANT, b: variant.id, dots: gains.length, aCloser, bCloser, medianGainPx: median(gains), p: signTest(aCloser, bCloser) });
  }
  return out;
}

/** Several sessions as plain text: one line per session and variant, then the pooled comparison. */
export function formatPooled(sessions: readonly AccuracyScores[]): string {
  const lines: string[] = [`${sessions.length} sessions together`, ''];
  const width = Math.max(...VARIANTS.map((v) => v.label.length), 12) + 2;
  lines.push('Median distance from the dot over all test dots, px, session by session');
  for (const variant of VARIANTS) {
    const cells = sessions.map((s) => {
      const v = s.variants.find((x) => x.id === variant.id);
      return padLeft(v?.ok && v.overall.scored ? num(v.overall.medianErrorPx) : '–', 7);
    });
    if (cells.some((c) => c.trim() !== '–')) lines.push(pad(variant.label, width) + cells.join(''));
  }
  lines.push('');
  lines.push('Against the default calibration, every dot of every session');
  for (const c of poolComparisons(sessions)) {
    const label = VARIANTS.find((v) => v.id === c.b)?.label ?? c.b;
    lines.push(`${pad(label, width)}closer on ${c.bCloser} of ${c.dots} dots (default closer on ${c.aCloser}), median gain ${num(c.medianGainPx)} px, sign test p ${c.p < 0.001 ? '< 0.001' : `= ${num(c.p, 3)}`}`);
  }
  return lines.join('\n');
}

/** A difference this lopsided, and at least this large, is called a clear one. */
const CLEAR_P = 0.01;
const CLEAR_GAIN = 0.15;

function px(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n)} px` : 'no result';
}

function verdictOf(variants: readonly VariantScore[], comparisons: readonly Comparison[]): string {
  const base = variants.find((v) => v.id === DEFAULT_VARIANT);
  if (!base || !base.ok || base.overall.scored === 0) return 'The default calibration could not be scored on this session, so there is nothing to compare.';
  const here = `The default calibration was a median ${px(base.overall.medianErrorPx)} off over all the test dots (${px(base.moved.medianErrorPx)} once you had moved)`;
  const real = variants.find((v) => v.id === REAL_FACE_VARIANT);
  const cmp = comparisons.find((c) => c.b === REAL_FACE_VARIANT);
  if (!real || !real.ok || !cmp || cmp.dots === 0) return `${here}. The real-face model was not scored.`;
  const there = `the real-face model ${px(real.overall.medianErrorPx)} (${px(real.moved.medianErrorPx)} once you had moved)`;
  const split = `closer on ${cmp.bCloser} of ${cmp.dots} dots`;
  const gain = cmp.medianGainPx / base.overall.medianErrorPx;
  if (cmp.p < CLEAR_P && gain >= CLEAR_GAIN) return `${here}, ${there}. The real-face model was ${split}: clearly better in this session.`;
  if (cmp.p < CLEAR_P && gain <= -CLEAR_GAIN) return `${here}, ${there}. The real-face model was ${split}: clearly worse in this session.`;
  return `${here}, ${there}. The real-face model was ${split}: no clear difference in this session.`;
}

/** Scores a recording: every calibration variant on the same frames. */
export function scoreRecording(rec: AccuracyRecording, opts: ScoreOptions = {}): AccuracyScores {
  const linePitchPx = rec.linePitchPx > 0 ? rec.linePitchPx : FALLBACK_LINE_PITCH_PX;
  const prior = opts.prior ?? null;
  const variants = VARIANTS.filter((v) => (!v.needsPrior || prior) && (!v.needsEyeNet || rec.eyeNet) && (!opts.only || opts.only.includes(v.id))).map((v) =>
    scoreVariant(v, rec, prior, linePitchPx),
  );
  const base = variants.find((v) => v.id === DEFAULT_VARIANT);
  const comparisons = base && base.ok ? variants.filter((v) => v.ok && v !== base).map((v) => compareVariants(base, v)) : [];

  const warnings: string[] = [];
  const calibration = rec.blocks.filter((b) => b.kind === 'calibrate').flatMap((b) => b.trials);
  const tests = rec.blocks.filter((b) => b.kind === 'test').flatMap((b) => b.trials);
  const thin = (trials: readonly RecordedTrial[]): number => trials.filter((t) => t.frames.filter((f) => f.e[0] <= rec.maxBlink).length < MIN_FRAMES_PER_DOT).length;
  if (thin(calibration) > 0) warnings.push(`${thin(calibration)} of ${calibration.length} calibration dots have too few frames: the face was lost, or the eyes were closed.`);
  if (thin(tests) > 0) warnings.push(`${thin(tests)} of ${tests.length} test dots have too few frames and are not scored.`);
  const { start, end } = rec.windowOrigin;
  if (Math.hypot(start.x - end.x, start.y - end.y) > 2) warnings.push('The window moved during the session, which shifts everything recorded after it.');
  if (base && base.ok && base.headStep !== 'learned') warnings.push(`Head-movement step: ${base.headStep}. The default was scored without it.`);
  const present = new Set(rec.blocks.flatMap((b) => (b.kind === 'test' ? [b.posture] : [])));
  const missing = POSTURES.filter((p) => !present.has(p.id));
  if (missing.length > 0) warnings.push(`The session stopped early: no dots for ${missing.map((p) => p.short.toLowerCase()).join(', ')}.`);

  return {
    recordedAt: rec.recordedAt,
    app: rec.app,
    viewport: rec.viewport,
    linePitchPx,
    frames: rec.blocks.reduce((n, b) => n + b.trials.reduce((m, t) => m + t.frames.length, 0), 0),
    calibrationDots: calibration.length,
    variants,
    comparisons,
    warnings,
    verdict: verdictOf(variants, comparisons),
  };
}

// ─────────────────────────────────── text ────────────────────────────────────

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padLeft = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const num = (n: number, digits = 0): string => (Number.isFinite(n) ? n.toFixed(digits) : '–');

/** The scores as plain text: what `npm run bench:live` prints and what "Copy results" copies. */
export function formatScores(s: AccuracyScores): string {
  const postures = POSTURES.filter((p) => s.variants.some((v) => v.postures.some((q) => q.posture === p.id)));
  const labelWidth = Math.max(...s.variants.map((v) => v.label.length), 12) + 2;
  const col = 15;
  const lines: string[] = [];
  lines.push(`Gaze Reader accuracy test, ${s.recordedAt} (app ${s.app})`);
  lines.push(`Window ${s.viewport.width}×${s.viewport.height} px, line pitch ${num(s.linePitchPx)} px, ${s.frames} frames, ${s.calibrationDots} calibration dots`);
  lines.push('');
  lines.push('Median distance from the dot, px (median up/down miss in lines of text)');
  lines.push(pad('', labelWidth) + postures.map((p) => padLeft(p.short, col)).join('') + padLeft('All', col) + padLeft('After moving', col));
  const cell = (g: GroupScore): string => padLeft(g.scored ? `${num(g.medianErrorPx)} (${num(g.medianVerticalLines, 1)})` : '–', col);
  for (const v of s.variants) {
    if (!v.ok) {
      lines.push(`${pad(v.label, labelWidth)}  could not be fitted: ${v.problem ?? 'unknown reason'}`);
      continue;
    }
    lines.push(pad(v.label, labelWidth) + postures.map((p) => cell(v.postures.find((q) => q.posture === p.id)?.score ?? groupScore([], s.linePitchPx))).join('') + cell(v.overall) + cell(v.moved));
  }
  lines.push('');
  lines.push('Read on the right line (within half a line), share of dots');
  lines.push(pad('', labelWidth) + postures.map((p) => padLeft(p.short, col)).join('') + padLeft('All', col) + padLeft('After moving', col));
  const share = (g: GroupScore): string => padLeft(g.scored ? `${num(g.onLine * 100)}%` : '–', col);
  for (const v of s.variants) {
    if (!v.ok) continue;
    lines.push(pad(v.label, labelWidth) + postures.map((p) => share(v.postures.find((q) => q.posture === p.id)?.score ?? groupScore([], s.linePitchPx))).join('') + share(v.overall) + share(v.moved));
  }
  if (s.comparisons.length > 0) {
    lines.push('');
    lines.push('Against the default, dot by dot');
    for (const c of s.comparisons) {
      const v = s.variants.find((x) => x.id === c.b);
      lines.push(`${pad(v?.label ?? c.b, labelWidth)}closer on ${c.bCloser} of ${c.dots}, default closer on ${c.aCloser}; median gain ${num(c.medianGainPx)} px; sign test p ${c.p < 0.001 ? '< 0.001' : `= ${num(c.p, 3)}`}`);
    }
  }
  const base = s.variants.find((v) => v.id === DEFAULT_VARIANT);
  if (base?.ok) {
    lines.push('');
    lines.push(`Default calibration: fit error ${num(base.fitErrorPx)} px on its own dots; head-movement step: ${base.headStep}; reads ${num(Math.abs(base.overall.biasYPx))} px ${base.overall.biasYPx >= 0 ? 'low' : 'high'} overall.`);
  }
  for (const w of s.warnings) lines.push(`Note: ${w}`);
  lines.push('');
  lines.push(s.verdict);
  return lines.join('\n');
}
