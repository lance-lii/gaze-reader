import { describe, expect, it } from 'vitest';
import { DEFAULT_HEAD_GESTURE_OPTIONS, HeadGestureDetector, type HeadGesture, type HeadGestureInput } from './headGestures';

const DEG = Math.PI / 180;

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());

/** What the head and face do over time (radians, 0..1 scores, image fractions). */
interface Motion {
  yaw?: (t: number) => number;
  pitch?: (t: number) => number;
  roll?: (t: number) => number;
  /** undefined: the tracker reports no eyebrow scores. */
  brow?: ((t: number) => number) | undefined;
  cx?: (t: number) => number;
  scale?: (t: number) => number;
  /** No face found while this is true. */
  lost?: (t: number) => boolean;
}

/** An out-and-back movement: 0 → amp → 0 over `dur` ms from `t0` (a raised cosine). */
const flick = (t0: number, amp: number, dur: number) => (t: number): number =>
  t < t0 || t > t0 + dur ? 0 : amp * Math.sin((Math.PI * (t - t0)) / dur) ** 2;
/** Moves to `amp` over `rise` ms from `t0` and stays there until `until` (then back over `rise`). */
const hold = (t0: number, amp: number, rise: number, until = Infinity) => (t: number): number => {
  if (t < t0) return 0;
  if (t < t0 + rise) return (amp * (t - t0)) / rise;
  if (t < until) return amp;
  if (t < until + rise) return amp * (1 - (t - until) / rise);
  return 0;
};
const sum = (...fs: ((t: number) => number)[]) => (t: number): number => fs.reduce((a, f) => a + f(t), 0);

interface RunOptions {
  ms: number;
  fps?: number;
  /** Per-frame pose noise SD, degrees (MediaPipe's is a few tenths in good light). */
  noiseDeg?: number;
  seed?: number;
  /** A resting pose other than straight at the camera. */
  rest?: { yaw: number; pitch: number; roll: number };
}

function run(motion: Motion, o: RunOptions, det = new HeadGestureDetector()): { gesture: HeadGesture; t: number }[] {
  const fps = o.fps ?? 30;
  const r = rng(o.seed ?? 1);
  const noise = (o.noiseDeg ?? 0.4) * DEG;
  const rest = o.rest ?? { yaw: 0, pitch: 4 * DEG, roll: 0 };
  const out: { gesture: HeadGesture; t: number }[] = [];
  for (let t = 0; t < o.ms; t += (1000 / fps) * (0.85 + 0.3 * r())) {
    const input: HeadGestureInput = motion.lost?.(t)
      ? { t, features: null }
      : {
          t,
          features: {
            headPose: {
              yaw: rest.yaw + (motion.yaw?.(t) ?? 0) + noise * gauss(r),
              pitch: rest.pitch + (motion.pitch?.(t) ?? 0) + noise * gauss(r),
              roll: rest.roll + (motion.roll?.(t) ?? 0) + noise * gauss(r),
              tx: 0,
              ty: -5,
              tz: -60,
            },
            faceCenter: { x: motion.cx?.(t) ?? 0.5, y: 0.48 },
            faceScale: motion.scale?.(t) ?? 0.1,
            ...('brow' in motion && motion.brow === undefined ? {} : { browRaise: Math.min(1, Math.max(0, (motion.brow?.(t) ?? 0.08) + 0.02 * gauss(r))) }),
          },
        };
    const g = det.update(input);
    if (g) out.push({ gesture: g, t });
  }
  return out;
}

const names = (found: { gesture: HeadGesture }[]): HeadGesture[] => found.map((f) => f.gesture);

