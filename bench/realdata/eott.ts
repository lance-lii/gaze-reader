import { extractEyeFeatures } from '../../src/gaze/features';
import type { CalibrationSample, EyeFeatures, Point } from '../../src/types';
import { fs, quantile } from './dataset';

/**
 * Real people moving their eyes, on video: the dot tests of the EOTT dataset (51 people filmed by
 * an ordinary webcam in a lab, each also followed by a dedicated eye tracker), after
 * scripts/research/extract_eott.py and extract_eott_reference.py have run the app's face model
 * over every frame. Each record is what the app's tracker would have been handed for one frame,
 * turned here into the app's features by the app's own code (extractEyeFeatures).
 *
 * Each person gives one test case, shaped like the app's own use: a calibration (the first dot
 * test: the person clicks dots, and is taken to look where they click) and, minutes later, a
 * reading to score (the final dot test: a dot shown at nine known places for three seconds each).
 *
 * The data is not in the repository (the dataset is GPLv3, and 220 MB extracted): see
 * docs/REAL_DATA.md.
 */
const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; cwd?: () => string } }).process;
const join = (...parts: string[]): string => parts.join('/');

export const EOTT_DIR = proc?.env?.GR_EOTT_DATA ?? join(proc?.cwd?.() ?? '.', '.data', 'eott', 'features');
/** Per-frame answers of a network trained by scripts/research/train_eye_cnn.py, when it has been run. */
export const EOTT_CNN_DIR = proc?.env?.GR_EOTT_CNN ?? join(proc?.cwd?.() ?? '.', '.data', 'eott', 'cnn');

/** Frames this long before a click calibrate on it: the eyes are on a thing while the hand clicks it. */
export const CLICK_WINDOW_MS = 500;
/** A dot's first frames are the eyes still on their way to it. */
export const DOT_SETTLE_MS = 800;
/** As the app takes it: the camera sits this far above the middle of the screen's top edge. */
export const CAMERA_ABOVE_SCREEN_PX = 36;

/**
 * The lighting gate. A test case counts as "same light" when, between the calibration and the
 * test, the face is within 10 % of the same brightness and its two halves keep their balance to
 * within 10 %; and a frame is dropped when the face in it is more than 10 % off its own
 * recording's usual brightness. Fixed before any score was looked at.
 */
export const LIGHT_BRIGHTNESS_TOLERANCE = 0.1;
export const LIGHT_BALANCE_TOLERANCE = 0.1;
export const LIGHT_FRAME_TOLERANCE = 0.1;

export interface Light {
  /** Mean brightness of the face, 0–255. */
  face: number;
  /** ln(left half ÷ right half), as the picture shows them. */
  balance: number;
  /** Mean brightness of the picture outside the face. */
  rest: number;
  /** Share of face pixels blown out (≥ 250). */
  clipped: number;
}

export interface EottFrame {
  session: 1 | 2;
  /** Its row in the person's record file (and in the file of eye pictures). */
  row: number;
  /** Milliseconds on the clock of the session's log (the video's own time plus its measured lag). */
  t: number;
  features: EyeFeatures;
  light: Light;
  /** Where the reference eye tracker has the gaze at this moment, screen px. */
  reference: Point | null;
  /** The trained network's answer for this frame, when there is one. */
  cnn: Point | null;
}

export interface EottSession {
  session: 1 | 2;
  name: string;
  clicks: { t: number; x: number; y: number }[];
  dots: { t0: number; t1: number; x: number; y: number }[];
  /** How far the video runs behind the log's clock, and how well that could be measured. */
  lagMs: number | null;
  lagCorrelation: number | null;
  frames: number;
  noFace: number;
  /** The usual lighting of the session's frames. */
  light: Light | null;
}

export interface EottPerson {
  id: string;
  setting: string;
  screen: { widthPx: number; heightPx: number; widthMm: number; heightMm: number };
  mmPerPx: number;
  /** Eyes to screen, mm: as measured in the lab, or the setting's median where it wasn't. */
  distanceMm: number;
  camera: Point;
  sessions: EottSession[];
  frames: EottFrame[];
  /** Frames with a face whose features the app's extractor refused. */
  unusable: number;
}

interface Meta {
  participant: string;
  recordLength: number;
  header: number;
  landmarks: number;
  blendshapeNames: string[];
  setting: string;
  screen: EottPerson['screen'];
  distanceMm: number | null;
  sessions: {
    session: 1 | 2;
    name: string;
    frames: number;
    noFace: number;
    clicks: { t: number; x: number; y: number }[];
    dots: { t0: number; t1: number; x: number; y: number }[];
    videoLagMs?: number | null;
    lagCorrelation?: number | null;
  }[];
}

