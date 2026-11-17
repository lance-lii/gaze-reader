import type { EyeFeatures } from '../types';

/**
 * Head gestures: deliberate movements of the head and face, read from what the face tracker
 * already reports for every frame (head pose from MediaPipe's transformation matrix, the eyebrow
 * blendshapes). No second model, nothing stored, nothing that isn't already measured for gaze.
 *
 *  - `turn-right` / `turn-left`: a quick turn of the head to the reader's right or left and
 *    straight back (a "flick"), the eyes staying on the page. The app pages forward / back.
 *  - `brows-up`: eyebrows raised and held for a moment. The app pauses or resumes page turning.
 *
 * What makes a movement a gesture is that it is quick, sideways, and comes back:
 *
 *  - It leaves the resting pose fast (from within `turnOffRad` to past `turnOnRad` in at most
 *    `riseMaxMs`). Settling into a new posture, or the slow wander of a head over minutes, is not.
 *  - It returns (to within `turnOffRad`, or `returnShare` of how far it went) no later than
 *    `maxMs` after leaving. Looking away at a phone, a person or a window does not come back in
 *    time, and when the reader finally turns back that is a move away from the new resting pose
 *    that doesn't come back either.
 *  - It is mostly yaw: a nod, a tilt of the head or a stretch moves pitch or roll as much.
 *  - It doesn't swing on to the other side, during the turn or in the `confirmMs` after it
 *    (shaking the head is not paging). That short wait is the price: the page turns a moment
 *    after the head is back.
 *  - The face stays the same face: its place and size in the image barely change. A tracker that
 *    hops to someone walking past shows a "turn" too, but the face jumps with it.
 *  - The resting pose was held for `settleMs` first, and `cooldownMs` have passed since the last
 *    gesture, so one movement is never two page turns.
 *
 * The resting pose is a running average of the pose while nothing is happening, so the reader can
 * sit however they like; a turn that is held becomes the new resting pose after a few seconds.
 *
 * Directions: `HeadPose.yaw > 0` turns the face toward image-right, the reader's left (see
 * headPose.ts), so a turn to the reader's right is negative yaw.
 *
 * The thresholds were chosen from how the simulated readers of bench/endtoend move (no false
 * gesture in any scenario: tests/headGestures.test.ts) and from synthetic gestures at 10–30
 * frames a second. They have not been tuned on recordings of real people.
 */

export type HeadGesture = 'turn-right' | 'turn-left' | 'brows-up';

export interface HeadGestureOptions {
  /** Yaw away from the resting pose at which a turn starts to count, radians. */
  turnOnRad: number;
  /** Yaw within this of the resting pose is "at rest", radians. */
  turnOffRad: number;
  /** Returning to this share of the peak also ends the turn (people rarely come back exactly). */
  returnShare: number;
  /** Rest → past `turnOnRad` must take at most this long. */
  riseMaxMs: number;
  /** Leaving rest → back must take at most this long. */
  maxMs: number;
  /** Frames well out (past `outShare` of `turnOnRad`) needed: one wild frame is a tracker glitch. */
  minFramesOut: number;
  outShare: number;
  /** After the head is back, the turn is reported only if it stays back this long. */
  confirmMs: number;
  /** Pitch and roll may move at most this share of the yaw peak. */
  crossAxisShare: number;
  /** The face centre may move at most this far (image widths / heights) during the turn... */
  maxCenterShift: number;
  /** ...and the face's size change by at most this fraction. */
  maxScaleChange: number;
  /** The resting pose must have been held this long before a turn. */
  settleMs: number;
  /** No gesture for this long after one. */
  cooldownMs: number;
  /** Time constant of the resting-pose average. */
  baselineMs: number;
  /** A gap between frames longer than this (a stall, the face lost) cancels a turn in progress. */
  maxGapMs: number;
  /** Eyebrow score above its resting level at which a raise starts to count, and below which it ends. */
  browOn: number;
  browOff: number;
  /** The raise must be held this long. */
  browHoldMs: number;
  /** Time constant of the eyebrows' resting level. */
  browBaselineMs: number;
}

const DEG = Math.PI / 180;
/** Eyebrows "raised" for longer than this are taken as their new resting level. */
const BROW_GIVE_UP_MS = 5000;

export const DEFAULT_HEAD_GESTURE_OPTIONS: Readonly<HeadGestureOptions> = Object.freeze({
  turnOnRad: 12 * DEG,
  turnOffRad: 5 * DEG,
  returnShare: 0.35,
  riseMaxMs: 450,
  maxMs: 1000,
  minFramesOut: 2,
  outShare: 0.6,
  confirmMs: 150,
  crossAxisShare: 0.7,
  maxCenterShift: 0.1,
  maxScaleChange: 0.2,
  settleMs: 300,
  cooldownMs: 700,
  baselineMs: 1500,
  maxGapMs: 250,
  browOn: 0.3,
  browOff: 0.15,
  browHoldMs: 600,
  browBaselineMs: 4000,
});

