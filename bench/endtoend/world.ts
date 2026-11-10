/**
 * The simulated world for the end-to-end harness: a reader in front of a laptop webcam, reading a
 * long document, with everything that goes wrong in real use. Each camera frame comes out as what
 * MediaPipe would report (478 landmarks, blendshapes, pose matrix: bench/lighting/faceSim.ts) plus
 * the ground truth: where the eyes really look, what the reader is doing, and which disturbances
 * are active. src/reading/simulatedReader.ts's ReaderBrain plans the reading eye movements.
 *
 * Parameters and where they come from:
 *  - Reading: fixations N(225, 60) ms, saccades 7.5 ± 2 characters, ~10 % regressions, return
 *    sweeps that undershoot (ReaderBrain; Rayner 1998, Psychological Bulletin 124:372). Speed 250
 *    words per minute (silent reading 238 non-fiction / 260 fiction: Brysbaert 2019, JML 109).
 *  - Blinks: 6 per minute while reading (Bentivoglio et al. 1997, Mov. Disord. 12:1028: 4.5/min
 *    reading, 17/min at rest), 100–400 ms each (the usual quoted range).
 *  - Landmark noise: faceSim's NOMINAL_NOISE at 640 × 480 (the lighting bench's), times a lighting
 *    factor; a farther face is smaller in the image, so the same pixel noise is a larger share of it.
 *    Raw gaze error then lands at 1–3° depending on the scenario (webcam trackers report 1–4°, e.g.
 *    WebGazer ≈ 4°: Papoutsaki et al. 2016, IJCAI).
 *  - Everything else (glances at a phone or the keyboard, posture changes, a second face, glare,
 *    occlusion, stalls) has no good published rate for reading at a laptop: the rates below are
 *    assumptions, chosen to be frequent rather than flattering, and each scenario says what it stresses.
 *  - What a reader does after finishing a page, besides looking for the next line at its end: now and
 *    then they rest their eyes elsewhere on the page or re-read the last lines for more than 1.5 s, and
 *    only then look below the page to turn it (finishPausePerPage, finishRereadPerPage). And a session
 *    doesn't always start with reading: when the book opens, is reopened, or a calibration refresh ends,
 *    the reader may first look at their phone or the keyboard (arrivalGlanceChance, reopensPerHour).
 *
 * Deterministic: one seeded generator per process (frames, events, head), so a seed replays exactly.
 */
import type { LineLayout, Point } from '../../src/types';
import { ReaderBrain, mulberry32 } from '../../src/reading/simulatedReader';
import { makeDocument, type SyntheticDocument } from '../../src/reading/testLayouts';
import {
  BASE_POSE,
  DEG,
  NOMINAL_NOISE,
  QUICK_TARGETS,
  VIEW,
  WORLDS,
  calibrationSession,
  frameFeatures,
  gauss,
  headFollow,
  makeFrame,
  type Frame,
  type NoiseSpec,
  type Perturbation,
  type Pose,
} from '../lighting/faceSim';
import type { CalibrationSample } from '../../src/types';

export const VIEWPORT = Object.freeze({ left: 0, top: 0, right: VIEW.width, bottom: VIEW.height });
/** Bumped whenever the world or the rig changes what a seed produces: saved results only compare within a version. */
export const HARNESS_VERSION = 'e2e-4';
/** The app's default typography: 22 px × 1.9 line height, a 62-character column centred in the window. */
export const PITCH = 42;
const COLUMN = { left: 315, right: 965 };

type Range = readonly [number, number];

