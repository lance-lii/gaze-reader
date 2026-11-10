/**
 * End-to-end gate, dim light at 15 frames a second: an hour, so that missed pages there are counted
 * on enough of them (see tests/endToEndGates.ts for how the limits are set).
 */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATE: Gate = { scenario: 'dim, 15 fps', minutes: 60, maxFalse: 18, maxMissed: 20 };

describe('end-to-end gate: dim light, 15 fps (simulated reader, fixed seed)', () => {
  it(gateTitle(GATE), { timeout: SLOW_MS }, () => {
    const s = gateSession(GATE);
    expect(s.falses, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxFalse);
    expect(s.missed, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxMissed);
  });
});
