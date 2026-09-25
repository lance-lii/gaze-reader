import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GazeSample, LineLayout } from '../types';
import { SimulatedReaderSource, gaussian, mulberry32, simulateReading } from './simulatedReader';
import { lastFullyVisibleIndex, makeDocument, makeReadingPage } from './testLayouts';

describe('PRNG', () => {
  it('is deterministic and uniform-ish', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5000 }, () => a());
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
  });

  it('draws standard normal deviates', () => {
    const rng = mulberry32(7);
    const zs = Array.from({ length: 20000 }, () => gaussian(rng));
    const mean = zs.reduce((s, z) => s + z, 0) / zs.length;
    const sd = Math.sqrt(zs.reduce((s, z) => s + (z - mean) ** 2, 0) / zs.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeGreaterThan(0.97);
    expect(sd).toBeLessThan(1.03);
  });
});

describe('simulateReading', () => {
  const layout = makeReadingPage(3);
  const L = lastFullyVisibleIndex(layout);

  it('reads every line in order, then lingers on the last one', () => {
    const sim = simulateReading(layout, { seed: 3, lingerMs: 2000 });
    expect(sim.truth).toHaveLength(sim.samples.length);
    const visited = [...new Set(sim.truth.map((x) => x.lineIndex))];
    expect(visited).toEqual(Array.from({ length: L + 1 }, (_, i) => i));
    for (let i = 1; i < sim.truth.length; i++) expect(sim.truth[i]!.lineIndex).toBeGreaterThanOrEqual(sim.truth[i - 1]!.lineIndex);
    const after = sim.truth.filter((x) => x.t > sim.lastLineEndT);
    expect(after.every((x) => x.lineIndex === L)).toBe(true);
    expect(sim.samples.at(-1)!.t - sim.lastLineEndT).toBeGreaterThanOrEqual(2000);
    expect(sim.samples.at(-1)!.t - sim.lastLineEndT).toBeLessThan(2100);
  });

  it('samples at the requested rate and is deterministic per seed', () => {
    const a = simulateReading(layout, { seed: 9, hz: 60, noisePx: 20, driftPx: 15, lingerMs: 500 });
    const b = simulateReading(layout, { seed: 9, hz: 60, noisePx: 20, driftPx: 15, lingerMs: 500 });
    expect(a).toEqual(b);
    const dts = a.samples.slice(1).map((s, i) => s.t - a.samples[i]!.t);
    expect(Math.min(...dts)).toBeGreaterThan(1000 / 60 - 2);
    expect(Math.max(...dts)).toBeLessThan(1000 / 60 + 2);
    expect(a.samples.every((s) => s.source === 'simulated' && s.valid)).toBe(true);
    const c = simulateReading(layout, { seed: 10, hz: 60, noisePx: 20, lingerMs: 500 });
    expect(c.samples[40]!.x).not.toBe(a.samples[40]!.x);
  });

  it('reads at about the requested speed', () => {
    for (const wpm of [200, 260, 350]) {
      let chars = 0;
      let ms = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const page = makeReadingPage(seed);
        const sim = simulateReading(page, { seed, wpm, lingerMs: 0 });
        chars += page.lines.filter((l) => l.fullyVisible).reduce((s, l) => s + l.charCount, 0);
        ms += sim.lastLineEndT - sim.samples[0]!.t;
      }
      const measured = chars / 6 / (ms / 60_000);
      expect(measured).toBeGreaterThan(0.88 * wpm);
      expect(measured).toBeLessThan(1.12 * wpm);
    }
  });

  it('adds noise and drift to the raw signal and smooths it', () => {
    const clean = simulateReading(layout, { seed: 4, lingerMs: 0 });
    const noisy = simulateReading(layout, { seed: 4, noisePx: 30, lingerMs: 0 });
    const n = Math.min(clean.samples.length, noisy.samples.length);
    let raw = 0;
    let smooth = 0;
    for (let i = 0; i < n; i++) {
      raw += (noisy.samples[i]!.rawY - clean.samples[i]!.rawY) ** 2;
      smooth += (noisy.samples[i]!.y - clean.samples[i]!.y) ** 2;
    }
    const rawSd = Math.sqrt(raw / n);
    expect(rawSd).toBeGreaterThan(26);
    expect(rawSd).toBeLessThan(34);
    expect(Math.sqrt(smooth / n)).toBeLessThan(0.6 * rawSd);

    const drifted = simulateReading(layout, { seed: 4, driftPx: 20, driftOnset: 'immediate', lingerMs: 0 });
    const offsets = drifted.samples.slice(0, 200).map((s, i) => s.rawY - clean.samples[i]!.rawY);
    const meanOffset = offsets.reduce((s, v) => s + v, 0) / offsets.length;
    expect(Math.abs(meanOffset)).toBeGreaterThan(12);
    expect(Math.abs(meanOffset)).toBeLessThanOrEqual(20);
  });

  it('blinks: short runs of invalid samples', () => {
    const sim = simulateReading(layout, { seed: 5, blinksPerMin: 20, lingerMs: 0 });
    const invalid = sim.samples.filter((s) => !s.valid);
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid.every((s) => s.confidence === 0)).toBe(true);
    let run = 0;
    let longest = 0;
    for (const s of sim.samples) {
      run = s.valid ? 0 : run + 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(9); // ≤ 250 ms at 30 Hz
  });

  it('falls back to defaults for unusable numeric options instead of producing nothing or NaN', () => {
    const base = simulateReading(layout, { seed: 6, lingerMs: 500 });
    for (const bad of [NaN, Infinity, -5]) {
      const sim = simulateReading(layout, { seed: 6, wpm: bad, hz: bad, lingerMs: bad, t0: bad, noisePx: bad, driftPx: bad, wanderPx: bad, blinksPerMin: bad });
      expect(sim.samples.length, `option value ${bad}`).toBeGreaterThan(100);
      expect(sim.samples.every((s) => Number.isFinite(s.t) && (!s.valid || (Number.isFinite(s.x) && Number.isFinite(s.y))))).toBe(true);
      expect(Number.isFinite(sim.lastLineEndT)).toBe(true);
    }
    expect(base.samples.length).toBeGreaterThan(100);
  });

  it('honours startLine/endLine and handles layouts without visible text', () => {
    const sim = simulateReading(layout, { seed: 2, startLine: 5, endLine: 8, lingerMs: 300 });
    const lines = new Set(sim.truth.map((x) => x.lineIndex));
    expect([...lines].sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
    const empty = simulateReading(makeDocument({ lines: 0 }).layoutAt(0), {});
    expect(empty.samples).toEqual([]);
  });
});

