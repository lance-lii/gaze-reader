import { describe, expect, it } from 'vitest';
import type { LineEstimate } from '../../src/types';
import type { TrackedLineEstimate } from '../../src/reading/lineTracker';
import { DEFAULT_TOUCH_UP_POLICY, TouchUpAdvisor, lightingSentence } from './touchUp';

const PITCH = 40;
const MIN = 60_000;

/** A wall clock the test moves by hand. */
function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** A confident estimate with `drift` lines of vertical offset, pinned to ±`sd` lines. */
function est(t: number, drift: number, sd = 0.2, probability = 0.9): TrackedLineEstimate {
  return {
    t,
    lineIndex: 4,
    probability,
    posterior: [],
    progressX: 0.5,
    lastSaccade: 'forward',
    driftY: drift * PITCH,
    fixationsOnPage: 20,
    sigmaYPx: 30,
    excursions: 0,
    driftLowY: (drift - 2 * sd) * PITCH,
    driftHighY: (drift + 2 * sd) * PITCH,
    driftSdY: sd * PITCH,
  };
}

/** Feeds 4 fixations a second from t0 for `ms`; returns the offers. */
function read(a: TouchUpAdvisor, t0: number, ms: number, make: (t: number) => LineEstimate) {
  const offers = [];
  for (let t = t0; t < t0 + ms; t += 250) {
    const o = a.onEstimate(make(t), PITCH);
    if (o) offers.push({ t, ...o });
  }
  return offers;
}

describe('TouchUpAdvisor: lighting', () => {
  it('offers once per lighting change, then waits at least 10 minutes (any tab)', () => {
    const c = clock();
    const a = new TouchUpAdvisor({ wallNow: c.now });
    const first = a.lightingChanged('side', 2.3);
    expect(first?.reason).toBe('lighting');
    expect(first?.text).toBe('The light comes from a different side than when you calibrated. A quick 5-dot refresh (about 10 seconds) keeps page turns on time.');
    expect(a.current.offeredAt).toBe(c.now()); // counted as made: the caller persists it
    expect(a.lightingChanged('side', 2.3)).toBeNull(); // same episode

    a.noteLightingRestored();
    c.advance(5 * MIN);
    expect(a.lightingChanged('sclera', 1.5)).toBeNull(); // new episode, but only 5 minutes later
    c.advance(5 * MIN);
    expect(a.lightingChanged('sclera', 1.5)?.text).toMatch(/^It's brighter than when you calibrated\./);

    // Another tab's record counts too.
    const other = new TouchUpAdvisor({ wallNow: c.now, record: { offeredAt: c.now() - 2 * MIN, snoozedUntil: 0 } });
    expect(other.lightingChanged('side', 2)).toBeNull();
    other.setRecord({ offeredAt: 0, snoozedUntil: 0 });
    expect(other.lightingChanged('side', 2)).not.toBeNull();
  });

  it('keeps quiet for 30 minutes after "Not now", and for 2 minutes after a calibration', () => {
    const c = clock();
    const a = new TouchUpAdvisor({ wallNow: c.now });
    expect(a.lightingChanged('side', 2)).not.toBeNull();
    const snoozed = a.snooze();
    expect(snoozed.snoozedUntil).toBe(c.now() + 30 * MIN);
    c.advance(20 * MIN);
    a.noteLightingRestored();
    expect(a.allowed()).toBe(false);
    c.advance(11 * MIN);
    expect(a.allowed()).toBe(true);

    a.noteCalibrated();
    expect(a.lightingChanged('glare', 3)).toBeNull();
    c.advance(DEFAULT_TOUCH_UP_POLICY.graceMs);
    expect(a.lightingChanged('glare', 3)?.text).toMatch(/^There are new reflections on your glasses or eyes\./);

    // A calibration made a minute ago elsewhere (another tab, the page before this one) counts too.
    const fresh = new TouchUpAdvisor({ wallNow: c.now, calibratedAt: c.now() - MIN });
    expect(fresh.allowed()).toBe(false);
    c.advance(MIN);
    expect(fresh.allowed()).toBe(true);
  });
});

describe('TouchUpAdvisor: learned offset', () => {
  it('offers after 20 s of reading with ≥ 1.5 lines of offset the tracker is sure of, in the right direction', () => {
    const c = clock();
    const a = new TouchUpAdvisor({ wallNow: c.now });
    expect(read(a, 0, 60_000, (t) => est(t, 1.2))).toEqual([]); // under 1.5 lines: the tracker copes
    const offers = read(a, 60_000, 60_000, (t) => est(t, 2.6));
    expect(offers).toHaveLength(1);
    expect(offers[0]!.t - 60_000).toBeGreaterThanOrEqual(20_000);
    expect(offers[0]!.t - 60_000).toBeLessThan(20_500);
    expect(offers[0]!.text).toMatch(/^Gaze Reader has been placing your eyes about 3 lines too low\./);
    expect(read(a, 120_000, 60_000, (t) => est(t, 2.6))).toEqual([]); // rate-limited: one per 10 minutes

    const up = new TouchUpAdvisor({ wallNow: c.now });
    const high = read(up, 0, 30_000, (t) => est(t, -1.6));
    expect(high[0]!.text).toMatch(/about 2 lines too high/);
  });

  it('needs the offset pinned down, and starts over when it shrinks or flips', () => {
    const c = clock();
    const a = new TouchUpAdvisor({ wallNow: c.now });
    // Right after a page turn the drift belief is wide: no evidence either way, the clock keeps running.
    expect(read(a, 0, 15_000, (t) => est(t, 2))).toEqual([]);
    expect(read(a, 15_000, 3_000, (t) => est(t, 2, 1.5))).toEqual([]);
    expect(read(a, 18_000, 5_000, (t) => est(t, 2))).toHaveLength(1);

    const b = new TouchUpAdvisor({ wallNow: c.now });
    expect(read(b, 0, 15_000, (t) => est(t, 2))).toEqual([]);
    expect(read(b, 15_000, 1_000, (t) => est(t, 0.5))).toEqual([]); // back to small: start over
    expect(read(b, 16_000, 15_000, (t) => est(t, 2))).toEqual([]);
    expect(read(b, 31_000, 15_000, (t) => est(t, -2))).toEqual([]); // flipped: start over
    expect(read(b, 46_000, 10_000, (t) => est(t, -2))).toHaveLength(1);

    const unsure = new TouchUpAdvisor({ wallNow: c.now });
    expect(read(unsure, 0, 60_000, (t) => est(t, 3, 0.2, 0.3))).toEqual([]); // not sure of the line
    expect(unsure.onEstimate(null, PITCH)).toBeNull();
    expect(unsure.onEstimate(est(0, 3), 0)).toBeNull(); // no layout
  });
});

describe('lightingSentence', () => {
  it('says what changed in the reader’s terms', () => {
    expect(lightingSentence('sclera', -2)).toBe("It's darker than when you calibrated.");
    expect(lightingSentence('backlight', -1.5)).toBe("There's more light behind you than when you calibrated.");
    expect(lightingSentence('backlight', 1.5)).toBe('The light behind you has changed since you calibrated.');
    expect(lightingSentence('shade', 1)).toBe('The light on your face has changed since you calibrated.');
    expect(lightingSentence('range', null)).toBe('The light on your face has changed since you calibrated.');
    expect(lightingSentence(null, null)).toBe('The light on your face has changed since you calibrated.');
    expect(lightingSentence('glare', -1)).toBe('The reflections on your glasses have changed since you calibrated.');
  });
});
