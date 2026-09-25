import { describe, expect, it } from 'vitest';
import type { GazeSample, LineEstimate, LineLayout, PageEndDecision, SaccadeKind, Sensitivity } from '../types';
import {
  PAGE_END_GUARDS,
  PAGE_END_PRESETS,
  PageEndDetector,
  endProgress,
  lastFullyVisibleLine,
  pageEndZones,
} from './pageEndDetector';
import { mulberry32 } from './simulatedReader';
import { makeDocument } from './testLayouts';

const doc = makeDocument({ lines: 40, paragraphLines: [99, 99], seed: 1 });
const viewport = { left: 0, top: 0, right: 1024, bottom: 20.5 * 42 };
const layout = doc.layoutAt(0, { viewport });
const pitch = layout.linePitch;
const L = lastFullyVisibleLine(layout);
const line = (i: number) => layout.lines[i]!;
const xAt = (i: number, frac: number) => line(i).left + frac * (line(i).right - line(i).left);
const STEP = 33;

function estimate(
  lineIndex: number,
  o: { p?: number; above?: number; fix?: number; sac?: SaccadeKind | null; drift?: number; lay?: LineLayout } = {},
): LineEstimate {
  const posterior = new Array<number>((o.lay ?? layout).lines.length).fill(0);
  const p = o.p ?? 0.9;
  const above = o.above ?? 0;
  posterior[lineIndex] = p;
  if (lineIndex > 0) posterior[lineIndex - 1] = posterior[lineIndex - 1]! + above;
  const rest = Math.max(0, 1 - p - above);
  const restAt = lineIndex >= 2 ? lineIndex - 2 : lineIndex + 1;
  posterior[restAt] = posterior[restAt]! + rest;
  return {
    t: 0,
    lineIndex,
    probability: p,
    posterior,
    progressX: 0,
    lastSaccade: o.sac === undefined ? 'forward' : o.sac,
    driftY: o.drift ?? 0,
    fixationsOnPage: o.fix ?? 10,
  };
}

interface Gaze {
  x: number;
  y: number;
  valid?: boolean;
}

/** Feeds the detector 30 Hz samples and reports the first trigger. */
class Rig {
  t = 1000;
  last: PageEndDecision | null = null;
  constructor(readonly det: PageEndDetector = new PageEndDetector()) {}

  run(ms: number, gaze: Gaze | ((t: number) => Gaze) | null, est: LineEstimate | null, lay: LineLayout | null = layout) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t += STEP;
      const g = typeof gaze === 'function' ? gaze(this.t) : gaze;
      const sample: GazeSample | null = g
        ? { t: this.t, x: g.x, y: g.y, rawX: g.x, rawY: g.y, valid: g.valid ?? true, confidence: 1, source: 'mouse' }
        : null;
      const d = this.det.update({ t: this.t, gaze: sample, estimate: est, layout: lay });
      this.last = d;
      if (d.trigger) return { d, at: this.t };
    }
    return null;
  }

  /**
   * The reader arrives on `lineIndex` with a return sweep and a corrective fixation (the two
   * fixations the detector takes as "the line entered"). Later estimates should use fix ≥ 12.
   */
  enter(lineIndex: number, o: { p?: number; above?: number } = {}): void {
    const g = { x: xAt(lineIndex, 0.1), y: line(lineIndex).centerY };
    expect(this.run(200, g, estimate(lineIndex, { ...o, sac: 'return-sweep', fix: 10 }))).toBeNull();
    expect(this.run(200, g, estimate(lineIndex, { ...o, sac: 'regression', fix: 11 }))).toBeNull();
  }
}

