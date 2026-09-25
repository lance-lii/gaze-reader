/**
 * Shared measurement code for the lighting benchmarks (features.bench.test.ts) and the fast
 * regression guards (tests/lightingRobustness.test.ts): the two model configurations being
 * compared, and how a perturbation's effect on the predicted gaze is measured.
 */
import { DEFAULT_LINE_PITCH_PX, trainGazeModel, type RidgeGazeModel, type TrainOptions, type TrainResult } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import type { CalibrationSample, EyeFeatures } from '../../src/types';
import { VIEW, type PairedFrame } from './faceSim';

/** One line of text at the app's default size, px. */
export const LINE_PX = DEFAULT_LINE_PITCH_PX;

/** FEATURE_NAMES as Gaze Reader 1.0 shipped them (before the 5-point iris features were appended). */
export const LEGACY_FEATURE_COUNT = FEATURE_NAMES.indexOf('rightU5');

export interface ModelConfig {
  readonly key: string;
  readonly label: string;
  /** Feature names the model sees: a prefix of FEATURE_NAMES. */
  readonly names: readonly string[];
  /** Passed to trainGazeModel; undefined = its default (GAZE_EXCLUDED_FEATURES). */
  readonly excludedFeatures?: readonly string[];
}

/** 1.0: the 27 original features, lid features allowed. */
export const OLD_CONFIG: ModelConfig = Object.freeze({
  key: 'OLD',
  label: '1.0 (27 features, lids allowed)',
  names: FEATURE_NAMES.slice(0, LEGACY_FEATURE_COUNT),
  excludedFeatures: [],
});

/** Now: every feature, GAZE_EXCLUDED_FEATURES neutralized (5-point corner-referenced iris + eyeLook* + posture). */
export const NEW_CONFIG: ModelConfig = Object.freeze({
  key: 'NEW',
  label: 'lids excluded, 5-point iris',
  names: [...FEATURE_NAMES],
});

export function configFeatures(cfg: ModelConfig, f: EyeFeatures): EyeFeatures {
  return f.vector.length === cfg.names.length ? f : { ...f, vector: f.vector.slice(0, cfg.names.length) };
}

/** Trains like the calibration overlay does (maxBlink 0.85, the build's feature names). */
export function trainConfig(cfg: ModelConfig, samples: readonly CalibrationSample[], extra: Pick<TrainOptions, 'environment'> = {}): TrainResult {
  return trainGazeModel(
    samples.map((s) => ({ ...s, features: configFeatures(cfg, s.features) })),
    { viewport: { ...VIEW }, maxBlink: 0.85, featureNames: cfg.names, excludedFeatures: cfg.excludedFeatures, ...extra },
  );
}

const mean = (a: readonly number[]): number => (a.length === 0 ? NaN : a.reduce((p, q) => p + q, 0) / a.length);
const sd = (a: readonly number[]): number => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (a.length - 1));
};
export { mean, sd };

export interface ShiftMeasurement {
  /** Mean change of the prediction (perturbed − baseline), px; +y = the gaze reads lower. */
  dx: number;
  dy: number;
  /** Frames predicted under the baseline but rejected (null) under the perturbation, %. */
  rejectedPct: number;
}

/** Paired effect of perturbation `li` against the baseline (index 0) on the reading grid. */
export function measureShift(model: RidgeGazeModel, cfg: ModelConfig, frames: readonly PairedFrame[], li: number): ShiftMeasurement {
  const dxs: number[] = [];
  const dys: number[] = [];
  let rejected = 0;
  let total = 0;
  for (const fr of frames) {
    const a = fr.byLight[0];
    const b = fr.byLight[li];
    if (!a || !b) continue;
    const pa = model.predictScreenFromVector(configFeatures(cfg, a).vector);
    if (!pa) continue;
    total++;
    const pb = model.predictScreenFromVector(configFeatures(cfg, b).vector);
    if (!pb) {
      rejected++;
      continue;
    }
    dxs.push(pb.x - pa.x);
    dys.push(pb.y - pa.y);
  }
  return { dx: mean(dxs), dy: mean(dys), rejectedPct: total > 0 ? (100 * rejected) / total : NaN };
}

export interface ReadingAccuracy {
  /** Mean over reading points of the per-frame SD of predicted y (precision), px. */
  sigmaY: number;
  sigmaX: number;
  /** Mean over reading points of |mean predicted y − target y| (accuracy), px. */
  errY: number;
  errX: number;
}

/** Precision and accuracy on the reading grid under perturbation `li` (default: the baseline). */
export function readingAccuracy(model: RidgeGazeModel, cfg: ModelConfig, frames: readonly PairedFrame[], li = 0): ReadingAccuracy {
  const byPoint = new Map<string, { tx: number; ty: number; xs: number[]; ys: number[] }>();
  for (const fr of frames) {
    const f = fr.byLight[li];
    if (!f) continue;
    const p = model.predictScreenFromVector(configFeatures(cfg, f).vector);
    if (!p) continue;
    const key = `${fr.target.x},${fr.target.y}`;
    let g = byPoint.get(key);
    if (!g) {
      g = { tx: fr.target.x, ty: fr.target.y, xs: [], ys: [] };
      byPoint.set(key, g);
    }
    g.xs.push(p.x);
    g.ys.push(p.y);
  }
  const groups = [...byPoint.values()];
  return {
    sigmaY: mean(groups.map((g) => sd(g.ys))),
    sigmaX: mean(groups.map((g) => sd(g.xs))),
    errY: mean(groups.map((g) => Math.abs(mean(g.ys) - g.ty))),
    errX: mean(groups.map((g) => Math.abs(mean(g.xs) - g.tx))),
  };
}
