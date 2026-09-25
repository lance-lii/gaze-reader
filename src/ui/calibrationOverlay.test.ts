// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents, EyeFeatures, FeatureFrame, FeatureSource, Point, Unsubscribe } from '../types';
import { createEventBus } from '../core/events';
import { evaluateModel, trainGazeModel } from '../gaze/calibrationModel';
import {
  CalibrationOverlay,
  DEFAULT_POSITION_THRESHOLDS,
  QUICK_TARGETS,
  STANDARD_TARGETS,
  VALIDATION_TARGETS,
  assessPosition,
  type CalibrationOverlayOptions,
  type PositionMetrics,
} from './calibrationOverlay';

type CalEvent = AppEvents['calibration'];

const VW = 1024; // jsdom's default window.innerWidth
const VH = 768;

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

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** A synthetic eye: nonlinear gaze features plus a few irrelevant ones. */
function eyeFeatures(gaze: Point, r: () => number, shift: readonly number[] = [], noise = 1): EyeFeatures {
  const nx = gaze.x / VW - 0.5;
  const ny = gaze.y / VH - 0.5;
  const vector = [
    0.3 + 0.2 * nx + 0.05 * nx * nx + 0.003 * noise * gaussian(r),
    0.7 - 0.18 * nx + 0.003 * noise * gaussian(r),
    0.05 * ny + 0.02 * ny * ny + 0.002 * noise * gaussian(r),
    1 / (1 + Math.exp(-4 * ny)) + 0.01 * noise * gaussian(r),
    0.28 - 0.06 * ny + 0.003 * noise * gaussian(r),
    0.01 * gaussian(r),
    55 + 0.3 * gaussian(r),
    gaussian(r),
  ].map((v, i) => v + (shift[i] ?? 0));
  return {
    vector,
    headPose: { yaw: 0.02, pitch: -0.05, roll: 0, tx: 0, ty: 0, tz: 55 },
    blink: 0.05,
    openness: 0.3,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
  };
}

