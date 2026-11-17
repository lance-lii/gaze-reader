/**
 * A model of gaze direction shared between people: an optional first stage of the calibration.
 *
 * The personal calibration (calibrationModel.ts) normally learns the whole map from eye features
 * to the screen from the reader's own dots. What it cannot learn from a few seconds of dots with
 * the head held still is what a head movement does to those features. A model fitted on many
 * pictures of other people, with their heads in many poses, has seen that. Its answer (which way
 * the eyes point as seen from the camera, as two tangents) becomes the only input of the reader's
 * own calibration, which then has six numbers to learn instead of a few hundred.
 *
 * The model is linear and a couple of kilobytes. Measured on photographs of 15 people
 * (docs/REAL_DATA.md): level with the plain calibration near the calibration pose, and about 40 %
 * closer once the head has turned more than 10° away. Not measured with the app's own camera
 * pipeline, which is why it is an opt-in setting.
 *
 * The weights (realFaceWeights.json) are fitted on MPIIFaceGaze and carry that dataset's licence,
 * CC BY-NC-SA 4.0, not this repository's MIT. This file is code and is MIT.
 */
import type { Point } from '../types';
import weights from './realFaceWeights.json';

export interface GazePriorWeights {
  /** Names the fit: stored with a calibration made on it. */
  id: string;
  /** Features read, in this order. Two more inputs follow them: tx ÷ tz and ty ÷ tz (where the head is in the picture). */
  names: readonly string[];
  /** Mean and standard deviation of every input (names.length + 2). */
  mean: readonly number[];
  sd: readonly number[];
  /** Weights per input and axis ([input][0 = x, 1 = y]); the last row is the constant. */
  w: readonly (readonly number[])[];
}

/** {@link GazePriorWeights} tied to one feature layout: what a gaze model stores and runs. */
export interface GazePrior {
  id: string;
  /** Vector index of every named input. */
  index: readonly number[];
  /** Vector indices of tx, ty and tz. */
  place: readonly [number, number, number];
  /**
   * Where the two answers go in the vector handed to the personal regression: the tx and ty
   * entries, which that regression never reads otherwise. The feature vector keeps its length
   * and layout this way, so everything keyed on them (signatures, saved models) is unaffected.
   */
  slots: readonly [number, number];
  mean: Float64Array;
  sd: Float64Array;
  wx: Float64Array;
  wy: Float64Array;
  bx: number;
  by: number;
}

const PLACE = ['tx', 'ty', 'tz'] as const;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The weights against a feature layout, or null when they are malformed or name a feature the layout lacks. */
export function resolveGazePrior(w: GazePriorWeights | null | undefined, featureNames: readonly string[] | undefined): GazePrior | null {
  if (!w || !featureNames || typeof w.id !== 'string' || !Array.isArray(w.names) || w.names.length === 0) return null;
  const d = w.names.length + 2;
  if (!Array.isArray(w.mean) || !Array.isArray(w.sd) || !Array.isArray(w.w)) return null;
  if (w.mean.length !== d || w.sd.length !== d || w.w.length !== d + 1) return null;
  if (!w.mean.every(finite) || !w.sd.every((s) => finite(s) && s > 0)) return null;
  if (!w.w.every((row) => Array.isArray(row) && row.length === 2 && row.every(finite))) return null;
  const index = w.names.map((n) => featureNames.indexOf(n));
  const place = PLACE.map((n) => featureNames.indexOf(n));
  if (index.some((i) => i < 0) || place.some((i) => i < 0)) return null;
  return {
    id: w.id,
    index,
    place: [place[0], place[1], place[2]],
    slots: [place[0], place[1]],
    mean: Float64Array.from(w.mean),
    sd: Float64Array.from(w.sd),
    wx: Float64Array.from(w.w.slice(0, d), (row) => row[0]),
    wy: Float64Array.from(w.w.slice(0, d), (row) => row[1]),
    bx: w.w[d][0],
    by: w.w[d][1],
  };
}

