import { describe, expect, it } from 'vitest';
import type { Fixation } from '../../src/types';
import { LineTracker } from '../../src/reading/lineTracker';
import { gaussian, mulberry32 } from '../../src/reading/simulatedReader';
import { makeReadingPage } from '../../src/reading/testLayouts';
import { LegacyLineTracker } from './legacyLineTracker';
import { fmt, markdownTable, quantile } from './harness';

/**
 * Line tracker cost per fixation on dense pages (the extension runs it on the page's main thread;
 * a 1440p window shows ≈ 55 lines at 16 px / 1.5, 80 or more zoomed out). Reading with a mid-page
 * jump of ±8 lines every 12 fixations; the jump fixations are the expensive ones (a line
 * transition over all line pairs, once per drift bin — the kernel is now built once per jump).
 * Wall-clock, so the bound is loose: 1.0 took ≈ 2.3 ms per jump fixation at 100 lines, the ±5-line
 * tracker before the change 5.8 ms, after it 1.7 ms (this desktop).
 */

type Tracker = Pick<LineTracker, 'setLayout' | 'onFixation'>;

function timeJumps(make: () => Tracker, lines: number): { jump: number[]; other: number[] } {
  const jump: number[] = [];
  const other: number[] = [];
  for (let seed = 1; seed <= 3; seed++) {
    const layout = makeReadingPage(seed, { lines, partialLastLine: false });
    const pitch = layout.linePitch;
    const rng = mulberry32(seed);
    const tracker = make();
    tracker.setLayout(layout, 'initial');
    let t = 0;
    let line = 0;
    for (let k = 0; k < 480; k++) {
      const isJump = k % 12 === 11;
      if (isJump) line = Math.max(0, Math.min(lines - 1, line + (rng() < 0.5 ? -8 : 8)));
      else if (k % 6 === 5) line = Math.min(lines - 1, line + 1);
      const l = layout.lines[line]!;
      const f: Fixation = { id: k, start: t, end: t + 220, x: l.left + (k % 6) * 110 + 20, y: l.centerY + 0.6 * pitch * gaussian(rng), sampleCount: 7 };
      t += 260;
      const t0 = performance.now();
      const e = tracker.onFixation(f);
      const ms = performance.now() - t0;
      (e.lastSaccade === 'jump' ? jump : other).push(ms);
    }
  }
  return { jump, other };
}

describe('line tracker cost per fixation', () => {
  it('jump fixations on dense pages stay within a few ms', () => {
    const rows: string[][] = [];
    let at80 = NaN;
    for (const lines of [40, 80, 100]) {
      for (const [name, make] of [
        ['old 1.0', () => new LegacyLineTracker()],
        ['new', () => new LineTracker()],
      ] as const) {
        const { jump, other } = timeJumps(make, lines);
        rows.push([String(lines), name, `${fmt(quantile(jump, 0.5), 2)} / ${fmt(quantile(jump, 0.9), 2)} / ${fmt(Math.max(...jump), 2)}`, fmt(quantile(other, 0.5), 2)]);
        if (lines === 80 && name === 'new') at80 = quantile(jump, 0.5);
      }
    }
    console.log('\n### Line tracker, ms per fixation\n\n' + markdownTable(['lines', 'tracker', 'jump: median / p90 / max', 'other: median'], rows));
    expect(at80).toBeLessThan(3);
  });
});