export interface Scenario {
  name: string;
  /** What it stresses, for the scoreboard. */
  about: string;
  minutes: number;
  wpm: number;
  noise: NoiseSpec;
  /** Landmark/pose noise multiplier: 1 good light, 2–3 dim. */
  jitter: number;
  /** Camera rate, its frame-to-frame spread (± fraction), and stalls (CPU, GC, USB) per minute. */
  fps: number;
  fpsSpread: number;
  stallsPerMin: number;
  stallMs: Range;
  blinksPerMin: number;
  /** Eyes closed 1–5 s (resting them). */
  closuresPerMin: number;
  /** Gaze-diverting behaviour, per minute: off the screen, at a phone below it, at Dewey in the corner,
   *  resting on the text, re-reading a few lines up. */
  lookAwayPerMin: number;
  phonePerMin: number;
  /** At the keyboard, below the screen but inside the tracker's range (unlike most phone glances). */
  keyboardPerMin: number;
  deweyPerMin: number;
  pausePerMin: number;
  rereadPerMin: number;
  /** Skimming at 2.5× speed for 30–90 s. */
  skimPerMin: number;
  /** The tracker loses the face for 0.2–3 s. */
  faceLossPerMin: number;
  /** Someone else in view: the tracker follows their face for part of 2–10 s. */
  secondFacePerMin: number;
  /** A reflection on glasses biases the iris landmarks for 5–60 s. */
  glarePerMin: number;
  /** A hand over part of the face for 2–10 s: one eye's landmarks are guessed. */
  occlusionPerMin: number;
  /** Sudden posture changes (a new base pose), and leaning in or back for 10–60 s. */
  postureJumpsPerMin: number;
  leansPerMin: number;
  /** Slow head wander: SD per √minute (deg, cm), mean-reverting over ~10 minutes. */
  driftDeg: number;
  driftCm: number;
  /**
   * After finishing a page, the chance that the reader rests their eyes elsewhere on it for 1.6–4 s
   * (thinking, back at the paragraph) and only then looks below the page to turn it…
   */
  finishPausePerPage: number;
  /** …or re-reads one to three lines above the last for 1.6–4 s before looking below the page. */
  finishRereadPerPage: number;
  /** The reader closes and reopens the book (the reading layer starts over, as on any book open), per hour. */
  reopensPerHour: number;
  /** When the book opens or is reopened, and after a calibration refresh: the chance of a 1–4 s look at the phone or keyboard first. */
  arrivalGlanceChance: number;
}

const BASE: Omit<Scenario, 'name' | 'about'> = {
  minutes: 60,
  wpm: 250,
  noise: NOMINAL_NOISE,
  jitter: 1,
  fps: 30,
  fpsSpread: 0.15,
  stallsPerMin: 0.2,
  stallMs: [100, 400],
  blinksPerMin: 6,
  closuresPerMin: 0.05,
  lookAwayPerMin: 0.5,
  phonePerMin: 0.2,
  keyboardPerMin: 0.2,
  deweyPerMin: 0.3,
  pausePerMin: 0.3,
  rereadPerMin: 0.3,
  skimPerMin: 0.05,
  faceLossPerMin: 0.1,
  secondFacePerMin: 0,
  glarePerMin: 0,
  occlusionPerMin: 0,
  postureJumpsPerMin: 0.1,
  leansPerMin: 0.15,
  driftDeg: 0.5,
  driftCm: 0.3,
  finishPausePerPage: 0.15,
  finishRereadPerPage: 0.1,
  reopensPerHour: 1.5,
  arrivalGlanceChance: 0.5,
};

/** The scoreboard's scenarios. `minutes` is per run; the bench runs several seeds of each. */
export const SCENARIOS: readonly Scenario[] = [
  { ...BASE, name: 'clean', about: 'good light, 30 fps, ordinary reading habits' },
  {
    ...BASE,
    name: 'everyday',
    about: 'a bit of everything: stalls, face losses, glare, a hand, a passer-by, fidgeting',
    fps: 24,
    fpsSpread: 0.3,
    stallsPerMin: 0.5,
    jitter: 1.3,
    faceLossPerMin: 0.3,
    secondFacePerMin: 0.05,
    glarePerMin: 0.05,
    occlusionPerMin: 0.05,
    postureJumpsPerMin: 0.2,
    leansPerMin: 0.25,
  },
  { ...BASE, name: 'noisy webcam', about: 'raw gaze error at published webcam levels (~2–3°)', noise: WORLDS.W3.noise, jitter: 2.2 },
  { ...BASE, name: 'dim, 15 fps', about: 'evening light: noisy landmarks, auto-exposure halves the rate', jitter: 2.5, fps: 15, faceLossPerMin: 0.4 },
  { ...BASE, name: '10 fps', about: 'a throttled or slow machine', fps: 10, fpsSpread: 0.3, stallsPerMin: 1 },
  { ...BASE, name: 'busy room', about: 'people walking behind, a hand on the chin', secondFacePerMin: 0.4, occlusionPerMin: 0.3, faceLossPerMin: 0.3 },
  { ...BASE, name: 'glasses', about: 'frequent reflections on the lenses', glarePerMin: 0.4 },
  { ...BASE, name: 'fidgety', about: 'restless posture: jumps, leaning, more wander', postureJumpsPerMin: 0.6, leansPerMin: 0.8, driftDeg: 1.5, driftCm: 1 },
  { ...BASE, name: 'distracted', about: 'phone, keyboard, looking away, pauses, re-reading and skimming, 3× as often', phonePerMin: 0.6, keyboardPerMin: 0.6, lookAwayPerMin: 1.5, pausePerMin: 0.9, rereadPerMin: 0.9, skimPerMin: 0.15, deweyPerMin: 0.9, arrivalGlanceChance: 0.8 },
];

export const scenario = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
};

