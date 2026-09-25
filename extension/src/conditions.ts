/**
 * The reader's conditions compared with calibration, for one page session.
 *
 * Two watchers from the app, fed the frames relayed from the offscreen
 * document:
 *  - LightingWatch (src/gaze/lighting.ts) reads the lighting numbers the
 *    offscreen document attaches to a few frames a second: coaching flags
 *    (dark, back-lit, glare…) and "the light differs from calibration";
 *  - AppearanceMonitor (src/gaze/appearance.ts) watches the eyelids (aperture
 *    and MediaPipe's eyeSquint score) against the calibration's baseline and
 *    reports steps: squinting when a light goes on, wider eyes when it goes off.
 *
 * Both are turned into the app's events. 'lighting-state' goes out about once a
 * second. 'appearance-changed' goes out when the gaze bias has probably jumped,
 * which the reading layer answers by re-learning its vertical offset
 * (LineTracker.appearanceChangedAt). One physical change is often seen by both
 * watchers: the lids within ~2 s, the lighting after its 5-s hold. It is then
 * reported once, by whichever saw it first.
 */
import type { AppEvents, CalibrationEnvironment, FeatureFrame, LightingComponent } from '../../src/types';
import { LightingWatch, type LightingComparison, type LightingWatchOptions } from '../../src/gaze/lighting';
import { AppearanceMonitor, type AppearanceChange, type AppearanceMonitorOptions } from '../../src/gaze/appearance';

export type LightingState = AppEvents['lighting-state'];
export type AppearanceEvent = AppEvents['appearance-changed'];

/** The lighting now differs from calibration: what moved, for the touch-up offer's wording. */
export interface LightingChange {
  /** When the change began (estimated), performance.now() ms. */
  t: number;
  dominant: LightingComponent | null;
  /** Signed change of the dominant component in tolerance units (positive = more of it). */
  z: number | null;
}

export interface ConditionsUpdate {
  /** Emit as 'lighting-state'. */
  lighting: LightingState | null;
  /** Emit as 'appearance-changed' and pass `t` to LineTracker.appearanceChangedAt. */
  appearance: AppearanceEvent | null;
  /** Set on the update where the lighting is first judged different from calibration. */
  lightingChanged: LightingChange | null;
  /** The lid monitor's report, when it made one (details for diagnostics). */
  lids: AppearanceChange | null;
}

export interface ConditionsWatchOptions {
  /**
   * A lighting change whose estimated onset is within this of a reported lid
   * change is the same change (default 5000 ms)…
   */
  sameOnsetMs?: number;
  /**
   * …and a return to the calibration lighting (which comes without an onset
   * estimate) within this long after a reported lid change is too (default 15 000 ms).
   */
  restoreAfterLidsMs?: number;
  lighting?: LightingWatchOptions;
  appearance?: AppearanceMonitorOptions;
}

const NO_UPDATE: ConditionsUpdate = Object.freeze({ lighting: null, appearance: null, lightingChanged: null, lids: null });

export class ConditionsWatch {
  private readonly lightingWatch: LightingWatch;
  private readonly lids: AppearanceMonitor;
  private readonly sameOnsetMs: number;
  private readonly restoreAfterLidsMs: number;
  private readonly holdMs: number;
  /** Onset and report time of the last lid change reported. */
  private lastLids: { t: number; at: number } | null = null;

  constructor(environment: CalibrationEnvironment | null = null, opts: ConditionsWatchOptions = {}) {
    this.sameOnsetMs = opts.sameOnsetMs ?? 5_000;
    this.restoreAfterLidsMs = opts.restoreAfterLidsMs ?? 15_000;
    this.holdMs = opts.lighting?.holdMs ?? 5_000;
    this.lightingWatch = new LightingWatch(environment?.lighting ?? null, opts.lighting);
    this.lids = new AppearanceMonitor(environment?.appearance ?? null, {
      ...opts.appearance,
      referencePitch: opts.appearance?.referencePitch ?? environment?.lighting?.pitch ?? null,
    });
  }

