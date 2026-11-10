/** End-to-end gates, restless posture and glasses (see tests/endToEndGates.ts for how the limits are set). */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATES: Gate[] = [
  { scenario: 'fidgety', minutes: 10, seeds: [1, 2, 3], maxFalse: 10, maxMissed: 6 },
  { scenario: 'fidgety', minutes: 10, seeds: [1, 2, 3], sensitivity: 'relaxed', maxFalse: 5, maxMissed: 21 },
  { scenario: 'glasses', minutes: 10, seeds: [1, 2, 3], maxFalse: 5, maxMissed: 11 },
];

describe('end-to-end gates: posture and glasses (simulated reader, fixed seed)', () => {
  for (const g of GATES) {
    it(gateTitle(g), { timeout: SLOW_MS }, () => {
      const s = gateSession(g);
      expect(s.falses, gateReport(s.summary)).toBeLessThanOrEqual(g.maxFalse);
      expect(s.missed, gateReport(s.summary)).toBeLessThanOrEqual(g.maxMissed);
    });
  }
});
