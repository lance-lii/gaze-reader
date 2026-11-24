import { describe, expect, it } from 'vitest';
import type { CalibrationSample, EyeFeatures, Point } from '../types';
import { deserializeGazeModel, refineGazeModel, trainGazeModel } from './calibrationModel';

/** A small feature layout: two eye numbers, noise, then the head. */
const NAMES = ['eyeX', 'eyeY', 'junk', 'yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale'];
const VIEW = { width: 1200, height: 800 };
/** Where the app assumes the camera without a window to ask: above the middle of the viewport. */
const CAMERA = { x: 600, y: -136 };
const DEG = Math.PI / 180;
const NET = 'toy-net';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

interface Head {
  yaw?: number;
  pitch?: number;
  faceScale?: number;
}

/**
 * What the toy tracker reports for a reader looking at `gaze` (viewport px). Its landmark
 * features move with the head (0.5 per radian) with the gaze unchanged; the toy network looks at
 * the eye itself and is not fooled. `net` names the network that answered, or null for none.
 */
function look(gaze: Point, r: () => number, head: Head = {}, net: string | null = NET): EyeFeatures {
  const yaw = head.yaw ?? 0;
  const pitch = head.pitch ?? 0;
  const faceScale = head.faceScale ?? 0.2;
  const dx = ((gaze.x - CAMERA.x) / 600) * (faceScale / 0.2);
  const dy = ((gaze.y - CAMERA.y) / 600) * (faceScale / 0.2);
  const vector = [dx + 0.5 * yaw + 0.004 * gauss(r), dy + 0.5 * pitch + 0.004 * gauss(r), gauss(r), yaw, pitch, 0, 0, -5, -60, faceScale * Math.cos(yaw)];
  return {
    vector,
    headPose: { yaw, pitch, roll: 0, tx: 0, ty: -5, tz: -60 },
    blink: 0.05,
    openness: 0.3,
    faceScale,
    faceCenter: { x: 0.5, y: 0.45 },
    // The answer is in the network's own units and not centred: the calibration finds the line to the screen.
    ...(net ? { eyeNet: { id: net, x: 0.8 * dx + 0.1 + 0.004 * gauss(r), y: 0.7 * dy - 0.2 + 0.004 * gauss(r) } } : {}),
  };
}

const GRID: Point[] = [0.1, 0.5, 0.9].flatMap((fx) => [0.1, 0.5, 0.9].map((fy) => ({ x: fx * VIEW.width, y: fy * VIEW.height })));

function session(seed: number, head: Head = {}, net: string | null = NET, per = 20): CalibrationSample[] {
  const r = rng(seed);
  return GRID.flatMap((target) => Array.from({ length: per }, (_, i) => ({ target, features: look(target, r, head, net), t: i })));
}

function meanError(model: { predict(f: EyeFeatures): Point | null }, head: Head, seed = 9): number {
  const r = rng(seed);
  let sum = 0;
  let n = 0;
  for (const target of [
    { x: 300, y: 200 },
    { x: 900, y: 600 },
    { x: 600, y: 400 },
    { x: 400, y: 700 },
  ]) {
    for (let i = 0; i < 20; i++) {
      const p = model.predict(look(target, r, head));
      if (!p) continue;
      sum += Math.hypot(p.x - target.x, p.y - target.y);
      n++;
    }
  }
  return n ? sum / n : NaN;
}

const train = (extra: Parameters<typeof trainGazeModel>[1] = {}, samples = session(1)) =>
  trainGazeModel(samples, { viewport: VIEW, featureNames: NAMES, eyeNet: NET, ...extra });