export interface HeadGestureInput {
  /** performance.now() ms of the frame. */
  t: number;
  /** The frame's features, or null when no face was found. */
  features: Pick<EyeFeatures, 'headPose' | 'faceCenter' | 'faceScale' | 'browRaise'> | null;
}

interface Rest {
  yaw: number;
  pitch: number;
  roll: number;
  cx: number;
  cy: number;
  scale: number;
}

interface Turn {
  /** +1: yaw rising (the reader's left), −1: the reader's right. */
  dir: 1 | -1;
  /** When the head left rest. */
  t0: number;
  peak: number;
  peakPitch: number;
  peakRoll: number;
  framesOut: number;
  centerShift: number;
  scaleChange: number;
}

export class HeadGestureDetector {
  private readonly opts: HeadGestureOptions;
  private rest: Rest | null = null;
  private lastT = -Infinity;
  /** Start of the current run of frames at rest, or null when not at rest. */
  private calmSince: number | null = null;
  /** The latest frame at rest, and how long that run had lasted by then. */
  private lastCalmT = -Infinity;
  private lastCalmRunMs = 0;
  private turn: Turn | null = null;
  /** A turn that has come back and is waiting out `confirmMs`. */
  private pending: { dir: 1 | -1; until: number } | null = null;
  private blockedUntil = -Infinity;
  private browRest: number | null = null;
  private browSince: number | null = null;
  private browFired = false;

  constructor(opts: Partial<HeadGestureOptions> = {}) {
    const merged = { ...DEFAULT_HEAD_GESTURE_OPTIONS };
    for (const key of Object.keys(merged) as (keyof HeadGestureOptions)[]) {
      const v = opts[key];
      if (v !== undefined && Number.isFinite(v) && v >= 0) merged[key] = v;
    }
    this.opts = merged;
  }

  get options(): Readonly<HeadGestureOptions> {
    return this.opts;
  }

  /** True while a turn has started and not yet come back (for the debug overlay). */
  get turning(): boolean {
    return this.turn !== null || this.pending !== null;
  }

  /** Forgets everything: the resting pose is learned again from the next frames. */
  reset(): void {
    this.rest = null;
    this.lastT = -Infinity;
    this.calmSince = null;
    this.lastCalmT = -Infinity;
    this.lastCalmRunMs = 0;
    this.turn = null;
    this.pending = null;
    this.blockedUntil = -Infinity;
    this.browRest = null;
    this.browSince = null;
    this.browFired = false;
  }

