/** End-to-end gates, restless posture and glasses (see tests/endToEndGates.ts for how the limits are set). */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATES: Gate[] = [
  { scenario: 'fidgety', minutes: 10, seeds: [1, 2, 3], maxFalse: 2, maxMissed: 2 },
  { scenario: 'fidgety', minutes: 10, seeds: [1, 2, 3], sensitivity: 'relaxed', maxFalse: 2, maxMissed: 2 },
  // A reader who skips the calibration's head-movement step: as it was before the step existed.
  { scenario: 'fidgety', minutes: 10, seeds: [1, 2, 3], headStep: false, maxFalse: 2, maxMissed: 2 },
  { scenario: 'glasses', minutes: 10, seeds: [1, 2, 3], maxFalse: 5, maxMissed: 9 },
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
