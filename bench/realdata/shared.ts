import { FEATURE_INDEX, FEATURE_NAMES, type FeatureName } from '../../src/gaze/features';
import { priorDirection, resolveGazePrior, type GazePrior, type GazePriorWeights } from '../../src/gaze/gazePrior';
import type { EyeFeatures, Point } from '../../src/types';
import type { Participant, RealSample } from './dataset';

/**
 * The fit of the model of gaze direction shared between people (src/gaze/gazePrior.ts runs it;
 * src/gaze/realFaceWeights.json is this fit on all 15 people), and a minimal way of fitting it to
 * one person, for comparison with the app's own calibration on its answers.
 */
export const SHARED_FEATURES: FeatureName[] = [
  'rightU5', 'rightVc5', 'leftU5', 'leftVc5', 'meanU5', 'meanVc5',
  'yaw', 'pitch', 'roll',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'rightV', 'leftV', 'rightOpen', 'leftOpen', 'rightLidY', 'leftLidY', 'meanV',
];
const F = FEATURE_INDEX;

export function sharedInputs(v: ArrayLike<number>, names: readonly FeatureName[] = SHARED_FEATURES): number[] {
  const out = names.map((n) => v[F[n]]);
  out.push(v[F.tx] / v[F.tz], v[F.ty] / v[F.tz]);
  return out;
}

export function faceScale(v: ArrayLike<number>): number {
  return v[F.faceScale] / Math.cos(Math.max(-0.7, Math.min(0.7, v[F.yaw])));
}

export type SharedWeights = GazePriorWeights;

function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const M = A.map((row, i) => [...row, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[best][c])) best = r;
    [M[c], M[best]] = [M[best], M[c]];
    const d = M[c][c];
    for (let k = c; k < n + m; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k < n + m; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

/** Ridge fit of where the target is as seen from the camera (tangents, target ÷ distance) on the shared inputs. */
export function fitShared(people: readonly Participant[], lambda = 0.01, names: readonly FeatureName[] = SHARED_FEATURES): SharedWeights {
  const X: number[][] = [];
  const Y: number[][] = [];
  for (const p of people) {
    for (const s of p.samples) {
      if (s.features.blink > 0.5) continue;
      X.push(sharedInputs(s.features.vector, names));
      const z = s.faceMm[2];
      Y.push([((s.target.x - p.cameraPx.x) * p.mmPerPx) / z, ((s.target.y - p.cameraPx.y) * p.mmPerPx) / z]);
    }
  }
  const d = X[0].length;
  const mean = new Array<number>(d).fill(0);
  const sd = new Array<number>(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mean[j]) ** 2 / X.length;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const A = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
  const B = Array.from({ length: d + 1 }, () => [0, 0]);
  const z = new Array<number>(d + 1);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) z[j] = (X[i][j] - mean[j]) / sd[j];
    z[d] = 1;
    for (let a = 0; a <= d; a++) {
      for (let b = a; b <= d; b++) A[a][b] += z[a] * z[b];
      B[a][0] += z[a] * Y[i][0];
      B[a][1] += z[a] * Y[i][1];
    }
  }
  for (let a = 0; a <= d; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
  for (let a = 0; a < d; a++) A[a][a] += lambda * X.length;
  return { id: 'bench', names, mean, sd, w: solve(A, B) };
}

const resolved = new WeakMap<SharedWeights, GazePrior>();

/** The app's own code on these weights (gazePrior.ts), so the scoreboards score what ships. */
export function sharedDirection(weights: SharedWeights, v: ArrayLike<number>): Point | null {
  let prior = resolved.get(weights);
  if (!prior) {
    const r = resolveGazePrior(weights, FEATURE_NAMES);
    if (!r) throw new Error('Shared weights do not fit FEATURE_NAMES.');
    prior = r;
    resolved.set(weights, prior);
  }
  return priorDirection(prior, v);
}

/** The shared model fitted to one person: screen = camera + (K·direction + c) ÷ face size, K and c per axis. */
export class SharedPersonalModel {
  private constructor(
    private readonly weights: SharedWeights,
    private readonly camera: Point,
    private readonly k: [number, number],
    private readonly c: [number, number],
  ) {}

  static fit(weights: SharedWeights, cal: readonly RealSample[], viewport: { width: number; height: number }, camera?: Point): SharedPersonalModel | null {
    // As the app assumes without a window: above the middle of the viewport (chrome 100 px + bezel 36 px).
    const cam = camera ?? { x: viewport.width / 2, y: -136 };
    const rows: { w: Point; s: number; t: Point }[] = [];
    for (const smp of cal) {
      if (smp.features.blink > 0.5) continue;
      const w = sharedDirection(weights, smp.features.vector);
      const s = faceScale(smp.features.vector);
      if (w && s > 0) rows.push({ w, s, t: smp.target });
    }
    if (rows.length < 4) return null;
    const k: [number, number] = [0, 0];
    const c: [number, number] = [0, 0];
    for (const axis of [0, 1] as const) {
      const x = rows.map((r) => (axis === 0 ? r.w.x : r.w.y));
      const y = rows.map((r) => ((axis === 0 ? r.t.x - cam.x : r.t.y - cam.y)) * r.s);
      const mx = x.reduce((a, b) => a + b, 0) / x.length;
      const my = y.reduce((a, b) => a + b, 0) / y.length;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < x.length; i++) {
        sxy += (x[i] - mx) * (y[i] - my);
        sxx += (x[i] - mx) ** 2;
      }
      k[axis] = sxy / sxx;
      c[axis] = my - k[axis] * mx;
    }
    return k.every(Number.isFinite) && c.every(Number.isFinite) ? new SharedPersonalModel(weights, cam, k, c) : null;
  }

  predict(features: EyeFeatures): Point | null {
    const w = sharedDirection(this.weights, features.vector);
    const s = faceScale(features.vector);
    if (!w || !(s > 0)) return null;
    return { x: this.camera.x + (this.k[0] * w.x + this.c[0]) / s, y: this.camera.y + (this.k[1] * w.y + this.c[1]) / s };
  }
}
