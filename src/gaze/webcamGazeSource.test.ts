import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EyeFeatures, FeatureFrame, FeatureSource, GazeModel, GazeSample, Point, Unsubscribe } from '../types';
import { BlinkGate, WebcamGazeSource } from './webcamGazeSource';

class FakeFeatures implements FeatureSource {
  running = true;
  startCalls = 0;
  private readonly cbs = new Set<(f: FeatureFrame) => void>();
  start(): Promise<void> {
    this.startCalls++;
    return Promise.resolve();
  }
  stop(): void {
    this.running = false;
  }
  onFrame(cb: (f: FeatureFrame) => void): Unsubscribe {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }
  push(frame: FeatureFrame): void {
    for (const cb of [...this.cbs]) cb(frame);
  }
  get listeners(): number {
    return this.cbs.size;
  }
}

/** Reads the target point straight out of the first two vector slots. */
class FakeModel implements GazeModel {
  readonly viewport = { width: 1000, height: 800 };
  readonly trainedAt = 0;
  constructor(private readonly offset: Point = { x: 0, y: 0 }) {}
  predict(f: EyeFeatures): Point | null {
    return { x: f.vector[0] + this.offset.x, y: f.vector[1] + this.offset.y };
  }
  toJSON() {
    return { version: 1 };
  }
}

function features(x: number, y: number, blink = 0): EyeFeatures {
  return {
    vector: [x, y],
    headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 },
    blink,
    openness: 0.3,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.5 },
  };
}

const FRAME_MS = 1000 / 30;

function setup(opts: { model?: GazeModel | null } = {}) {
  let now = 10_000;
  let model: GazeModel | null = opts.model === undefined ? new FakeModel() : opts.model;
  const src = new FakeFeatures();
  const gaze = new WebcamGazeSource({ features: src, getModel: () => model, now: () => now });
  const samples: GazeSample[] = [];
  gaze.onSample((s) => samples.push(s));
  void gaze.start();

  const frame = (f: Partial<FeatureFrame> & { at?: number } = {}): GazeSample => {
    const { at, ...rest } = f;
    now = at ?? now + FRAME_MS;
    src.push({ t: now, faceFound: true, features: features(500, 400), quality: 0.8, ...rest });
    return samples[samples.length - 1];
  };
  const look = (x: number, y: number, extra: Partial<FeatureFrame> = {}): GazeSample =>
    frame({ features: features(x, y), ...extra });
  const blink = (score: number, x = 500, y = 400): GazeSample => frame({ features: features(x, y, score) });

  return {
    src,
    gaze,
    samples,
    frame,
    look,
    blink,
    setModel: (m: GazeModel | null) => {
      model = m;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebcamGazeSource lifecycle', () => {
  it('subscribes on start and unsubscribes on stop, without driving the camera', async () => {
    const src = new FakeFeatures();
    const gaze = new WebcamGazeSource({ features: src, getModel: () => new FakeModel() });
    expect(gaze.kind).toBe('webcam');
    expect(gaze.running).toBe(false);
    await gaze.start();
    await gaze.start();
    expect(gaze.running).toBe(true);
    expect(src.listeners).toBe(1);
    expect(src.startCalls).toBe(0);
    gaze.stop();
    expect(gaze.running).toBe(false);
    expect(src.listeners).toBe(0);
    gaze.stop();
  });

  it('emits exactly one sample per frame, valid or not', () => {
    const h = setup();
    h.look(100, 100);
    h.blink(0.95);
    h.frame({ faceFound: false, features: null });
    h.look(120, 90);
    h.frame({ features: null });
    expect(h.samples).toHaveLength(5);
    expect(h.samples.map((s) => s.valid)).toEqual([true, false, false, true, false]);
  });

  it('isolates a throwing listener', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = setup();
    h.gaze.onSample(() => {
      throw new Error('boom');
    });
    const seen: GazeSample[] = [];
    h.gaze.onSample((s) => seen.push(s));
    h.look(1, 2);
    expect(seen).toHaveLength(1);
    expect(h.samples).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
  });
});

