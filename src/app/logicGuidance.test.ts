import { describe, expect, it } from 'vitest';
import type { AppEvents, GazeSample } from '../types';
import { createEventBus } from '../core/events';
import { QUIPS } from '../buddy/quips';
import {
  AppearanceChangeFilter,
  DriftWatch,
  GuidanceGate,
  SustainedFlags,
  accuracyCheckView,
  coachFlag,
  correctedGazeBus,
  driftOwnerKey,
  formatLines,
  sameRidgeCore,
  type AccuracyCheckView as AccuracyView,
} from './logic';
import { offsetVerdict } from './offsetWords';

/** Lighting & guidance helpers of the app shell (src/app/logic.ts). */

const PITCH = 40;

describe('DriftWatch', () => {
  /** Pushes one estimate every `dt` ms from `from` to `to` with a drift of `lines`. */
  function run(w: DriftWatch, from: number, to: number, lines: number, dt = 250, pinned = true): boolean {
    let out = false;
    for (let t = from; t <= to; t += dt) out = w.push(t, lines * PITCH, PITCH, pinned);
    return out;
  }

  it('fires only after about 20 s beyond 1.5 lines, in one direction', () => {
    const w = new DriftWatch();
    expect(run(w, 0, 19_000, 2)).toBe(false);
    expect(run(w, 19_250, 20_500, 2)).toBe(true);
    expect(w.direction).toBe(1);
    expect(w.peakLines).toBeCloseTo(2);
  });

  it('never fires under the threshold, and restarts when the sign flips', () => {
    const w = new DriftWatch();
    expect(run(w, 0, 60_000, 1.4)).toBe(false);
    run(w, 60_250, 75_000, 2);
    expect(run(w, 75_250, 90_000, -2)).toBe(false); // 15 s of the other sign
    expect(run(w, 90_250, 96_000, -2)).toBe(true);
    expect(w.direction).toBe(-1);
  });

  it('rides out short dips but restarts after a long one or a gap in the data', () => {
    const w = new DriftWatch();
    run(w, 0, 10_000, 2);
    run(w, 10_250, 12_000, 1); // 2 s dip: kept
    expect(run(w, 12_250, 21_000, 2)).toBe(true);
    w.reset();
    run(w, 0, 10_000, 2);
    run(w, 10_250, 14_000, 1); // 4 s dip: restarted
    expect(run(w, 14_250, 25_000, 2)).toBe(false);
    w.reset();
    run(w, 0, 10_000, 2);
    expect(run(w, 17_000, 22_000, 2)).toBe(false); // 7 s without estimates (reader away)
  });

  it('ignores unpinned estimates (neither evidence for nor against)', () => {
    const w = new DriftWatch();
    run(w, 0, 10_000, 2);
    run(w, 10_250, 13_000, 0, 250, false);
    expect(run(w, 13_250, 21_000, 2)).toBe(true);
    const u = new DriftWatch();
    expect(run(u, 0, 60_000, 3, 250, false)).toBe(false);
  });

  it('needs most of the stretch over the threshold', () => {
    const w = new DriftWatch({ graceMs: 10_000 });
    let out = false;
    // Alternating 2 s over / 2 s under: half the estimates over.
    for (let t = 0; t <= 40_000; t += 250) out = w.push(t, (Math.floor(t / 2000) % 2 === 0 ? 2 : 1) * PITCH, PITCH);
    expect(out).toBe(false);
  });

  it('survives bad input', () => {
    const w = new DriftWatch();
    expect(w.push(Number.NaN, 80, PITCH)).toBe(false);
    expect(w.push(0, Number.NaN, PITCH)).toBe(false);
    expect(w.push(0, 80, 0)).toBe(false);
  });
});

