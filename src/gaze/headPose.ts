import type { HeadPose } from '../types';

/**
 * Head pose from MediaPipe's facial transformation matrix.
 *
 * The matrix maps the canonical face model into MediaPipe's metric camera
 * space: right-handed, +y up, the virtual camera at the origin looking down −z
 * (so a face in front of the camera has tz < 0, typically −30…−80 cm). A
 * frontal, upright face has a rotation ≈ identity.
 *
 * Angles use the Tait–Bryan order R = Ry(yaw) · Rx(pitch) · Rz(roll) — yaw
 * about the vertical axis first, which is how heads actually move and keeps the
 * gimbal singularity at ±90° pitch, far outside any reading posture. In that
 * frame:
 *  - yaw   > 0 turns the face toward image-right (the subject's left),
 *  - pitch > 0 tilts the chin down,
 *  - roll  > 0 tilts the head counter-clockwise as seen in the (unmirrored) image.
 */

export const NEUTRAL_HEAD_POSE: Readonly<HeadPose> = Object.freeze({
  yaw: 0,
  pitch: 0,
  roll: 0,
  tx: 0,
  ty: 0,
  tz: 0,
});

export type MatrixLayout = 'column-major' | 'row-major';

/**
 * Guesses how a flattened 4×4 affine matrix is stored. The bottom row of an
 * affine matrix is (0, 0, 0, 1): column-major storage puts those zeros at
 * [3, 7, 11] and the translation at [12, 13, 14]; row-major is the transpose.
 * With zero translation both readings are equally plausible and we fall back
 * to column-major, which is what MediaPipe emits.
 */
export function detectMatrixLayout(m: ArrayLike<number>): MatrixLayout {
  const colMajorBottom = Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]);
  const rowMajorBottom = Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]);
  return rowMajorBottom < colMajorBottom ? 'row-major' : 'column-major';
}

const EPS = 1e-9;
/** |sin(pitch)| above this is treated as gimbal lock (pitch ≈ ±90°). */
const GIMBAL_LOCK = 1 - 1e-6;

/**
 * Decodes a pose, or returns null if the input is not a usable 4×4 affine
 * matrix (too short, non-finite, or a degenerate rotation part).
 */
export function tryHeadPoseFromMatrix(m: ArrayLike<number> | null | undefined): HeadPose | null {
  if (!m || m.length < 16) return null;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return null;

  const colMajor = detectMatrixLayout(m) === 'column-major';
  const at = (row: number, col: number): number => (colMajor ? m[col * 4 + row] : m[row * 4 + col]);

  // Columns of the upper-left 3×3 are the images of the model axes. Normalizing
  // them strips any (possibly per-axis) scale the solver folded into the matrix.
  const r: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let col = 0; col < 3; col++) {
    const x = at(0, col);
    const y = at(1, col);
    const z = at(2, col);
    const norm = Math.hypot(x, y, z);
    if (norm < EPS) return null;
    r[0][col] = x / norm;
    r[1][col] = y / norm;
    r[2][col] = z / norm;
  }

  // For R = Ry(a)·Rx(b)·Rz(c):  r12 = −sin b,  r02 = sin a·cos b,  r22 = cos a·cos b,
  //                             r10 = cos b·sin c,  r11 = cos b·cos c.
  const sinPitch = Math.max(-1, Math.min(1, -r[1][2]));
  const pitch = Math.asin(sinPitch);
  let yaw: number;
  let roll: number;
  if (Math.abs(sinPitch) < GIMBAL_LOCK) {
    yaw = Math.atan2(r[0][2], r[2][2]);
    roll = Math.atan2(r[1][0], r[1][1]);
  } else {
    // Yaw and roll share an axis here; attribute the whole rotation to yaw.
    yaw = Math.atan2(-r[2][0], r[0][0]);
    roll = 0;
  }

  return { yaw, pitch, roll, tx: at(0, 3), ty: at(1, 3), tz: at(2, 3) };
}

/**
 * Head pose from a flattened 4×4 facial transformation matrix (column- or
 * row-major, detected automatically). Unusable input yields the neutral pose.
 */
export function headPoseFromMatrix(m: readonly number[]): HeadPose {
  return tryHeadPoseFromMatrix(m) ?? { ...NEUTRAL_HEAD_POSE };
}