// ───────────────────────────────── Event tracks ─────────────────────────────────

interface Interval<P> {
  start: number;
  end: number;
  payload: P;
}

/** A Poisson process of intervals, queried with a monotonically increasing time. */
class Track<P> {
  private i = 0;
  constructor(readonly intervals: readonly Interval<P>[]) {}
  at(t: number): Interval<P> | null {
    while (this.i < this.intervals.length && this.intervals[this.i]!.end <= t) this.i++;
    const iv = this.intervals[this.i];
    return iv && iv.start <= t ? iv : null;
  }
}

const uniform = (r: () => number, [a, b]: Range): number => a + (b - a) * r();
const exponential = (r: () => number, ratePerMs: number): number => -Math.log(Math.max(r(), 1e-12)) / ratePerMs;

function poisson<P>(r: () => number, perMin: number, endMs: number, duration: Range, payload: (r: () => number) => P, startMs = 5000): Track<P> {
  const out: Interval<P>[] = [];
  if (perMin > 0) {
    const rate = perMin / 60_000;
    for (let t = startMs + exponential(r, rate); t < endMs; t += exponential(r, rate)) {
      const d = uniform(r, duration);
      out.push({ start: t, end: t + d, payload: payload(r) });
      t += d; // no overlap within a track
    }
  }
  return new Track(out);
}

export type Diversion =
  | { kind: 'look-away'; target: Point }
  | { kind: 'phone'; target: Point }
  | { kind: 'keyboard'; target: Point }
  | { kind: 'dewey'; target: Point }
  | { kind: 'pause' }
  | { kind: 'reread'; lines: number; frac: number };

const DIVERSIONS: ReadonlyArray<{ kind: Diversion['kind']; rate: (s: Scenario) => number; duration: Range }> = [
  { kind: 'look-away', rate: (s) => s.lookAwayPerMin, duration: [500, 3000] },
  { kind: 'phone', rate: (s) => s.phonePerMin, duration: [2000, 8000] },
  { kind: 'keyboard', rate: (s) => s.keyboardPerMin, duration: [800, 4000] },
  { kind: 'dewey', rate: (s) => s.deweyPerMin, duration: [500, 1500] },
  { kind: 'pause', rate: (s) => s.pausePerMin, duration: [2000, 6000] },
  { kind: 'reread', rate: (s) => s.rereadPerMin, duration: [1000, 3000] },
];

/** A phone on the desk in front of the laptop: 30–40° below the eyes (mostly past the tracker's range). */
const phoneGlance = (r: () => number): Diversion => ({ kind: 'phone', target: { x: uniform(r, [400, 900]), y: uniform(r, [1500, 1900]) } });
/** The keyboard: 5–12 cm below the screen's edge, where gaze is still tracked (and looks like a glance down). */
const keyboardGlance = (r: () => number): Diversion => ({ kind: 'keyboard', target: { x: uniform(r, [300, 1000]), y: VIEW.height + uniform(r, [200, 500]) } });

/** Gaze-diverting behaviour as one non-overlapping sequence (one thing at a time). */
function diversions(r: () => number, s: Scenario, endMs: number): Track<Diversion> {
  const total = DIVERSIONS.reduce((a, d) => a + d.rate(s), 0);
  const out: Interval<Diversion>[] = [];
  if (total > 0) {
    for (let t = 5000 + exponential(r, total / 60_000); t < endMs; t += exponential(r, total / 60_000)) {
      let pick = r() * total;
      const d = DIVERSIONS.find((x) => (pick -= x.rate(s)) < 0) ?? DIVERSIONS[DIVERSIONS.length - 1]!;
      const dur = uniform(r, d.duration);
      let payload: Diversion;
      switch (d.kind) {
        case 'look-away': {
          // Off a screen edge: left, right or above it, 10–25° out.
          const side = Math.floor(r() * 3);
          payload = {
            kind: 'look-away',
            target: side === 0 ? { x: -uniform(r, [400, 900]), y: uniform(r, [0, 800]) } : side === 1 ? { x: VIEW.width + uniform(r, [400, 900]), y: uniform(r, [0, 800]) } : { x: uniform(r, [200, 1080]), y: -uniform(r, [400, 800]) },
          };
          break;
        }
        case 'phone':
          payload = phoneGlance(r);
          break;
        case 'keyboard':
          payload = keyboardGlance(r);
          break;
        case 'dewey':
          payload = { kind: 'dewey', target: { x: uniform(r, [1150, 1230]), y: uniform(r, [690, 760]) } };
          break;
        case 'pause':
          payload = { kind: 'pause' };
          break;
        case 'reread':
          payload = { kind: 'reread', lines: 2 + Math.floor(r() * 5), frac: uniform(r, [0.05, 0.6]) };
          break;
      }
      out.push({ start: t, end: t + dur, payload });
      t += dur;
    }
  }
  return new Track(out);
}

