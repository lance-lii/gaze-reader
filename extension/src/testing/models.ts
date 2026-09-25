/**
 * A tiny, exactly predictable gaze model for tests: x = 500 + 100·f[0],
 * y = 400 + 100·f[1] (viewport px at the calibration zoom).
 */
import type { EyeFeatures } from '../../../src/types';
import { RidgeGazeModel, featureSignature } from '../../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../../src/gaze/features';

export function linearGazeModel(opts: { trainedAt?: number; viewport?: { width: number; height: number } } = {}): RidgeGazeModel {
  const n = FEATURE_NAMES.length;
  const zeros = () => new Float64Array(n);
  const ones = () => new Float64Array(n).fill(1);
  const wx = zeros();
  const wy = zeros();
  wx[0] = 100;
  wy[1] = 100;
  return new RidgeGazeModel({
    featureLength: n,
    featureSignature: featureSignature(FEATURE_NAMES),
    mean: zeros(),
    std: ones(),
    quad: [],
    expMean: zeros(),
    expStd: ones(),
    wx,
    bx: 500,
    wy,
    by: 400,
    lambda: 1,
    viewport: opts.viewport ?? { width: 1000, height: 800 },
    origin: { x: 0, y: 0 },
    adjust: { sx: 1, ox: 0, sy: 1, oy: 0 },
    trainedAt: opts.trainedAt ?? 1_700_000_000_000,
  });
}

/** Features that `linearGazeModel` maps to (500 + 100·a, 400 + 100·b). */
export function eyeFeatures(a = 0, b = 0): EyeFeatures {
  const vector = new Array<number>(FEATURE_NAMES.length).fill(0);
  vector[0] = a;
  vector[1] = b;
  return {
    vector,
    headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 },
    blink: 0,
    openness: 0.3,
    faceScale: 0.1,
    faceCenter: { x: 0.5, y: 0.5 },
  };
}
