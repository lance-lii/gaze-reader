/** End-to-end gate, a noisy webcam (see tests/endToEndGates.ts for how the limits are set, and why this one guards unintended turns). */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATE: Gate = { scenario: 'noisy webcam', minutes: 10, seeds: [1, 2, 3], maxFalse: 7, maxMissed: 39 };

describe('end-to-end gate: noisy webcam (simulated reader, fixed seed)', () => {
  it(gateTitle(GATE), { timeout: SLOW_MS }, () => {
    const s = gateSession(GATE);
    expect(s.falses, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxFalse);
    expect(s.missed, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxMissed);
  });
});