describe('HeadGestureDetector: head turns', () => {
  it('a quick turn to the reader’s right and back is one turn-right; to the left, one turn-left', () => {
    // HeadPose.yaw > 0 turns the face toward image-right, which is the reader's left.
    for (const fps of [30, 24, 15]) {
      for (const amp of [16, 22, 30]) {
        for (const dur of [350, 500, 700]) {
          const label = `${fps} fps, ${amp}°, ${dur} ms`;
          expect(names(run({ yaw: flick(2000, -amp * DEG, dur) }, { ms: 5000, fps, seed: amp + dur })), `right, ${label}`).toEqual(['turn-right']);
          expect(names(run({ yaw: flick(2000, amp * DEG, dur) }, { ms: 5000, fps, seed: amp + dur + 1 })), `left, ${label}`).toEqual(['turn-left']);
        }
      }
    }
  });

  it('works at 10 frames a second when the turn is held a moment', () => {
    let seen = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const found = names(run({ yaw: flick(2000, -24 * DEG, 700) }, { ms: 5000, fps: 10, seed }));
      expect(found.filter((g) => g !== 'turn-right')).toEqual([]);
      seen += found.length;
    }
    expect(seen).toBeGreaterThanOrEqual(18);
  });

  it('is measured from however the reader sits', () => {
    const rest = { yaw: 14 * DEG, pitch: 10 * DEG, roll: -6 * DEG };
    expect(names(run({ yaw: flick(2500, -18 * DEG, 450) }, { ms: 5000, rest }))).toEqual(['turn-right']);
  });

  it('reports the gesture when the head is back, not before', () => {
    const [found] = run({ yaw: flick(2000, 20 * DEG, 500) }, { ms: 4000, noiseDeg: 0 });
    expect(found!.t).toBeGreaterThan(2300 + DEFAULT_HEAD_GESTURE_OPTIONS.confirmMs);
    expect(found!.t).toBeLessThan(2560 + DEFAULT_HEAD_GESTURE_OPTIONS.confirmMs);
  });

  it('two turns a second apart are two page turns; a second one right on its heels is not', () => {
    expect(names(run({ yaw: sum(flick(2000, -20 * DEG, 450), flick(3600, -20 * DEG, 450)) }, { ms: 6000 }))).toEqual(['turn-right', 'turn-right']);
    expect(names(run({ yaw: sum(flick(2000, -20 * DEG, 400), flick(2450, -20 * DEG, 400)) }, { ms: 6000 }))).toEqual(['turn-right']);
  });

  it('small or slow movements are not gestures', () => {
    // The head following the eyes along a line and back, reading.
    expect(run({ yaw: (t) => 2 * DEG * Math.sin(t / 300) }, { ms: 20_000 })).toEqual([]);
    // A turn that stops short of the threshold.
    expect(run({ yaw: flick(2000, 8 * DEG, 400) }, { ms: 5000 })).toEqual([]);
    // Turning slowly and coming back slowly (looking over at something, unhurried).
    expect(run({ yaw: flick(2000, 25 * DEG, 2600) }, { ms: 8000 })).toEqual([]);
    // Slow wander of several degrees over a minute.
    expect(run({ yaw: (t) => 9 * DEG * Math.sin(t / 9000), pitch: (t) => 5 * DEG * Math.cos(t / 7000) }, { ms: 60_000 })).toEqual([]);
  });

  it('looking away and back is not a gesture, in either direction, however fast the head moves', () => {
    for (const awayMs of [1200, 2500, 8000]) {
      for (const amp of [18, 35]) {
        const found = run({ yaw: hold(2000, amp * DEG, 200, 2000 + awayMs) }, { ms: 2000 + awayMs + 6000, seed: awayMs + amp });
        expect(found, `${amp}° for ${awayMs} ms`).toEqual([]);
      }
    }
  });

  it('a new posture is not a gesture, and turns are then measured from it', () => {
    const settle = hold(2000, 15 * DEG, 250);
    expect(run({ yaw: settle }, { ms: 12_000 })).toEqual([]);
    expect(names(run({ yaw: sum(settle, flick(9000, -18 * DEG, 450)) }, { ms: 12_000 }))).toEqual(['turn-right']);
  });

  it('nods, tilts and diagonal movements are not turns', () => {
    expect(run({ pitch: flick(2000, 18 * DEG, 450) }, { ms: 5000 })).toEqual([]);
    expect(run({ roll: flick(2000, 18 * DEG, 450) }, { ms: 5000 })).toEqual([]);
    expect(run({ yaw: flick(2000, 18 * DEG, 450), pitch: flick(2000, 16 * DEG, 450) }, { ms: 5000 })).toEqual([]);
    expect(run({ yaw: flick(2000, 18 * DEG, 450), roll: flick(2000, -15 * DEG, 450) }, { ms: 5000 })).toEqual([]);
    // A turn with the little nod and tilt that come with it still counts.
    expect(names(run({ yaw: flick(2000, 20 * DEG, 450), pitch: flick(2000, 5 * DEG, 450), roll: flick(2000, 4 * DEG, 450) }, { ms: 5000 }))).toEqual(['turn-left']);
  });

  it('shaking the head is not paging', () => {
    const shake = (t: number): number => (t < 2000 || t > 3200 ? 0 : 18 * DEG * Math.sin((2 * Math.PI * (t - 2000)) / 600));
    for (let seed = 1; seed <= 10; seed++) expect(run({ yaw: shake }, { ms: 7000, seed }), `seed ${seed}`).toEqual([]);
  });

  it('the tracker hopping to another face and back is not a turn', () => {
    const other = (t: number): boolean => t >= 2000 && t < 2500;
    const found = run(
      { yaw: (t) => (other(t) ? 17 * DEG : 0), cx: (t) => (other(t) ? 0.74 : 0.5), scale: (t) => (other(t) ? 0.065 : 0.1) },
      { ms: 6000 },
    );
    expect(found).toEqual([]);
    // Either tell alone is enough.
    expect(run({ yaw: (t) => (other(t) ? 17 * DEG : 0), cx: (t) => (other(t) ? 0.7 : 0.5) }, { ms: 6000 })).toEqual([]);
    expect(run({ yaw: (t) => (other(t) ? 17 * DEG : 0), scale: (t) => (other(t) ? 0.07 : 0.1) }, { ms: 6000 })).toEqual([]);
  });

  it('a single wild frame, a lost face or a stall in the middle cancels the turn', () => {
    expect(run({ yaw: (t) => (t >= 2000 && t < 2030 ? 25 * DEG : 0) }, { ms: 5000, noiseDeg: 0 })).toEqual([]);
    expect(run({ yaw: flick(2000, 20 * DEG, 500), lost: (t) => t > 2200 && t < 2300 }, { ms: 5000 })).toEqual([]);
    // Frames stop for half a second while the head is turned.
    const det = new HeadGestureDetector();
    const pose = (yaw: number) => ({ headPose: { yaw, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -60 }, faceCenter: { x: 0.5, y: 0.5 }, faceScale: 0.1 });
    const seen: (HeadGesture | null)[] = [];
    for (let t = 0; t < 1000; t += 33) seen.push(det.update({ t, features: pose(0) }));
    seen.push(det.update({ t: 1033, features: pose(0.2) }), det.update({ t: 1066, features: pose(0.3) }), det.update({ t: 1100, features: pose(0.3) }));
    seen.push(det.update({ t: 1600, features: pose(0) }), det.update({ t: 1633, features: pose(0) }));
    expect(seen.filter(Boolean)).toEqual([]);
  });

  it('copes with noisy pose (dim light) without inventing turns', () => {
    for (let seed = 1; seed <= 5; seed++) expect(run({}, { ms: 120_000, noiseDeg: 2.3, fps: 15, seed }), `seed ${seed}`).toEqual([]);
    expect(names(run({ yaw: flick(3000, -24 * DEG, 500) }, { ms: 6000, noiseDeg: 1.5, seed: 3 }))).toEqual(['turn-right']);
  });

  it('starts over on reset and on a clock that runs backwards, and ignores unusable frames', () => {
    const det = new HeadGestureDetector();
    expect(names(run({ yaw: flick(2000, 20 * DEG, 450) }, { ms: 3000 }, det))).toEqual(['turn-left']);
    // A new stream starting at t = 0 again: the resting pose is learned afresh, nothing fires on the jump.
    expect(names(run({ yaw: flick(2000, 20 * DEG, 450) }, { ms: 3000, rest: { yaw: 0.4, pitch: 0, roll: 0 } }, det))).toEqual(['turn-left']);
    det.reset();
    expect(det.turning).toBe(false);
    expect(det.update({ t: Number.NaN, features: null })).toBeNull();
    expect(det.update({ t: 10, features: { headPose: { yaw: Number.NaN, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 0 }, faceCenter: { x: 0.5, y: 0.5 }, faceScale: 0.1 } })).toBeNull();
    expect(det.update({ t: 20, features: { headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 0 }, faceCenter: { x: 0.5, y: 0.5 }, faceScale: 0 } })).toBeNull();
  });

  it('takes sane options only', () => {
    const det = new HeadGestureDetector({ turnOnRad: 20 * DEG, maxMs: Number.NaN, cooldownMs: -5 });
    expect(det.options.turnOnRad).toBeCloseTo(20 * DEG, 12);
    expect(det.options.maxMs).toBe(DEFAULT_HEAD_GESTURE_OPTIONS.maxMs);
    expect(det.options.cooldownMs).toBe(DEFAULT_HEAD_GESTURE_OPTIONS.cooldownMs);
    expect(names(run({ yaw: flick(2000, 16 * DEG, 450) }, { ms: 5000 }, det))).toEqual([]);
  });
});