describe('a calibration on the eye-picture network', () => {
  it('fits a straight line from the network’s two answers to the screen, and nothing else', () => {
    const { model, diagnostics } = train();
    expect(model.eyeNet).toEqual({ id: NET, slots: [6, 7] });
    expect(model.prior).toBeNull();
    expect(model.dominantFeatures).toEqual([]);
    expect(diagnostics.expandedDim).toBe(NAMES.length);
    expect(model.excludedFeatures).toEqual([0, 1, 2, 3, 4, 5, 8, 9]);
    expect(meanError(model, {})).toBeLessThan(6);
  });

  it('holds when the head turns after calibrating, where the plain calibration is thrown', () => {
    const onNet = train({ poseCompensation: false }).model;
    const plain = train({ eyeNet: null, poseCompensation: false }).model;
    expect(plain.eyeNet).toBeNull();
    expect(meanError(plain, {})).toBeLessThan(6);
    const turned = { yaw: 8 * DEG, pitch: -6 * DEG };
    expect(meanError(plain, turned)).toBeGreaterThan(40);
    expect(meanError(onNet, turned)).toBeLessThan(6);
  });

  it('still scales about the camera when the reader leans in', () => {
    expect(meanError(train().model, { faceScale: 0.25 })).toBeLessThan(8);
  });

  it('has nothing to say about a frame the network did not answer, or another network answered', () => {
    const { model } = train();
    const r = rng(3);
    const target = { x: 600, y: 400 };
    expect(model.predict(look(target, r))).not.toBeNull();
    expect(model.predict(look(target, r, {}, null))).toBeNull();
    expect(model.predict(look(target, r, {}, 'another-net'))).toBeNull();
    const broken = look(target, r);
    broken.eyeNet = { id: NET, x: Number.NaN, y: 0 };
    expect(model.predict(broken)).toBeNull();
  });

  it('treats a wild answer as a tracking glitch', () => {
    const { model } = train();
    const f = look({ x: 600, y: 400 }, rng(3));
    f.eyeNet = { id: NET, x: f.eyeNet!.x + 50, y: f.eyeNet!.y };
    expect(model.predict(f)).toBeNull();
  });

  it('leaves out the frames the network did not answer, and needs enough that it did', () => {
    const samples = session(1);
    for (let i = 0; i < samples.length; i += 4) samples[i] = { ...samples[i], features: { ...samples[i].features, eyeNet: undefined } };
    const { model } = train({}, samples);
    expect(meanError(model, {})).toBeLessThan(6);
    expect(() => train({}, session(1, {}, null))).toThrow(/calibration points/);
    expect(() => train({}, session(1, {}, 'another-net'))).toThrow(/calibration points/);
  });

  it('drops glances away at a dot by the network’s answers', () => {
    const samples = session(1);
    const r = rng(4);
    for (let i = 0; i < 4; i++) samples[i] = { ...samples[i], features: look({ x: 1150, y: 760 }, r) };
    const { model, diagnostics } = train({}, samples);
    expect(diagnostics.rejectedOutliers).toBeGreaterThanOrEqual(4);
    expect(meanError(model, {})).toBeLessThan(6);
  });

  it('is saved with its network’s name and reads the same afterwards', () => {
    const { model } = train();
    const json = JSON.parse(JSON.stringify(model.toJSON())) as Record<string, unknown>;
    expect(json.eyeNet).toEqual({ id: NET, slots: [6, 7] });
    const back = deserializeGazeModel(json, { featureLength: NAMES.length, featureNames: NAMES })!;
    expect(back.eyeNet).toEqual(model.eyeNet);
    const f = look({ x: 333, y: 555 }, rng(5), { yaw: 0.05 });
    expect(back.predict(f)).toEqual(model.predict(f));
  });

  it('is void when what it says about its network is damaged', () => {
    const json = JSON.parse(JSON.stringify(train().model.toJSON())) as Record<string, unknown>;
    const expectations = { featureLength: NAMES.length };
    expect(deserializeGazeModel({ ...json, eyeNet: 'toy-net' }, expectations)).toBeNull();
    expect(deserializeGazeModel({ ...json, eyeNet: { id: '', slots: [6, 7] } }, expectations)).toBeNull();
    expect(deserializeGazeModel({ ...json, eyeNet: { id: NET, slots: [6, 6] } }, expectations)).toBeNull();
    expect(deserializeGazeModel({ ...json, eyeNet: { id: NET, slots: [6, 400] } }, expectations)).toBeNull();
    expect(deserializeGazeModel({ ...json, eyeNet: { id: NET, slots: [6] } }, expectations)).toBeNull();
  });

  it('can be corrected in place from a few dots, like any calibration', () => {
    const { model } = train();
    const r = rng(11);
    // The reader's dots land 40 px right of where the model says: a correction should take that out.
    const shifted: CalibrationSample[] = GRID.slice(0, 5).flatMap((target) =>
      Array.from({ length: 10 }, (_, i) => ({ target: { x: target.x + 40, y: target.y }, features: look(target, r), t: i })),
    );
    const refined = refineGazeModel(model, shifted);
    expect(refined.model.eyeNet).toEqual(model.eyeNet);
    const before = model.predict(look({ x: 600, y: 400 }, rng(12)))!;
    const p = refined.model.predict(look({ x: 600, y: 400 }, rng(12)))!;
    expect(p.x - before.x).toBeGreaterThan(25);
    expect(p.x - before.x).toBeLessThan(55);
  });

  it('refuses to be made on the shared model and the network at once, or without feature names', () => {
    const toy = { id: 'toy', names: ['eyeX', 'eyeY'], mean: [0, 0, 0, 0], sd: [1, 1, 1, 1], w: [[1, 0], [0, 1], [0, 0], [0, 0], [0, 0]] };
    expect(() => train({ prior: toy })).toThrow(/not both/);
    expect(() => trainGazeModel(session(1), { viewport: VIEW, eyeNet: NET })).toThrow(/feature names/);
  });

  it('leaves a calibration without one exactly as it was', () => {
    const { model } = train({ eyeNet: null });
    expect('eyeNet' in model.toJSON()).toBe(false);
    expect(model.eyeNet).toBeNull();
  });
});
