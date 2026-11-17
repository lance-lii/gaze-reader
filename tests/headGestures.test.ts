/**
 * Head gestures against the simulated readers of bench/endtoend: people who read, fidget, lean,
 * look at their phone, get walked past and cover half their face, and never make a gesture. Any
 * gesture the detector reports here is a false one: a page turned, or reading paused, by a reader
 * who did nothing. The synthetic gestures themselves are in src/gaze/headGestures.test.ts.
 *
 * The simulated head follows the eyes a little and changes posture, but it doesn't swing round
 * when the reader looks away, as a real head does; those movements are covered by the synthetic
 * tests (looking away and back is too slow to be a turn). The simulator has no eyebrows.
 */
import { describe, expect, it } from 'vitest';
import { HeadGestureDetector, type HeadGesture } from '../src/gaze/headGestures';
import { frameFeatures } from '../bench/lighting/faceSim';
import { SCENARIOS, World, type Scenario } from '../bench/endtoend/world';

/** Gestures reported over one session; the page is turned for the reader a moment after they finish it. */
function falseGestures(scenario: Scenario, seed: number, minutes: number): { gesture: HeadGesture; t: number; active: string[] }[] {
  const world = new World({ seed, scenario, minutes });
  const det = new HeadGestureDetector();
  const out: { gesture: HeadGesture; t: number; active: string[] }[] = [];
  const pageMs = world.layout.viewport.bottom - world.layout.viewport.top;
  for (let frame = world.next(); frame; frame = world.next()) {
    const features = frame.frame ? frameFeatures(frame.frame) : null;
    const g = det.update({ t: frame.t, features });
    if (g) out.push({ gesture: g, t: frame.t, active: frame.truth.active });
    const since = frame.truth.lingerSince;
    if (since !== null && frame.t - since > 600) world.scrollTo(Math.min(world.doc.scrollHeight - pageMs, world.layout.scrollTop + 0.85 * pageMs));
  }
  return out;
}

// Seeds 1 and 2 of every scenario (4.5 simulated hours) gave no gesture when the thresholds were set; seed 1 is kept as the guard.
describe('head gestures: readers who make none (simulated, fixed seeds)', { timeout: 120_000 }, () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: no gesture in 15 min`, () => {
      for (const seed of [1]) {
        const found = falseGestures(scenario, seed, 15);
        expect(found, `seed ${seed}`).toEqual([]);
      }
    });
  }
});
