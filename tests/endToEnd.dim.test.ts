/**
 * End-to-end gate, dim light at 15 frames a second: three 20-minute sessions, so that missed pages
 * there are counted on enough of them (see tests/endToEndGates.ts for how the limits are set). One
 * hour-long session swung from 14 to 37 missed pages on a change that left three short ones at 30.
 *
 * The limits were reset with the distance compensation (calibrationModel.ts): on these seeds the
 * first 20 minutes went from 0 unintended turns to 4 and from about 35 missed pages to 25, while
 * over the same seeds' full hours (`npm run eval`) unintended turns fell from 6.3 to 2.7 an hour.
 */
import { describe, expect, it } from 'vitest';
import { SLOW_MS, gateReport, gateSession, gateTitle, type Gate } from './endToEndGates';

const GATE: Gate = { scenario: 'dim, 15 fps', minutes: 20, seeds: [1, 2, 3], maxFalse: 7, maxMissed: 33 };

describe('end-to-end gate: dim light, 15 fps (simulated reader, fixed seed)', () => {
  it(gateTitle(GATE), { timeout: SLOW_MS }, () => {
    const s = gateSession(GATE);
    expect(s.falses, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxFalse);
    expect(s.missed, gateReport(s.summary)).toBeLessThanOrEqual(GATE.maxMissed);
  });
});
