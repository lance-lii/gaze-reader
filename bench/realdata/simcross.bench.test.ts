import { describe, it } from 'vitest';
import { GAZE_EXCLUDED_FEATURES, fitPoseCompensation, trainGazeModel } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import type { EyeFeatures, Point } from '../../src/types';
import { BASE_POSE, calibrationSession, DEG, frameFeatures, gauss, headFollow, headMovementSession, makeFrame, neckPose, READING_POINTS, rng, VIEW, WORLDS, type Pose, type WorldName } from '../lighting/faceSim';
import { LINE_PX, mean } from '../lighting/harness';
import { fs, loadParticipants, REAL_DATA_DIR, realDataAvailable, type RealSample } from './dataset';
import { fitShared, SharedPersonalModel } from './shared';

/**
 * Scoreboard: the shared model fitted on real faces (shared.ts, all of MPIIFaceGaze), scored on the
 * simulator's faces next to the app's own calibration. The two disagree with the real-face
 * scoreboard (mpiifacegaze.bench.test.ts): see docs/REAL_DATA.md. Also writes the fitted weights
 * to .data/mpiifacegaze/shared-weights.json (git-ignored; CC BY-NC-SA 4.0 like the data).
 */
const POSTURES: { label: string; delta: Partial<Pose> }[] = [
  { label: 'same', delta: {} },
  { label: 'back 6 cm', delta: { tz: -66 } },
  { label: 'in 10 cm', delta: { tz: -50 } },
  { label: 'right 3 cm', delta: { tx: 3 } },
  { label: 'down 2 cm', delta: { ty: -7 } },
  { label: 'chin −4°', delta: { pitch: 8 * DEG } },
  { label: 'turn 4°', delta: { yaw: 4 * DEG } },
  { label: 'tilt 4°', delta: { roll: 4 * DEG } },
  { label: 'slouched', delta: { ...neckPose(BASE_POSE, 0, 6 * DEG, 0), ty: BASE_POSE.ty - 3, tz: BASE_POSE.tz - 3 } },
  { label: 'head on hand', delta: { ...neckPose(BASE_POSE, 3 * DEG, 2 * DEG, 8 * DEG) } },
  { label: 'chin −8°', delta: { pitch: 12 * DEG } },
];

interface P { predict(f: EyeFeatures): Point | null }

describe.skipIf(!realDataAvailable())('real-face model on simulated faces', () => {
  it('prints', () => {
    const weights = fitShared(loadParticipants());
    fs!.writeFileSync(`${REAL_DATA_DIR}/../shared-weights.json`, JSON.stringify(weights));
    const lines: string[] = [`| world | model | ${POSTURES.map((p) => p.label).join(' | ')} |`];
    for (const w of ['W1', 'W3', 'W5'] as WorldName[]) {
      const noise = WORLDS[w].noise;
      const models: Record<string, (seed: number) => P | null> = {
        'app, no head step': (seed) => trainGazeModel(calibrationSession(seed, { noise }), { viewport: { ...VIEW }, maxBlink: 0.85, featureNames: FEATURE_NAMES, excludedFeatures: [...GAZE_EXCLUDED_FEATURES] }).model,
        'app now': (seed) => {
          const t = trainGazeModel(calibrationSession(seed, { noise }), { viewport: { ...VIEW }, maxBlink: 0.85, featureNames: FEATURE_NAMES, excludedFeatures: [...GAZE_EXCLUDED_FEATURES] }).model;
          const f = fitPoseCompensation(t, headMovementSession(seed, { noise }), { maxBlink: 0.85 });
          return f.ok ? f.model : t;
        },
        'real-face model + 4': (seed) => SharedPersonalModel.fit(weights, calibrationSession(seed, { noise }) as unknown as RealSample[], VIEW),
      };
      for (const [name, make] of Object.entries(models)) {
        const cells = POSTURES.map(() => ({ err: [] as number[], dy: [] as number[] }));
        for (const seed of [1, 2, 3, 4]) {
          const model = make(seed);
          if (!model) continue;
          POSTURES.forEach((p, k) => {
            const r = rng(seed * 101);
            const dys: number[] = [];
            for (const target of READING_POINTS) {
              for (let i = 0; i < 6; i++) {
                const f = frameFeatures(makeFrame(target, headFollow(target, { ...BASE_POSE, ...p.delta }), { h: 0.1 * DEG * gauss(r), v: 0.1 * DEG * gauss(r) }, {}, r, noise));
                const q = f && model.predict(f);
                if (!q) continue;
                cells[k].err.push(Math.hypot(q.x - target.x, q.y - target.y));
                dys.push(q.y - target.y);
              }
            }
            cells[k].dy.push(Math.abs(mean(dys)));
          });
        }
        lines.push(`| ${w} | ${name} | ${cells.map((c) => `${(mean(c.err) / LINE_PX).toFixed(2)} (${(mean(c.dy) / LINE_PX).toFixed(2)})`).join(' | ')} |`);
      }
    }
    console.log(`\nmean error in lines (and the size of the mean vertical shift, lines)\n${lines.join('\n')}`);
  });
});