// ─────────────────────────────────── The world ───────────────────────────────────

export interface Truth {
  /** Where the eyes really look (viewport px; may be off the screen), or null with the eyes shut. */
  gaze: Point | null;
  /** The reader's own activity: reading, lingering at the end of the page (finished it), away, idle. */
  mode: 'reading' | 'lingering' | 'away' | 'idle';
  /** docTop of the line being read, or null. */
  lineDocTop: number | null;
  /** When the reader finished the page's last line (lingering since), or null. */
  lingerSince: number | null;
  /** The frame shows someone else's face (the tracker locked on to a passer-by). */
  otherFace: boolean;
  eyesShut: boolean;
  /** Active disturbances and behaviours, for attributing failures. */
  active: string[];
}

export interface WorldFrame {
  t: number;
  /** What the face tracker reports; null when it found no face. */
  frame: Frame | null;
  truth: Truth;
  /** The reader closed the book and opened it again just before this frame (the app starts its reading layer over). */
  event?: 'reopen';
}

/** After finishing a page: eyes elsewhere for a while (phase A), then a deliberate look below the page (phase B). */
interface FinishEpisode {
  kind: 'finish-pause' | 'finish-reread';
  start: number;
  aEnd: number;
  end: number;
  scrollTop: number;
  /** Phase A: where the eyes are, as fixations (one point for a pause; a short run of reading for a re-read). */
  fixations: { t: number; at: Point }[];
  /** Phase B: below the page. */
  down: Point;
}

export interface WorldOptions {
  seed: number;
  scenario: Scenario;
  /** Override the session length (minutes). */
  minutes?: number;
}

export class World {
  readonly scenario: Scenario;
  readonly doc: SyntheticDocument;
  readonly endMs: number;
  layout: LineLayout;
  t = 0;

  private readonly r: () => number;
  private readonly brain: ReaderBrain;
  private readonly speed = { factor: 1 };
  private readonly diversion: Track<Diversion>;
  private readonly blinks: Track<null>;
  private readonly closures: Track<null>;
  private readonly skims: Track<null>;
  private readonly faceLoss: Track<null>;
  private readonly secondFace: Track<{ pose: Pose; capture: Range; target: Point }>;
  private readonly glare: Track<{ dx: number; dy: number; eyes: 'both' | 'right' | 'left' }>;
  private readonly occlusion: Track<{ dx: number; dy: number; eyes: 'right' | 'left' }>;
  private readonly stalls: Track<null>;
  private readonly leans: Track<number>;
  private readonly jumps: number[];
  private jumpIndex = 0;
  /** Posture: the base pose (moved by jumps), slow wander (OU), the current lean offset. */
  private posture: Pose = { ...BASE_POSE };
  private postureFrom: Pose = { ...BASE_POSE };
  private postureTo: Pose = { ...BASE_POSE };
  private postureT0 = -Infinity;
  private wander = { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0 };
  private rereadTarget: Point | null = null;
  private lastGaze: Point = { x: VIEW.width / 2, y: VIEW.height / 2 };
  private lastDiversion: Interval<Diversion> | null = null;
  /** Diversions placed at a moment rather than by the Poisson track (arrivals: see arrive()). */
  private readonly overrides: Interval<Diversion>[] = [];
  /** Separate streams, so these behaviours don't reshuffle the frames, events and head of a seed. */
  private readonly arrivalR: () => number;
  private readonly episodeR: () => number;
  private readonly reopens: Track<null>;
  private reopenDone: Interval<null> | null = null;
  private wasLingering = false;
  private episode: FinishEpisode | null = null;

