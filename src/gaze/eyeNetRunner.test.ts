import { describe, expect, it } from 'vitest';
import type { FeatureFrame } from '../types';
import { EYE_CORNERS } from './eyeNet';
import { EYE_NET_MAX_PENDING, EYE_NET_MAX_WAIT_MS, EyeNetRunner, type EyeNetRunnerDeps, type EyeNetWorkerLike } from './eyeNetRunner';
import type { EyeNetReply, EyeNetRequest } from './eyeNetWorker';
import { FEATURE_INDEX, FEATURE_NAMES } from './features';

const SHAPE = { id: 'net-1', width: 60, height: 36, span: 1.7, extras: 5 };
const W = 640;
const H = 480;

interface FakeBitmap {
  x: number;
  y: number;
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

function harness(shape = SHAPE) {
  const sent: EyeNetRequest[] = [];
  const timers = new Map<number, () => void>();
  const bitmaps: FakeBitmap[] = [];
  const failures: string[] = [];
  let nextTimer = 0;
  let terminated = false;
  let bitmapFails = false;
  let waits: Promise<unknown>[] = [];
  const worker: EyeNetWorkerLike = {
    postMessage: (m) => void sent.push(m),
    onmessage: null,
    onerror: null,
    terminate: () => {
      terminated = true;
    },
  };
  const deps: EyeNetRunnerDeps = {
    createWorker: () => worker,
    bitmapOf: (_source, x, y, width, height) => {
      const p = bitmapFails
        ? Promise.reject(new Error('no picture'))
        : Promise.resolve().then(() => {
            const b: FakeBitmap = { x, y, width, height, closed: false, close: () => void (b.closed = true) };
            bitmaps.push(b);
            return b as unknown as ImageBitmap;
          });
      waits.push(p.catch(() => undefined));
      return p;
    },
    setTimeout: (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const runner = new EyeNetRunner({ some: 'weights' }, shape, deps, (m) => failures.push(m));
  const reply = (r: EyeNetReply): void => worker.onmessage?.({ data: r });
  return {
    runner,
    sent,
    timers,
    bitmaps,
    failures,
    reply,
    worker,
    get terminated() {
      return terminated;
    },
    failBitmaps: () => {
      bitmapFails = true;
    },
    /** Lets the bitmaps asked for so far arrive. */
    settle: async () => {
      const w = waits;
      waits = [];
      await Promise.all(w);
      await Promise.resolve();
    },
    frames: () => sent.filter((m): m is Extract<EyeNetRequest, { type: 'frame' }> => m.type === 'frame'),
  };
}

/** Face-mesh landmarks with the eyes level, 60 px wide, around (220, 200) and (380, 200) of a 640×480 frame. */
function landmarks(shiftX = 0): { x: number; y: number }[] {
  const out = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  out[EYE_CORNERS[0][0]] = { x: (190 + shiftX) / W, y: 200 / H };
  out[EYE_CORNERS[0][1]] = { x: (250 + shiftX) / W, y: 200 / H };
  out[EYE_CORNERS[1][0]] = { x: (350 + shiftX) / W, y: 200 / H };
  out[EYE_CORNERS[1][1]] = { x: (410 + shiftX) / W, y: 200 / H };
  return out;
}

function frame(t: number): FeatureFrame {
  const vector = new Array<number>(FEATURE_NAMES.length).fill(0);
  vector[FEATURE_INDEX.yaw] = 0.1;
  vector[FEATURE_INDEX.pitch] = -0.2;
  vector[FEATURE_INDEX.roll] = 0.05;
  vector[FEATURE_INDEX.tx] = 3;
  vector[FEATURE_INDEX.ty] = -6;
  vector[FEATURE_INDEX.tz] = -60;
  return {
    t,
    faceFound: true,
    quality: 1,
    features: { vector, headPose: { yaw: 0.1, pitch: -0.2, roll: 0.05, tx: 3, ty: -6, tz: -60 }, blink: 0, openness: 0.3, faceScale: 0.2, faceCenter: { x: 0.5, y: 0.5 } },
  };
}

const SOURCE = {} as HTMLVideoElement;

describe('EyeNetRunner', () => {
  it('gives the worker the weights, and is running once the worker says it has them', () => {
    const h = harness();
    expect(h.sent).toEqual([{ type: 'load', weights: { some: 'weights' } }]);
    expect(h.runner.running).toBe(false);
    h.reply({ type: 'ready', id: 'net-1' });
    expect(h.runner.running).toBe(true);
    expect(h.runner.id).toBe('net-1');
  });

  it('passes frames straight through until the network is ready', () => {
    const h = harness();
    const out: FeatureFrame[] = [];
    const f = frame(1);
    h.runner.submit(SOURCE, W, H, landmarks(), f, (x) => out.push(x));
    expect(out).toEqual([f]);
    expect(h.frames()).toHaveLength(0);
  });

  it('sends the eye region and attaches the answer to that frame', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    const out: FeatureFrame[] = [];
    h.runner.submit(SOURCE, W, H, landmarks(), frame(1), (x) => out.push(x));
    expect(out).toHaveLength(0);
    await h.settle();
    const [sent] = h.frames();
    const region = h.bitmaps[0];
    // The region holds both eyes with room for the pictures, and is far smaller than the frame.
    expect(region.x).toBeLessThan(190 - 20);
    expect(region.x + region.width).toBeGreaterThan(410 + 20);
    expect(region.y).toBeLessThan(200 - 20);
    expect(region.width * region.height).toBeLessThan((W * H) / 4);
    // Corners are in the region's own pixels.
    expect(sent.corners).toEqual([190 - region.x, 200 - region.y, 250 - region.x, 200 - region.y, 350 - region.x, 200 - region.y, 410 - region.x, 200 - region.y]);
    // The head's angles and where the face is in the camera's view.
    expect(sent.extra).toEqual([0.1, -0.2, 0.05, 3 / -60, -6 / -60]);
    h.reply({ type: 'answer', seq: sent.seq, x: 0.12, y: -0.34 });
    expect(out).toHaveLength(1);
    expect(out[0].t).toBe(1);
    expect(out[0].features?.eyeNet).toEqual({ id: 'net-1', x: 0.12, y: -0.34 });
    expect(h.timers.size).toBe(0);
    expect(h.runner.takeCounts()).toEqual({ answered: 1, missed: 0 });
    expect(h.runner.takeCounts()).toEqual({ answered: 0, missed: 0 });
  });

  it('sends no extra numbers to a network that takes none', async () => {
    const h = harness({ ...SHAPE, extras: 0 });
    h.reply({ type: 'ready', id: 'net-1' });
    h.runner.submit(SOURCE, W, H, landmarks(), frame(1), () => {});
    await h.settle();
    expect(h.frames()[0].extra).toBeNull();
  });

  it('keeps frames in order when answers come back out of order', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    const out: number[] = [];
    for (const t of [1, 2, 3]) h.runner.submit(SOURCE, W, H, landmarks(), frame(t), (x) => out.push(x.t));
    await h.settle();
    const [a, b, c] = h.frames();
    h.reply({ type: 'answer', seq: c.seq, x: 0, y: 0 });
    h.reply({ type: 'answer', seq: b.seq, x: 0, y: 0 });
    expect(out).toEqual([]);
    h.reply({ type: 'answer', seq: a.seq, x: 0, y: 0 });
    expect(out).toEqual([1, 2, 3]);
  });

  it('lets a frame go without an answer after the wait, and ignores the answer if it comes later', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    const out: FeatureFrame[] = [];
    h.runner.submit(SOURCE, W, H, landmarks(), frame(1), (x) => out.push(x));
    await h.settle();
    expect(EYE_NET_MAX_WAIT_MS).toBeLessThan(70);
    [...h.timers.values()][0]();
    expect(out).toHaveLength(1);
    expect(out[0].features?.eyeNet).toBeUndefined();
    h.reply({ type: 'answer', seq: h.frames()[0].seq, x: 1, y: 1 });
    expect(out).toHaveLength(1);
    expect(h.runner.takeCounts()).toEqual({ answered: 0, missed: 1 });
  });

  it('does not queue more than a few frames behind a slow worker', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    const out: number[] = [];
    for (let t = 1; t <= EYE_NET_MAX_PENDING + 2; t++) h.runner.submit(SOURCE, W, H, landmarks(), frame(t), (x) => out.push(x.t));
    await h.settle();
    expect(h.frames()).toHaveLength(EYE_NET_MAX_PENDING);
    // The extra frames wait their turn all the same.
    expect(out).toEqual([]);
    for (const f of h.frames()) h.reply({ type: 'answer', seq: f.seq, x: 0, y: 0 });
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes on a frame with no face, or with the eyes out of the picture, without asking', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    const out: FeatureFrame[] = [];
    h.runner.submit(SOURCE, W, H, landmarks(), { t: 1, faceFound: false, features: null, quality: 0 }, (x) => out.push(x));
    h.runner.submit(SOURCE, W, H, landmarks(5000), frame(2), (x) => out.push(x));
    h.runner.submit(SOURCE, W, H, [], frame(3), (x) => out.push(x));
    await h.settle();
    expect(out.map((f) => f.t)).toEqual([1, 2, 3]);
    expect(h.frames()).toHaveLength(0);
    expect(out.every((f) => f.features?.eyeNet === undefined)).toBe(true);
  });

