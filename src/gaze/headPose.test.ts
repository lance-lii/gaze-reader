import { describe, expect, it } from 'vitest';
import { cameraAnglesInHead, detectMatrixLayout, headPoseFromMatrix, NEUTRAL_HEAD_POSE, tryHeadPoseFromMatrix, type MatrixLayout } from './headPose';

type M3 = number[][];

const mul = (a: M3, b: M3): M3 =>
  a.map((row, i) => row.map((_, j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));

/** R = Ry(yaw) · Rx(pitch) · Rz(roll) — the convention headPose.ts decodes. */
function rotation(yaw: number, pitch: number, roll: number): M3 {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  return mul(mul(ry, rx), rz);
}

function flatten(r: M3, t: [number, number, number], layout: MatrixLayout, scale = 1): number[] {
  const m: M3 = [
    [scale * r[0][0], scale * r[0][1], scale * r[0][2], t[0]],
    [scale * r[1][0], scale * r[1][1], scale * r[1][2], t[1]],
    [scale * r[2][0], scale * r[2][1], scale * r[2][2], t[2]],
    [0, 0, 0, 1],
  ];
  const out = new Array<number>(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (layout === 'column-major') out[j * 4 + i] = m[i][j];
      else out[i * 4 + j] = m[i][j];
    }
  }
  return out;
}

const deg = (d: number): number => (d * Math.PI) / 180;
const LAYOUTS: MatrixLayout[] = ['column-major', 'row-major'];
const T: [number, number, number] = [1.5, -2.25, -48];

describe('headPoseFromMatrix', () => {
  it('reads an upright frontal face as zero rotation, keeping the translation', () => {
    for (const layout of LAYOUTS) {
      const pose = headPoseFromMatrix(flatten(rotation(0, 0, 0), T, layout));
      expect(pose.yaw).toBeCloseTo(0, 12);
      expect(pose.pitch).toBeCloseTo(0, 12);
      expect(pose.roll).toBeCloseTo(0, 12);
      expect([pose.tx, pose.ty, pose.tz]).toEqual(T);
    }
  });

  const cases: [number, number, number][] = [
    [25, 0, 0],
    [-25, 0, 0],
    [0, 18, 0],
    [0, -18, 0],
    [0, 0, 12],
    [0, 0, -12],
    [30, -20, 10],
    [-45, 35, -25],
    [60, 10, 40],
    [-5, -60, 170],
  ];

  it.each(cases)('recovers yaw %d°, pitch %d°, roll %d° in both layouts, with scale', (y, p, r) => {
    for (const layout of LAYOUTS) {
      for (const scale of [1, 1.3]) {
        const pose = headPoseFromMatrix(flatten(rotation(deg(y), deg(p), deg(r)), T, layout, scale));
        expect(pose.yaw).toBeCloseTo(deg(y), 9);
        expect(pose.pitch).toBeCloseTo(deg(p), 9);
        expect(pose.roll).toBeCloseTo(deg(r), 9);
        expect(pose.tx).toBeCloseTo(T[0], 12);
        expect(pose.ty).toBeCloseTo(T[1], 12);
        expect(pose.tz).toBeCloseTo(T[2], 12);
      }
    }
  });

  it('follows the documented sign conventions', () => {
    // The face's forward axis is the third column of R (canonical model faces +z).
    const forward = (r: M3) => [r[0][2], r[1][2], r[2][2]];
    const yawed = rotation(deg(20), 0, 0);
    expect(forward(yawed)[0]).toBeGreaterThan(0); // toward +x = image-right = subject's left
    expect(headPoseFromMatrix(flatten(yawed, T, 'column-major')).yaw).toBeGreaterThan(0);

    const nodded = rotation(0, deg(15), 0);
    expect(forward(nodded)[1]).toBeLessThan(0); // −y = chin down
    expect(headPoseFromMatrix(flatten(nodded, T, 'column-major')).pitch).toBeGreaterThan(0);
  });

  it('stays finite at gimbal lock and still describes the same rotation', () => {
    const original = rotation(deg(30), deg(90), deg(20));
    const pose = headPoseFromMatrix(flatten(original, T, 'column-major'));
    expect(pose.pitch).toBeCloseTo(Math.PI / 2, 6);
    expect(Number.isFinite(pose.yaw) && Number.isFinite(pose.roll)).toBe(true);
    const rebuilt = rotation(pose.yaw, pose.pitch, pose.roll);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(rebuilt[i][j]).toBeCloseTo(original[i][j], 5);
  });

  it('returns the neutral pose for unusable input', () => {
    expect(headPoseFromMatrix([])).toEqual(NEUTRAL_HEAD_POSE);
    expect(headPoseFromMatrix(new Array(15).fill(0))).toEqual(NEUTRAL_HEAD_POSE);
    const withNaN = flatten(rotation(0.1, 0.2, 0.3), T, 'column-major');
    withNaN[5] = Number.NaN;
    expect(headPoseFromMatrix(withNaN)).toEqual(NEUTRAL_HEAD_POSE);
    expect(tryHeadPoseFromMatrix(new Array(16).fill(0))).toBeNull(); // zero rotation columns
    expect(tryHeadPoseFromMatrix(null)).toBeNull();
    // The neutral pose is a fresh object each time, never the frozen constant.
    expect(Object.isFrozen(headPoseFromMatrix([]))).toBe(false);
  });
});