  constructor(opts: WorldOptions) {
    this.scenario = opts.scenario;
    const s = opts.scenario;
    const minutes = opts.minutes ?? s.minutes;
    this.endMs = minutes * 60_000;
    const seed = opts.seed;
    this.r = mulberry32(seed * 7919 + 13);
    const ev = mulberry32(seed * 104729 + 7);
    // Enough text for the whole session (≈ 6 characters per word, 62 per line), skimming included.
    const lines = Math.ceil(((minutes * s.wpm * 6) / 62) * 1.6) + 60;
    this.doc = makeDocument({ lines, pitch: PITCH, columnLeft: COLUMN.left, columnRight: COLUMN.right, paragraphGap: 0, indentPx: 33, paragraphLines: [3, 9], seed: 500 + seed });
    this.layout = this.doc.layoutAt(0, { viewport: VIEWPORT, measuredAt: 0 });
    this.brain = new ReaderBrain(mulberry32(seed), { wpm: () => s.wpm * this.speed.factor });
    this.diversion = diversions(ev, s, this.endMs);
    this.blinks = poisson(ev, s.blinksPerMin, this.endMs, [100, 400], () => null, 1000);
    this.closures = poisson(ev, s.closuresPerMin, this.endMs, [1000, 5000], () => null);
    this.skims = poisson(ev, s.skimPerMin, this.endMs, [30_000, 90_000], () => null);
    this.faceLoss = poisson(ev, s.faceLossPerMin, this.endMs, [200, 3000], () => null);
    this.secondFace = poisson(ev, s.secondFacePerMin, this.endMs, [2000, 10_000], (r) => {
      const side = r() < 0.5 ? -1 : 1;
      const a = r();
      const b = a + (1 - a) * r();
      return {
        pose: { yaw: -side * uniform(r, [5, 20]) * DEG, pitch: uniform(r, [-5, 10]) * DEG, roll: 0, tx: side * uniform(r, [15, 25]), ty: uniform(r, [-8, -2]), tz: -uniform(r, [70, 110]) },
        capture: [a, b] as const,
        target: { x: uniform(r, [-300, VIEW.width + 300]), y: uniform(r, [-300, VIEW.height + 300]) },
      };
    });
    this.glare = poisson(ev, s.glarePerMin, this.endMs, [5000, 60_000], (r) => {
      const m = uniform(r, [0.04, 0.12]);
      const a = r() * 2 * Math.PI;
      const pick = r();
      return { dx: m * Math.cos(a), dy: m * Math.sin(a), eyes: pick < 0.5 ? 'both' : pick < 0.75 ? 'right' : 'left' };
    });
    this.occlusion = poisson(ev, s.occlusionPerMin, this.endMs, [2000, 10_000], (r) => {
      const m = uniform(r, [0.15, 0.3]);
      const a = r() * 2 * Math.PI;
      return { dx: m * Math.cos(a), dy: m * Math.sin(a), eyes: r() < 0.5 ? 'right' : 'left' };
    });
    this.stalls = poisson(ev, s.stallsPerMin, this.endMs, s.stallMs, () => null);
    this.leans = poisson(ev, s.leansPerMin, this.endMs, [10_000, 60_000], (r) => (r() < 0.5 ? 1 : -1) * uniform(r, [5, 10]));
    this.arrivalR = mulberry32(seed * 6151 + 29);
    this.episodeR = mulberry32(seed * 3571 + 41);
    // Closing and reopening the book: 3–10 s away (the library, the camera starting again).
    this.reopens = poisson(mulberry32(seed * 1229 + 53), s.reopensPerHour / 60, this.endMs, [3000, 10_000], () => null, 60_000);
    this.arrive(0);
    this.jumps = [];
    if (s.postureJumpsPerMin > 0) {
      for (let t = 30_000 + exponential(ev, s.postureJumpsPerMin / 60_000); t < this.endMs; t += exponential(ev, s.postureJumpsPerMin / 60_000)) this.jumps.push(t);
    }
  }

  /** The reader's eye-movement state (for missed-turn timing in the rig). */
  get reader(): ReaderBrain {
    return this.brain;
  }

  /**
   * The book has just opened (or reopened), or a calibration refresh ended: now and then the reader
   * looks at the phone or the keyboard for 1–4 s before reading (arrivalGlanceChance).
   */
  arrive(t: number): void {
    const r = this.arrivalR;
    if (r() >= this.scenario.arrivalGlanceChance) return;
    const start = t + uniform(r, [0, 300]);
    this.overrides.push({ start, end: start + uniform(r, [1000, 4000]), payload: r() < 0.5 ? phoneGlance(r) : keyboardGlance(r) });
  }

  /** The page scrolled (a turn): the reader follows on the next frame. */
  scrollTo(top: number): void {
    this.layout = this.doc.layoutAt(top, { viewport: VIEWPORT, measuredAt: this.t });
  }

  /** The reader spends `ms` on something that isn't reading (a quick recalibration): no frames, the plan waits. */
  hold(ms: number): void {
    this.brain.shift(ms);
    this.t += ms;
  }

  /** A 5-dot quick refresh at the reader's current posture and conditions (what the overlay would collect). */
  refreshSamples(): CalibrationSample[] {
    const out: CalibrationSample[] = [];
    for (const tf of QUICK_TARGETS) {
      const target = { x: tf.x * VIEW.width, y: tf.y * VIEW.height };
      const fix = { h: 0.4 * DEG * gauss(this.r), v: 0.4 * DEG * gauss(this.r) };
      for (let i = 0; i < 34; i++) {
        const pose = this.pose(target, this.t);
        const gn = { h: fix.h + 0.1 * DEG * gauss(this.r), v: fix.v + 0.1 * DEG * gauss(this.r) };
        const f = frameFeatures(makeFrame(target, pose, gn, this.perturbation(this.t, false), this.r, this.scenario.noise));
        if (f) out.push({ target, features: f, t: this.t + i * 33 });
      }
    }
    return out;
  }

