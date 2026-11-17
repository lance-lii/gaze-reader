import { describe, expect, it } from 'vitest';
import { GAZE_EXCLUDED_FEATURES, trainGazeModel, type TrainOptions } from '../../src/gaze/calibrationModel';
import { FEATURE_INDEX, FEATURE_NAMES } from '../../src/gaze/features';
import type { GazeModel } from '../../src/types';
import { loadParticipants, realDataAvailable, type Participant, type RealSample } from './dataset';
import { emptyErrors, POSE_BINS_DEG, poseSplits, score, splits, summarize, table, type Errors, type Predictor, type Row } from './protocol';
import { fitShared, sharedDirection, SharedPersonalModel, type SharedWeights } from './shared';

/**
 * Scoreboard on real faces: the app's calibration and corrections on MPIIFaceGaze (see dataset.ts,
 * protocol.ts and docs/REAL_DATA.md). Skipped when the data isn't there. Run with
 * `npm run bench -- bench/realdata`.
 */
const HEAD = ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale'];

interface Config {
  label: string;
  /** `shared`: the shared model fitted on everybody but this person. */
  fit: (p: Participant, cal: readonly RealSample[], shared: SharedWeights) => Predictor | null;
}

const base = (p: Participant): TrainOptions => ({
  viewport: { width: p.screen.widthPx, height: p.screen.heightPx },
  featureNames: FEATURE_NAMES,
});

function train(cal: readonly RealSample[], options: TrainOptions): GazeModel | null {
  try {
    return trainGazeModel([...cal], options).model;
  } catch {
    return null;
  }
}

/**
 * The shared model's answer as two inputs of the app's own calibration: written over the head
 * position (tx, ty), which the gaze fit doesn't use, and those two taken off the excluded list.
 */
function withPrior(shared: SharedWeights, v: ArrayLike<number>): number[] {
  const out = Array.from(v);
  const d = sharedDirection(shared, v);
  out[FEATURE_INDEX.tx] = d ? d.x : NaN;
  out[FEATURE_INDEX.ty] = d ? d.y : NaN;
  return out;
}

function trainWithPrior(p: Participant, cal: readonly RealSample[], shared: SharedWeights, excluded: string[], extra: Partial<TrainOptions> = {}): Predictor | null {
  const model = train(cal.map((s) => ({ ...s, features: { ...s.features, vector: withPrior(shared, s.features.vector) } })), { ...base(p), excludedFeatures: excluded, depthCompensation: true, poseCompensation: false, ...extra });
  return model && { predict: (f) => model.predict({ ...f, vector: withPrior(shared, f.vector) }) };
}
const PRIOR = ['tx', 'ty'];

const CONFIGS: Config[] = [
  { label: 'the app now', fit: (p, cal) => train(cal, base(p)) },
  { label: 'the app, camera where it really is', fit: (p, cal) => train(cal, { ...base(p), camera: p.cameraPx }) },
  { label: 'no distance correction', fit: (p, cal) => train(cal, { ...base(p), depthCompensation: false }) },
  { label: '1.1: head pose as gaze features', fit: (p, cal) => train(cal, { ...base(p), excludedFeatures: [...GAZE_EXCLUDED_FEATURES].filter((n) => !HEAD.includes(n)) }) },
  { label: '1.0: every feature', fit: (p, cal) => train(cal, { ...base(p), excludedFeatures: [] }) },
  { label: 'app calibration on the shared answer alone', fit: (p, cal, shared) => trainWithPrior(p, cal, shared, FEATURE_NAMES.filter((n) => !PRIOR.includes(n))) },
  { label: 'the same, no squares', fit: (p, cal, shared) => trainWithPrior(p, cal, shared, FEATURE_NAMES.filter((n) => !PRIOR.includes(n)), { quadraticFeatures: 0 }) },
  { label: 'app calibration + the shared answer', fit: (p, cal, shared) => trainWithPrior(p, cal, shared, [...GAZE_EXCLUDED_FEATURES].filter((n) => !PRIOR.includes(n))) },
  { label: 'shared model + 4 personal numbers', fit: (p, cal, shared) => SharedPersonalModel.fit(shared, cal, { width: p.screen.widthPx, height: p.screen.heightPx }) },
];