describe('detectMatrixLayout', () => {
  it('finds the translation column in either storage order', () => {
    const r = rotation(deg(10), deg(-5), deg(3));
    expect(detectMatrixLayout(flatten(r, T, 'column-major'))).toBe('column-major');
    expect(detectMatrixLayout(flatten(r, T, 'row-major'))).toBe('row-major');
    // Small lateral offsets still dominate the ~0 bottom row.
    expect(detectMatrixLayout(flatten(r, [0.02, -0.01, -0.5], 'row-major'))).toBe('row-major');
  });

  it('defaults to column-major (MediaPipe) when translation is zero', () => {
    expect(detectMatrixLayout(flatten(rotation(0.3, 0.1, 0), [0, 0, 0], 'row-major'))).toBe('column-major');
  });
});

describe('cameraAnglesInHead', () => {
  const DEG = Math.PI / 180;
  const pose = (p: Partial<Record<'yaw' | 'pitch' | 'roll' | 'tx' | 'ty' | 'tz', number>>) => ({ yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -60, ...p });

  it('is zero for a head that faces the camera squarely, at any distance', () => {
    for (const tz of [-30, -60, -90]) {
      const a = cameraAnglesInHead(pose({ tz }))!;
      expect(a.a).toBeCloseTo(0, 12);
      expect(a.b).toBeCloseTo(0, 12);
    }
  });

  it('a turn of the head moves the camera by that angle in the head’s frame: yaw across, pitch up-down', () => {
    const yawed = cameraAnglesInHead(pose({ yaw: 5 * DEG }))!;
    expect(Math.abs(yawed.a)).toBeCloseTo(5 * DEG, 6);
    expect(yawed.b).toBeCloseTo(0, 6);
    const pitched = cameraAnglesInHead(pose({ pitch: 5 * DEG }))!;
    expect(Math.abs(pitched.b)).toBeCloseTo(5 * DEG, 6);
    expect(pitched.a).toBeCloseTo(0, 6);
    // Opposite turns, opposite signs.
    expect(Math.sign(cameraAnglesInHead(pose({ pitch: -5 * DEG }))!.b)).toBe(-Math.sign(pitched.b));
  });

  it('a move of the head across the camera’s view is the same thing as a turn: 2 cm down at 60 cm is 1.9°', () => {
    const lower = cameraAnglesInHead(pose({ ty: -2 }))!;
    expect(Math.abs(lower.b)).toBeCloseTo(Math.atan2(2, 60), 9);
    expect(lower.a).toBeCloseTo(0, 9);
    // A head that turns to keep facing the camera as it moves hasn't changed at all.
    const p = { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: -2, tz: -60 };
    const turn = cameraAnglesInHead({ ...p, pitch: 0 })!.b;
    const facing = [cameraAnglesInHead({ ...p, pitch: turn })!.b, cameraAnglesInHead({ ...p, pitch: -turn })!.b];
    expect(Math.min(...facing.map(Math.abs))).toBeLessThan(1e-9);
  });

  it('agrees with the matrix it comes from: the camera is at −Rᵀt', () => {
    // Build R = Ry(yaw)·Rx(pitch)·Rz(roll) and t, as headPoseFromMatrix reads them, and compare.
    const want = { yaw: 7 * DEG, pitch: -4 * DEG, roll: 6 * DEG, tx: 3, ty: -5, tz: -55 };
    const [cy, sy, cp, sp, cr, sr] = [Math.cos(want.yaw), Math.sin(want.yaw), Math.cos(want.pitch), Math.sin(want.pitch), Math.cos(want.roll), Math.sin(want.roll)];
    const R = [
      [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
      [cp * sr, cp * cr, -sp],
      [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
    ];
    const t = [want.tx, want.ty, want.tz];
    const decoded = headPoseFromMatrix([R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, t[0], t[1], t[2], 1]);
    expect(decoded.yaw).toBeCloseTo(want.yaw, 9);
    expect(decoded.roll).toBeCloseTo(want.roll, 9);
    const cam = [0, 1, 2].map((col) => -(R[0][col] * t[0] + R[1][col] * t[1] + R[2][col] * t[2]));
    const got = cameraAnglesInHead(decoded)!;
    expect(got.a).toBeCloseTo(Math.atan2(cam[0], cam[2]), 9);
    expect(got.b).toBeCloseTo(Math.atan2(cam[1], cam[2]), 9);
  });

  it('is null for a pose that isn’t one: no translation, a face behind the camera, non-finite numbers', () => {
    expect(cameraAnglesInHead({ ...NEUTRAL_HEAD_POSE })).toBeNull();
    expect(cameraAnglesInHead(pose({ tz: 40 }))).toBeNull();
    expect(cameraAnglesInHead(pose({ pitch: Number.NaN }))).toBeNull();
  });
});