  /** A new calibration, a quick refresh, or none: both watchers start over against it. */
  setEnvironment(environment: CalibrationEnvironment | null): void {
    this.lightingWatch.setReference(environment?.lighting ?? null);
    this.lids.setBaseline(environment?.appearance ?? null, environment?.lighting?.pitch ?? null);
    this.lastLids = null;
  }

  /** The camera restarted (tab hidden and back, reconnect): forget the session, keep the references. */
  reset(): void {
    this.lightingWatch.reset();
    this.lids.reset();
    this.lastLids = null;
  }

  get lightingState(): LightingState {
    return this.lightingWatch.state;
  }

  /** Whether each watcher has something to compare against. */
  get watching(): { lighting: boolean; lids: boolean } {
    return { lighting: this.lightingWatch.reference !== null, lids: this.lids.state !== 'off' };
  }

  /** Lid monitor internals for the debug overlay and diagnostics. */
  get lidMonitor(): Pick<AppearanceMonitor, 'state' | 'residualZ' | 'squintZ' | 'levelVsCalibration' | 'pendingShiftSince'> {
    return this.lids;
  }

  /**
   * One camera frame. `gazeYNorm` is where a lid-free model puts the gaze, as
   * a fraction of the calibration viewport's height (null when unknown).
   */
  onFrame(frame: FeatureFrame, gazeYNorm: number | null): ConditionsUpdate {
    if (!Number.isFinite(frame.t)) return NO_UPDATE;
    this.lightingWatch.onFrame(frame);
    const lids = frame.faceFound
      ? this.lids.update({ t: frame.t, features: frame.features, quality: frame.quality, gazeYNorm })
      : null;
    let appearance: AppearanceEvent | null = null;
    if (lids) {
      appearance = { t: lids.t, reason: 'lids', detail: lids.detail };
      this.lastLids = { t: lids.t, at: frame.t };
    }
    const ticked = this.tick(frame.t);
    return {
      lighting: ticked.lighting,
      appearance: appearance ?? ticked.appearance,
      lightingChanged: ticked.lightingChanged,
      lids,
    };
  }

  /**
   * Recomputes the lighting comparison (at most once a second; frames call it
   * too). Call it on a timer as well, so flags go stale when frames stop.
   */
  tick(now: number): ConditionsUpdate {
    const u = this.lightingWatch.tick(now);
    if (!u) return NO_UPDATE;
    let appearance: AppearanceEvent | null = null;
    let lightingChanged: LightingChange | null = null;
    if (u.transition === 'changed') {
      const onset = u.changedAt ?? now;
      lightingChanged = { t: onset, dominant: u.state.dominant, z: dominantZ(u.comparison, u.state.dominant) };
      const seen = this.lastLids !== null && Math.abs(this.lastLids.t - onset) <= this.sameOnsetMs;
      if (!seen) appearance = { t: onset, reason: 'lighting', detail: describeChange(u.state.dominant) };
    } else if (u.transition === 'changed-again') {
      // Already changed, and now as much again (a lamp, then the overhead light off): the gaze
      // bias moved again. Same episode for the touch-up offer, so no `lightingChanged`.
      const onset = u.changedAt ?? now;
      const seen = this.lastLids !== null && Math.abs(this.lastLids.t - onset) <= this.sameOnsetMs;
      if (!seen) appearance = { t: onset, reason: 'lighting', detail: 'lighting changed again' };
    } else if (u.transition === 'restored') {
      const seen = this.lastLids !== null && now - this.lastLids.at <= this.restoreAfterLidsMs;
      // The distance has been back under the threshold for the hold time, so it began at least that long ago.
      if (!seen) appearance = { t: now - this.holdMs, reason: 'lighting', detail: 'lighting back to how it was at calibration' };
    }
    return { lighting: u.state, appearance, lightingChanged, lids: null };
  }
}

function dominantZ(cmp: LightingComparison | null, dominant: LightingComponent | null): number | null {
  if (!cmp || !dominant) return null;
  const z = cmp.z[dominant];
  return Number.isFinite(z) ? z : null;
}

function describeChange(dominant: LightingComponent | null): string {
  return dominant ? `lighting changed since calibration (${dominant})` : 'lighting changed since calibration';
}