describe('page-end presets and geometry', () => {
  it('uses the thresholds from the spec table', () => {
    expect(PAGE_END_PRESETS).toEqual({
      relaxed: { minPosterior: 0.7, minProgress: 0.85, dwellMs: 600, zoneMs: 1800, glanceMs: 800, cooldownMs: 2200 },
      balanced: { minPosterior: 0.55, minProgress: 0.7, dwellMs: 350, zoneMs: 1200, glanceMs: 600, cooldownMs: 1800 },
      eager: { minPosterior: 0.45, minProgress: 0.55, dwellMs: 200, zoneMs: 800, glanceMs: 450, cooldownMs: 1400 },
    });
    expect(PAGE_END_GUARDS).toEqual({ validityWindowMs: 1000, minValidFraction: 0.6, minFixationsOnPage: 4, minMsSinceTurn: 2500 });
  });

  it('derives the zones from the last fully visible line', () => {
    const z = pageEndZones(layout)!;
    expect(z.lastIndex).toBe(L);
    expect(z.zoneTop).toBeCloseTo(line(L).top - 0.25 * pitch, 9);
    expect(z.zoneLeft).toBeCloseTo(xAt(L, 0.5), 9);
    expect(z.glanceTop).toBeCloseTo(Math.max(viewport.bottom - 0.2 * pitch, line(L).centerY + 0.6 * pitch), 9);
    expect(pageEndZones(null)).toBeNull();
    expect(pageEndZones(makeDocument({ lines: 0 }).layoutAt(0))).toBeNull();
  });

  it('judges progress on short last lines by the words left, not the fraction', () => {
    const full = line(3);
    expect(endProgress(full, xAt(3, 0.5), 700)).toBeCloseTo(0.5, 9);
    const short = { ...full, right: full.left + 120 };
    expect(endProgress(short, short.left + 10, 700)).toBeGreaterThan(0.8);
    expect(endProgress(short, short.right + 50, 700)).toBe(1);
    expect(endProgress(full, NaN, 700)).toBeNaN();
  });
});