  it('lets the frame go when its picture cannot be taken', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    h.failBitmaps();
    const out: FeatureFrame[] = [];
    h.runner.submit(SOURCE, W, H, landmarks(), frame(1), (x) => out.push(x));
    await h.settle();
    expect(out).toHaveLength(1);
    expect(h.frames()).toHaveLength(0);
  });

  it('closes a picture that arrives after its frame has gone', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    h.runner.submit(SOURCE, W, H, landmarks(), frame(1), () => {});
    [...h.timers.values()][0]();
    await h.settle();
    expect(h.bitmaps[0].closed).toBe(true);
    expect(h.frames()).toHaveLength(0);
  });

  it('stops for good, releasing what waits, when the worker cannot read the weights or breaks', async () => {
    for (const breakIt of [(h: ReturnType<typeof harness>) => h.reply({ type: 'failed', message: 'not a network' }), (h: ReturnType<typeof harness>) => h.worker.onerror?.({})]) {
      const h = harness();
      h.reply({ type: 'ready', id: 'net-1' });
      const out: FeatureFrame[] = [];
      h.runner.submit(SOURCE, W, H, landmarks(), frame(1), (x) => out.push(x));
      await h.settle();
      breakIt(h);
      expect(out).toHaveLength(1);
      expect(h.failures).toHaveLength(1);
      expect(h.terminated).toBe(true);
      expect(h.runner.running).toBe(false);
      // Later frames pass through untouched.
      h.runner.submit(SOURCE, W, H, landmarks(), frame(2), (x) => out.push(x));
      expect(out.map((f) => f.t)).toEqual([1, 2]);
    }
  });

  it('refuses a worker that loaded some other network', () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'another' });
    expect(h.runner.running).toBe(false);
    expect(h.failures).toHaveLength(1);
  });

  it('on dispose stops the worker and releases what waits, without calling it a failure', async () => {
    const h = harness();
    h.reply({ type: 'ready', id: 'net-1' });
    const out: FeatureFrame[] = [];
    h.runner.submit(SOURCE, W, H, landmarks(), frame(1), (x) => out.push(x));
    await h.settle();
    h.runner.dispose();
    h.runner.dispose();
    expect(out).toHaveLength(1);
    expect(h.terminated).toBe(true);
    expect(h.failures).toEqual([]);
    expect(h.timers.size).toBe(0);
  });
});