export function eottAvailable(dir = EOTT_DIR): boolean {
  return !!fs && fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^P_\d+\.json$/.test(f));
}

function floats(path: string): Float32Array {
  const bytes = fs!.readFileSync(path);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.floor(bytes.byteLength / 4) * 4));
}

const median = (xs: number[]): number => quantile(xs, 0.5);

function usualLight(frames: readonly EottFrame[]): Light | null {
  if (frames.length < 10) return null;
  return {
    face: median(frames.map((f) => f.light.face)),
    balance: median(frames.map((f) => f.light.balance)),
    rest: median(frames.map((f) => f.light.rest)),
    clipped: frames.reduce((a, f) => a + f.light.clipped, 0) / frames.length,
  };
}

let cached: EottPerson[] | null = null;

export function loadEott(dir = EOTT_DIR, cnnDir = EOTT_CNN_DIR): EottPerson[] {
  if (cached) return cached;
  if (!fs) throw new Error('The real-face scoreboards need Node 22.3+ (process.getBuiltinModule).');
  const out: EottPerson[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => /^P_\d+\.json$/.test(f)).sort()) {
    const meta = JSON.parse(new TextDecoder().decode(fs.readFileSync(join(dir, file)))) as Meta;
    const data = floats(join(dir, file.replace(/\.json$/, '.f32')));
    const refPath = join(dir, file.replace(/\.json$/, '.ref.f32'));
    const ref = fs.existsSync(refPath) ? floats(refPath) : new Float32Array(0);
    const cnnPath = join(cnnDir, file.replace(/\.json$/, '.f32'));
    const cnn = fs.existsSync(cnnPath) ? floats(cnnPath) : null;
    const L = meta.recordLength;
    const nBlend = L - meta.header - 2 * meta.landmarks - 16;
    const lag = new Map(meta.sessions.map((s) => [s.session, s.videoLagMs ?? null]));

    // The reference tracker's samples per session, in time order: (ms, x, y).
    const refOf = new Map<number, { t: number[]; x: number[]; y: number[] }>();
    for (let r = 0; r + 5 <= ref.length; r += 5) {
      let s = refOf.get(ref[r]);
      if (!s) refOf.set(ref[r], (s = { t: [], x: [], y: [] }));
      s.t.push(ref[r + 1]);
      s.x.push(ref[r + 2]);
      s.y.push(ref[r + 3]);
    }
    /** The reference at a moment: between its two nearest samples, unless they are over 50 ms apart (it had lost the eyes). */
    const referenceAt = (session: number, t: number): Point | null => {
      const s = refOf.get(session);
      if (!s || s.t.length < 2 || t < s.t[0] || t > s.t[s.t.length - 1]) return null;
      let lo = 0;
      let hi = s.t.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s.t[mid] <= t) lo = mid;
        else hi = mid;
      }
      if (s.t[hi] - s.t[lo] > 50) return null;
      const u = s.t[hi] === s.t[lo] ? 0 : (t - s.t[lo]) / (s.t[hi] - s.t[lo]);
      return { x: s.x[lo] + u * (s.x[hi] - s.x[lo]), y: s.y[lo] + u * (s.y[hi] - s.y[lo]) };
    };

    const frames: EottFrame[] = [];
    let unusable = 0;
    for (let r = 0, row = 0; r + L <= data.length; r += L, row++) {
      const h = data.subarray(r, r + meta.header);
      const session = h[0] as 1 | 2;
      const shift = lag.get(session);
      if (shift === null || shift === undefined) continue; // the video could not be put on the log's clock
      let o = r + meta.header;
      const landmarks: { x: number; y: number; z: number }[] = new Array(meta.landmarks);
      for (let i = 0; i < meta.landmarks; i++) landmarks[i] = { x: data[o + 2 * i], y: data[o + 2 * i + 1], z: 0 };
      o += 2 * meta.landmarks;
      const blend = meta.blendshapeNames.slice(0, nBlend).map((categoryName, i) => ({ categoryName, score: data[o + i] }));
      o += nBlend;
      const matrix = Array.from(data.subarray(o, o + 16));
      const features = extractEyeFeatures(landmarks, blend, matrix, { aspectRatio: h[3] / h[4] });
      if (!features) {
        unusable++;
        continue;
      }
      const t = h[2] + shift;
      const answer = cnn && Number.isFinite(cnn[2 * row]) && Number.isFinite(cnn[2 * row + 1]) ? { x: cnn[2 * row], y: cnn[2 * row + 1] } : null;
      frames.push({
        session,
        row,
        t,
        features,
        light: { face: h[5], balance: Math.log(Math.max(h[6], 1) / Math.max(h[7], 1)), rest: h[8], clipped: h[9] },
        reference: referenceAt(session, t),
        cnn: answer,
      });
    }
    const mmPerPx = meta.screen.widthMm / meta.screen.widthPx;
    out.push({
      id: meta.participant,
      setting: meta.setting,
      screen: meta.screen,
      mmPerPx,
      distanceMm: meta.distanceMm ?? NaN,
      camera: { x: meta.screen.widthPx / 2, y: -CAMERA_ABOVE_SCREEN_PX },
      sessions: meta.sessions.map((s) => ({
        session: s.session,
        name: s.name,
        clicks: s.clicks,
        dots: s.dots,
        lagMs: s.videoLagMs ?? null,
        lagCorrelation: s.lagCorrelation ?? null,
        frames: s.frames,
        noFace: s.noFace,
        light: usualLight(frames.filter((f) => f.session === s.session)),
      })),
      frames,
      unusable,
    });
  }
  // Where the lab did not write the distance down: the median of the people in the same setting.
  for (const p of out) {
    if (Number.isFinite(p.distanceMm)) continue;
    const same = out.filter((q) => q.setting === p.setting && Number.isFinite(q.distanceMm)).map((q) => q.distanceMm);
    p.distanceMm = same.length ? median(same) : 600;
  }
  cached = out;
  return out;
}

