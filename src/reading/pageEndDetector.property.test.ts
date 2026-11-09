/**
 * Property tests for the page-end detector: random, hostile input streams (gaze anywhere or off
 * the screen, blinks, NaNs, frame gaps and stalls, time going backwards, estimates that jump
 * about, scrolls at any moment), checked against the guarantees the decision layer makes
 * whatever the tracker says. Seeded, so a failure replays; the seed is in the message.
 */
import { describe, expect, it } from 'vitest';
import type { GazeSample, LineEstimate, LineLayout, PageEndDecision, SaccadeKind } from '../types';
import { PAGE_END_GUARDS, PAGE_END_PRESETS, PageEndDetector } from './pageEndDetector';
import { mulberry32 } from './simulatedReader';
import { makeReadingPage } from './testLayouts';

const SACCADES: (SaccadeKind | null)[] = ['forward', 'regression', 'return-sweep', 'jump', null];

interface Step {
  t: number;
  sample: GazeSample | null;
  estimate: LineEstimate | null;
  scroll: boolean;
}

/** A random but replayable stream: segments of reading-like gaze, looks off the page, blinks and gaps. */
function stream(seed: number, layout: LineLayout, n: number): Step[] {
  const rng = mulberry32(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)]!;
  const lines = layout.lines;
  const vp = layout.viewport;
  const steps: Step[] = [];
  let t = 1000 + rng() * 1e6;
  let est: LineEstimate | null = null;
  let fix = 0;
  let mode = 0;
  let left = 0;
  let x = vp.left;
  let y = vp.top;
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) {
      mode = Math.floor(rng() * 6);
      left = 5 + Math.floor(rng() * 120);
    }
    // Time: mostly 30 Hz with jitter, sometimes a stall or a long gap (sleep), now and then backwards.
    const r = rng();
    t += r < 0.85 ? 20 + rng() * 30 : r < 0.95 ? 100 + rng() * 900 : r < 0.98 ? 5000 + rng() * 3.6e6 : -rng() * 200;
    let valid = true;
    switch (mode) {
      case 0: // reading somewhere on the page
      case 1: {
        const line = pick(lines);
        x = line.left + rng() * (line.right - line.left);
        y = line.centerY + (rng() - 0.5) * 80;
        break;
      }
      case 2: // at the end of the last lines
        x = lines[lines.length - 1]!.right - rng() * 120;
        y = lines[Math.max(0, lines.length - 1 - Math.floor(rng() * 3))]!.centerY + (rng() - 0.5) * 60;
        break;
      case 3: // off the page: below (a phone), or anywhere
        x = vp.left + rng() * (vp.right - vp.left);
        y = rng() < 0.6 ? vp.bottom + rng() * 600 : vp.top - 400 + rng() * (vp.bottom - vp.top + 800);
        break;
      case 4: // blinks and lost tracking
        valid = rng() < 0.3;
        break;
      default: // garbage coordinates
        x = pick([NaN, Infinity, -Infinity, 1e9, -1e9, x]);
        y = pick([NaN, Infinity, -1e9, 1e9, y]);
        valid = rng() < 0.7;
    }
    const sample: GazeSample | null =
      rng() < 0.03 ? null : { t, x, y, rawX: x, rawY: y, valid, confidence: rng(), source: pick(['webcam', 'mouse', 'simulated'] as const) };
    // The estimate changes at fixation ends: any line, any confidence, sometimes none at all.
    if (rng() < 0.08) {
      if (rng() < 0.1) est = null;
      else {
        const lineIndex = Math.floor(rng() * lines.length);
        const probability = rng();
        const posterior = lines.map(() => rng());
        const sum = posterior.reduce((a, b) => a + b, 0);
        for (let j = 0; j < posterior.length; j++) posterior[j] = (posterior[j]! / sum) * (1 - probability);
        posterior[lineIndex] = posterior[lineIndex]! + probability;
        fix += rng() < 0.9 ? 1 : 0;
        est = { t, lineIndex, probability, posterior, progressX: rng(), lastSaccade: pick(SACCADES), driftY: (rng() - 0.5) * 6 * layout.linePitch, fixationsOnPage: fix };
      }
    }
    const scroll = rng() < 0.004;
    if (scroll) fix = 0;
    steps.push({ t, sample, estimate: est, scroll });
  }
  return steps;
}

