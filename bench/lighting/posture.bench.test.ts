import { describe, expect, it } from 'vitest';
import { evaluateModel, fitPoseCompensation, GAZE_EXCLUDED_FEATURES, trainGazeModel, type RidgeGazeModel } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import type { CalibrationSample } from '../../src/types';
import { BASE_POSE, calibrationSession, DEG, frameFeatures, gauss, headFollow, headMovementSession, makeFrame, neckPose, READING_POINTS, rng, VIEW, WORLDS, type NoiseSpec, type Pose, type WorldName } from './faceSim';
import { LINE_PX, mean } from './harness';

/**
 * Scoreboard: how far a change of posture after calibration moves the predicted gaze, what using
 * the head's pose as gaze features costs, and what the distance compensation gains. Run with `npm run bench`; the fast guard is in
 * tests/lightingRobustness.test.ts.
 *
 * The reader calibrates in BASE_POSE (60 cm, chin 4° down), then reads the 45-point reading grid
 * in another posture, with the eyes on the same points. A cell is the size of one calibration's
 * mean shift over the grid, averaged over calibrations: |dy| in lines / |dx| in px. "cv" is the calibration's own
 * leave-one-target-out error, "val" the error on 7 off-grid dots in the calibration posture
 * (8 seeds each).
 *
 * - "1.1": the whole head pose is a set of gaze features (fitted linearly to calibration's tenths
 *   of a degree and millimetres of head movement).
 * - "pose": head yaw and pitch are excluded, roll and head position (tx, ty, tz, faceScale) still
 *   fitted. The corner-referenced iris already says where the eyes point relative to the camera,
 *   head turn included.
 * - "no head step": no head-pose feature is fitted (all in GAZE_EXCLUDED_FEATURES); a change of
 *   distance is corrected geometrically instead (DepthCompensation in calibrationModel.ts). The
 *   simulated camera sits 83 px above the middle of the viewport's top edge; the model assumes 136 px.
 * - "now": the same, after the calibration's head-movement step (eyes on the middle dot while the
 *   head nods 6°, turns 7° and tilts 5° about the neck; PoseCompensation, fitPoseCompensation).
 * - "now, camera 4 cm off": "now" with the camera assumed 170 px higher still (a guess that is
 *   badly off), to show what the assumption is worth.
 *
 * The last three postures are what readers end up in: both a turn and a move of the head.
 */

const POSTURES: { label: string; delta: Partial<Pose> }[] = [
  { label: 'back 6 cm', delta: { tz: -66 } },
  { label: 'in 6 cm', delta: { tz: -54 } },
  { label: 'in 10 cm', delta: { tz: -50 } },
  { label: 'right 3 cm', delta: { tx: 3 } },
  { label: 'down 2 cm', delta: { ty: -7 } },
  { label: 'chin −4°', delta: { pitch: 8 * DEG } },
  { label: 'chin +4°', delta: { pitch: 0 } },
  { label: 'turn 4°', delta: { yaw: 4 * DEG } },
  { label: 'tilt 4°', delta: { roll: 4 * DEG } },
  // Postures people really end up in: both a turn and a move of the head.
  { label: 'slouched', delta: { ...neckPose(BASE_POSE, 0, 6 * DEG, 0), ty: BASE_POSE.ty - 3, tz: BASE_POSE.tz - 3 } },
  { label: 'head on hand', delta: { ...neckPose(BASE_POSE, 3 * DEG, 2 * DEG, 8 * DEG) } },
  { label: 'chin −8°', delta: { pitch: 12 * DEG } },
];

const VALIDATION = [
  { x: 0.25, y: 0.22 },
  { x: 0.75, y: 0.22 },
  { x: 0.25, y: 0.78 },
  { x: 0.75, y: 0.78 },
  { x: 0.5, y: 0.3 },
  { x: 0.4, y: 0.6 },
  { x: 0.6, y: 0.85 },
];

const POSE = ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale'];
const CONFIGS: Record<string, { excluded: string[]; camera?: { x: number; y: number }; headStep?: boolean }> = {
  '1.1': { excluded: [...GAZE_EXCLUDED_FEATURES].filter((n) => !POSE.includes(n)) },
  pose: { excluded: [...GAZE_EXCLUDED_FEATURES].filter((n) => !POSE.includes(n) || n === 'yaw' || n === 'pitch') },
  'no head step': { excluded: [...GAZE_EXCLUDED_FEATURES] },
  now: { excluded: [...GAZE_EXCLUDED_FEATURES], headStep: true },
  'now, camera 4 cm off': { excluded: [...GAZE_EXCLUDED_FEATURES], camera: { x: VIEW.width / 2, y: -306 }, headStep: true },
};

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

