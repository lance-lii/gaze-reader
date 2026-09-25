import { describe, expect, it } from 'vitest';
import type { Fixation, GazeSample } from '../types';
import { DEFAULT_FIXATION_OPTIONS, FixationDetector, classifySaccade } from './fixations';
import { OneEuroFilter2D } from './oneEuro';
import { gaussian, mulberry32 } from '../reading/simulatedReader';
import { makeDocument } from '../reading/testLayouts';

const HZ = 30;
const DT = 1000 / HZ;

function sample(t: number, x: number, y: number, valid = true): GazeSample {
  return { t, x, y, rawX: x, rawY: y, valid, confidence: valid ? 1 : 0, source: 'mouse' };
}

interface Target {
  x: number;
  y: number;
  ms: number;
}

/** Where the eyes truly were at time t. */
function targetAt(targets: Target[], t: number): Target {
  let end = 0;
  for (const target of targets) {
    end += target.ms;
    if (t < end) return target;
  }
  return targets[targets.length - 1]!;
}

/** Samples a sequence of fixation targets at 30 Hz, optionally noisy and One-Euro smoothed. */
function trace(targets: Target[], opts: { noise?: number; seed?: number } = {}): GazeSample[] {
  const rng = mulberry32(opts.seed ?? 1);
  const filter = new OneEuroFilter2D();
  const out: GazeSample[] = [];
  let t = 0;
  let end = 0;
  for (const target of targets) {
    end += target.ms;
    for (; t < end - 1e-6; t += DT) {
      const rx = target.x + (opts.noise ?? 0) * gaussian(rng);
      const ry = target.y + (opts.noise ?? 0) * gaussian(rng);
      const s = opts.noise ? filter.filter(rx, ry, t) : { x: rx, y: ry };
      out.push({ ...sample(t, s.x, s.y), rawX: rx, rawY: ry });
    }
  }
  return out;
}

function run(det: FixationDetector, samples: GazeSample[]): { done: Fixation[]; current: Fixation | null } {
  const done: Fixation[] = [];
  let current: Fixation | null = null;
  for (const s of samples) {
    const r = det.push(s);
    if (r.completed) done.push(r.completed);
    current = r.current;
  }
  return { done, current };
}

/** Reading-like targets: fixations every ~85 px along lines of a 700 px column, then a return sweep. */
function readingTargets(lines: number, seed: number): Target[] {
  const rng = mulberry32(seed);
  const out: Target[] = [];
  for (let l = 0; l < lines; l++) {
    for (let x = 200; x < 840; x += 70 + 30 * rng()) out.push({ x, y: 100 + 42 * l, ms: 180 + 120 * rng() });
  }
  return out;
}