  /** The calibration at the start: 13 dots in the base posture, today's light. */
  calibrationSamples(seed: number): CalibrationSample[] {
    return calibrationSession(seed, { noise: this.scenario.noise, light: { jitter: this.scenario.jitter } });
  }

  /** The next camera frame, or null at the end of the session. */
  next(): WorldFrame | null {
    const s = this.scenario;
    const interval = (1000 / s.fps) * (1 + s.fpsSpread * (2 * this.r() - 1));
    let t = this.t + interval;
    const stall = this.stalls.at(t);
    if (stall) t = stall.end + interval * this.r(); // frames lost during a stall
    // Closed the book and reopened it: no frames meanwhile, and the reading plan waits.
    let event: WorldFrame['event'];
    const reopen = this.reopens.at(t);
    if (reopen && reopen !== this.reopenDone) {
      this.reopenDone = reopen;
      const gap = reopen.end - this.t;
      this.brain.shift(gap);
      t = reopen.end + interval * this.r();
      event = 'reopen';
      this.episode = null;
      this.arrive(t);
    }
    const dt = t - this.t;
    this.t = t;
    if (t >= this.endMs) return null;

    this.speed.factor = this.skims.at(t) ? 2.5 : 1;
    const active: string[] = [];
    while (this.overrides.length > 0 && this.overrides[0]!.end <= t) this.overrides.shift();
    const early = this.overrides[0] && this.overrides[0].start <= t ? this.overrides[0] : null;
    const div = early ?? this.diversion.at(t);
    if (div !== this.lastDiversion) {
      this.rereadTarget = null;
      this.lastDiversion = div;
    }
    const episode = this.finishEpisode(t);
    let gaze: Point | null;
    let mode: Truth['mode'];
    if (episode) {
      active.push(episode.kind);
      this.brain.shift(dt); // the plan waits; the finished page's wait goes on (see finishEpisode)
      if (this.brain.lingerStartedAt !== null) this.brain.lingerStartedAt -= dt;
      mode = 'lingering';
      gaze = episode.gaze;
      if (episode.down) active.push('look-down');
    } else if (div) {
      active.push(div.payload.kind);
      this.brain.shift(dt); // the reading plan waits
      mode = this.brain.mode === 'lingering' ? 'lingering' : 'away';
      gaze = this.diversionGaze(div.payload);
    } else {
      const truth = this.brain.advance(t, this.layout);
      gaze = truth ? { x: truth.x, y: truth.y } : null;
      mode = this.brain.mode === 'idle' ? 'idle' : this.brain.mode;
    }
    if (gaze && (mode === 'reading' || mode === 'lingering')) this.lastGaze = gaze;
    if (this.speed.factor > 1) active.push('skim');

    const blink = this.blinks.at(t);
    const closure = this.closures.at(t);
    let squint = 0;
    if (closure) {
      squint = 1;
      active.push('eyes-closed');
    } else if (blink) {
      const x = (t - blink.start) / (blink.end - blink.start);
      squint = Math.min(1, 3 * Math.min(x, 1 - x) + (x > 1 / 3 && x < 2 / 3 ? 1 : 0));
      active.push('blink');
    }
    const eyesShut = squint >= 0.9;

    const truthBase = {
      mode,
      lineDocTop: this.brain.lineDocTop,
      lingerSince: this.brain.mode === 'lingering' ? this.brain.lingerStartedAt : null,
    };
    if (this.faceLoss.at(t)) {
      active.push('face-lost');
      return { t, frame: null, truth: { ...truthBase, gaze: eyesShut ? null : gaze, otherFace: false, eyesShut, active } };
    }
    const other = this.secondFace.at(t);
    if (other) {
      active.push('second-face');
      const span = other.end - other.start;
      const [a, b] = other.payload.capture;
      if (t >= other.start + a * span && t <= other.start + b * span) {
        // The tracker follows the passer-by: a real face, looking somewhere else, in another place.
        const p = other.payload;
        if (this.r() < 0.02) p.target = { x: uniform(this.r, [-300, VIEW.width + 300]), y: uniform(this.r, [-300, VIEW.height + 300]) };
        const frame = makeFrame(p.target, p.pose, { h: 0.2 * DEG * gauss(this.r), v: 0.2 * DEG * gauss(this.r) }, { jitter: s.jitter }, this.r, s.noise);
        return { t, frame, truth: { ...truthBase, gaze, otherFace: true, eyesShut, active } };
      }
    }
    const light = this.perturbation(t, true, active);
    light.squint = squint;
    const target = gaze ?? this.lastGaze;
    const frame = makeFrame(target, this.pose(target, t, dt), { h: 0.1 * DEG * gauss(this.r), v: 0.1 * DEG * gauss(this.r) }, light, this.r, s.noise);
    const out: WorldFrame = { t, frame, truth: { ...truthBase, gaze: eyesShut ? null : gaze, otherFace: false, eyesShut, active } };
    if (event) out.event = event;
    return out;
  }

