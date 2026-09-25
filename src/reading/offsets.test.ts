import { describe, expect, it } from 'vitest';
import { APP_DOC, APP_DOC_LONG, NEW, constant, noOffset, quantile, stepAt, type Schedule } from '../../bench/reading/harness';
import { runSession, summarizeSessions, type SessionConfig, type SessionSummary } from '../../bench/reading/session';
import { READING_ORDERS, runInterrupted, runPage } from '../../bench/reading/page';
import { lastFullyVisibleIndex, makeReadingPage, withBlockGap } from './testLayouts';

/**
 * Fast guards for the reading layer under lighting-like gaze offsets: a few seeds of the
 * multi-page sessions from bench/reading/offsets.bench.test.ts (the full scoreboard, 24 seeds ×
 * 7 turns per row, runs with `npm run bench`). Each session: FixationDetector → LineTracker →
 * PageEndDetector wired like the app controller, 7 page turns, 0.75-pitch noise, blinks.
 */

const SEEDS = [1, 2, 3, 4, 5, 6];

function sessions(schedule: Schedule, extra: Partial<SessionConfig> = {}, seeds: readonly number[] = SEEDS): SessionSummary {
  return summarizeSessions(seeds.map((seed) => runSession({ seed, pipeline: NEW, schedule, ...extra })));
}

const badTurns = (s: SessionSummary): number => s.premature + s.unsafe;

describe('reading layer under gaze offsets (fast guards; full scoreboard in bench/reading)', () => {
  it('reads without an offset as before: ≥ 99 % on the true line, every turn on time', () => {
    const s = sessions(noOffset);
    expect(s.turns).toBe(7 * SEEDS.length);
    expect(s.onLine).toBeGreaterThanOrEqual(0.99);
    expect(badTurns(s) + s.missed).toBe(0);
  });

  it('absorbs a constant ±2-line offset (light different from calibration)', () => {
    // Gaze Reader 1.0: +2 → 3 % on the line, 73 of 168 turns early; −2 → 69 of 168 turns missed.
    for (const dy of [2, -2]) {
      const s = sessions(constant(dy));
      expect(s.onLine, `offset ${dy}`).toBeGreaterThanOrEqual(0.9);
      expect(badTurns(s), `offset ${dy}`).toBe(0);
      expect(s.missed, `offset ${dy}`).toBe(0);
    }
  });

  it('absorbs a constant ±2/+3-line offset on the app layout too (no paragraph gaps, 1.5em indent)', () => {
    // The app's reader has no gaps between paragraphs: less structure to pin the drift than the
    // gapped document above (the extension's). 1.0: every turn early (+) or missed (−).
    for (const dy of [3, 2, -2]) {
      const s = sessions(constant(dy), { doc: APP_DOC });
      expect(s.onLine, `offset ${dy}`).toBeGreaterThanOrEqual(0.88);
      expect(badTurns(s) + s.missed, `offset ${dy}`).toBe(0);
    }
  });

  it('applies an appearance report that arrives 2.3 s late (the lid monitor) at the change: no missed turn after a 4-line step up', () => {
    // The tracker rewinds to the change and replays the fixations since. Applied on arrival instead,
    // it came after those fixations had moved the line: 6 of 168 turns missed, 93 % on the line.
    const s = sessions(stepAt(-4, 100_000), { appearanceEvents: [100_000], eventDelayMs: 2300 });
    expect(badTurns(s) + s.missed).toBe(0);
    expect(s.onLine).toBeGreaterThanOrEqual(0.97);
  });

  it('re-learns a 3-line step (a light switched on) reported by the camera without an early turn', () => {
    const s = sessions(stepAt(3, 100_000), { appearanceEvents: [100_000] });
    expect(badTurns(s)).toBe(0);
    expect(s.onLine).toBeGreaterThanOrEqual(0.97);
    // Unreported, a downward step mid-line is still partly read as the sensor (1.0: 92 of 168 early).
    expect(badTurns(sessions(stepAt(3, 100_000)))).toBe(0);
  });

  it('keeps looks below the page while waiting for the turn from moving the drift', () => {
    // Seed 16's first page: lingering glances below the page once read as a 3-line bias step.
    // Each such run of glances made the tracker place the reader 3 lines higher; the page never turned.
    const s = sessions(noOffset, { wanderLines: 0.3, blinksPerMin: 15, turns: 1 }, [16]);
    expect(s.missed + badTurns(s)).toBe(0);
  });

  it('takes a glance down and straight back mid-page for a look, not a step of the bias', () => {
    for (const seed of [6, 19]) {
      const r = runInterrupted({ seed, pipeline: NEW, look: { kind: 'glance', dyLines: 4 }, lookMs: 350 });
      expect(r.onLine / r.fixations, `seed ${seed}`).toBeGreaterThan(0.95);
      expect(r.fired && !r.premature && !r.unsafe).toBe(true);
    }
  });
});

describe('single pages on the app layout (fast guards)', () => {
  const PAGES = Array.from({ length: 24 }, (_, i) => i + 1);

  it('turns the first page after a calibration safely when re-reading long gapless paragraphs', () => {
    // Right after a calibration the light is the calibration's: reset({ calibrated: true }) drops the
    // uniform share of the drift prior. Over 96 pages: 0/2/0 early/unsafe/missed, against 0/4/0 with
    // the share (a start with a stored calibration) and 4/7/0 before the page-end detector's drift clamp.
    const reRead = READING_ORDERS.find(([label]) => label.startsWith('re-read'))![1];
    const runs = PAGES.map((seed) =>
      runPage({ seed, pipeline: NEW, segments: reRead, doc: APP_DOC_LONG, prepare: (t) => t.reset?.({ calibrated: true }) }),
    );
    expect(runs.filter((r) => r.premature).length).toBe(0);
    expect(runs.filter((r) => r.unsafe).length).toBeLessThanOrEqual(1);
    expect(runs.filter((r) => !r.fired).length).toBe(0);
  });

  it('turns promptly when a short last line follows a scene break or a heading (2.8–3.8 pitches below)', () => {
    // The sweep across the gap is classified as a jump; one line down to the start of the column it
    // still enters the last line (without that: p90 922 / 1353 ms).
    for (const pitches of [2.8, 3.8]) {
      const runs = PAGES.map((seed) => {
        const page = makeReadingPage(seed, APP_DOC);
        const L = lastFullyVisibleIndex(page);
        return runPage({ seed, pipeline: NEW, layout: withBlockGap(page, L, (pitches - 1) * page.linePitch, 0.3) });
      });
      expect(runs.filter((r) => r.premature || r.unsafe || !r.fired).length, `${pitches} pitches`).toBe(0);
      expect(quantile(runs.map((r) => r.latency), 0.9), `${pitches} pitches`).toBeLessThanOrEqual(400);
    }
  });
});