function train(
  samples: CalibrationSample[],
  cfg: { excluded: string[]; camera?: { x: number; y: number }; headStep?: boolean },
  seed: number,
  noise: NoiseSpec,
): { model: RidgeGazeModel; cv: number; learned: boolean } {
  const trained = trainGazeModel(samples, {
    viewport: { ...VIEW },
    maxBlink: 0.85,
    featureNames: FEATURE_NAMES,
    excludedFeatures: cfg.excluded,
    ...(cfg.camera ? { camera: cfg.camera } : {}),
  });
  // The calibration's head-movement step: eyes on the middle dot, the head nods, turns and tilts.
  const fitted = cfg.headStep ? fitPoseCompensation(trained.model, headMovementSession(seed, { noise }), { maxBlink: 0.85 }) : null;
  if (fitted && !fitted.ok) console.log(`head step taught nothing (seed ${seed}): ${fitted.reason}`);
  return { model: fitted?.ok ? fitted.model : trained.model, cv: trained.report.meanErrorPx, learned: !!fitted?.ok };
}

/** Mean prediction − target over the reading grid in `pose`, px. */
function postureShift(model: RidgeGazeModel, pose: Pose, seed: number, noise: NoiseSpec): { dx: number; dy: number } {
  const r = rng(seed * 101);
  const dx: number[] = [];
  const dy: number[] = [];
  for (const target of READING_POINTS) {
    for (let i = 0; i < 10; i++) {
      const f = frameFeatures(makeFrame(target, headFollow(target, pose), { h: 0.1 * DEG * gauss(r), v: 0.1 * DEG * gauss(r) }, {}, r, noise));
      const p = f && model.predictScreenFromVector(f.vector);
      if (!p) continue;
      dx.push(p.x - target.x);
      dy.push(p.y - target.y);
    }
  }
  return { dx: mean(dx), dy: mean(dy) };
}

describe('posture after calibration (scoreboard)', () => {
  it('prints the shift per posture change: 1.1, pose weights, now', () => {
    const worlds: WorldName[] = ['W1', 'W2', 'W3', 'W4', 'W5'];
    const head = ['world', 'model', 'cv', 'val', ...POSTURES.map((p) => p.label)];
    const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
    const worst: Record<string, number> = Object.fromEntries(Object.keys(CONFIGS).map((k) => [k, 0]));
    let unlearned = 0;
    for (const w of worlds) {
      const noise = WORLDS[w].noise;
      for (const [name, cfg] of Object.entries(CONFIGS)) {
        const cv: number[] = [];
        const val: number[] = [];
        const cells = POSTURES.map(() => ({ dx: [] as number[], dy: [] as number[] }));
        for (const seed of SEEDS) {
          const t = train(calibrationSession(seed, { noise }), cfg, seed, noise);
          if (cfg.headStep && !t.learned) unlearned++;
          cv.push(t.cv);
          val.push(evaluateModel(t.model, calibrationSession(seed + 1000, { noise, targets: VALIDATION }), { maxBlink: 0.85 }).meanErrorPx);
          POSTURES.forEach((p, k) => {
            const s = postureShift(t.model, { ...BASE_POSE, ...p.delta }, seed, noise);
            cells[k].dx.push(s.dx);
            cells[k].dy.push(s.dy);
          });
        }
        // Each reader has one calibration: average the size of each calibration's shift (signed
        // shifts of noise-fitted weights would cancel across calibrations).
        const shifts = cells.map((c) => ({ dy: mean(c.dy.map(Math.abs)) / LINE_PX, dx: mean(c.dx.map(Math.abs)) }));
        worst[name] = Math.max(worst[name]!, ...shifts.map((s) => s.dy));
        lines.push(
          `| ${w} | ${name} | ${(mean(cv) / LINE_PX).toFixed(2)} | ${(mean(val) / LINE_PX).toFixed(2)} | ${shifts.map((s) => `${s.dy.toFixed(2)} / ${s.dx.toFixed(0)}`).join(' | ')} |`,
        );
      }
    }
    console.log(`\n### Posture after calibration (lines; posture cells |dy| lines / |dx| px)\n${lines.join('\n')}`);
    console.log(`head-movement steps that taught nothing: ${unlearned}`);
    expect(unlearned).toBe(0);
    expect(worst.now).toBeLessThan(worst['1.1']!);
    expect(worst.now).toBeLessThan(worst['no head step']!);
    expect(worst.now).toBeLessThanOrEqual(worst.pose!);
  });
});
