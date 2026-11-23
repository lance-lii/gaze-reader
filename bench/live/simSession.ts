/**
 * An accuracy test session played by the face simulator: the same blocks the overlay records,
 * with a simulated reader who turns their head, leans back and sits lower when asked. It lets the
 * scoring be tested without a camera. It says nothing about real faces: that is what the live
 * session is for.
 */
import {
  ACCURACY_TEST_KIND,
  ACCURACY_TEST_VERSION,
  POSTURES,
  TEST_TARGETS,
  recordFrame,
  type AccuracyRecording,
  type PostureId,
  type RecordedBlock,
  type RecordedFrame,
  type RecordedTrial,
} from '../../src/gaze/accuracyTest';
import { FEATURE_NAMES } from '../../src/gaze/features';
import type { CalibrationSample, Point } from '../../src/types';
import { BASE_POSE, DEG, NOMINAL_NOISE, STANDARD_TARGETS, VIEW, frameFeatures, gauss, headFollow, headMovementSession, makeFrame, neckPose, rng, type Pose } from '../lighting/faceSim';

export interface SimSessionOptions {
  /** Frames per dot (default 34). */
  perDot?: number;
  /** How far the simulated reader moves: turn (deg), lean back (cm), slide down (cm). */
  turnDeg?: number;
  backCm?: number;
  lowCm?: number;
  /** Leave these postures out, as a session stopped early would. */
  skip?: readonly PostureId[];
}

/** The head pose the simulated reader holds in each posture. */
export function posturePose(id: PostureId, o: SimSessionOptions = {}): Pose {
  switch (id) {
    case 'turned':
      return neckPose(BASE_POSE, (o.turnDeg ?? 8) * DEG, 0, 0);
    case 'back':
      return { ...BASE_POSE, tz: BASE_POSE.tz - (o.backCm ?? 9) };
    case 'low':
      return { ...BASE_POSE, ty: BASE_POSE.ty - (o.lowCm ?? 4), pitch: BASE_POSE.pitch - 3 * DEG };
    case 'again':
      // Nobody sits back exactly where they were.
      return { ...BASE_POSE, tx: BASE_POSE.tx + 0.6, ty: BASE_POSE.ty - 0.5, tz: BASE_POSE.tz - 0.8 };
    default:
      return BASE_POSE;
  }
}

export function simulatedSession(seed: number, o: SimSessionOptions = {}): AccuracyRecording {
  const r = rng(seed);
  const per = o.perDot ?? 34;
  let t = 0;
  const frame = (features: CalibrationSample['features']): RecordedFrame | null => recordFrame({ t: (t += 33), faceFound: true, features, quality: 1 }, 0);

  const dots = (targets: readonly Point[], base: Pose): RecordedTrial[] =>
    targets.map((tf) => {
      const target = { x: tf.x * VIEW.width, y: tf.y * VIEW.height };
      const fix = { h: gauss(r) * 0.4 * DEG, v: gauss(r) * 0.4 * DEG };
      const follow = headFollow(target, base);
      const head: Pose = { ...follow, yaw: follow.yaw + 0.3 * DEG * gauss(r), pitch: follow.pitch + 0.3 * DEG * gauss(r), tx: follow.tx + 0.2 * gauss(r), ty: follow.ty + 0.2 * gauss(r) };
      const frames: RecordedFrame[] = [];
      for (let i = 0; i < per; i++) {
        const gaze = { h: fix.h + 0.1 * DEG * gauss(r), v: fix.v + 0.1 * DEG * gauss(r) };
        const f = frameFeatures(makeFrame(target, head, gaze, {}, r, NOMINAL_NOISE));
        const rec = f ? frame(f) : null;
        if (rec) frames.push(rec);
      }
      return { target, frames };
    });

  const head = headMovementSession(seed + 1);
  const centre = { x: VIEW.width / 2, y: VIEW.height / 2 };
  const headFrames = head.map((s) => frame(s.features)).filter((f): f is RecordedFrame => f !== null);

  const blocks: RecordedBlock[] = [
    { kind: 'calibrate', trials: dots(STANDARD_TARGETS, BASE_POSE) },
    { kind: 'head', trials: [{ target: centre, label: 'all', frames: headFrames }] },
  ];
  for (const p of POSTURES) {
    if (o.skip?.includes(p.id)) continue;
    blocks.push({ kind: 'test', posture: p.id, trials: dots(TEST_TARGETS, posturePose(p.id, o)) });
  }

  return {
    kind: ACCURACY_TEST_KIND,
    version: ACCURACY_TEST_VERSION,
    app: 'simulated',
    recordedAt: '2026-01-01T00:00:00.000Z',
    featureNames: [...FEATURE_NAMES],
    viewport: { width: VIEW.width, height: VIEW.height },
    // Just above the middle of the screen's top edge, where the simulator's camera is.
    camera: { x: VIEW.width / 2, y: -30 },
    windowOrigin: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
    linePitchPx: 30,
    maxBlink: 0.85,
    blocks,
  };
}