  /**
   * The reader has just finished the page (the brain started lingering): now and then, instead of
   * waiting at the end of the last line, they rest their eyes elsewhere on the page or re-read a few
   * lines for 1.6–4 s, then look below the page (the turn gesture, from wherever they are). The time
   * counts as waiting for the turn: a page still unturned 8 s after its end is a miss, as before.
   */
  private finishEpisode(t: number): { kind: FinishEpisode['kind']; gaze: Point; down: boolean } | null {
    const lingering = this.brain.mode === 'lingering';
    if (lingering && !this.wasLingering) this.episode = this.planEpisode(t);
    this.wasLingering = lingering;
    const e = this.episode;
    if (!e) return null;
    if (!lingering || t >= e.end || Math.abs(this.layout.scrollTop - e.scrollTop) > 0.5) {
      this.episode = null; // over, or the page turned under it
      return null;
    }
    if (t < e.start) return null;
    if (t >= e.aEnd) return { kind: e.kind, gaze: { x: e.down.x + 12 * gauss(this.episodeR), y: e.down.y + 12 * gauss(this.episodeR) }, down: true };
    let at = e.fixations[0]!.at;
    for (const f of e.fixations) if (f.t <= t) at = f.at;
    return { kind: e.kind, gaze: at, down: false };
  }