let sharedCache: SharedWeights[] | null = null;
/** Leave-one-person-out: entry i is fitted on everyone but person i, so nobody is tested on a model that saw them. */
function sharedFor(people: readonly Participant[]): SharedWeights[] {
  sharedCache ??= people.map((_, i) => fitShared(people.filter((__, j) => j !== i)));
  return sharedCache;
}

function run(k: number, perPerson = 6): { same: Row[]; other: Row[] } {
  const people = loadParticipants();
  const shared = sharedFor(people);
  const same: Row[] = [];
  const other: Row[] = [];
  for (const cfg of CONFIGS) {
    const sameErr: Errors[] = [];
    const otherErr: Errors[] = [];
    for (const [pi, p] of people.entries()) {
      const a = emptyErrors();
      const b = emptyErrors();
      for (const split of splits(p, k, perPerson, 1000 + pi)) {
        const model = cfg.fit(p, split.cal, shared[pi]);
        if (!model) continue;
        score(model, split.sameDay, p, a);
        score(model, split.otherDays, p, b);
      }
      sameErr.push(a);
      otherErr.push(b);
    }
    same.push(summarize(cfg.label, sameErr));
    other.push(summarize(cfg.label, otherErr));
  }
  return { same, other };
}

function runPose(k: number, perPerson = 6): { rows: Row[][]; radius: number } {
  const people = loadParticipants();
  const shared = sharedFor(people);
  const rows: Row[][] = POSE_BINS_DEG.map(() => []);
  let radius = 0;
  let n = 0;
  for (const cfg of CONFIGS) {
    const errs: Errors[][] = POSE_BINS_DEG.map(() => []);
    for (const [pi, p] of people.entries()) {
      const acc = POSE_BINS_DEG.map(() => emptyErrors());
      for (const split of poseSplits(p, k, perPerson, 2000 + pi)) {
        if (cfg === CONFIGS[0]) {
          radius += split.radiusDeg;
          n++;
        }
        const model = cfg.fit(p, split.cal, shared[pi]);
        if (!model) continue;
        split.bins.forEach((bin, b) => score(model, bin, p, acc[b]));
      }
      acc.forEach((e, b) => errs[b].push(e));
    }
    errs.forEach((e, b) => rows[b].push(summarize(cfg.label, e)));
  }
  return { rows, radius: radius / Math.max(1, n) };
}

describe.skipIf(!realDataAvailable())('real faces: MPIIFaceGaze (scoreboard)', () => {
  it('what the dataset is', () => {
    const people = loadParticipants();
    const lines = people.map((p) => {
      const days = new Set(p.samples.map((s) => s.day)).size;
      const dist = p.samples.map((s) => s.distanceMm).sort((x, y) => x - y);
      return `${p.id}: ${p.samples.length} usable of ${p.annotated} (${p.noFace} no face, ${p.unusable} refused), ${days} days, screen ${p.screen.widthPx}×${p.screen.heightPx} px = ${p.screen.widthMm.toFixed(0)}×${p.screen.heightMm.toFixed(0)} mm, camera (${p.cameraPx.x.toFixed(0)}, ${p.cameraPx.y.toFixed(0)}) px, distance ${dist[Math.floor(dist.length * 0.1)].toFixed(0)}–${dist[Math.floor(dist.length * 0.9)].toFixed(0)} mm`;
    });
    console.log(`\n${lines.join('\n')}\n`);
    expect(people.length).toBeGreaterThan(0);
  });

  for (const k of [40, 100]) {
    it(`calibrated with the head in one place (${k} pictures), tested with it elsewhere`, () => {
      const { rows, radius } = runPose(k);
      console.log(`\ncalibration pictures are within ${radius.toFixed(1)}° of one head pose (mean of the largest)`);
      POSE_BINS_DEG.forEach((edge, b) => {
        const from = b === 0 ? 0 : POSE_BINS_DEG[b - 1];
        console.log(table(`head ${from}–${Number.isFinite(edge) ? edge : '…'}° from where it was at calibration (${k} pictures)`, rows[b]));
      });
      expect(rows[0][0].people).toBeGreaterThan(0);
    });
  }

  for (const k of [20, 40, 100]) {
    it(`calibrated on ${k} pictures of one day`, () => {
      const { same, other } = run(k);
      console.log(table(`calibrated on ${k} consecutive pictures; tested on the rest of that day`, same));
      console.log(table(`calibrated on ${k} consecutive pictures; tested on other days`, other));
      expect(same[0].people).toBeGreaterThan(0);
    });
  }
});
