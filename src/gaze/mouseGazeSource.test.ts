// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GazeSample } from '../types';
import { MouseGazeSource, type MouseGazeSourceOptions } from './mouseGazeSource';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const move = (x: number, y: number, type: 'mousemove' | 'pointermove' = 'mousemove'): void => {
  const Ctor = type === 'pointermove' ? PointerEvent : MouseEvent;
  window.dispatchEvent(new Ctor(type, { clientX: x, clientY: y }));
};
const leaveWindow = (): void => {
  document.documentElement.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
};

function start(opts: MouseGazeSourceOptions = {}) {
  const src = new MouseGazeSource({ random: mulberry32(7), ...opts });
  const samples: GazeSample[] = [];
  src.onSample((s) => samples.push(s));
  void src.start();
  return { src, samples, since: (i: number) => samples.slice(i) };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

let active: MouseGazeSource[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  active = [];
});

afterEach(() => {
  for (const s of active) s.stop();
  vi.useRealTimers();
});

const track = <T extends { src: MouseGazeSource }>(h: T): T => {
  active.push(h.src);
  return h;
};

describe('MouseGazeSource', () => {
  it('is invalid until the pointer moves, then follows it exactly with no noise', () => {
    const h = track(start({ noisePx: () => 0 }));
    expect(h.src.kind).toBe('mouse');
    expect(h.src.running).toBe(true);

    vi.advanceTimersByTime(200);
    expect(h.samples.length).toBeGreaterThan(0);
    expect(h.samples.every((s) => !s.valid && s.confidence === 0)).toBe(true);
    expect(h.samples.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true);

    const n = h.samples.length;
    move(120, 340);
    vi.advanceTimersByTime(200);
    const after = h.since(n);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(s).toMatchObject({ valid: true, confidence: 1, x: 120, y: 340, rawX: 120, rawY: 340, source: 'mouse' });

    move(400, 90, 'pointermove');
    vi.advanceTimersByTime(100);
    expect(h.samples.at(-1)).toMatchObject({ x: 400, y: 90, valid: true });
  });

  it('emits at the requested rate with increasing timestamps', () => {
    const h = track(start({ hz: 30 }));
    move(10, 10);
    vi.advanceTimersByTime(1000);
    expect(h.samples.length).toBeGreaterThanOrEqual(29);
    expect(h.samples.length).toBeLessThanOrEqual(31);
    const ts = h.samples.map((s) => s.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);

    const fast = track(start({ hz: 60 }));
    vi.advanceTimersByTime(1000);
    expect(fast.samples.length).toBeGreaterThanOrEqual(59);
  });

  it('becomes invalid when the pointer leaves the window and recovers on the next move', () => {
    const h = track(start());
    move(300, 200);
    vi.advanceTimersByTime(100);
    const last = h.samples.at(-1);
    expect(last?.valid).toBe(true);

    // Moving between elements keeps it valid; leaving the document does not.
    document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.documentElement }));
    vi.advanceTimersByTime(100);
    expect(h.samples.at(-1)?.valid).toBe(true);

    leaveWindow();
    const n = h.samples.length;
    vi.advanceTimersByTime(200);
    for (const s of h.since(n)) expect(s).toMatchObject({ valid: false, x: last?.x, y: last?.y });

    move(310, 210);
    vi.advanceTimersByTime(100);
    expect(h.samples.at(-1)).toMatchObject({ valid: true, rawX: 310, rawY: 210 });
  });

  it('adds Gaussian noise whose spread matches noisePx, then smooths it', () => {
    const sigma = 25;
    const h = track(start({ noisePx: () => sigma }));
    move(500, 400);
    vi.advanceTimersByTime(100_000); // ~3000 samples
    const s = h.samples.filter((x) => x.valid);
    expect(s.length).toBeGreaterThan(2900);

    const dx = s.map((x) => x.rawX - 500);
    const dy = s.map((x) => x.rawY - 400);
    expect(std(dx)).toBeGreaterThan(sigma * 0.94);
    expect(std(dx)).toBeLessThan(sigma * 1.06);
    expect(std(dy)).toBeGreaterThan(sigma * 0.94);
    expect(std(dy)).toBeLessThan(sigma * 1.06);
    expect(Math.abs(mean(dx))).toBeLessThan(2);
    expect(Math.abs(mean(dy))).toBeLessThan(2);
    // x and y noise are independent.
    const r = mean(dx.map((v, i) => v * dy[i])) / (std(dx) * std(dy));
    expect(Math.abs(r)).toBeLessThan(0.07);
    // Roughly Gaussian: ~68 % within one σ.
    const within = dx.filter((v) => Math.abs(v) < sigma).length / dx.length;
    expect(within).toBeGreaterThan(0.64);
    expect(within).toBeLessThan(0.72);

    expect(std(s.map((x) => x.x - 500))).toBeLessThan(std(dx) * 0.6);
  });

  it('reads noisePx live', () => {
    let sigma = 0;
    const h = track(start({ noisePx: () => sigma }));
    move(50, 60);
    vi.advanceTimersByTime(300);
    expect(h.samples.at(-1)?.rawX).toBe(50);
    sigma = 40;
    const n = h.samples.length;
    vi.advanceTimersByTime(1000);
    expect(h.since(n).some((x) => x.rawX !== 50)).toBe(true);
  });

  it('survives a degenerate random generator', () => {
    const h = track(start({ noisePx: () => 10, random: () => 0 }));
    move(5, 5);
    vi.advanceTimersByTime(300);
    const s = h.samples.filter((x) => x.valid);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => Number.isFinite(x.x) && Number.isFinite(x.rawY))).toBe(true);
  });

  it('stops cleanly: no samples, no listeners, and a restart waits for a fresh move', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const h = track(start());
    await h.src.start(); // idempotent
    move(10, 20);
    vi.advanceTimersByTime(100);
    h.src.stop();
    expect(h.src.running).toBe(false);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);

    const n = h.samples.length;
    vi.advanceTimersByTime(1000);
    expect(h.samples.length).toBe(n);

    await h.src.start();
    vi.advanceTimersByTime(100);
    expect(h.since(n).every((s) => !s.valid)).toBe(true);
    // One interval only, even after start() twice.
    const m = h.samples.length;
    vi.advanceTimersByTime(1000);
    expect(h.samples.length - m).toBeLessThanOrEqual(31);
  });

  it('isolates a throwing listener', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = track(start());
    h.src.onSample(() => {
      throw new Error('boom');
    });
    vi.advanceTimersByTime(100);
    expect(h.samples.length).toBeGreaterThan(0);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
