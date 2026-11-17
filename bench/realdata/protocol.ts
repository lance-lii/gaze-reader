import { FEATURE_INDEX } from '../../src/gaze/features';
import type { EyeFeatures, Point } from '../../src/types';
import { quantile, rng, type Participant, type RealSample } from './dataset';

/**
 * How the real-face scoreboards calibrate and score.
 *
 * A calibration is `k` consecutive pictures of one day (one sitting, as near as the dataset
 * gets: its pictures are a random 3000 of each person's weeks, in time order within a day), each
 * of a different point on the screen. The app's own calibration is 13 dots with a few dozen frames
 * each; this is more dots and one frame each.
 *
 * The model is then asked where the person looked in their other pictures:
 *  - "same day": the rest of that day (the reader sat down again, the light moved on);
 *  - "other days": every other day (a calibration reused days or weeks later, as the app does).
 *
 * An error is the distance between the predicted and the true point on the screen, in millimetres
 * and in degrees of visual angle at that picture's own viewing distance. Each person's score is
 * the median over their test pictures and calibrations; a row is the mean of those over people
 * (and the worst person), so one person with many pictures doesn't decide it.
 */
export const BLINK_MAX = 0.5;
export const LINE_MM = 9;

export interface Split {
  cal: RealSample[];
  sameDay: RealSample[];
  otherDays: RealSample[];
}

export function splits(p: Participant, k: number, count: number, seed: number, otherDaysMax = 400): Split[] {
  const random = rng(seed);
  const byDay = new Map<number, RealSample[]>();
  for (const s of p.samples) {
    if (s.features.blink > BLINK_MAX) continue;
    let list = byDay.get(s.day);
    if (!list) byDay.set(s.day, (list = []));
    list.push(s);
  }
  const days = [...byDay.entries()].filter(([, list]) => list.length >= k + 20);
  const out: Split[] = [];
  if (days.length === 0) return out;
  for (let c = 0; c < count; c++) {
    const [day, list] = days[Math.floor(random() * days.length)];
    const start = Math.floor(random() * (list.length - k + 1));
    const cal = list.slice(start, start + k);
    const sameDay = [...list.slice(0, start), ...list.slice(start + k)];
    let otherDays = p.samples.filter((s) => s.day !== day && s.features.blink <= BLINK_MAX);
    if (otherDays.length > otherDaysMax) {
      const step = otherDays.length / otherDaysMax;
      const offset = random() * step;
      otherDays = Array.from({ length: otherDaysMax }, (_, i) => otherDays[Math.min(otherDays.length - 1, Math.floor(offset + i * step))]);
    }
    out.push({ cal, sameDay, otherDays });
  }
  return out;
}

export interface Errors {
  mm: number[];
  deg: number[];
  /** Vertical part only, mm: what decides which line the reader is on. */
  dyMm: number[];
  /** Signed, for looking at bias. */
  dx: number[];
  dy: number[];
  failed: number;
}

export const emptyErrors = (): Errors => ({ mm: [], deg: [], dyMm: [], dx: [], dy: [], failed: 0 });

export interface Predictor {
  predict(features: EyeFeatures): Point | null;
}

export function score(model: Predictor, test: readonly RealSample[], p: Participant, into: Errors = emptyErrors()): Errors {
  for (const s of test) {
    const g = model.predict(s.features);
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) {
      into.failed++;
      continue;
    }
    const dx = (g.x - s.target.x) * p.mmPerPx;
    const dy = (g.y - s.target.y) * p.mmPerPx;
    const mm = Math.hypot(dx, dy);
    into.mm.push(mm);
    into.deg.push((Math.atan2(mm, s.distanceMm) * 180) / Math.PI);
    into.dyMm.push(Math.abs(dy));
    into.dx.push(dx);
    into.dy.push(dy);
  }
  return into;
}

export interface Row {
  label: string;
  /** Mean over people of each person's median. */
  mm: number;
  deg: number;
  dyMm: number;
  /** The worst person's median, degrees. */
  worstDeg: number;
  /** Mean over people of each person's 90th percentile, degrees. */
  p90Deg: number;
  people: number;
}