describe('SimulatedReaderSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const doc = makeDocument({ lines: 80, seed: 11 });
  const viewport = { left: 0, top: 0, right: 1024, bottom: 12.5 * 42 };

  it('emits samples at ~30 Hz while running, and nothing after stop()', async () => {
    const layout = doc.layoutAt(0, { viewport });
    const src = new SimulatedReaderSource({ getLayout: () => layout, seed: 1 });
    expect(src.kind).toBe('simulated');
    const got: GazeSample[] = [];
    const off = src.onSample((s) => got.push(s));
    await src.start();
    await src.start(); // idempotent
    expect(src.running).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(got.length).toBeGreaterThanOrEqual(58);
    expect(got.length).toBeLessThanOrEqual(62);
    expect(got.every((s) => s.valid && s.source === 'simulated')).toBe(true);
    src.stop();
    expect(src.running).toBe(false);
    const n = got.length;
    vi.advanceTimersByTime(2000);
    expect(got.length).toBe(n);
    // Restart, then unsubscribe.
    await src.start();
    vi.advanceTimersByTime(500);
    expect(got.length).toBeGreaterThan(n);
    off();
    const m = got.length;
    vi.advanceTimersByTime(500);
    expect(got.length).toBe(m);
    src.stop();
  });

  it('survives rapid start/stop and a listener that throws or stops the source', async () => {
    const layout = doc.layoutAt(0, { viewport });
    const src = new SimulatedReaderSource({ getLayout: () => layout });
    for (let i = 0; i < 5; i++) {
      void src.start();
      src.stop();
    }
    const got: number[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    src.onSample(() => {
      throw new Error('boom');
    });
    src.onSample((s) => got.push(s.t));
    await src.start();
    vi.advanceTimersByTime(300);
    expect(got.length).toBeGreaterThan(5);
    expect(errors).toHaveBeenCalled();
    src.onSample(() => src.stop());
    vi.advanceTimersByTime(300);
    const n = got.length;
    vi.advanceTimersByTime(1000);
    expect(got.length).toBe(n);
    errors.mockRestore();
  });

  it('never emits a valid sample with non-finite coordinates, whatever the options', async () => {
    const layout = doc.layoutAt(0, { viewport });
    const src = new SimulatedReaderSource({ getLayout: () => layout, noisePx: NaN, driftPx: NaN, wanderPx: NaN, hz: NaN, blinksPerMin: NaN, wpm: () => NaN });
    const got: GazeSample[] = [];
    src.onSample((s) => got.push(s));
    await src.start();
    vi.advanceTimersByTime(1000);
    src.stop();
    expect(got.length).toBeGreaterThan(20);
    expect(got.every((s) => !s.valid || (Number.isFinite(s.x) && Number.isFinite(s.y)))).toBe(true);
    expect(got.some((s) => s.valid)).toBe(true);
  });

  it('emits invalid samples while there is nothing to read', async () => {
    let layout: LineLayout | null = null;
    const src = new SimulatedReaderSource({ getLayout: () => layout });
    const got: GazeSample[] = [];
    src.onSample((s) => got.push(s));
    await src.start();
    vi.advanceTimersByTime(500);
    expect(got.length).toBeGreaterThan(10);
    expect(got.every((s) => !s.valid)).toBe(true);
    expect(src.state.mode).toBe('idle');
    layout = doc.layoutAt(0, { viewport });
    vi.advanceTimersByTime(500);
    expect(got.at(-1)!.valid).toBe(true);
    expect(src.state.mode).toBe('reading');
    src.stop();
  });

  it('lingers at the end of the page and resumes below the last line read after a scroll', async () => {
    let layout = doc.layoutAt(0, { viewport });
    const L = lastFullyVisibleIndex(layout);
    const src = new SimulatedReaderSource({ getLayout: () => layout, wpm: () => 600, noisePx: 0, driftPx: 0, seed: 3 });
    await src.start();
    vi.advanceTimersByTime(60_000);
    expect(src.state.mode).toBe('lingering');
    expect(src.state.lineDocTop).toBe(layout.lines[L]!.docTop);
    expect(src.state.lastReadDocTop).toBe(layout.lines[L]!.docTop);
    // Turn the page with one line of overlap: the last line read moves to the top.
    const lastRead = layout.lines[L]!;
    layout = doc.layoutAt(lastRead.docTop - 0.35 * layout.linePitch, { viewport });
    vi.advanceTimersByTime(100);
    expect(src.state.mode).toBe('reading');
    const resumed = layout.lines.find((l) => l.docTop === src.state.lineDocTop)!;
    expect(resumed.fullyVisible).toBe(true);
    expect(resumed.docTop).toBeGreaterThan(lastRead.docTop);
    expect(layout.lines.filter((l) => l.fullyVisible && l.docTop > lastRead.docTop)[0]).toBe(resumed);
    src.stop();
  });

  it('picks up where it left off after stop() and start(), without reading the paused time', async () => {
    const tall = { ...viewport, bottom: 30.5 * 42 };
    const layout = doc.layoutAt(0, { viewport: tall });
    const src = new SimulatedReaderSource({ getLayout: () => layout, seed: 2 });
    const got: GazeSample[] = [];
    src.onSample((s) => got.push(s));
    await src.start();
    vi.advanceTimersByTime(3000);
    src.stop();
    const before = src.state;
    const lastBefore = got.at(-1)!;
    vi.advanceTimersByTime(30_000);
    await src.start();
    vi.advanceTimersByTime(100);
    // Unprotected, the first tick replayed 30 s of reading (~13 lines) at once.
    expect(src.state.linesRead - before.linesRead).toBeLessThanOrEqual(1);
    const firstAfter = got.find((s) => s.t > lastBefore.t + 1000)!;
    expect(Math.abs(firstAfter.x - lastBefore.x)).toBeLessThan(300);
    src.stop();
  });

  it('pauses instead of racing ahead when its timer was throttled', async () => {
    const layout = doc.layoutAt(0, { viewport });
    const src = new SimulatedReaderSource({ getLayout: () => layout, seed: 2 });
    await src.start();
    vi.advanceTimersByTime(1000);
    const before = src.state.linesRead;
    // A hidden tab: a minute passes between two ticks. Unprotected, the reader would read ~25 lines at once.
    const now = performance.now.bind(performance);
    const jump = vi.spyOn(performance, 'now').mockImplementation(() => now() + 60_000);
    vi.advanceTimersByTime(200);
    expect(src.state.linesRead - before).toBeLessThanOrEqual(1);
    jump.mockRestore();
    src.stop();
  });
});