describe('GuidanceGate', () => {
  it('holds offers while a book settles in, then allows one per 10 min and two per book', () => {
    const g = new GuidanceGate();
    g.startSession(0);
    expect(g.mayOffer(10_000)).toBe(false);
    expect(g.mayOffer(20_000)).toBe(true);
    g.noteOffered(20_000);
    expect(g.mayOffer(20_000 + 9 * 60_000)).toBe(false);
    expect(g.mayOffer(20_000 + 10 * 60_000)).toBe(true);
    g.noteOffered(20_000 + 10 * 60_000);
    expect(g.mayOffer(20_000 + 30 * 60_000)).toBe(false); // two per book
    g.startSession(40 * 60_000);
    expect(g.mayOffer(40 * 60_000 + 20_000)).toBe(true);
  });

  it('stays quiet after a correction and after "Not now"', () => {
    const g = new GuidanceGate();
    g.startSession(0);
    g.noteFixed(60_000);
    expect(g.mayOffer(60_000 + 2 * 60_000)).toBe(false);
    expect(g.mayOffer(60_000 + 3 * 60_000)).toBe(true);
    g.snooze(300_000);
    expect(g.mayOffer(300_000 + 29 * 60_000)).toBe(false);
    expect(g.mayOffer(300_000 + 30 * 60_000)).toBe(true);
  });

  it('lets guidance through only right after a page turn or during a pause in reading', () => {
    const g = new GuidanceGate();
    g.startSession(0);
    expect(g.isPause(1000)).toBe(true); // nothing read yet
    g.noteReading(10_000);
    expect(g.isPause(11_000)).toBe(false); // reading a line
    expect(g.isPause(12_600)).toBe(true); // 2.6 s without a fixation
    g.noteReading(20_000);
    g.notePageTurn(20_500);
    expect(g.isPause(21_000)).toBe(true);
    g.noteReading(21_500);
    expect(g.isPause(22_100)).toBe(false);
  });

  it('coaches once per session', () => {
    const g = new GuidanceGate();
    g.startSession(0);
    expect(g.hasCoached).toBe(false);
    g.noteCoached();
    expect(g.hasCoached).toBe(true);
    g.startSession(1000);
    expect(g.hasCoached).toBe(false);
  });
});

describe('AppearanceChangeFilter', () => {
  it('merges the eyelid and lighting reports of one change, keeps separate changes', () => {
    const f = new AppearanceChangeFilter();
    expect(f.accept('lids', 10_000, 12_300)).toBe(true);
    expect(f.accept('lighting', 11_500, 21_000)).toBe(false); // same change, seen later
    expect(f.accept('lighting', 40_000, 50_000)).toBe(true); // a later change
    expect(f.accept('lids', 43_000, 52_000)).toBe(false);
  });

  it('always passes refreshes and manual reports, which re-anchor', () => {
    const f = new AppearanceChangeFilter();
    expect(f.accept('lids', 10_000, 12_000)).toBe(true);
    expect(f.accept('refresh', 13_000, 13_000)).toBe(true);
    expect(f.accept('lighting', 11_000, 16_000)).toBe(true); // after a refresh it's news again
    expect(f.accept('manual', 16_000, 16_000)).toBe(true);
    f.reset();
    expect(f.accept('lids', 10_000, 17_000)).toBe(true);
  });

  it('forgets old reports', () => {
    const f = new AppearanceChangeFilter();
    expect(f.accept('lids', 10_000, 12_000)).toBe(true);
    expect(f.accept('lids', 14_000, 60_000)).toBe(true); // 48 s later: memory expired
  });
});

describe('driftOwnerKey', () => {
  it('ties webcam drift to the calibration and other drift to the source', () => {
    expect(driftOwnerKey('webcam', 123)).toBe('webcam:123');
    expect(driftOwnerKey('webcam', 124)).not.toBe(driftOwnerKey('webcam', 123));
    expect(driftOwnerKey('webcam', null)).toBeNull();
    expect(driftOwnerKey('mouse', 123)).toBe('mouse');
    expect(driftOwnerKey('simulated', undefined)).toBe('simulated');
    expect(driftOwnerKey(null, 1)).toBeNull();
  });
});

describe('sameRidgeCore', () => {
  const base = { version: 1, kind: 'k', featureLength: 2, mean: [1, 2], std: [1, 1], quad: [0], expMean: [0], expStd: [1], wx: [1, 2], bx: 3, wy: [4, 5], by: 6, lambda: 0.1, adjust: { sx: 1, ox: 0, sy: 1, oy: 0 }, trainedAt: 1 };
  it('recognises a refresh (only the screen-space correction and metadata changed)', () => {
    expect(sameRidgeCore({ ...base, adjust: { sx: 1, ox: 5, sy: 1.02, oy: -80 }, trainedAt: 2, environment: null }, base)).toBe(true);
  });
  it('tells a new calibration apart', () => {
    expect(sameRidgeCore({ ...base, wy: [4, 5.0001] }, base)).toBe(false);
    expect(sameRidgeCore({ ...base, kind: 'other' }, base)).toBe(false);
    expect(sameRidgeCore({ version: 1 }, { version: 1 })).toBe(false);
    expect(sameRidgeCore(null, base)).toBe(false);
  });
});