describe('FixationDetector', () => {
  it('finds every fixation of a clean trace, with stable ids and accurate centers', () => {
    const targets = [200, 285, 370, 455, 540].map((x) => ({ x, y: 100, ms: 250 }));
    const det = new FixationDetector();
    const seenCurrentIds = new Set<number>();
    const done: Fixation[] = [];
    for (const s of trace(targets)) {
      const r = det.push(s);
      if (r.current) seenCurrentIds.add(r.current.id);
      if (r.completed) done.push(r.completed);
    }
    expect(done).toHaveLength(4); // the last one is still in progress
    done.forEach((f, i) => {
      expect(f.x).toBeCloseTo(targets[i]!.x, 6);
      expect(f.y).toBeCloseTo(100, 6);
      expect(f.end - f.start).toBeGreaterThan(199);
      expect(f.sampleCount).toBeGreaterThanOrEqual(7);
      if (i > 0) expect(f.id).toBe(done[i - 1]!.id + 1);
    });
    expect([...seenCurrentIds]).toEqual([1, 2, 3, 4, 5]);
  });

  it('detects fixations in noisy, smoothed webcam-like gaze', () => {
    const errY: number[] = [];
    const errX: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const targets = readingTargets(6, seed);
      const { done } = run(new FixationDetector(), trace(targets, { noise: 30, seed }));
      // Merging a few neighbours is fine; splitting noise into many fixations is not.
      expect(done.length).toBeGreaterThan(0.6 * targets.length);
      expect(done.length).toBeLessThan(1.15 * targets.length);
      for (const f of done) {
        const truth = targetAt(targets, (f.start + f.end) / 2);
        errY.push(Math.abs(f.y - truth.y));
        errX.push(Math.abs(f.x - truth.x));
      }
    }
    // Fixation centers average out most of the noise (σ = 30 px raw): about a fifth of a line.
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(errY)).toBeLessThan(10);
    expect(mean(errX)).toBeLessThan(16);
  });

  it('never reports a fixation shorter than minDurationMs', () => {
    const det = new FixationDetector({ minDurationMs: 150 });
    const { done, current } = run(det, trace([{ x: 100, y: 100, ms: 130 }, { x: 400, y: 100, ms: 130 }, { x: 700, y: 100, ms: 60 }]));
    expect(done).toHaveLength(0);
    expect(current).toBeNull();
  });

  it('keeps a fixation through a blink shorter than maxGapMs', () => {
    const det = new FixationDetector();
    const samples = trace([{ x: 300, y: 200, ms: 600 }]).map((s) =>
      s.t > 210 && s.t < 320 ? { ...s, valid: false, x: NaN, y: NaN } : s,
    );
    const { done, current } = run(det, samples);
    expect(done).toHaveLength(0);
    expect(current?.start).toBe(0);
    expect(current!.end).toBeGreaterThan(550);
  });

  it('ends the current fixation once tracking has been lost for longer than maxGapMs', () => {
    const det = new FixationDetector();
    run(det, trace([{ x: 300, y: 200, ms: 400 }]));
    let completed: Fixation | null = null;
    let at = -1;
    for (let t = 400; t < 800 && !completed; t += DT) {
      const r = det.push(sample(t, 300, 200, false));
      if (r.completed) {
        completed = r.completed;
        at = t;
      }
      if (!completed) expect(r.current).not.toBeNull();
    }
    expect(completed).not.toBeNull();
    expect(at - completed!.end).toBeGreaterThan(DEFAULT_FIXATION_OPTIONS.maxGapMs);
    expect(at - completed!.end).toBeLessThan(DEFAULT_FIXATION_OPTIONS.maxGapMs + 2 * DT);
    expect(det.push(sample(900, 300, 200, false)).current).toBeNull();
  });

  it('treats a missing-frames gap in valid samples like tracking loss', () => {
    const det = new FixationDetector();
    run(det, trace([{ x: 300, y: 200, ms: 300 }]));
    const r = det.push(sample(900, 300, 200));
    expect(r.completed).not.toBeNull();
    expect(r.current).toBeNull(); // a new window has only just started
  });

  it('ignores a single outlier sample instead of splitting the fixation', () => {
    const samples = trace([{ x: 300, y: 200, ms: 600 }]);
    samples[9] = sample(samples[9]!.t, 520, 260);
    const { done, current } = run(new FixationDetector(), samples);
    expect(done).toHaveLength(0);
    expect(current!.x).toBeCloseTo(300, 6);
    expect(current!.sampleCount).toBe(samples.length - 1);
  });

  it('treats non-finite coordinates as invalid and ignores non-finite timestamps', () => {
    const det = new FixationDetector();
    run(det, trace([{ x: 300, y: 200, ms: 300 }]));
    const before = det.push(sample(300, 300, 200)).current!;
    expect(det.push(sample(NaN, 300, 200)).current).toEqual(before);
    const r = det.push(sample(333, Infinity, 200));
    expect(r.completed).toBeNull();
    expect(r.current!.sampleCount).toBe(before.sampleCount);
  });

  it('starts over when the clock goes backwards, and on reset()', () => {
    const det = new FixationDetector();
    run(det, trace([{ x: 300, y: 200, ms: 300 }]));
    const r = det.push(sample(10, 300, 200));
    expect(r.completed).toBeNull();
    expect(r.current).toBeNull();
    run(det, trace([{ x: 300, y: 200, ms: 300 }]).map((s) => ({ ...s, t: s.t + 20 })));
    det.reset();
    expect(det.push(sample(1000, 300, 200)).current).toBeNull();
  });

  it('reports a long stare as consecutive fixations so consumers keep getting updates', () => {
    const { done, current } = run(new FixationDetector(), trace([{ x: 500, y: 300, ms: 2100 }]));
    expect(done.length).toBe(3);
    for (const f of done) {
      expect(f.end - f.start).toBeLessThanOrEqual(DEFAULT_FIXATION_OPTIONS.maxDurationMs!);
      expect(f.x).toBeCloseTo(500, 6);
    }
    expect(done.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(current?.id).toBe(4);
    const unlimited = run(new FixationDetector({ maxDurationMs: Infinity }), trace([{ x: 500, y: 300, ms: 2100 }]));
    expect(unlimited.done).toHaveLength(0);
    expect(unlimited.current!.end).toBeGreaterThan(2000);
  });

  it('falls back to defaults for invalid options', () => {
    const det = new FixationDetector({ maxDispersionPx: -5, minDurationMs: NaN, maxGapMs: 90 });
    expect(det.options).toEqual({ ...DEFAULT_FIXATION_OPTIONS, maxGapMs: 90 });
  });
});