describe('WebcamGazeSource samples', () => {
  it('reports the prediction as raw, smooths x/y and uses frame quality as confidence', () => {
    const h = setup();
    const first = h.look(300, 200, { quality: 0.65 });
    expect(first).toMatchObject({ valid: true, rawX: 300, rawY: 200, x: 300, y: 200, confidence: 0.65, source: 'webcam' });
    expect(first.t).toBe(h.now);

    // Jitter around (300, 200): the smoothed signal wobbles far less than the raw one.
    let rawSpread = 0;
    let smoothSpread = 0;
    for (let i = 0; i < 60; i++) {
      const s = h.look(300 + (i % 2 ? 30 : -30), 200);
      if (i > 10) {
        rawSpread = Math.max(rawSpread, Math.abs(s.rawX - 300));
        smoothSpread = Math.max(smoothSpread, Math.abs(s.x - 300));
      }
    }
    expect(rawSpread).toBe(30);
    expect(smoothSpread).toBeLessThan(10);
  });

  it('marks samples invalid with stale coordinates and zero confidence', () => {
    const h = setup();
    const good = h.look(640, 360);
    const cases: Omit<FeatureFrame, 't'>[] = [
      { faceFound: false, features: null, quality: 0 },
      { faceFound: true, features: null, quality: 0 },
      { faceFound: false, features: features(10, 10), quality: 0.9 },
      { faceFound: true, features: features(5000, 10), quality: 0.9 }, // far outside what calibration saw
      { faceFound: true, features: features(Number.NaN, 10), quality: 0.9 },
    ];
    for (const c of cases) {
      expect(h.frame(c)).toMatchObject({ valid: false, confidence: 0, x: good.x, y: good.y, rawX: good.rawX, rawY: good.rawY });
    }
  });

  it('is invalid without a model or when the model refuses', () => {
    const modelFrom = (predict: (f: EyeFeatures) => Point | null): GazeModel => ({
      viewport: { width: 1000, height: 800 },
      trainedAt: 0,
      predict,
      toJSON: () => ({ version: 1 }),
    });
    const h = setup({ model: null });
    expect(h.look(1, 1).valid).toBe(false);
    h.setModel(modelFrom(() => null));
    expect(h.look(1, 1).valid).toBe(false);
    h.setModel(
      modelFrom(() => {
        throw new Error('bad features');
      }),
    );
    expect(h.look(1, 1).valid).toBe(false);
    h.setModel(new FakeModel());
    expect(h.look(1, 1).valid).toBe(true);
  });

  it('gives finite coordinates before the first valid sample', () => {
    const h = setup({ model: null });
    const s = h.look(1, 1);
    expect(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.rawX) && Number.isFinite(s.rawY)).toBe(true);
  });

  it('keeps time in the local clock even if a remote source uses another time origin', () => {
    const h = setup();
    const a = h.frame({ at: undefined });
    expect(a.t).toBe(h.now);
    // Frame stamped by a different document (e.g. the extension's offscreen page).
    h.advance(FRAME_MS);
    h.src.push({ t: 987_654_321, faceFound: true, features: features(1, 1), quality: 1 });
    expect(h.samples.at(-1)?.t).toBe(h.now);
    h.advance(FRAME_MS);
    h.src.push({ t: -5, faceFound: true, features: features(1, 1), quality: 1 });
    expect(h.samples.at(-1)?.t).toBe(h.now);
    const ts = h.samples.map((s) => s.t);
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
  });
});

describe('WebcamGazeSource smoothing resets', () => {
  const settleAt = (h: ReturnType<typeof setup>, x: number, y: number) => {
    for (let i = 0; i < 40; i++) h.look(x, y);
  };

  it('restarts the filter after more than 300 ms of invalid frames', () => {
    const h = setup();
    settleAt(h, 100, 100);
    for (let i = 0; i < 12; i++) h.frame({ faceFound: false, features: null }); // 400 ms
    const s = h.look(700, 500);
    expect(s.valid).toBe(true);
    expect(s.x).toBe(700);
    expect(s.y).toBe(500);
  });

  it('smooths across a short dropout instead of jumping', () => {
    const h = setup();
    settleAt(h, 100, 100);
    for (let i = 0; i < 3; i++) h.frame({ faceFound: false, features: null }); // 100 ms
    const s = h.look(700, 500);
    expect(s.x).toBeGreaterThan(100);
    expect(s.x).toBeLessThan(700);
  });

  it('restarts the filter after a stall with no frames at all', () => {
    const h = setup();
    settleAt(h, 100, 100);
    h.advance(500);
    expect(h.look(700, 500).x).toBe(700);
  });

  it('restarts the filter when the calibration model changes', () => {
    const h = setup();
    settleAt(h, 100, 100);
    h.setModel(new FakeModel({ x: 400, y: 0 }));
    expect(h.look(100, 100).x).toBe(500);
  });
});