describe('accuracyCheckView', () => {
  const check = (y: number, over: Partial<AppEvents['accuracy-check']> = {}): AppEvents['accuracy-check'] => ({
    meanErrorPx: 30 + Math.abs(y) * PITCH,
    offsetXPx: 3,
    offsetYPx: y * PITCH,
    offsetYLines: y,
    applied: false,
    ...over,
  });

  it('grades the offset with the overlay’s words and rounding', () => {
    expect(accuracyCheckView(check(0.3))).toMatchObject({ tone: 'success', quip: 'accuracyGood', offerTouchUp: false, badge: 'On target' });
    const close = accuracyCheckView(check(-0.6));
    expect(close).toMatchObject({ tone: 'info', title: 'Close enough', quip: 'accuracyClose', offerTouchUp: false });
    expect(close.message).toBe('Tracking reads about half a line high. The reader corrects that much by itself.');
    const slightly = accuracyCheckView(check(-1.2));
    expect(slightly).toMatchObject({ tone: 'info', title: 'Tracking is slightly off', quip: 'accuracySlightlyOff', offerTouchUp: true });
    expect(slightly.message).toBe('Tracking reads about 1 line high. A quick 5-dot refresh re-centres it.');
    const off = accuracyCheckView(check(2.5));
    expect(off).toMatchObject({ tone: 'warn', title: 'Tracking has drifted', quip: 'accuracyOff', offerTouchUp: true, badge: 'Drifted' });
    expect(off.message).toBe('Tracking reads about 3 lines low. A quick 5-dot refresh re-centres it.');
  });

  it('says when the correction was applied, and when nothing could be measured', () => {
    const fixed = accuracyCheckView(check(3, { applied: true }));
    expect(fixed).toMatchObject({ tone: 'success', quip: 'accuracyFixed', offerTouchUp: false });
    expect(fixed.message).toBe('Tracking read about 3 lines low. That’s fixed now.');
    expect(accuracyCheckView(check(0, { meanErrorPx: Number.NaN, offsetYPx: Number.NaN, offsetYLines: Number.NaN }))).toMatchObject({
      tone: 'error',
      quip: 'accuracyFailed',
      badge: null,
    });
  });

  it('is not "on target" when the top and bottom are off in opposite directions (regression: the mean hid a 20 % gain)', () => {
    // CHECK_TARGETS at y = 0.15, 0.5, 0.5, 0.85, 0.85 of an 800 px viewport, 30 px lines, y' = c + g·(y − c).
    for (const [gain, expected] of [
      [1.1, 'accuracyGood'],
      [1.2, 'accuracyStretched'],
      [1.3, 'accuracyStretched'],
    ] as const) {
      const maxDot = ((gain - 1) * 0.35 * 800) / 30;
      const v = accuracyCheckView(check(0, { meanErrorPx: 22 * (gain - 1) * 10, offsetYPx: 0, maxDotYLines: maxDot }));
      expect(v.quip, `gain ${gain}`).toBe(expected);
      if (expected === 'accuracyStretched') {
        expect(v.title).not.toMatch(/on target/);
        expect(v.message).toMatch(/up to \d lines off near the top and bottom/);
        expect(v).toMatchObject({ offerRecalibrate: true, offerTouchUp: false });
      }
    }
  });

  it('agrees with the overlay’s badge across a grid of offsets (regression: "Slightly off" on screen, "close enough" in the toast)', () => {
    const toneFor: Record<string, AccuracyView['tone']> = { 'On target': 'success', 'Close enough': 'info', 'Slightly off': 'info', Drifted: 'warn' };
    for (const y of [0, 0.3, -0.6, 0.8, -1, 1.4, 1.6, -1.9, 2.5, -4]) {
      for (const xFrac of [0, 0.03, -0.08, 0.15]) {
        for (const maxDot of [Number.NaN, Math.abs(y) + 0.3, Math.abs(y) + 1.6]) {
          const input = check(y, { offsetXFrac: xFrac, ...(Number.isNaN(maxDot) ? {} : { maxDotYLines: maxDot }) });
          const overlay = offsetVerdict(y, xFrac, maxDot);
          const v = accuracyCheckView(input);
          const at = `y ${y}, x ${xFrac}, dot ${maxDot}`;
          expect(v.badge, at).toBe(overlay.badge);
          expect(v.tone, at).toBe(toneFor[overlay.badge]);
          expect(v.offerTouchUp || v.offerRecalibrate, at).toBe(overlay.words.worthCorrecting);
          if (overlay.badge === 'On target') expect(v.quip, at).toBe('accuracyGood');
          else if (overlay.badge === 'Close enough') expect(v.quip, at).toBe('accuracyClose');
          else {
            expect(['accuracySlightlyOff', 'accuracyOff', 'accuracySideways', 'accuracyStretched'], at).toContain(v.quip);
            // Same words, same rounding as the overlay's "Tracking reads …" title.
            expect(v.message.startsWith(`Tracking reads ${overlay.words.text}.`), at).toBe(true);
          }
          // "A few lines off" only when there is a vertical offset to speak of.
          if (v.quip === 'accuracyOff') expect(overlay.words.vertical, at).not.toBeNull();
        }
      }
    }
    // The cases from the review.
    expect(accuracyCheckView(check(0.8)).quip).toBe('accuracySlightlyOff');
    expect(accuracyCheckView(check(1.4)).title).toBe('Tracking is slightly off');
    expect(accuracyCheckView(check(1.6)).message).toBe('Tracking reads about 2 lines low. A quick 5-dot refresh re-centres it.');
    const sideways = accuracyCheckView(check(0.2, { offsetXFrac: 0.15 }));
    expect(sideways).toMatchObject({ badge: 'Drifted', title: 'Tracking has drifted', quip: 'accuracySideways', offerTouchUp: true });
    expect(sideways.message).toBe('Tracking reads to the right. A quick 5-dot refresh re-centres it.');
  });

  it('only names quips Dewey has', () => {
    for (const y of [0, 0.6, 1, 2, Number.NaN]) {
      for (const over of [{}, { offsetXFrac: 0.2 }, { maxDotYLines: 2.5 }, { applied: true }]) {
        const v = accuracyCheckView(check(y, Number.isNaN(y) ? { meanErrorPx: Number.NaN } : over));
        expect(QUIPS[v.quip]?.length ?? 0, v.quip).toBeGreaterThan(0);
      }
    }
  });

  it('formatLines', () => {
    expect(formatLines(1)).toBe('1 line');
    expect(formatLines(-2)).toBe('2 lines');
    expect(formatLines(1.46)).toBe('1.5 lines');
    expect(formatLines(0.01)).toBe('0.1 lines');
    expect(formatLines(Number.NaN)).toBe('? lines');
  });
});

