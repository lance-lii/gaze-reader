/**
 * Regression gates for the decision layer, end to end: short fixed-seed sessions of the simulated
 * reader in bench/endtoend (webcam landmarks → gaze → fixations → line tracker → page turns, with
 * the disturbances of each scenario). The full scoreboard — hours per scenario, every disturbance —
 * is `npm run eval`.
 *
 * A session is deterministic for its seed, so any change in these counts is a change in behaviour.
 * The limits allow one event of slack (floating-point differences between machines can shift a
 * session); when an improvement lowers a count, lower its limit with it.
 */
import { describe, expect, it } from 'vitest';
import { runSession, summarize, type SessionMetrics } from '../bench/endtoend/rig';
import { scenario } from '../bench/endtoend/world';

const cache = new Map<string, SessionMetrics>();
function session(name: string, minutes: number, seed = 1): SessionMetrics {
  const key = `${name}/${minutes}/${seed}`;
  let s = cache.get(key);
  if (!s) cache.set(key, (s = runSession(scenario(name), seed, { minutes })));
  return s;
}
const count = (s: SessionMetrics, kind: 'false' | 'missed') => s.turns.filter((t) => t.kind === kind).length;
const SLOW = 60_000;

describe('end-to-end decision gates (simulated reader, fixed seeds)', () => {
  // [scenario, minutes, max unintended turns, max missed turns]
  const gates: Array<[string, number, number, number]> = [
    ['clean', 20, 3, 1],
    ['everyday', 20, 3, 3],
    ['fidgety', 15, 5, 3],
    ['distracted', 15, 2, 2],
    ['dim, 15 fps', 10, 1, 4],
  ];
  for (const [name, minutes, maxFalse, maxMissed] of gates) {
    it(`${name}, ${minutes} min: at most ${maxFalse} unintended and ${maxMissed} missed page turns`, { timeout: SLOW }, () => {
      const s = session(name, minutes);
      expect(s.turns.length, 'pages turned').toBeGreaterThan(minutes / 2);
      expect(count(s, 'false'), 'unintended turns').toBeLessThanOrEqual(maxFalse);
      expect(count(s, 'missed'), 'missed turns').toBeLessThanOrEqual(maxMissed);
    });
  }

  it('gaze error against ground truth stays within the baseline in clean conditions', { timeout: SLOW }, () => {
    const s = summarize([session('clean', 20)]);
    expect(s.errP50, 'median error, px').toBeLessThanOrEqual(80);
    expect(s.errP90, '90th percentile, px').toBeLessThanOrEqual(150);
    expect(s.calibrationErrPx, 'calibration error, px').toBeLessThanOrEqual(55);
  });

  it('turns promptly once the reader finishes a page in clean conditions', { timeout: SLOW }, () => {
    const s = summarize([session('clean', 20)]);
    expect(s.latencyP90, '90th percentile latency, ms').toBeLessThanOrEqual(600);
  });
});
