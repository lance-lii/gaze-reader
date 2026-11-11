/**
 * End-to-end gate for the pill's "Unsure of your line" (src/reading/lineConfidence.ts): up while the
 * line tracker can't follow the lines, and the pages a reader has to turn by hand there mostly
 * missed while it says so; not up in clean light or everyday reading. A noisy webcam is where the
 * tracker is lost (on the reader's line about one fixation in six). Fixed seeds, with limits well
 * clear of what the code does, since any change to the pipeline reshuffles a session (see
 * tests/endToEndGates.ts). Every scenario for an hour: `npm run bench -- bench/reading/lineTracker`.
 */
import { describe, expect, it } from 'vitest';
import { scenario } from '../bench/endtoend/world';
import { scoreLineTracker } from '../bench/reading/lineScore';
import { SLOW_MS } from './endToEndGates';

describe('end-to-end gate: "Unsure of your line" (simulated reader, fixed seeds)', () => {
  it('noisy webcam, 3 × 10 min: shown ≥ 60 % of the reading, ≥ 65 % of the missed pages missed while shown', { timeout: SLOW_MS }, () => {
    // Seeds 1–3: shown 80 % of the time, 29 of the 32 missed pages missed while shown.
    const r = scoreLineTracker(scenario('noisy webcam'), [1, 2, 3], { minutes: 10 });
    expect(r.unsurePct).toBeGreaterThanOrEqual(60);
    expect(r.missedUnsurePct).toBeGreaterThanOrEqual(65);
  });

  it('clean light and everyday reading, 30 min each: shown ≤ 3 % of the reading, at most twice', { timeout: SLOW_MS }, () => {
    // Seed 1: never shown in either.
    for (const name of ['clean', 'everyday']) {
      const r = scoreLineTracker(scenario(name), [1], { minutes: 30 });
      expect(r.unsurePct, name).toBeLessThanOrEqual(3);
      expect(Math.round(r.unsurePerHour * r.hours), name).toBeLessThanOrEqual(2);
    }
  });
});
