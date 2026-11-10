/**
 * End-to-end gate, dim light at 15 frames a second: three 20-minute sessions, so that missed pages
 * there are counted on enough of them (see tests/endToEndGates.ts for how the limits are set). One
 * hour-long session swung from 14 to 37 missed pages on a change that left three short ones at 30.
 */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATE: Gate = { scenario: 'dim, 15 fps', minutes: 20, seeds: [1, 2, 3], maxFalse: 2, maxMissed: 47 };

describe('end-to-end gate: dim light, 15 fps (simulated reader, fixed seed)', () => {
  it(gateTitle(GATE), { timeout: SLOW_MS }, () => {
    const s = gateSession(GATE);
    expect(s.falses, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxFalse);
    expect(s.missed, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxMissed);
  });
});