/**
 * Which way the eyes point as seen from the camera: the tangents of the angle to the right and
 * downward, in the units the weights were fitted in (screen millimetres from the camera ÷ distance).
 * Null when an input is missing or not a number.
 */
export function priorDirection(prior: GazePrior, v: ArrayLike<number>): Point | null {
  const n = prior.index.length;
  let x = prior.bx;
  let y = prior.by;
  for (let j = 0; j < n; j++) {
    const z = (v[prior.index[j]] - prior.mean[j]) / prior.sd[j];
    x += z * prior.wx[j];
    y += z * prior.wy[j];
  }
  const tz = v[prior.place[2]];
  const zx = (v[prior.place[0]] / tz - prior.mean[n]) / prior.sd[n];
  const zy = (v[prior.place[1]] / tz - prior.mean[n + 1]) / prior.sd[n + 1];
  x += zx * prior.wx[n] + zy * prior.wx[n + 1];
  y += zx * prior.wy[n] + zy * prior.wy[n + 1];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Copies `v` into `out` with the prior's two answers in its slots. False (and `out` undefined) when there is no answer. */
export function applyGazePrior(prior: GazePrior, v: ArrayLike<number>, out: Float64Array): boolean {
  const d = priorDirection(prior, v);
  if (!d) return false;
  for (let j = 0; j < out.length; j++) out[j] = v[j];
  out[prior.slots[0]] = d.x;
  out[prior.slots[1]] = d.y;
  return true;
}

export function serializeGazePrior(prior: GazePrior): Record<string, unknown> {
  return {
    id: prior.id,
    index: [...prior.index],
    place: [...prior.place],
    slots: [...prior.slots],
    mean: Array.from(prior.mean),
    sd: Array.from(prior.sd),
    wx: Array.from(prior.wx),
    wy: Array.from(prior.wy),
    bx: prior.bx,
    by: prior.by,
  };
}

/** Untrusted JSON (storage, extension messages) → a prior, or null when anything about it is off. */
export function sanitizeGazePrior(json: unknown, featureLength: number): GazePrior | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  const indices = (x: unknown, length?: number): number[] | null =>
    Array.isArray(x) && (length === undefined ? x.length > 0 && x.length <= featureLength : x.length === length) && x.every((i) => Number.isInteger(i) && i >= 0 && i < featureLength)
      ? (x as number[]).slice()
      : null;
  const index = indices(r.index);
  const place = indices(r.place, 3);
  const slots = indices(r.slots, 2);
  if (typeof r.id !== 'string' || r.id.length > 80 || !index || !place || !slots || slots[0] === slots[1]) return null;
  const d = index.length + 2;
  const numbers = (x: unknown, positive = false): Float64Array | null =>
    Array.isArray(x) && x.length === d && x.every((n) => finite(n) && (!positive || n > 0)) ? Float64Array.from(x as number[]) : null;
  const mean = numbers(r.mean);
  const sd = numbers(r.sd, true);
  const wx = numbers(r.wx);
  const wy = numbers(r.wy);
  if (!mean || !sd || !wx || !wy || !finite(r.bx) || !finite(r.by)) return null;
  return { id: r.id, index, place: [place[0], place[1], place[2]], slots: [slots[0], slots[1]], mean, sd, wx, wy, bx: r.bx, by: r.by };
}

export function cloneGazePrior(prior: GazePrior): GazePrior {
  return {
    ...prior,
    index: [...prior.index],
    place: [...prior.place],
    slots: [...prior.slots],
    mean: Float64Array.from(prior.mean),
    sd: Float64Array.from(prior.sd),
    wx: Float64Array.from(prior.wx),
    wy: Float64Array.from(prior.wy),
  };
}

/** The shipped fit: MPIIFaceGaze, all 15 people. CC BY-NC-SA 4.0 (see realFaceWeights.json). */
export const REAL_FACE_PRIOR: GazePriorWeights = weights;