describe('HeadGestureDetector: eyebrows', () => {
  const raised = (t0: number, ms: number, level = 0.6) => (t: number): number => (t >= t0 && t < t0 + ms ? level : 0.08);

  it('eyebrows raised and held are one brows-up; a flash of surprise is none', () => {
    expect(names(run({ brow: raised(2000, 900) }, { ms: 5000 }))).toEqual(['brows-up']);
    expect(run({ brow: raised(2000, 350) }, { ms: 5000 })).toEqual([]);
    const [found] = run({ brow: raised(2000, 1500) }, { ms: 5000 });
    expect(found!.t).toBeGreaterThanOrEqual(2600);
    expect(found!.t).toBeLessThan(2760);
  });

  it('fires once however long they stay up, and again after they come down', () => {
    expect(names(run({ brow: raised(2000, 3500) }, { ms: 8000 }))).toEqual(['brows-up']);
    expect(names(run({ brow: (t) => Math.max(raised(2000, 900)(t), raised(4500, 900)(t)) }, { ms: 8000 }))).toEqual(['brows-up', 'brows-up']);
  });

  it('measures the raise from how this face’s eyebrows usually read', () => {
    // A face whose eyebrows always read high: no gesture from that alone, a raise on top still counts.
    expect(run({ brow: () => 0.45 }, { ms: 20_000 })).toEqual([]);
    expect(names(run({ brow: (t) => (t >= 6000 && t < 7000 ? 0.85 : 0.45) }, { ms: 10_000 }))).toEqual(['brows-up']);
    // Eyebrows that go up and stay up become the resting level.
    expect(names(run({ brow: (t) => (t >= 2000 ? 0.6 : 0.08) }, { ms: 30_000 }))).toEqual(['brows-up']);
  });

  it('needs the tracker’s eyebrow scores, and waits out a head turn', () => {
    expect(run({ brow: undefined }, { ms: 5000 })).toEqual([]);
    // Eyebrows go up while the head turns: the turn is reported, not both at once.
    const found = names(run({ yaw: flick(2000, -20 * DEG, 500), brow: raised(1700, 700) }, { ms: 6000 }));
    expect(found).toEqual(['turn-right']);
  });
});