function run(det: PageEndDetector, layout: LineLayout, steps: readonly Step[], check?: (s: Step, d: PageEndDecision, i: number) => void): PageEndDecision[] {
  const out: PageEndDecision[] = [];
  steps.forEach((s, i) => {
    if (s.scroll) det.notifyScrolled(s.t);
    const d = det.update({ t: s.t, gaze: s.sample, estimate: s.estimate, layout });
    out.push(d);
    check?.(s, d, i);
  });
  return out;
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 101 + i);

describe('page-end detector: guarantees under random input', () => {
  it('fires only on a valid, finite sample, never within the cooldown, and never on too few valid samples', () => {
    const cooldown = PAGE_END_PRESETS.balanced.cooldownMs;
    let fired = 0;
    for (const seed of SEEDS) {
      const layout = makeReadingPage(seed);
      const det = new PageEndDetector();
      let lastScroll = -Infinity;
      let lastFire = -Infinity;
      let maxT = -Infinity;
      const recent: { t: number; ok: boolean }[] = [];
      run(det, layout, stream(seed, layout, 6000), (s, d) => {
        if (s.scroll) lastScroll = Math.max(lastScroll, s.t);
        maxT = Math.max(maxT, s.t);
        const ok = !!s.sample && s.sample.valid && Number.isFinite(s.sample.x) && Number.isFinite(s.sample.y);
        recent.push({ t: s.t, ok });
        while (recent.length > 0 && recent[0]!.t < s.t - PAGE_END_GUARDS.validityWindowMs) recent.shift();
        if (!d.trigger) return;
        fired++;
        const where = `seed ${seed}, t ${s.t.toFixed(0)}`;
        expect(ok, `fired on an invalid sample (${where})`).toBe(true);
        expect(s.t - Math.max(lastScroll, lastFire), `fired within the cooldown (${where})`).toBeGreaterThanOrEqual(cooldown - 1e-6);
        expect(recent.filter((r) => r.ok).length, `fired on too few valid samples (${where})`).toBeGreaterThanOrEqual(PAGE_END_GUARDS.minValidSamples - 1);
        lastFire = s.t;
      });
    }
    expect(fired, 'the streams do reach the end of the page now and then').toBeGreaterThan(0);
  });

  it('always answers with a line on the page, a confidence in 0..1 and an explanation', () => {
    for (const seed of SEEDS) {
      const layout = makeReadingPage(seed);
      for (const d of run(new PageEndDetector({ sensitivity: (['relaxed', 'balanced', 'eager'] as const)[seed % 3], glanceDownToTurn: seed % 2 === 0 }), layout, stream(seed, layout, 3000))) {
        expect(Number.isInteger(d.targetLineIndex) && d.targetLineIndex >= 0 && d.targetLineIndex < layout.lines.length, `seed ${seed}: target ${d.targetLineIndex}`).toBe(true);
        expect(d.confidence >= 0 && d.confidence <= 1, `seed ${seed}: confidence ${d.confidence}`).toBe(true);
        expect(d.detail.length, `seed ${seed}`).toBeGreaterThan(0);
        if (!d.trigger) expect(d.reason, `seed ${seed}`).toBe('none');
      }
    }
  });

  it('with glance-down off, never fires for a look below the page', () => {
    for (const seed of SEEDS) {
      const layout = makeReadingPage(seed);
      for (const [i, d] of run(new PageEndDetector({ sensitivity: 'balanced', glanceDownToTurn: false }), layout, stream(seed, layout, 3000)).entries()) {
        expect(d.reason, `seed ${seed}, step ${i}`).not.toBe('glance-down');
      }
    }
  });

  it('replays the same stream to the same decisions after reset() (no state leaks between books)', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const layout = makeReadingPage(seed);
      const steps = stream(seed, layout, 3000);
      const det = new PageEndDetector();
      const first = run(det, layout, steps);
      det.reset();
      expect(run(det, layout, steps), `seed ${seed}`).toEqual(first);
    }
  });
});