  private planEpisode(t: number): FinishEpisode | null {
    const r = this.episodeR;
    const s = this.scenario;
    const pick = r();
    const kind: FinishEpisode['kind'] | null = pick < s.finishPausePerPage ? 'finish-pause' : pick < s.finishPausePerPage + s.finishRereadPerPage ? 'finish-reread' : null;
    if (!kind) return null;
    const lines = this.layout.lines;
    let L = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.fullyVisible) { L = i; break; }
    if (L < 0) return null;
    const last = lines[L]!;
    const col = this.layout.column;
    const start = t + uniform(r, [150, 450]);
    const aEnd = start + uniform(r, [1600, 4000]);
    const fixations: { t: number; at: Point }[] = [];
    if (kind === 'finish-pause') {
      // Eyes at rest: the middle of the page (thinking), the start of a line in the last paragraph, or the start of the last line.
      const where = r();
      const w = col.right - col.left;
      const line = lines[Math.max(0, L - 1 - Math.floor(r() * 6))]!;
      const at =
        where < 0.4
          ? { x: col.left + uniform(r, [0.3, 0.7]) * w, y: this.layout.viewport.top + uniform(r, [0.35, 0.65]) * (this.layout.viewport.bottom - this.layout.viewport.top) }
          : where < 0.8
            ? { x: line.left + uniform(r, [0, 0.35]) * (line.right - line.left), y: line.centerY }
            : { x: last.left + uniform(r, [0, 0.4]) * (last.right - last.left), y: last.centerY };
      fixations.push({ t: start, at });
    } else {
      // Back up one to three lines and read on from there, at reading pace, until phase A ends.
      let i = Math.max(0, L - 1 - Math.floor(r() * 3));
      let char = 3 + 2 * r();
      for (let ft = start; ft < aEnd; ft += uniform(r, [180, 300])) {
        const line = lines[i]!;
        const n = Math.max(1, line.charCount);
        if (char > n - 1) {
          if (i >= L) break;
          i++;
          char = 3 + 2 * r();
        }
        const l = lines[i]!;
        fixations.push({ t: ft, at: { x: l.left + (char * (l.right - l.left)) / Math.max(1, l.charCount), y: l.centerY } });
        char += Math.max(2, 7.5 + 2 * gauss(r));
      }
      if (fixations.length === 0) fixations.push({ t: start, at: { x: last.left, y: last.centerY } });
    }
    const from = fixations[fixations.length - 1]!.at;
    const down = { x: from.x + uniform(r, [-60, 60]), y: this.layout.viewport.bottom + uniform(r, [0.5, 3]) * PITCH };
    return { kind, start, aEnd, end: aEnd + uniform(r, [700, 1500]), scrollTop: this.layout.scrollTop, fixations, down };
  }

  private diversionGaze(d: Diversion): Point {
    switch (d.kind) {
      case 'look-away':
      case 'phone':
      case 'keyboard':
      case 'dewey':
        return { x: d.target.x + 15 * gauss(this.r), y: d.target.y + 15 * gauss(this.r) };
      case 'pause':
        return this.lastGaze;
      case 'reread': {
        if (!this.rereadTarget) {
          // A few lines up from where the reader is: re-reading a sentence.
          const lines = this.layout.lines;
          const here = lines.findIndex((l) => this.brain.lineDocTop !== null && Math.abs(l.docTop - this.brain.lineDocTop) < 1);
          const line = lines[Math.max(0, (here < 0 ? lines.length - 1 : here) - d.lines)];
          this.rereadTarget = line ? { x: line.left + d.frac * (line.right - line.left), y: line.centerY } : this.lastGaze;
        }
        return this.rereadTarget;
      }
    }
  }

  private perturbation(t: number, live: boolean, active?: string[]): Perturbation {
    const p: Perturbation = { jitter: this.scenario.jitter };
    if (!live) return p;
    const g = this.glare.at(t);
    if (g) {
      p.irisBias = { dx: g.payload.dx, dy: g.payload.dy };
      p.irisBiasEyes = g.payload.eyes;
      active?.push('glare');
    }
    const o = this.occlusion.at(t);
    if (o) {
      p.irisBias = { dx: o.payload.dx, dy: o.payload.dy };
      p.irisBiasEyes = o.payload.eyes;
      p.jitter = (p.jitter ?? 1) * 3;
      active?.push('occlusion');
    }
    return p;
  }

  /** Head pose at `t`: posture (with jumps), slow wander, leaning, and a little turn toward the target. */
  private pose(target: Point, t: number, dt = 0): Pose {
    const s = this.scenario;
    while (this.jumpIndex < this.jumps.length && this.jumps[this.jumpIndex]! <= t) {
      this.jumpIndex++;
      this.postureFrom = this.currentPosture(t);
      const sign = (): number => (this.r() < 0.5 ? -1 : 1);
      this.postureTo = {
        ...this.postureTo,
        pitch: BASE_POSE.pitch + sign() * uniform(this.r, [2, 6]) * DEG,
        yaw: BASE_POSE.yaw + sign() * uniform(this.r, [1, 4]) * DEG,
        ty: BASE_POSE.ty + sign() * uniform(this.r, [1, 3]),
        tx: BASE_POSE.tx + sign() * uniform(this.r, [1, 3]),
      };
      this.postureT0 = t;
    }
    this.posture = this.currentPosture(t);
    if (dt > 0) {
      // Ornstein–Uhlenbeck wander: SD driftDeg/driftCm per √minute, mean-reverting over ~10 minutes.
      const m = dt / 60_000;
      const k = Math.exp(-m / 10);
      const step = (sd: number): number => sd * Math.sqrt(m) * gauss(this.r);
      this.wander = {
        yaw: k * this.wander.yaw + step(s.driftDeg * DEG),
        pitch: k * this.wander.pitch + step(s.driftDeg * DEG),
        roll: k * this.wander.roll + step(0.5 * s.driftDeg * DEG),
        tx: k * this.wander.tx + step(s.driftCm),
        ty: k * this.wander.ty + step(s.driftCm),
      };
    }
    const lean = this.leans.at(t);
    let dz = 0;
    if (lean) {
      const ramp = Math.min(1, (t - lean.start) / 2000, (lean.end - t) / 2000);
      dz = lean.payload * Math.max(0, ramp);
    }
    const base: Pose = {
      yaw: this.posture.yaw + this.wander.yaw,
      pitch: this.posture.pitch + this.wander.pitch,
      roll: this.posture.roll + this.wander.roll,
      tx: this.posture.tx + this.wander.tx,
      ty: this.posture.ty + this.wander.ty,
      tz: this.posture.tz + dz,
    };
    return headFollow(target, base);
  }

  private currentPosture(t: number): Pose {
    const x = Math.min(1, Math.max(0, (t - this.postureT0) / 1000));
    const lerp = (a: number, b: number): number => a + (b - a) * x;
    const a = this.postureFrom;
    const b = this.postureTo;
    return { yaw: lerp(a.yaw, b.yaw), pitch: lerp(a.pitch, b.pitch), roll: lerp(a.roll, b.roll), tx: lerp(a.tx, b.tx), ty: lerp(a.ty, b.ty), tz: lerp(a.tz, b.tz) };
  }
}
