/**
 * Regression gates for the decision layer, end to end: short fixed-seed sessions of the simulated
 * reader in bench/endtoend (webcam landmarks → gaze → fixations → line tracker → page turns, with
 * the disturbances of each scenario). The full scoreboard — hours per scenario, every disturbance —
 * is `npm run eval`, and that is what judges an improvement.
 *
 * A session is deterministic for its seed, but any change to the pipeline sends the reader down a
 * different path, and in 80 simulated minutes a count of about ten unintended turns moves by ±3 on
 * that alone. So the limits sit about 1.5 standard deviations above the long-run rates (measured over
 * 32 hours on other seeds): they catch a real regression, not a reshuffle. Lower them with the rates.
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
const SLOW = 120_000;
/** [scenario, minutes]: 80 minutes in all. */
const GATE_SESSIONS: Array<[string, number]> = [
  ['clean', 20],
  ['everyday', 20],
  ['fidgety', 15],
  ['distracted', 15],
  ['dim, 15 fps', 10],
];
function tally(kind: 'false' | 'missed'): { total: number; pages: number; detail: string } {
  let total = 0;
  let pages = 0;
  const parts: string[] = [];
  for (const [name, minutes] of GATE_SESSIONS) {
    const s = session(name, minutes);
    const n = count(s, kind);
    total += n;
    pages += s.turns.length;
    parts.push(`${name} ${n}/${s.turns.length}`);
  }
  return { total, pages, detail: parts.join(', ') };
}

describe('end-to-end decision gates (simulated reader, fixed seeds)', () => {
  it('turns a page the reader didn\'t mean to turn at most 15 times in 80 minutes of mixed conditions', { timeout: SLOW }, () => {
    const t = tally('false');
    expect(t.pages, 'pages turned').toBeGreaterThan(80);
    expect(t.total, `unintended turns (${t.detail})`).toBeLessThanOrEqual(15);
  });

  it('misses at most 13 page turns in the same sessions', { timeout: SLOW }, () => {
    const t = tally('missed');
    expect(t.total, `missed turns (${t.detail})`).toBeLessThanOrEqual(13);
  });

  it('in clean conditions: at most 3 unintended turns in 20 minutes, prompt turns, gaze error within the baseline', { timeout: SLOW }, () => {
    const s = session('clean', 20);
    expect(count(s, 'false'), 'unintended turns').toBeLessThanOrEqual(3);
    expect(count(s, 'missed'), 'missed turns').toBeLessThanOrEqual(1);
    const m = summarize([s]);
    expect(m.latencyP90, '90th percentile latency, ms').toBeLessThanOrEqual(600);
    expect(m.errP50, 'median gaze error, px').toBeLessThanOrEqual(80);
    expect(m.errP90, '90th percentile gaze error, px').toBeLessThanOrEqual(150);
    expect(m.calibrationErrPx, 'calibration error, px').toBeLessThanOrEqual(55);
  });
});