export function summarize(label: string, perPerson: readonly Errors[]): Row {
  const used = perPerson.filter((e) => e.mm.length > 0);
  const mean = (f: (e: Errors) => number): number => used.reduce((a, e) => a + f(e), 0) / Math.max(1, used.length);
  return {
    label,
    mm: mean((e) => quantile(e.mm, 0.5)),
    deg: mean((e) => quantile(e.deg, 0.5)),
    dyMm: mean((e) => quantile(e.dyMm, 0.5)),
    worstDeg: Math.max(...used.map((e) => quantile(e.deg, 0.5))),
    p90Deg: mean((e) => quantile(e.deg, 0.9)),
    people: used.length,
  };
}

export function table(title: string, rows: readonly Row[]): string {
  const head = '| model | error mm | error ° | vertical mm (lines) | p90 ° | worst person ° |\n|---|---|---|---|---|---|';
  const body = rows
    .map((r) => `| ${r.label} | ${r.mm.toFixed(1)} | ${r.deg.toFixed(2)} | ${r.dyMm.toFixed(1)} (${(r.dyMm / LINE_MM).toFixed(2)}) | ${r.p90Deg.toFixed(2)} | ${r.worstDeg.toFixed(2)} |`)
    .join('\n');
  return `\n${title}\n${head}\n${body}\n`;
}

/**
 * The app's situation: a calibration with the head in one place, then reading with the head
 * somewhere else. The calibration is the `k` pictures (of all the person's days) whose head pose
 * is nearest a randomly chosen picture's; every other picture is a test, sorted by how far its
 * head pose is from the calibration's.
 *
 * "How far" is one angle: the root of the squared changes of yaw, pitch and roll and of the face's
 * direction from the camera (so a head that slid sideways counts like a head that turned).
 */
export interface PoseSplit {
  cal: RealSample[];
  /** Tests by distance of the head pose from the calibration's, in degrees. */
  bins: RealSample[][];
  /** The calibration pictures' own largest distance from their centre, degrees. */
  radiusDeg: number;
}
export const POSE_BINS_DEG = [3, 6, 10, Infinity];

function poseOf(s: RealSample): number[] {
  const v = s.features.vector;
  const F = FEATURE_INDEX;
  return [v[F.yaw], v[F.pitch], v[F.roll], Math.atan(v[F.tx] / v[F.tz]), Math.atan(v[F.ty] / v[F.tz])];
}

export function poseSplits(p: Participant, k: number, count: number, seed: number, perBinMax = 300): PoseSplit[] {
  const random = rng(seed);
  const usable = p.samples.filter((s) => s.features.blink <= BLINK_MAX);
  const poses = usable.map(poseOf);
  const out: PoseSplit[] = [];
  for (let c = 0; c < count; c++) {
    const centre = poses[Math.floor(random() * poses.length)];
    const dist = (q: number[]): number => (Math.hypot(...q.map((x, i) => x - centre[i])) * 180) / Math.PI;
    const order = usable.map((s, i) => ({ s, d: dist(poses[i]) })).sort((a, b) => a.d - b.d);
    const cal = order.slice(0, k);
    // Distances are measured from the calibration's own mean pose, not the picture it grew from.
    const mean = centre.map((_, j) => cal.reduce((a, o) => a + poseOf(o.s)[j], 0) / cal.length);
    const fromMean = (s: RealSample): number => (Math.hypot(...poseOf(s).map((x, i) => x - mean[i])) * 180) / Math.PI;
    const bins: RealSample[][] = POSE_BINS_DEG.map(() => []);
    for (const o of order.slice(k)) {
      const d = fromMean(o.s);
      bins[POSE_BINS_DEG.findIndex((edge) => d < edge)].push(o.s);
    }
    for (let b = 0; b < bins.length; b++) {
      if (bins[b].length <= perBinMax) continue;
      const step = bins[b].length / perBinMax;
      const offset = random() * step;
      bins[b] = Array.from({ length: perBinMax }, (_, i) => bins[b][Math.min(bins[b].length - 1, Math.floor(offset + i * step))]);
    }
    out.push({ cal: cal.map((o) => o.s), bins, radiusDeg: Math.max(...cal.map((o) => fromMean(o.s))) });
  }
  return out;
}