  /** One frame in; the gesture it completed, or null. */
  update(input: HeadGestureInput): HeadGesture | null {
    const { t } = input;
    if (!Number.isFinite(t)) return null;
    const o = this.opts;
    const dt = t - this.lastT;
    if (dt < 0) this.reset(); // a clock that runs backwards is a new stream
    const f = input.features;
    const pose = f?.headPose;
    const usable =
      !!f &&
      !!pose &&
      Number.isFinite(pose.yaw) &&
      Number.isFinite(pose.pitch) &&
      Number.isFinite(pose.roll) &&
      Number.isFinite(f.faceCenter?.x) &&
      Number.isFinite(f.faceCenter?.y) &&
      f.faceScale > 0;
    if (!usable || dt > o.maxGapMs) {
      // The face was lost, or frames stopped for a while: whatever was in progress doesn't count,
      // and the resting pose has to be seen held again first.
      this.turn = null;
      this.pending = null;
      this.calmSince = null;
      this.lastCalmT = -Infinity;
      this.browSince = null;
      if (!usable) {
        this.lastT = t;
        return null;
      }
    }
    this.lastT = t;
    const cur: Rest = { yaw: pose!.yaw, pitch: pose!.pitch, roll: pose!.roll, cx: f!.faceCenter.x, cy: f!.faceCenter.y, scale: f!.faceScale };
    if (!this.rest) {
      this.rest = { ...cur };
      this.calmSince = t;
      this.lastCalmT = t;
      this.lastCalmRunMs = 0;
      this.updateBrows(t, f!.browRaise, 0);
      return null;
    }
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, o.maxGapMs) : 0;
    const turned = this.updateTurn(t, cur, step);
    const brows = this.updateBrows(t, f!.browRaise, step);
    const gesture = turned ?? brows;
    if (gesture) this.blockedUntil = t + o.cooldownMs;
    return gesture;
  }

  private updateTurn(t: number, cur: Rest, step: number): HeadGesture | null {
    const o = this.opts;
    const rest = this.rest!;
    const d = cur.yaw - rest.yaw;
    const mag = Math.abs(d);

    const turn = this.turn;
    if (turn) {
      const reversed = d * turn.dir < 0 && mag >= o.turnOnRad;
      if (reversed || t - turn.t0 > o.maxMs) {
        // Shaking the head, or a look away that is taking too long: not a gesture. A reversal
        // also earns a cooldown, so the swing back isn't read as a turn of its own.
        this.turn = null;
        this.calmSince = null;
        this.lastCalmT = -Infinity;
        if (reversed) this.blockedUntil = Math.max(this.blockedUntil, t + o.cooldownMs);
        return null;
      }
      if (d * turn.dir > 0) {
        turn.peak = Math.max(turn.peak, mag);
        if (mag >= o.outShare * o.turnOnRad) turn.framesOut++;
      }
      turn.peakPitch = Math.max(turn.peakPitch, Math.abs(cur.pitch - rest.pitch));
      turn.peakRoll = Math.max(turn.peakRoll, Math.abs(cur.roll - rest.roll));
      turn.centerShift = Math.max(turn.centerShift, Math.abs(cur.cx - rest.cx), Math.abs(cur.cy - rest.cy));
      turn.scaleChange = Math.max(turn.scaleChange, Math.abs(cur.scale / rest.scale - 1));
      if (mag > Math.max(o.turnOffRad, o.returnShare * turn.peak)) return null; // still out
      // Back at rest: was it a deliberate, sideways flick of this same face?
      this.turn = null;
      this.calmSince = t;
      this.lastCalmT = t;
      this.lastCalmRunMs = 0;
      const ok =
        turn.framesOut >= o.minFramesOut &&
        turn.peakPitch <= o.crossAxisShare * turn.peak &&
        turn.peakRoll <= o.crossAxisShare * turn.peak &&
        turn.centerShift <= o.maxCenterShift &&
        turn.scaleChange <= o.maxScaleChange;
      if (ok) this.pending = { dir: turn.dir, until: t + o.confirmMs };
      return null;
    }

    const pending = this.pending;
    if (pending) {
      if (d * pending.dir < 0 && mag >= o.outShare * o.turnOnRad) {
        // The head swung on to the other side: a shake, not a turn.
        this.pending = null;
        this.calmSince = null;
        this.lastCalmT = -Infinity;
        this.blockedUntil = Math.max(this.blockedUntil, t + o.cooldownMs);
        return null;
      }
      if (t >= pending.until) {
        this.pending = null;
        if (mag < o.turnOffRad) {
          this.calmSince ??= t;
          this.lastCalmT = t;
          this.lastCalmRunMs = t - this.calmSince;
        }
        return pending.dir < 0 ? 'turn-right' : 'turn-left';
      }
      return null;
    }

    if (mag < o.turnOffRad) {
      // At rest: the resting pose follows slowly.
      this.calmSince ??= t;
      this.lastCalmT = t;
      this.lastCalmRunMs = t - this.calmSince;
      this.follow(cur, step, o.baselineMs);
      return null;
    }
    this.calmSince = null;
    if (mag >= o.turnOnRad) {
      const quick = t - this.lastCalmT <= o.riseMaxMs;
      if (quick && this.lastCalmRunMs >= o.settleMs && t >= this.blockedUntil) {
        this.turn = {
          dir: d > 0 ? 1 : -1,
          t0: this.lastCalmT,
          peak: mag,
          peakPitch: Math.abs(cur.pitch - rest.pitch),
          peakRoll: Math.abs(cur.roll - rest.roll),
          framesOut: 1,
          centerShift: Math.max(Math.abs(cur.cx - rest.cx), Math.abs(cur.cy - rest.cy)),
          scaleChange: Math.abs(cur.scale / rest.scale - 1),
        };
        return null;
      }
    }
    // Away from rest without a turn in progress (a slow turn, a new posture, a turn too soon after
    // another): once it has lasted longer than a turn's rise, it is where the head now rests.
    if (t - this.lastCalmT > o.riseMaxMs) this.follow(cur, step, o.baselineMs);
    return null;
  }

  private follow(cur: Rest, step: number, tauMs: number): void {
    const rest = this.rest!;
    const a = tauMs > 0 ? 1 - Math.exp(-step / tauMs) : 1;
    rest.yaw += a * (cur.yaw - rest.yaw);
    rest.pitch += a * (cur.pitch - rest.pitch);
    rest.roll += a * (cur.roll - rest.roll);
    rest.cx += a * (cur.cx - rest.cx);
    rest.cy += a * (cur.cy - rest.cy);
    rest.scale += a * (cur.scale - rest.scale);
  }

  private updateBrows(t: number, brow: number | undefined, step: number): HeadGesture | null {
    const o = this.opts;
    if (brow === undefined || !Number.isFinite(brow)) {
      this.browSince = null;
      return null;
    }
    if (this.browRest === null) {
      this.browRest = brow;
      return null;
    }
    const lift = brow - this.browRest;
    if (lift < o.browOff) {
      this.browSince = null;
      this.browFired = false;
      const a = o.browBaselineMs > 0 ? 1 - Math.exp(-step / o.browBaselineMs) : 1;
      this.browRest += a * lift;
      return null;
    }
    if (lift < o.browOn) return null; // between the two levels: neither starts nor ends a raise
    this.browSince ??= t;
    if (t - this.browSince > BROW_GIVE_UP_MS) {
      // Raised for this long is how the eyebrows sit now (or how the tracker reads this face).
      this.browRest = brow;
      this.browSince = null;
      return null;
    }
    if (this.browFired || this.turn || this.pending || t < this.blockedUntil || t - this.browSince < o.browHoldMs) return null;
    this.browFired = true;
    return 'brows-up';
  }
}
