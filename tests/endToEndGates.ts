/**
 * Shared by the end-to-end gates (tests/endToEnd*.test.ts): one fixed-seed session of the simulated
 * reader in bench/endtoend per scenario (webcam landmarks → gaze → fixations → line tracker → page
 * turns, with that scenario's disturbances), each held to its own limits. The scoreboard — hours
 * per scenario, both presets, with intervals — is `npm run eval`, and that is what judges a change.
 *
 * A session is deterministic for its seed, but any change to the pipeline sends the reader down a
 * different path, which alone moves a count by about its square root. Seeds differ far more than
 * that (a bad calibration or posture can make one session several times worse than another), so
 * the limits aren't long-run rates: each sits about 1.5 standard deviations above what the code
 * does on the gate seed, ceil(n + 1.5·√max(n, 1)). A real regression in that scenario fails it; a
 * reshuffle doesn't. When a change moves a scenario's numbers on purpose, set its limits from the
 * new counts the same way (and check `npm run eval` agrees), never higher to let a regression pass.
 *
 * Noisy webcam misses nearly every page on its gate seed already (published webcam noise is more
 * than the reading layer can follow), so its gate guards unintended turns rather than missed ones.
 */
import { runSession, summarize, type SessionMetrics, type Summary } from '../bench/endtoend/rig';
import { scenario } from '../bench/endtoend/world';
import type { Sensitivity } from '../src/types';

export interface Gate {
  scenario: string;
  minutes: number;
  sensitivity?: Sensitivity;
  /** At most this many unintended turns in the session… */
  maxFalse: number;
  /** …and this many finished pages not turned (missed). */
  maxMissed: number;
}

export const GATE_SEED = 1;
/** Simulated hours take a while; a gate session of up to an hour runs in about ten seconds. */
export const SLOW_MS = 180_000;

const cache = new Map<string, { metrics: SessionMetrics; summary: Summary; falses: number; missed: number }>();

export function gateSession(g: Gate): { metrics: SessionMetrics; summary: Summary; falses: number; missed: number } {
  const key = `${g.scenario}/${g.minutes}/${g.sensitivity ?? 'balanced'}`;
  let s = cache.get(key);
  if (!s) {
    const metrics = runSession(scenario(g.scenario), GATE_SEED, { minutes: g.minutes, sensitivity: g.sensitivity ?? 'balanced' });
    const count = (kind: string): number => metrics.turns.filter((t) => t.kind === kind).length;
    s = { metrics, summary: summarize([metrics]), falses: count('false'), missed: count('missed') };
    cache.set(key, s);
  }
  return s;
}

/** What happened, for a failure message. */
export function gateReport(s: Summary): string {
  const causes = Object.entries(s.falseCauses)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}× ${k}`)
    .join(', ');
  return `${s.scenario} (${s.sensitivity}): ${(s.falsePerHour * s.hours).toFixed(0)} unintended in ${(60 * s.hours).toFixed(0)} min${causes ? ` (${causes})` : ''}, ${s.missedPct.toFixed(1)} % of ${s.pages} pages missed`;
}

export const gateTitle = (g: Gate): string =>
  `${g.scenario}${g.sensitivity && g.sensitivity !== 'balanced' ? ` (${g.sensitivity})` : ''}, ${g.minutes} min: ≤ ${g.maxFalse} unintended turns, ≤ ${g.maxMissed} missed`;