export interface EottSample extends CalibrationSample {
  frame: EottFrame;
}

export interface LightVerdict {
  /** Calibration and test in the same light, by the gate above. */
  same: boolean;
  /** ln(test ÷ calibration) of the face's brightness, and the change of its left–right balance. */
  brightness: number;
  balance: number;
}

export interface EottCase {
  person: EottPerson;
  /** Calibration: the frames just before each click of the first dot test, looking at the click. */
  cal: EottSample[];
  /** Test: the frames of each dot of the final dot test, once the eyes have had time to reach it. */
  test: EottSample[];
  /** The same test frames against the reference eye tracker instead of the dot (where it had the eyes). */
  testReference: EottSample[];
  light: LightVerdict | null;
  /** Frames left out of the calibration and of the test because the light on the face flickered. */
  droppedForLight: number;
}

/** One test case per person who has both dot tests. `gate: false` keeps the frames the lighting gate would drop. */
export function eottCase(p: EottPerson, gate = true): EottCase | null {
  const first = p.sessions.find((s) => s.session === 1);
  const last = p.sessions.find((s) => s.session === 2);
  if (!first || !last || first.clicks.length < 5 || last.dots.length < 5 || !first.light || !last.light) return null;
  let dropped = 0;
  const steady = (f: EottFrame, usual: Light): boolean => {
    const ok = !gate || Math.abs(Math.log(Math.max(f.light.face, 1) / Math.max(usual.face, 1))) <= LIGHT_FRAME_TOLERANCE;
    if (!ok) dropped++;
    return ok;
  };
  const cal: EottSample[] = [];
  const test: EottSample[] = [];
  const testReference: EottSample[] = [];
  for (const f of p.frames) {
    if (f.session === 1) {
      const click = first.clicks.find((c) => f.t >= c.t - CLICK_WINDOW_MS && f.t <= c.t);
      if (click && steady(f, first.light)) cal.push({ target: { x: click.x, y: click.y }, features: f.features, t: f.t, frame: f });
    } else {
      const dot = last.dots.find((d) => f.t >= d.t0 + DOT_SETTLE_MS && f.t < d.t1);
      if (dot && steady(f, last.light)) {
        test.push({ target: { x: dot.x, y: dot.y }, features: f.features, t: f.t, frame: f });
        if (f.reference) testReference.push({ target: f.reference, features: f.features, t: f.t, frame: f });
      }
    }
  }
  if (cal.length < 20 || test.length < 20) return null;
  const brightness = Math.log(Math.max(last.light.face, 1) / Math.max(first.light.face, 1));
  const balance = last.light.balance - first.light.balance;
  return {
    person: p,
    cal,
    test,
    testReference,
    light: { same: Math.abs(brightness) <= LIGHT_BRIGHTNESS_TOLERANCE && Math.abs(balance) <= LIGHT_BALANCE_TOLERANCE, brightness, balance },
    droppedForLight: dropped,
  };
}
