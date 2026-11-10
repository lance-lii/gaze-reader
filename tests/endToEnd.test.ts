/**
 * End-to-end gates, everyday conditions: fixed-seed sessions of the simulated reader, each scenario
 * to its own limits (see tests/endToEndGates.ts for how they are set). The other conditions are in
 * endToEnd.posture, .noisy and .dim, so the files run in parallel.
 */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATES: Gate[] = [
  { scenario: 'clean', minutes: 20, maxFalse: 2, maxMissed: 2 },
  { scenario: 'everyday', minutes: 20, maxFalse: 6, maxMissed: 6 },
  { scenario: 'everyday', minutes: 20, sensitivity: 'relaxed', maxFalse: 2, maxMissed: 7 },
  { scenario: 'distracted', minutes: 15, maxFalse: 2, maxMissed: 5 },
];

describe('end-to-end gates: everyday conditions (simulated reader, fixed seed)', () => {
  for (const g of GATES) {
    it(gateTitle(g), { timeout: SLOW_MS }, () => {
      const s = gateSession(g);
      expect(s.falses, gateReport(s.summary)).toBeLessThanOrEqual(g.maxFalse);
      expect(s.missed, gateReport(s.summary)).toBeLessThanOrEqual(g.maxMissed);
    });
  }

  it('clean: prompt turns, gaze error within the baseline', { timeout: SLOW_MS }, () => {
    const { summary } = gateSession(GATES[0]!);
    expect(summary.latencyP90, '90th percentile latency, ms').toBeLessThanOrEqual(1500);
    expect(summary.errP50, 'median gaze error, px').toBeLessThanOrEqual(80);
    expect(summary.errP90, '90th percentile gaze error, px').toBeLessThanOrEqual(160);
    expect(summary.calibrationErrPx, 'calibration error, px').toBeLessThanOrEqual(55);
  });
});