describe('lighting coaching', () => {
  it('coaches a flag only once it has held for a while, most useful first', () => {
    const s = new SustainedFlags(8000);
    expect(s.update(0, ['glare', 'side-lit'])).toEqual([]);
    expect(s.update(5000, ['glare', 'backlit'])).toEqual([]);
    expect(s.update(8000, ['glare', 'backlit'])).toEqual(['glare']);
    expect(coachFlag(s.update(13_000, ['glare', 'backlit']))).toBe('backlit');
    expect(s.update(14_000, ['backlit'])).toEqual(['backlit']);
    expect(s.update(15_000, ['glare', 'backlit'])).toEqual(['backlit']); // glare restarted
    expect(coachFlag(['side-lit', 'unstable', 'overexposed'])).toBeNull();
    s.reset();
    expect(s.update(16_000, ['backlit'])).toEqual([]);
  });

  it('has a Dewey line for every coached flag', () => {
    for (const key of ['lightBacklit', 'lightGlare', 'lightDark', 'lightChanged', 'driftOffer', 'trackerUpgraded'] as const) {
      expect(QUIPS[key]?.length ?? 0, key).toBeGreaterThan(0);
    }
  });
});

describe('correctedGazeBus', () => {
  const sample = (y: number): GazeSample => ({ t: 1, x: 10, y, rawX: 10, rawY: y + 5, valid: true, confidence: 1, source: 'webcam' });

  it('hands gaze listeners the corrected sample and passes everything else through', () => {
    const bus = createEventBus();
    const view = correctedGazeBus(bus, (s) => ({ ...s, y: s.y - 80, rawY: s.rawY - 80 }));
    const seen: GazeSample[] = [];
    const turns: number[] = [];
    view.on('gaze', (s) => seen.push(s));
    view.on('page-turn', (e) => turns.push(e.to));
    const direct: GazeSample[] = [];
    bus.on('gaze', (s) => direct.push(s));
    bus.emit('gaze', sample(300));
    bus.emit('page-turn', { from: 0, to: 500, auto: true, reason: 'x', pageIndex: 1 });
    expect(seen.map((s) => [s.y, s.rawY])).toEqual([[220, 225]]);
    expect(direct[0]!.y).toBe(300); // the real bus is untouched
    expect(turns).toEqual([500]);
    // Emitting through the view reaches everyone.
    view.emit('buddy-poke', {});
    let once = 0;
    view.once('gaze', () => once++);
    bus.emit('gaze', sample(100));
    bus.emit('gaze', sample(100));
    expect(once).toBe(1);
  });

  it('unsubscribes, and clear() removes only its own listeners', () => {
    const bus = createEventBus();
    const view = correctedGazeBus(bus, (s) => s);
    let a = 0;
    let b = 0;
    let c = 0;
    const off = view.on('gaze', () => a++);
    view.on('gaze', () => b++);
    bus.on('gaze', () => c++);
    off();
    off(); // twice is harmless
    bus.emit('gaze', sample(1));
    view.clear();
    bus.emit('gaze', sample(1));
    expect([a, b, c]).toEqual([0, 1, 2]);
  });
});