describe('WebcamGazeSource blink handling', () => {
  it('drops a blink and the frame right after it', () => {
    const h = setup();
    for (let i = 0; i < 10; i++) h.look(500, 400);
    const during = [0.3, 0.7, 0.95, 0.9, 0.6].map((b) => h.blink(b).valid);
    expect(during).toEqual([true, false, false, false, false]);
    expect(h.blink(0.1).valid).toBe(false); // settling (50 ms): the iris landmark lags the lid
    expect(h.blink(0.1).valid).toBe(true);
  });

  it('lets sustained half-closed lids through (reading the bottom of the page)', () => {
    const h = setup();
    const valid: boolean[] = [];
    for (let i = 0; i < 30; i++) valid.push(h.blink(0.6).valid); // 1 s
    const firstValid = valid.indexOf(true);
    expect(firstValid).toBeGreaterThanOrEqual(Math.floor(400 / FRAME_MS) - 1);
    expect(firstValid).toBeLessThanOrEqual(Math.ceil(400 / FRAME_MS) + 1);
    expect(valid.slice(firstValid).every(Boolean)).toBe(true);
  });

  it('never lets closed eyes through', () => {
    const h = setup();
    for (let i = 0; i < 60; i++) expect(h.blink(0.95).valid).toBe(false);
  });

  it('never lets shut lids through, even when the blink score stays moderate', () => {
    // Some faces never reach the 0.85 score with their eyes closed; the lid
    // aperture tells a long closure apart from lowered lids.
    const h = setup();
    for (let i = 0; i < 60; i++) {
      expect(h.frame({ features: { ...features(500, 400, 0.6), openness: 0.03 } }).valid).toBe(false);
    }
    // The same score with open-enough lids (reading the bottom of the page) still passes.
    for (let i = 0; i < 20; i++) h.frame({ features: { ...features(500, 400, 0.6), openness: 0.16 } });
    expect(h.samples.at(-1)?.valid).toBe(true);
  });
});

describe('WebcamGazeSource robustness', () => {
  it('falls back to the defaults for NaN or negative tuning options', () => {
    const src = new FakeFeatures();
    let now = 0;
    const gaze = new WebcamGazeSource({
      features: src,
      getModel: () => new FakeModel(),
      resetAfterInvalidMs: Number.NaN,
      maxOffscreenViewports: -1,
      now: () => now,
    });
    const samples: GazeSample[] = [];
    gaze.onSample((s) => samples.push(s));
    void gaze.start();
    const look = (x: number, y: number, dt = FRAME_MS): GazeSample => {
      now += dt;
      src.push({ t: now, faceFound: true, features: features(x, y), quality: 1 });
      return samples[samples.length - 1];
    };
    // An on-screen point is still valid (a negative bound would reject everything)…
    for (let i = 0; i < 30; i++) expect(look(100, 100).valid).toBe(true);
    // …and a long gap still restarts the smoothing (NaN would never reset it).
    expect(look(700, 500, 1000).x).toBe(700);
  });

  it('treats a throwing getModel as "no model", still emitting one sample per frame', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const src = new FakeFeatures();
    const gaze = new WebcamGazeSource({
      features: src,
      getModel: () => {
        throw new Error('storage exploded');
      },
      now: () => 1000,
    });
    const samples: GazeSample[] = [];
    gaze.onSample((s) => samples.push(s));
    void gaze.start();
    src.push({ t: 1000, faceFound: true, features: features(1, 1), quality: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ valid: false, confidence: 0 });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('BlinkGate', () => {
  it('follows the documented rules', () => {
    const gate = new BlinkGate({ threshold: 0.5, closedThreshold: 0.85, maxBlinkMs: 400, settleMs: 50 });
    expect(gate.update(0, 0.2)).toBe(false);
    expect(gate.update(10, 0.6)).toBe(true);
    expect(gate.update(409, 0.6)).toBe(true);
    expect(gate.update(410, 0.6)).toBe(false); // sustained → lowered lids
    expect(gate.update(420, 0.9)).toBe(true); // a real blink while looking down
    expect(gate.update(430, 0.3)).toBe(true); // settling
    expect(gate.update(480, 0.3)).toBe(false);
    expect(gate.update(490, Number.NaN)).toBe(false);
    gate.reset();
    expect(gate.update(500, 0.6)).toBe(true); // a fresh episode after reset
  });

  it('uses the lid aperture to tell shut eyes from lowered lids', () => {
    const gate = new BlinkGate();
    expect(gate.update(0, 0.6, 0.18)).toBe(true); // start of an episode: could be a blink
    expect(gate.update(500, 0.6, 0.18)).toBe(false); // sustained with open-enough lids → lowered lids
    expect(gate.update(533, 0.6, 0.04)).toBe(true); // lids shut despite a moderate score
    expect(gate.update(566, 0.6, Number.NaN)).toBe(false); // aperture unknown → the score rule alone
    expect(gate.update(600, 0.6)).toBe(false);
    expect(gate.update(633, 0.3, 0.02)).toBe(false); // below the score threshold the aperture is not consulted
  });
});