describe('PageEndDetector', () => {
  it('fires on the last line once progress has held for the dwell time', () => {
    const rig = new Rig();
    rig.enter(L);
    const start = rig.t;
    const hit = rig.run(2000, { x: xAt(L, 0.8), y: line(L).centerY }, estimate(L, { fix: 12 }));
    expect(hit?.d.reason).toBe('line-tracker');
    expect(hit!.at - start).toBeGreaterThanOrEqual(350);
    expect(hit!.at - start).toBeLessThanOrEqual(350 + 2 * STEP);
    expect(hit!.d.targetLineIndex).toBe(L);
    expect(hit!.d.confidence).toBeGreaterThanOrEqual(0.55);
    expect(hit!.d.detail).toMatch(/line-tracker/);
  });

  it('does not fire while the reader is short of θx', () => {
    const rig = new Rig();
    rig.enter(L);
    // Left half of the line, so the bottom-dwell zone (right half) stays out of it too.
    expect(rig.run(3000, { x: xAt(L, 0.45), y: line(L).centerY }, estimate(L, { fix: 12 }))).toBeNull();
    expect(rig.last!.detail).toMatch(/dwell 0\/350/);
  });

  it('does not restart the dwell for a one-sample dip', () => {
    const rig = new Rig();
    rig.enter(L);
    const on = { x: xAt(L, 0.8), y: line(L).centerY };
    expect(rig.run(8 * STEP, on, estimate(L, { fix: 12 }))).toBeNull();
    expect(rig.run(STEP, { ...on, x: xAt(L, 0.3) }, estimate(L, { fix: 12 }))).toBeNull();
    const dipEnd = rig.t;
    const hit = rig.run(1000, on, estimate(L, { fix: 12 }));
    expect(hit!.at - dipEnd).toBeLessThanOrEqual(6 * STEP);
  });

  it('waits for the reader to enter the last line: a mid-line slide of the tracker is not enough', () => {
    const rig = new Rig();
    rig.enter(L - 1);
    // Vertical noise slides the tracker onto L while the reader is finishing L−1 (no sweep).
    const noisyEnd = { x: xAt(L, 0.85), y: line(L - 1).centerY + 0.4 * pitch };
    expect(rig.run(2500, noisyEnd, estimate(L, { p: 0.8, fix: 12 }))).toBeNull();
    // The reader's sweep into L shows them arriving; now reading to its end turns the page.
    rig.enter(L);
    expect(rig.run(1000, { x: xAt(L, 0.85), y: line(L).centerY }, estimate(L, { fix: 12 }))?.d.reason).toBe('line-tracker');
  });

  it('forgets which line the reader entered when the page scrolls (page back, undo, manual scroll)', () => {
    // Read to the end of a later page...
    const later = doc.layoutAt(15 * pitch, { viewport });
    const Lb = lastFullyVisibleLine(later);
    const at = (lay: LineLayout, i: number, frac: number) => lay.lines[i]!.left + frac * (lay.lines[i]!.right - lay.lines[i]!.left);
    const rig = new Rig();
    const landing = { x: at(later, Lb, 0.1), y: later.lines[Lb]!.centerY };
    expect(rig.run(200, landing, estimate(Lb, { sac: 'return-sweep', fix: 10, lay: later }), later)).toBeNull();
    expect(rig.run(200, landing, estimate(Lb, { sac: 'regression', fix: 11, lay: later }), later)).toBeNull();
    // ...then page back (the extension re-measures with reason 'scroll', so the tracker keeps its
    // last saccade kind). The line entered on the later page lies below this page's last line.
    rig.det.notifyScrolled(rig.t);
    expect(layout.lines[L]!.docTop).toBeLessThan(later.lines[Lb]!.docTop);
    // Vertical noise slides the tracker onto L while the reader is still on L−1: no turn.
    const noisyEnd = { x: xAt(L, 0.85), y: line(L - 1).centerY + 0.4 * pitch };
    expect(rig.run(4000, noisyEnd, estimate(L, { p: 0.8, fix: 12 }))).toBeNull();
    expect(rig.last!.detail).toMatch(/not entered/);
  });

  it('ignores gaze that has left the last line while the tracker has not caught up yet', () => {
    // A short paragraph-final last line: θx (judged by the words left) is met almost anywhere in the column.
    const lines = layout.lines.map((l, i) => (i === L ? { ...l, right: l.left + 150 } : l));
    const shortEnd: LineLayout = { ...layout, lines };
    const rig = new Rig();
    // Mid-page, the reader peeks at the last line (the tracker follows with a jump)...
    rig.run(300, { x: lines[L]!.left + 120, y: line(L).centerY }, estimate(L, { sac: 'jump', fix: 30 }), shortEnd);
    // ...and goes back up to line 9. Until that fixation completes, the tracker still says L.
    expect(rig.run(600, { x: xAt(9, 0.05), y: line(9).centerY }, estimate(L, { sac: 'jump', fix: 30 }), shortEnd)).toBeNull();
    expect(rig.last!.detail).toMatch(/dwell 0\//);
  });

  it('never fires on an invalid sample, even when a guard releases during a blink', () => {
    const rig = new Rig();
    const g = { x: xAt(L, 0.1), y: line(L).centerY };
    rig.run(200, g, estimate(L, { sac: 'return-sweep', fix: 1 }));
    rig.run(200, g, estimate(L, { sac: 'regression', fix: 2 }));
    // The dwell completes while the "read enough" guard (4 fixations or 2.5 s) still holds it back.
    const end = { x: xAt(L, 0.9), y: line(L).centerY };
    expect(rig.run(700, end, estimate(L, { fix: 3 }))).toBeNull();
    // The 4th fixation completes on a blink (a tracking gap ends it): hold until the eyes are back.
    expect(rig.run(STEP, { ...end, valid: false }, estimate(L, { fix: 4 }))).toBeNull();
    expect(rig.last!.detail).toMatch(/gaze invalid/);
    const hit = rig.run(STEP, end, estimate(L, { fix: 4 }));
    expect(hit?.d.reason).toBe('line-tracker');
    expect(hit!.d.detail).not.toMatch(/NaN/);
  });

  it('also accepts a line the tracker has been very sure of for several fixations', () => {
    const rig = new Rig();
    rig.enter(L - 1);
    const g = { x: xAt(L, 0.85), y: line(L - 1).centerY + 0.4 * pitch };
    for (let fix = 12; fix < 14; fix++) expect(rig.run(250, g, estimate(L, { p: 0.95, fix }))).toBeNull();
    expect(rig.run(1000, g, estimate(L, { p: 0.95, fix: 14 }))?.d.reason).toBe('line-tracker');
  });

  it('turns right away when the reader sweeps back from the end of the last line', () => {
    const rig = new Rig();
    rig.enter(L);
    expect(rig.run(100, { x: xAt(L, 0.95), y: line(L).centerY }, estimate(L, { fix: 12 }))).toBeNull();
    const hit = rig.run(200, { x: xAt(L, 0.05), y: line(L).centerY + 0.6 * pitch }, estimate(L, { fix: 12 }));
    expect(hit?.d.reason).toBe('line-tracker');
    expect(hit!.d.detail).toMatch(/return sweep/);
    // A glance back up the page is not a sweep.
    const rig2 = new Rig();
    rig2.enter(L);
    rig2.run(100, { x: xAt(L, 0.95), y: line(L).centerY }, estimate(L, { fix: 12 }));
    expect(rig2.run(200, { x: xAt(L, 0.05), y: line(L - 5).centerY }, estimate(L, { fix: 12 }))).toBeNull();
  });

  it('waits longer, and sweeps are ignored, while the line above still has real probability', () => {
    const rig = new Rig();
    rig.enter(L, { p: 0.8, above: 0.15 });
    rig.run(100, { x: xAt(L, 0.95), y: line(L).centerY }, estimate(L, { p: 0.8, above: 0.15, fix: 12 }));
    expect(rig.run(200, { x: xAt(L, 0.05), y: line(L).centerY }, estimate(L, { p: 0.8, above: 0.15, fix: 12 }))).toBeNull();
    const start = rig.t;
    const hit = rig.run(2000, { x: xAt(L, 0.9), y: line(L).centerY }, estimate(L, { p: 0.8, above: 0.15, fix: 12 }));
    expect(hit!.at - start).toBeGreaterThanOrEqual(700);
    expect(hit!.d.targetLineIndex).toBe(L);
  });

  it('anchors the turn one line higher when the tracker is torn', () => {
    const rig = new Rig();
    rig.enter(L, { p: 0.62, above: 0.33 });
    const hit = rig.run(2000, { x: xAt(L, 0.9), y: line(L).centerY }, estimate(L, { p: 0.62, above: 0.33, fix: 12 }));
    expect(hit?.d.reason).toBe('line-tracker');
    expect(hit!.d.targetLineIndex).toBe(L - 1);
    expect(hit!.d.detail).toMatch(/anchored/);
  });

  it('falls back to bottom-dwell when the tracker is unsure', () => {
    const rig = new Rig();
    const start = rig.t;
    const hit = rig.run(3000, { x: xAt(L, 0.8), y: line(L).centerY }, estimate(L, { p: 0.45, above: 0.4, fix: 9 }));
    expect(hit?.d.reason).toBe('bottom-dwell');
    expect(hit!.at - start).toBeGreaterThanOrEqual(1200);
    expect(hit!.at - start).toBeLessThanOrEqual(1200 + 2 * STEP);
  });

  it('bottom-dwell turns one page per stay, and never for a look below the page', () => {
    const unsure = estimate(L, { p: 0.45, above: 0.4, fix: 9 });
    const parked = { x: xAt(L, 0.8), y: line(L).centerY };
    const rig = new Rig();
    expect(rig.run(3000, parked, unsure)?.d.reason).toBe('bottom-dwell');
    rig.det.notifyScrolled(rig.t); // the page turned
    // Gaze (or a mouse) left parked at the bottom right: no page after page.
    expect(rig.run(8000, parked, unsure)).toBeNull();
    // Up the page and back down: it may turn again.
    rig.run(400, { x: xAt(L, 0.5), y: line(L - 6).centerY }, unsure);
    expect(rig.run(3000, parked, unsure)?.d.reason).toBe('bottom-dwell');

    // With glance-down switched off, looking at the keyboard below the column never turns…
    const off = new Rig(new PageEndDetector({ glanceDownToTurn: false }));
    const keyboard = { x: xAt(L, 0.8), y: viewport.bottom + 3 * pitch };
    expect(off.run(6000, keyboard, unsure)).toBeNull();
    expect(off.run(6000, keyboard, null)).toBeNull();
    // …while gaze just below the last line (vertical noise) still counts as dwelling on it.
    const noisy = new Rig(new PageEndDetector({ glanceDownToTurn: false }));
    const low = { x: xAt(L, 0.8), y: viewport.bottom + 0.5 * pitch };
    expect(noisy.run(3000, low, unsure)?.d.reason).toBe('bottom-dwell');
  });

  it('waits for the gaze to come back up the page after a turn (a resting mouse must not page through the book)', () => {
    const rig = new Rig();
    rig.enter(L);
    const parked = { x: xAt(L, 0.95), y: line(L).centerY };
    expect(rig.run(2000, parked, estimate(L, { fix: 12 }))?.d.reason).toBe('line-tracker');
    rig.det.notifyScrolled(rig.t); // the page turned under the resting pointer
    // New page, same spot: the tracker puts the reader on its last line, fixation after fixation.
    expect(rig.run(300, parked, estimate(L, { fix: 1, sac: 'jump' }))).toBeNull();
    for (let fix = 2; fix <= 12; fix++) expect(rig.run(600, parked, estimate(L, { fix }))).toBeNull();
    expect(rig.last!.detail).toMatch(/gaze has not left the bottom/);
    // Reading starts at the top of the page and works down: the last line turns it again.
    rig.run(300, { x: xAt(2, 0.3), y: line(2).centerY }, estimate(2, { fix: 13, sac: 'jump' }));
    rig.enter(L);
    expect(rig.run(3000, parked, estimate(L, { fix: 14 }))?.d.reason).toBe('line-tracker');
  });

  it('vetoes bottom-dwell when the tracker is sure the reader is well above', () => {
    const rig = new Rig();
    expect(rig.run(4000, { x: xAt(L, 0.8), y: line(L).centerY }, estimate(L - 5, { p: 0.9 }))).toBeNull();
  });

  it('turns on a deliberate glance below the page, once per glance, and only if enabled', () => {
    const rig = new Rig();
    const below = { x: 500, y: viewport.bottom + 60 };
    const start = rig.t;
    const hit = rig.run(2000, below, null);
    expect(hit?.d.reason).toBe('glance-down'); // exempt from the "read enough" guard
    expect(hit!.at - start).toBeGreaterThanOrEqual(600);
    expect(hit!.d.targetLineIndex).toBe(L);
    // Still looking down (at the keyboard): no page after page.
    expect(rig.run(6000, below, null)).toBeNull();
    // Back on the page, then down again: turns again.
    rig.run(400, { x: 500, y: line(5).centerY }, null);
    expect(rig.run(2000, below, null)?.d.reason).toBe('glance-down');

    const off = new Rig(new PageEndDetector({ glanceDownToTurn: false }));
    expect(off.run(3000, below, null)).toBeNull();
  });

  it('ignores a look at the keyboard mid-page when the tracker is sure the reader is above', () => {
    const lookDown = { x: 500, y: viewport.bottom + 0.5 * (viewport.bottom - viewport.top) };
    // Mid-page: the tracker keeps line 8 with high confidence while the eyes are on the desk.
    const mid = new Rig();
    expect(mid.run(3000, lookDown, estimate(8, { p: 0.9, fix: 30 }))).toBeNull();
    // The same look from the last two lines is a deliberate glance.
    for (const at of [L, L - 1]) {
      const rig = new Rig();
      expect(rig.run(3000, lookDown, estimate(at, { p: 0.9, fix: 30 }))?.d.reason).toBe('glance-down');
    }
    // No estimate at all (the extension's page mode) still fires.
    expect(new Rig().run(3000, lookDown, null)?.d.reason).toBe('glance-down');
  });

  it('respects the cooldown after any scroll', () => {
    const rig = new Rig();
    rig.enter(L);
    rig.det.notifyScrolled(rig.t);
    const scrolledAt = rig.t;
    const hit = rig.run(4000, { x: xAt(L, 0.9), y: line(L).centerY }, estimate(L, { fix: 12 }));
    expect(hit!.at - scrolledAt).toBeGreaterThanOrEqual(PAGE_END_PRESETS.balanced.cooldownMs);
    const rig2 = new Rig();
    rig2.enter(L);
    rig2.det.notifyScrolled(rig2.t);
    rig2.run(500, { x: xAt(L, 0.9), y: line(L).centerY }, estimate(L, { fix: 12 }));
    expect(rig2.last!.detail).toMatch(/^cooldown/);
  });

  it('starts its own cooldown after firing, so an ignored trigger is not repeated every sample', () => {
    const rig = new Rig();
    rig.enter(L);
    const g = { x: xAt(L, 0.9), y: line(L).centerY };
    const first = rig.run(2000, g, estimate(L, { fix: 12 }))!;
    // Not repeated while the gaze stays put (see the resting-mouse test)…
    expect(rig.run(5000, g, estimate(L, { fix: 12 }))).toBeNull();
    // …and even a reader who glances up and straight back waits out the cooldown.
    const quick = new Rig();
    quick.enter(L);
    const firstQuick = quick.run(2000, g, estimate(L, { fix: 12 }))!;
    quick.run(2 * STEP, { x: xAt(L - 4, 0.5), y: line(L - 4).centerY }, estimate(L, { fix: 12 }));
    quick.enter(L);
    const second = quick.run(5000, g, estimate(L, { fix: 14 }))!;
    expect(first).not.toBeNull();
    expect(second.at - firstQuick.at).toBeGreaterThanOrEqual(PAGE_END_PRESETS.balanced.cooldownMs);
  });

  it('never fires while tracking is mostly lost', () => {
    const rig = new Rig();
    rig.enter(L);
    const flaky = (x: number) => (t: number): Gaze => ({ x, y: line(L).centerY, valid: Math.round(t / STEP) % 2 === 0 });
    expect(rig.run(1100, flaky(xAt(L, 0.3)), estimate(L, { fix: 12 }))).toBeNull();
    expect(rig.run(4000, flaky(xAt(L, 0.9)), estimate(L, { fix: 12 }))).toBeNull();
    expect(rig.last!.detail).toMatch(/tracking lost/);
    const lost = new Rig();
    expect(lost.run(4000, { x: 500, y: viewport.bottom + 80, valid: false }, estimate(L, { fix: 12 }))).toBeNull();
    expect(lost.run(4000, null, estimate(L, { fix: 12 }))).toBeNull();
  });

  it('rides out a blink without losing the dwell', () => {
    const rig = new Rig();
    rig.enter(L);
    const on = { x: xAt(L, 0.9), y: line(L).centerY };
    rig.run(8 * STEP, on, estimate(L, { fix: 12 }));
    expect(rig.run(5 * STEP, { ...on, valid: false }, estimate(L, { fix: 12 }))).toBeNull();
    const blinkEnd = rig.t;
    expect(rig.run(1000, on, estimate(L, { fix: 12 }))!.at - blinkEnd).toBeLessThanOrEqual(4 * STEP);
  });

  it('needs some reading on the page before the tracker-based rules may fire', () => {
    const rig = new Rig();
    const est = estimate(L, { fix: 2, sac: 'return-sweep' });
    const start = rig.t;
    const hit = rig.run(5000, { x: xAt(L, 0.9), y: line(L).centerY }, est);
    expect(hit!.at - start).toBeGreaterThanOrEqual(PAGE_END_GUARDS.minMsSinceTurn - STEP);
  });

  it('never fires earlier with a stricter preset (relaxed ≥ balanced ≥ eager)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      // A random but shared stream: segments of tracker beliefs and gaze positions near the page end.
      const segments = Array.from({ length: 40 }, () => {
        const li = L - Math.floor(rng() * 3);
        const p = 0.3 + 0.7 * rng();
        const above = rng() < 0.5 ? 0 : (1 - p) * rng();
        const sac: SaccadeKind = (['forward', 'forward', 'regression', 'return-sweep', 'jump'] as const)[Math.floor(rng() * 5)]!;
        return {
          ms: 60 + rng() * 500,
          est: estimate(li, { p, above, fix: Math.floor(rng() * 8), sac }),
          gaze: { x: 150 + rng() * 750, y: line(li).centerY + (rng() - 0.3) * 3 * pitch, valid: rng() > 0.08 },
        };
      });
      const firstFire = (s: Sensitivity): number => {
        const rig = new Rig(new PageEndDetector({ sensitivity: s }));
        for (const seg of segments) {
          const hit = rig.run(seg.ms, seg.gaze, seg.est);
          if (hit) return hit.at;
        }
        return Infinity;
      };
      const [relaxed, balanced, eager] = (['relaxed', 'balanced', 'eager'] as const).map(firstFire);
      expect(relaxed).toBeGreaterThanOrEqual(balanced!);
      expect(balanced).toBeGreaterThanOrEqual(eager!);
    }
  });

  it('explains itself when it cannot decide', () => {
    const det = new PageEndDetector();
    expect(det.update({ t: 5, gaze: null, estimate: null, layout: null })).toMatchObject({ trigger: false, reason: 'none', detail: 'no layout' });
    expect(det.update({ t: NaN, gaze: null, estimate: null, layout }).detail).toMatch(/clock/);
    const offscreen = doc.layoutAt(0, { viewport: { left: 0, top: 0, right: 1024, bottom: 10 } });
    expect(det.update({ t: 6, gaze: null, estimate: null, layout: offscreen }).detail).toBe('no fully visible line');
    // An estimate for a different layout (stale posterior) is ignored rather than misread.
    const stale = { ...estimate(L), posterior: [1] };
    const d = det.update({ t: 7, gaze: null, estimate: stale, layout });
    expect(d.targetLineIndex).toBe(L);
  });

  it('can be reconfigured and reset', () => {
    const det = new PageEndDetector({ sensitivity: 'eager', glanceDownToTurn: false });
    expect(det.options).toEqual({ sensitivity: 'eager', glanceDownToTurn: false });
    expect(det.thresholds).toBe(PAGE_END_PRESETS.eager);
    det.configure({ sensitivity: 'relaxed' });
    expect(det.thresholds).toBe(PAGE_END_PRESETS.relaxed);
    expect(det.options.glanceDownToTurn).toBe(false);
    det.configure({ sensitivity: 'bogus' as Sensitivity });
    expect(det.options.sensitivity).toBe('relaxed');

    const rig = new Rig(det);
    rig.det.configure({ sensitivity: 'balanced' });
    rig.det.notifyScrolled(rig.t + 10_000);
    rig.det.reset();
    rig.enter(L);
    expect(rig.run(1000, { x: xAt(L, 0.9), y: line(L).centerY }, estimate(L, { fix: 12 }))?.d.reason).toBe('line-tracker');
  });
});