describe('classifySaccade', () => {
  const layout = makeDocument({ lines: 12, paragraphLines: [99, 99], seed: 1 }).layoutAt(0);
  const pitch = layout.linePitch;
  const fix = (x: number, y: number): Fixation => ({ id: 0, start: 0, end: 200, x, y, sampleCount: 6 });
  const y0 = layout.lines[3]!.centerY;

  it('recognizes reading saccades', () => {
    expect(classifySaccade(fix(300, y0), fix(385, y0 + 5), layout)).toBe('forward');
    expect(classifySaccade(fix(500, y0), fix(440, y0 - 4), layout)).toBe('regression');
    expect(classifySaccade(fix(830, y0), fix(200, y0 + pitch), layout)).toBe('return-sweep');
    // Noisy vertical: still a sweep unless it clearly goes up.
    expect(classifySaccade(fix(830, y0), fix(200, y0 - 0.3 * pitch), layout)).toBe('return-sweep');
    expect(classifySaccade(fix(830, y0), fix(200, y0 - 0.8 * pitch), layout)).toBe('regression');
  });

  it('requires a sweep to start in the right part of the column and land in the left part', () => {
    expect(classifySaccade(fix(460, y0), fix(170, y0 + pitch), layout)).toBe('regression');
    expect(classifySaccade(fix(850, y0), fix(560, y0 + pitch), layout)).toBe('regression');
  });

  it('calls large displacements jumps', () => {
    expect(classifySaccade(fix(300, y0), fix(320, y0 + 3 * pitch), layout)).toBe('jump');
    expect(classifySaccade(fix(300, y0), fix(320, y0 - 3 * pitch), layout)).toBe('jump');
    expect(classifySaccade(fix(170, y0), fix(820, y0), layout)).toBe('jump');
    expect(classifySaccade(fix(1500, y0), fix(100, y0), layout)).toBe('jump');
    expect(classifySaccade(fix(300, NaN), fix(320, y0), layout)).toBe('jump');
  });

  it('recognizes the short return sweep from a paragraph-final line when told the current line', () => {
    const short = { ...layout.lines[3]!, right: layout.lines[3]!.left + 150 };
    const prev = fix(short.left + 130, y0);
    const next = fix(210, y0 + pitch);
    expect(classifySaccade(prev, next, layout)).toBe('regression');
    expect(classifySaccade(prev, next, layout, short)).toBe('return-sweep');
    // Without downward movement it is a regression within the line.
    expect(classifySaccade(prev, fix(170, y0), layout, short)).toBe('regression');
  });

  it('classifies on dx alone when the vertical step belongs to the sensor (ignoreDy)', () => {
    // The gaze bias stepped 4 lines down between two fixations (a light switched on): with dy it
    // is a jump; the eyes only made a forward saccade, a sweep or a regression.
    const down = 4 * pitch;
    expect(classifySaccade(fix(300, y0), fix(385, y0 + down), layout)).toBe('jump');
    expect(classifySaccade(fix(300, y0), fix(385, y0 + down), layout, null, { ignoreDy: true })).toBe('forward');
    expect(classifySaccade(fix(830, y0), fix(200, y0 + down), layout, null, { ignoreDy: true })).toBe('return-sweep');
    expect(classifySaccade(fix(830, y0), fix(200, y0 - down), layout, null, { ignoreDy: true })).toBe('return-sweep');
    expect(classifySaccade(fix(500, y0), fix(440, y0 - down), layout, null, { ignoreDy: true })).toBe('regression');
    // Horizontal limits still apply, and a short paragraph-final line's sweep needs no drop.
    expect(classifySaccade(fix(170, y0), fix(820, y0 + down), layout, null, { ignoreDy: true })).toBe('jump');
    const short = { ...layout.lines[3]!, right: layout.lines[3]!.left + 150 };
    expect(classifySaccade(fix(short.left + 130, y0), fix(210, y0 - down), layout, short, { ignoreDy: true })).toBe('return-sweep');
    // A non-finite y doesn't matter then either; a non-finite x still does.
    expect(classifySaccade(fix(300, NaN), fix(385, y0), layout, null, { ignoreDy: true })).toBe('forward');
    expect(classifySaccade(fix(NaN, y0), fix(385, y0), layout, null, { ignoreDy: true })).toBe('jump');
  });

  it('works without a layout using typical metrics', () => {
    expect(classifySaccade(fix(300, 100), fix(380, 102), null)).toBe('forward');
    expect(classifySaccade(fix(900, 100), fix(250, 140), null)).toBe('return-sweep');
    expect(classifySaccade(fix(400, 100), fix(350, 100), null)).toBe('regression');
    expect(classifySaccade(fix(400, 100), fix(400, 250), null)).toBe('jump');
  });
});