class FakeSource implements FeatureSource {
  running = true;
  private readonly listeners = new Set<(frame: FeatureFrame) => void>();
  async start(): Promise<void> {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  onFrame(cb: (frame: FeatureFrame) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  push(frame: FeatureFrame): void {
    for (const cb of [...this.listeners]) cb(frame);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface Reader {
  faceFound: boolean;
  faceScale: number;
  faceCenter: Point;
  shift: number[];
  /** Close the eyes while the ring shrinks on this (0-based) target index / attempt. */
  closeEyes: ((index: number, attempt: number) => boolean) | null;
  /**
   * Lids that droop while looking at this point: MediaPipe's blink score rises
   * to a sustained ~0.65 and the tracker's quality score drops with it.
   */
  lidsLowered: ((gaze: Point) => boolean) | null;
  pointIndex: number;
  attempt: number;
}

/** A simulated reader who dutifully looks at whatever dot is on screen. */
function simulateReader(src: FakeSource, scope: ParentNode, bus: ReturnType<typeof createEventBus>, periodMs = 33, seed = 7) {
  const r = rng(seed);
  const reader: Reader = {
    faceFound: true,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
    shift: [],
    closeEyes: null,
    lidsLowered: null,
    pointIndex: -1,
    attempt: 0,
  };
  bus.on('calibration', (e) => {
    if ((e.phase === 'point' || e.phase === 'validating') && e.index !== undefined && e.message !== 'resumed' && e.message !== 'paused' && e.message !== 'face-lost') {
      reader.attempt = e.message === 'retry' ? reader.attempt + 1 : 0;
      reader.pointIndex = e.index;
    }
  });
  const id = setInterval(() => {
    const target = scope.querySelector<HTMLElement>('.gr-cal-target');
    const phase = scope.querySelector<HTMLElement>('.gr-cal')?.dataset.phase;
    let gaze: Point = { x: VW / 2, y: VH / 2 };
    if ((phase === 'targets' || phase === 'validating') && target?.dataset.x && target.dataset.y) {
      gaze = { x: Number(target.dataset.x), y: Number(target.dataset.y) };
    }
    if (!reader.faceFound) {
      src.push({ t: performance.now(), faceFound: false, features: null, quality: 0 });
      return;
    }
    const features = eyeFeatures(gaze, r, reader.shift);
    features.faceScale = reader.faceScale;
    features.faceCenter = { ...reader.faceCenter };
    let quality = 0.9;
    if (reader.lidsLowered?.(gaze)) {
      features.blink = 0.65;
      features.openness = 0.16;
      quality = 0.1;
    }
    const shrinking = target?.classList.contains('is-shrinking') ?? false;
    if (shrinking && reader.closeEyes?.(reader.pointIndex, reader.attempt)) features.blink = 0.9;
    src.push({ t: performance.now(), faceFound: true, features, quality });
  }, periodMs);
  return { reader, stop: () => clearInterval(id) };
}

function setup(opts: Partial<CalibrationOverlayOptions> = {}, readerPeriodMs = 33) {
  const bus = createEventBus();
  const events: CalEvent[] = [];
  bus.on('calibration', (e) => events.push(e));
  const src = new FakeSource();
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const overlay = new CalibrationOverlay({ features: src, bus, random: rng(3), ...opts });
  overlay.mount(shadow);
  const sim = simulateReader(src, shadow, bus, readerPeriodMs);
  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const found = shadow.querySelector<T>(sel);
    if (!found) throw new Error(`missing ${sel}`);
    return found;
  };
  const root = q<HTMLDivElement>('.gr-cal');
  return { bus, events, src, host, shadow, overlay, sim, q, root };
}

async function advanceUntil(pred: () => boolean, maxMs = 120_000, stepMs = 100): Promise<void> {
  for (let t = 0; t <= maxMs; t += stepMs) {
    if (pred()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`condition not met within ${maxMs} ms`);
}

function key(k: string, target: EventTarget = window, code = k === ' ' ? 'Space' : k): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(e);
  return e;
}

async function startCalibration(ctx: ReturnType<typeof setup>): Promise<void> {
  const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
  await advanceUntil(() => !start.disabled, 5000);
  start.click();
  await advanceUntil(() => ctx.root.dataset.phase === 'targets', 2000, 20);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('CalibrationOverlay — standard flow', () => {
  it('runs positioning → 13 targets → training → 4 checks → results, then resolves on "Use it"', async () => {
    const ctx = setup({ linePitchPx: 20 });
    const { events, root, q, shadow, src, overlay } = ctx;
    const done = overlay.run();

    expect(root.hidden).toBe(false);
    expect(root.hasAttribute('data-gr-ignore')).toBe(true);
    expect(root.getAttribute('role')).toBe('dialog');
    expect(shadow.querySelector('style')?.textContent).toContain('.gr-cal-target');
    expect(root.dataset.phase).toBe('positioning');
    expect(q<HTMLButtonElement>('[data-action="start"]').disabled).toBe(true);

    await advanceUntil(() => !q<HTMLButtonElement>('[data-action="start"]').disabled, 5000);
    expect(q('.gr-cal-status-text').textContent).toMatch(/all set/);
    expect(q('.gr-cal-preview').dataset.state).toBe('good');
    expect([...shadow.querySelectorAll<HTMLElement>('.gr-cal-check')].map((c) => c.dataset.state)).toEqual(['ok', 'ok', 'ok', 'ok']);

    q<HTMLButtonElement>('[data-action="start"]').click();
    await advanceUntil(() => root.dataset.phase === 'targets', 2000, 20);
    expect(q('.gr-cal-count').textContent).toBe(`1 / ${STANDARD_TARGETS.length}`);

    await advanceUntil(() => root.dataset.phase === 'results', 120_000, 250);

    const phases = events.map((e) => e.phase);
    expect(phases.slice(0, 2)).toEqual(['start', 'positioning']);
    const points = events.filter((e) => e.phase === 'point');
    expect(points.map((e) => e.index)).toEqual([...STANDARD_TARGETS.keys()]);
    expect(points.every((e) => e.total === STANDARD_TARGETS.length && e.message === undefined)).toBe(true);
    const checks = events.filter((e) => e.phase === 'validating');
    expect(checks.map((e) => e.index)).toEqual([...VALIDATION_TARGETS.keys()]);
    expect(phases.indexOf('training')).toBeGreaterThan(phases.lastIndexOf('point'));
    expect(phases.indexOf('validating')).toBeGreaterThan(phases.indexOf('training'));
    expect(phases).not.toContain('done');

    // Results screen.
    expect(q('.gr-cal-badge').dataset.quality).toBe('excellent');
    expect(q('.gr-cal-stat-value').textContent).toMatch(/^±\d+$/);
    expect(shadow.querySelectorAll('.gr-cal-map-gaze')).toHaveLength(VALIDATION_TARGETS.length);
    const use = q<HTMLButtonElement>('[data-action="use"]');
    expect(shadow.activeElement).toBe(use);
    // The live gaze dot follows the new model.
    await vi.advanceTimersByTimeAsync(200);
    expect(q('.gr-cal-live').classList.contains('is-on')).toBe(true);

    use.click();
    const result = await done;
    expect(result).not.toBeNull();
    const { model, report } = result!;
    expect(report.perPoint).toHaveLength(VALIDATION_TARGETS.length);
    expect(report.quality).toBe('excellent');
    expect(shadow.querySelectorAll('.gr-cal-stat-value')[1].textContent).toBe(`≈ ${(report.meanErrorYPx / 20).toFixed(1)}`);
    expect(events.at(-1)).toEqual({ phase: 'done', report });
    expect(model.viewport).toEqual({ width: VW, height: VH });

    const p = model.predict(eyeFeatures({ x: 300, y: 500 }, rng(99), [], 0));
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.x - 300, p!.y - 500)).toBeLessThan(25);

    // Hidden, unsubscribed, keyboard released.
    expect(root.hidden).toBe(true);
    expect(src.listenerCount).toBe(0);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    key(' ');
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', seen);
    ctx.sim.stop();
    overlay.destroy();
  });

  it('Esc cancels: resolves null and emits cancelled', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    await expect(done).resolves.toBeNull();
    expect(ctx.events.at(-1)).toEqual({ phase: 'cancelled' });
    expect(ctx.events.some((ev) => ev.phase === 'done')).toBe(false);
    expect(ctx.root.hidden).toBe(true);
    expect(ctx.src.listenerCount).toBe(0);
    ctx.sim.stop();
  });

  it('is modal: keys never reach the page behind it', async () => {
    const ctx = setup();
    const pageShortcut = vi.fn();
    window.addEventListener('keydown', pageShortcut);
    document.body.addEventListener('keydown', pageShortcut);
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    key(' ', document.body);
    key('d', document.body);
    key('PageDown', window);
    expect(pageShortcut).not.toHaveBeenCalled();
    ctx.overlay.cancel();
    await done;
    window.removeEventListener('keydown', pageShortcut);
    ctx.sim.stop();
  });

  it('Space pauses and resumes; nothing progresses while paused', async () => {
    const ctx = setup();
    const { events, q, root } = ctx;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(2500);

    const e = key(' ');
    expect(e.defaultPrevented).toBe(true);
    const paused = events.at(-1)!;
    expect(paused).toMatchObject({ phase: 'point', message: 'paused' });
    expect(q('.gr-cal-pause').closest('[hidden]')).toBeNull();
    expect(root.dataset.paused).toBe('user');

    const before = events.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.length).toBe(before); // a deliberate pause never auto-resumes

    key(' ');
    expect(events.at(-1)).toMatchObject({ phase: 'point', index: paused.index, message: 'resumed' });
    expect(q('.gr-cal-pause').hidden).toBe(true);

    await advanceUntil(() => root.dataset.phase === 'results', 120_000, 250);
    const indices = events.filter((ev) => ev.phase === 'point' && ev.message === undefined).map((ev) => ev.index);
    expect(indices).toEqual([...STANDARD_TARGETS.keys()]); // the interrupted target was shown again, not skipped
    ctx.overlay.cancel();
    await expect(done).resolves.toBeNull();
    ctx.sim.stop();
  });

  it('a tap on the screen pauses too (no keyboard on a tablet), and the pause card resumes or cancels', async () => {
    const ctx = setup();
    const { events, q, root } = ctx;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(1200);
    q('.gr-cal-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
    expect(root.dataset.paused).toBe('user');
    expect(events.at(-1)).toMatchObject({ phase: 'point', message: 'paused' });
    q<HTMLButtonElement>('.gr-cal-pause [data-action="continue"]').click();
    expect(root.dataset.paused).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ phase: 'point', message: 'resumed' });

    q('.gr-cal-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 2 }));
    expect(root.dataset.paused).toBeUndefined(); // a right-click is not a tap

    q('.gr-cal-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
    q<HTMLButtonElement>('.gr-cal-pause [data-action="cancel"]').click();
    await expect(done).resolves.toBeNull();
    expect(events.at(-1)).toEqual({ phase: 'cancelled' });
    ctx.sim.stop();
  });

  it('repeats a target that collected too few samples', async () => {
    const ctx = setup();
    ctx.sim.reader.closeEyes = (index, attempt) => index === 2 && attempt === 0;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    const third = ctx.events.filter((e) => e.phase === 'point' && e.index === 2);
    expect(third.map((e) => e.message)).toEqual([undefined, 'retry']);
    expect(ctx.events.some((e) => e.message === 'face-lost')).toBe(false);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    expect(result?.report.quality).toBe('excellent');
    ctx.sim.stop();
  });

  it('keeps lowered lids on the low targets (same blink rule as the live gaze source) instead of retrying or pausing', async () => {
    const ctx = setup();
    ctx.sim.reader.lidsLowered = (gaze) => gaze.y > VH * 0.6;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    expect(ctx.events.filter((e) => e.message !== undefined)).toEqual([]);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    expect(result?.report.quality).toBe('excellent');
    // The low check points were measured too.
    expect(result!.report.perPoint.filter((p) => p.target.y > VH * 0.6)).toHaveLength(2);
    ctx.sim.stop();
  });

  it('still treats a real blink as a blink', async () => {
    const ctx = setup();
    // Eyes shut for a whole target, but with a moderate score: the collapsed lid aperture gives it away.
    ctx.sim.reader.closeEyes = (index, attempt) => index === 1 && attempt === 0;
    const push = ctx.src.push.bind(ctx.src);
    ctx.src.push = (frame) => {
      const f = frame.features;
      if (f && f.blink >= 0.9) push({ ...frame, features: { ...f, blink: 0.7, openness: 0.03 } });
      else push(frame);
    };
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.events.filter((e) => e.phase === 'point').length >= 3, 30_000, 100);
    expect(ctx.events.filter((e) => e.phase === 'point' && e.index === 1).map((e) => e.message)).toEqual([undefined, 'retry']);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('auto-pauses when the face disappears and picks up when it returns', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    ctx.sim.reader.faceFound = false;
    await vi.advanceTimersByTimeAsync(2600);
    expect(ctx.events.at(-1)).toMatchObject({ message: 'face-lost' });
    expect(ctx.root.dataset.paused).toBe('face');
    expect(ctx.q('.gr-cal-pause').textContent).toMatch(/lost sight/);

    ctx.sim.reader.faceFound = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.events.at(-1)).toMatchObject({ message: 'resumed' });
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    expect(await done).not.toBeNull();
    ctx.sim.stop();
  });

  it('fails gracefully when too few targets succeed, and can be cancelled from there', async () => {
    // 4 Hz frames → ~4 samples per target, below the minimum of 8.
    const ctx = setup({ timing: { maxAttempts: 1 } }, 250);
    const done = ctx.overlay.run();
    const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
    await advanceUntil(() => !start.disabled, 5000);
    start.click();
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    const failed = ctx.events.find((e) => e.phase === 'failed');
    expect(failed?.message).toMatch(/steady look/);
    expect(ctx.shadow.activeElement).toBe(ctx.q('[data-action="retry"]'));
    expect(ctx.events.some((e) => e.phase === 'training')).toBe(false);

    ctx.shadow.querySelector<HTMLButtonElement>('.gr-cal-center:not([hidden]) [data-action="cancel"]')!.click();
    await expect(done).resolves.toBeNull();
    expect(ctx.events.at(-1)).toEqual({ phase: 'cancelled' });
    ctx.sim.stop();
  });

  it('"Try again" after a failure goes back to positioning', async () => {
    const ctx = setup({ timing: { maxAttempts: 1 } }, 250);
    const done = ctx.overlay.run();
    const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
    await advanceUntil(() => !start.disabled, 5000);
    start.click();
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    ctx.q<HTMLButtonElement>('[data-action="retry"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.phase).toBe('positioning');
    expect(ctx.events.filter((e) => e.phase === 'positioning')).toHaveLength(2);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('CalibrationOverlay — quick mode', () => {
  it('refines a saved model from 5 points without a validation pass', async () => {
    // Yesterday's full calibration…
    const r = rng(5);
    const baseSamples = STANDARD_TARGETS.flatMap((f) =>
      Array.from({ length: 30 }, (_, i) => {
        const target = { x: f.x * VW, y: f.y * VH };
        return { target, features: eyeFeatures(target, r), t: i };
      }),
    );
    const base = trainGazeModel(baseSamples, { viewport: { width: VW, height: VH } }).model;

    // …and today the reader sits a little differently.
    const shift = [0.015, -0.012, 0.004, 0.04, -0.006];
    const ctx = setup({ mode: 'quick', baseModel: base });
    ctx.sim.reader.shift = shift;
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/5 dots/);
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);

    const points = ctx.events.filter((e) => e.phase === 'point');
    expect(points.map((e) => e.index)).toEqual([...QUICK_TARGETS.keys()]);
    expect(points.every((e) => e.total === QUICK_TARGETS.length)).toBe(true);
    expect(ctx.events.some((e) => e.phase === 'validating')).toBe(false);

    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    expect(result).not.toBeNull();
    const r2 = rng(6);
    const today = [
      { x: 256, y: 170 },
      { x: 768, y: 600 },
      { x: 512, y: 384 },
    ].flatMap((target) => Array.from({ length: 20 }, (_, i) => ({ target, features: eyeFeatures(target, r2, shift), t: i })));
    const before = evaluateModel(base, today).meanErrorPx;
    const after = evaluateModel(result!.model, today).meanErrorPx;
    expect(after).toBeLessThan(before / 2);
    expect(result!.model.toJSON()).toMatchObject({ version: 1 });
    ctx.sim.stop();
  });

  it('offers a full calibration when the saved model cannot be tuned up', async () => {
    const r = rng(8);
    const baseSamples = STANDARD_TARGETS.flatMap((f) =>
      Array.from({ length: 30 }, (_, i) => {
        const target = { x: f.x * VW, y: f.y * VH };
        return { target, features: eyeFeatures(target, r), t: i };
      }),
    );
    const base = trainGazeModel(baseSamples, { viewport: { width: VW, height: VH } }).model;
    const ctx = setup({ mode: 'quick', baseModel: base });
    ctx.sim.reader.shift = [1, 1, 1, 1, 1]; // eyes nothing like the saved calibration: every prediction is rejected
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    const retry = ctx.q<HTMLButtonElement>('[data-action="retry"]');
    expect(retry.textContent).toBe('Full calibration');
    expect(ctx.q('.gr-cal-failed-text').textContent).toMatch(/full calibration/);

    ctx.sim.reader.shift = [];
    retry.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/13 dots/);
    const before = ctx.events.length;
    await startCalibration(ctx);
    expect(ctx.events.slice(before).find((e) => e.phase === 'point')?.total).toBe(STANDARD_TARGETS.length);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('falls back to the full grid without a usable base model', async () => {
    const ctx = setup({ mode: 'quick', baseModel: null });
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/13 dots/);
    await startCalibration(ctx);
    expect(ctx.events.find((e) => e.phase === 'point')?.total).toBe(STANDARD_TARGETS.length);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('CalibrationOverlay — positioning coach', () => {
  it('coaches distance and direction from the live features', async () => {
    const ctx = setup();
    const { sim, q } = ctx;
    const done = ctx.overlay.run();
    const text = (): string => q('.gr-cal-status-text').textContent ?? '';
    const start = q<HTMLButtonElement>('[data-action="start"]');

    sim.reader.faceScale = 0.04;
    await vi.advanceTimersByTimeAsync(800);
    expect(text()).toMatch(/closer/);
    expect(start.disabled).toBe(true);
    expect(q('[data-state="bad"].gr-cal-check').textContent).toMatch(/Distance/);

    sim.reader.faceScale = 0.12;
    sim.reader.faceCenter = { x: 0.85, y: 0.45 }; // image-right = the reader's left
    await vi.advanceTimersByTimeAsync(800);
    expect(text()).toMatch(/to your right/);

    sim.reader.faceFound = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(text()).toMatch(/can’t see your face/);

    // With a face in view but an unresolved issue, "Start anyway" appears after a while.
    sim.reader.faceFound = true;
    await vi.advanceTimersByTimeAsync(8000);
    expect(start.disabled).toBe(false);
    expect(start.textContent).toBe('Start anyway');

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('waits patiently for a camera that sends nothing', async () => {
    const ctx = setup();
    ctx.sim.stop();
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-status-text').textContent).toMatch(/Waiting for the camera/);
    await vi.advanceTimersByTimeAsync(6000);
    expect(ctx.q('.gr-cal-status-text').textContent).toMatch(/another app/);
    expect(ctx.q<HTMLButtonElement>('[data-action="start"]').disabled).toBe(true);
    key('Escape');
    await expect(done).resolves.toBeNull();
  });
});

describe('CalibrationOverlay — lifecycle', () => {
  it('destroy() mid-run resolves null and removes every trace', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    ctx.overlay.destroy();
    expect(ctx.shadow.querySelector('.gr-cal')).toBeNull();
    expect(ctx.src.listenerCount).toBe(0);
    await expect(done).resolves.toBeNull();
    expect(ctx.events.at(-1)).toEqual({ phase: 'cancelled' });
    expect(vi.getTimerCount()).toBe(1); // only the simulated reader's interval is left
    ctx.sim.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => key('Escape')).not.toThrow();
    await expect(ctx.overlay.run()).resolves.toBeNull();
    ctx.overlay.destroy(); // idempotent
  });

  it('run() is idempotent while running and restartable after cancel', async () => {
    const ctx = setup();
    const a = ctx.overlay.run();
    expect(ctx.overlay.run()).toBe(a);
    expect(ctx.overlay.running).toBe(true);
    ctx.overlay.cancel();
    const b = ctx.overlay.run(); // requested while the first run is still unwinding
    await expect(a).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.hidden).toBe(false);
    expect(ctx.root.dataset.phase).toBe('positioning');
    expect(ctx.events.filter((e) => e.phase === 'start')).toHaveLength(2);
    ctx.overlay.cancel();
    await expect(b).resolves.toBeNull();
    expect(ctx.overlay.running).toBe(false);
    ctx.sim.stop();
  });

  it('a broken feature source fails the run cleanly instead of wedging it', async () => {
    const bus = createEventBus();
    const events: CalEvent[] = [];
    bus.on('calibration', (e) => events.push(e));
    const broken = new FakeSource();
    broken.onFrame = () => {
      throw new Error('port disconnected');
    };
    const overlay = new CalibrationOverlay({ features: broken, bus });
    overlay.mount(document.body);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(overlay.run()).resolves.toBeNull();
    errors.mockRestore();
    expect(events).toEqual([{ phase: 'failed', message: 'port disconnected' }]);
    expect(overlay.running).toBe(false);
    expect(document.querySelector<HTMLElement>('.gr-cal')?.hidden).toBe(true);
    overlay.destroy();
  });

  it('works mounted straight into the document and keeps focus inside', async () => {
    const bus = createEventBus();
    const src = new FakeSource();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const overlay = new CalibrationOverlay({ features: src, bus });
    overlay.mount(document.body);
    const sim = simulateReader(src, document, bus);
    const done = overlay.run();
    const root = document.querySelector<HTMLElement>('.gr-cal')!;
    expect(document.activeElement).toBe(root);

    await advanceUntil(() => !document.querySelector<HTMLButtonElement>('[data-action="start"]')!.disabled, 5000);
    // Tab cycles only through the overlay's visible buttons.
    const visible = [...root.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.closest('[hidden]') && !b.disabled);
    expect(visible.map((b) => b.dataset.action)).toEqual(['cancel', 'start']);
    for (let i = 0; i < 4; i++) {
      key('Tab');
      expect(visible).toContain(document.activeElement);
    }
    key('Escape');
    await expect(done).resolves.toBeNull();
    expect(document.activeElement).toBe(outside); // focus handed back
    overlay.destroy();
    sim.stop();
  });
});

describe('CalibrationOverlay — keyboard', () => {
  it('inside a closed shadow root (the extension), Enter and Space on a focused button belong to the button', async () => {
    const bus = createEventBus();
    const events: CalEvent[] = [];
    bus.on('calibration', (e) => events.push(e));
    const src = new FakeSource();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const overlay = new CalibrationOverlay({ features: src, bus, random: rng(3) });
    overlay.mount(shadow);
    const sim = simulateReader(src, shadow, bus);
    const root = shadow.querySelector<HTMLElement>('.gr-cal')!;
    const visible = (action: string): HTMLButtonElement =>
      shadow.querySelector<HTMLButtonElement>(`.gr-cal-center:not([hidden]) [data-action="${action}"]`)!;
    const done = overlay.run();
    const start = shadow.querySelector<HTMLButtonElement>('[data-action="start"]')!;
    await advanceUntil(() => !start.disabled, 5000);

    // Enter on the focused Cancel button must activate Cancel, not start the calibration.
    const cancel = visible('cancel');
    cancel.focus();
    const enter = key('Enter', cancel);
    expect(enter.defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(root.dataset.phase).toBe('positioning');

    // Enter anywhere else starts.
    root.focus();
    key('Enter', root);
    await advanceUntil(() => root.dataset.phase === 'targets', 2000, 20);

    // Pause, then Space on the pause card's Cancel button is that button's, not a resume.
    key(' ', root);
    expect(root.dataset.paused).toBe('user');
    const pauseCancel = shadow.querySelector<HTMLButtonElement>('.gr-cal-pause [data-action="cancel"]')!;
    pauseCancel.focus();
    const space = key(' ', pauseCancel);
    expect(space.defaultPrevented).toBe(false);
    expect(root.dataset.paused).toBe('user');
    expect(events.at(-1)?.message).toBe('paused');

    overlay.cancel();
    await expect(done).resolves.toBeNull();
    overlay.destroy();
    sim.stop();
  });

  it('keeps keyboard scrolling from moving the page behind it', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await vi.advanceTimersByTimeAsync(300);
    for (const k of ['PageDown', 'ArrowDown', 'End', ' ', 'Home']) expect(key(k, ctx.root).defaultPrevented).toBe(true);
    expect(key('x', ctx.root).defaultPrevented).toBe(false);

    // A card that overflows a short window may still scroll itself.
    const center = ctx.shadow.querySelector<HTMLElement>('.gr-cal-center:not([hidden])')!;
    Object.defineProperty(center, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(center, 'clientHeight', { configurable: true, value: 400 });
    const cancel = center.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    cancel.focus();
    expect(key('ArrowDown', cancel).defaultPrevented).toBe(false);
    expect(key('PageDown', cancel).defaultPrevented).toBe(false);

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('scrolls an overflowing card so the focused button is on screen', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
    const center = start.closest<HTMLElement>('.gr-cal-center')!;
    // A 400 px tall window: the card's action row sits below the fold.
    let scrollTop = 0;
    Object.defineProperty(center, 'scrollHeight', { configurable: true, value: 640 });
    Object.defineProperty(center, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(center, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    const rect = (top: number, height: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 100, height });
    center.getBoundingClientRect = () => rect(0, 400);
    start.getBoundingClientRect = () => rect(520 - scrollTop, 44);

    await advanceUntil(() => !start.disabled, 5000);
    expect(ctx.shadow.activeElement).toBe(start); // focus moves to Start once it lights up…
    expect(scrollTop).toBeGreaterThanOrEqual(564 - 400); // …and the card scrolls to show it
    expect(start.getBoundingClientRect().bottom).toBeLessThanOrEqual(400);

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('assessPosition', () => {
  const good: PositionMetrics = {
    faceFound: true,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
    yaw: 0,
    pitch: 0,
    quality: 0.9,
    brightness: 0.5,
  };

  it('is happy with a well-placed face', () => {
    expect(assessPosition(good)).toEqual({ issue: null, checks: { face: true, distance: true, center: true, light: true } });
  });

  it('gives directions from the reader’s point of view (the image is not mirrored)', () => {
    expect(assessPosition({ ...good, faceCenter: { x: 0.8, y: 0.45 } }).issue).toBe('move-right');
    expect(assessPosition({ ...good, faceCenter: { x: 0.2, y: 0.45 } }).issue).toBe('move-left');
    expect(assessPosition({ ...good, faceCenter: { x: 0.5, y: 0.1 } }).issue).toBe('move-down');
    expect(assessPosition({ ...good, faceCenter: { x: 0.5, y: 0.85 } }).issue).toBe('move-up');
  });

  it('prioritizes the most fundamental problem', () => {
    const t = DEFAULT_POSITION_THRESHOLDS;
    expect(assessPosition({ ...good, faceScale: t.minFaceScale / 2 }).issue).toBe('too-far');
    expect(assessPosition({ ...good, faceScale: t.maxFaceScale * 1.5 }).issue).toBe('too-close');
    expect(assessPosition({ ...good, yaw: 0.6, faceScale: 0.03 }).issue).toBe('not-facing');
    expect(assessPosition({ ...good, brightness: 0.05 }).issue).toBe('too-dark');
    expect(assessPosition({ ...good, brightness: null, quality: 0.2 }).issue).toBe('unsteady');
    expect(assessPosition({ ...good, brightness: 0.05, faceCenter: { x: 0.9, y: 0.45 } }).issue).toBe('move-right');
    const both = assessPosition({ ...good, faceScale: 0.03, brightness: 0.05 });
    expect(both.checks).toEqual({ face: true, distance: false, center: true, light: false });
  });

  it('treats missing or non-finite data as no face', () => {
    expect(assessPosition({ ...good, faceFound: false }).issue).toBe('no-face');
    expect(assessPosition({ ...good, faceScale: Number.NaN }).issue).toBe('no-face');
    expect(assessPosition({ ...good, faceCenter: { x: Infinity, y: 0.5 } }).checks.face).toBe(false);
  });
});
