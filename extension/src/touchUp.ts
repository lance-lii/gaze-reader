/**
 * When to offer the quick 5-dot refresh (a "touch-up" of the calibration).
 *
 * Two signs that the calibration no longer fits the reader's conditions:
 *  - the lighting differs from calibration (ConditionsWatch, after its 5-s hold);
 *  - the line tracker has learned a large vertical gaze offset (≥ 1.5 lines),
 *    pinned down by the text, for a while. The tracker copes with up to about
 *    ±5 lines, but at that size a refresh is cheaper than living with it: the
 *    first page after every reset starts from "calibration is about right".
 *
 * Offers are rate-limited across every tab and page load (the record lives in
 * chrome.storage.local): at most one per `minIntervalMs`, none for `snoozeMs`
 * after "Not now", none right after a calibration or refresh.
 */
import type { LightingComponent, LineEstimate } from '../../src/types';
import { isTrackedLineEstimate } from '../../src/reading/lineTracker';
import type { TouchUpRecord } from './extStorage';

export type { TouchUpRecord } from './extStorage';

export type TouchUpReason = 'lighting' | 'drift';

export interface TouchUpOffer {
  reason: TouchUpReason;
  /** What to tell the reader (one or two sentences, ends with what the refresh does). */
  text: string;
}

export interface TouchUpPolicy {
  /** Minimum time between two offers, in any tab. */
  minIntervalMs: number;
  /** Quiet time after the reader chose "Not now". */
  snoozeMs: number;
  /** No offer this soon after a calibration or refresh. */
  graceMs: number;
  /** Vertical offset (lines) that is worth a refresh… */
  driftLines: number;
  /** …held for this long (ms of reading, fixation time)… */
  driftHoldMs: number;
  /** …while the tracker is this sure of it (SD of the drift for the most likely line, lines)… */
  maxDriftSdLines: number;
  /** …and of the line (posterior of the most likely line). */
  minLineProbability: number;
}

export const DEFAULT_TOUCH_UP_POLICY: Readonly<TouchUpPolicy> = Object.freeze({
  minIntervalMs: 10 * 60_000,
  snoozeMs: 30 * 60_000,
  graceMs: 2 * 60_000,
  driftLines: 1.5,
  driftHoldMs: 20_000,
  maxDriftSdLines: 0.5,
  minLineProbability: 0.6,
});

const REFRESH = 'A quick 5-dot refresh (about 10 seconds) keeps page turns on time.';

export interface TouchUpAdvisorOptions {
  policy?: Partial<TouchUpPolicy>;
  /** Wall clock for the persisted record (default Date.now). */
  wallNow?: () => number;
  record?: TouchUpRecord | null;
  /** When the calibration in use was made or last refreshed (GazeModel.trainedAt, Date.now() ms). */
  calibratedAt?: number | null;
}

export class TouchUpAdvisor {
  private readonly policy: TouchUpPolicy;
  private readonly wallNow: () => number;
  private record: TouchUpRecord;
  private calibratedAt = -Infinity;
  /** Fixation time (performance.now()) since when the offset has been large, and its sign. */
  private driftSince: number | null = null;
  private driftSign = 0;
  /** An offer for this reason is on screen or was just made; one per episode. */
  private lightingEpisodeOffered = false;

  constructor(opts: TouchUpAdvisorOptions = {}) {
    this.policy = { ...DEFAULT_TOUCH_UP_POLICY, ...opts.policy };
    this.wallNow = opts.wallNow ?? Date.now;
    this.record = opts.record ?? { offeredAt: 0, snoozedUntil: 0 };
    if (Number.isFinite(opts.calibratedAt)) this.calibratedAt = opts.calibratedAt as number;
  }

  /** Another tab offered or was snoozed (storage changed). */
  setRecord(record: TouchUpRecord | null): void {
    this.record = record ?? { offeredAt: 0, snoozedUntil: 0 };
  }

  /** A calibration or refresh just finished (at `at`, default now): its offset is fresh, nothing to offer for a while. */
  noteCalibrated(at: number = this.wallNow()): void {
    this.calibratedAt = at;
    this.driftSince = null;
    this.lightingEpisodeOffered = false;
  }

  /** The lighting went back to calibration conditions: a later change is a new episode. */
  noteLightingRestored(): void {
    this.lightingEpisodeOffered = false;
  }

  /** Whether an offer may be shown now (rate limits only). */
  allowed(): boolean {
    const now = this.wallNow();
    const p = this.policy;
    if (now - this.calibratedAt < p.graceMs) return false;
    if (now < this.record.snoozedUntil) return false;
    return !(now - this.record.offeredAt < p.minIntervalMs && now >= this.record.offeredAt);
  }

  /** The rate-limit record, to persist after an offer or a snooze. */
  get current(): TouchUpRecord {
    return { ...this.record };
  }

  /**
   * The lighting now differs from calibration. Returns the offer to show (and
   * counts it as made: persist `current`), or null.
   */
  lightingChanged(dominant: LightingComponent | null, z: number | null): TouchUpOffer | null {
    if (this.lightingEpisodeOffered || !this.allowed()) return null;
    this.lightingEpisodeOffered = true;
    return this.offer({ reason: 'lighting', text: `${lightingSentence(dominant, z)} ${REFRESH}` });
  }

  /**
   * Every line estimate (text mode only: page mode's pseudo-lines were never
   * read, so their "drift" means nothing). `pitchPx` is the layout's line pitch.
   * Returns the offer to show (counted as made: persist `current`), or null.
   */
  onEstimate(est: LineEstimate | null, pitchPx: number): TouchUpOffer | null {
    const p = this.policy;
    if (!est || !(pitchPx > 0) || !Number.isFinite(est.driftY)) return null;
    const lines = est.driftY / pitchPx;
    const sdLines = isTrackedLineEstimate(est) && Number.isFinite(est.driftSdY) ? (est.driftSdY as number) / pitchPx : Infinity;
    const pinned = est.lineIndex >= 0 && est.probability >= p.minLineProbability && sdLines <= p.maxDriftSdLines;
    const sign = Math.sign(lines);
    if (!pinned) return null; // unsure: neither evidence for nor against, keep the clock running
    if (Math.abs(lines) < p.driftLines) {
      this.driftSince = null;
      return null;
    }
    if (this.driftSince === null || sign !== this.driftSign) {
      this.driftSince = est.t;
      this.driftSign = sign;
      return null;
    }
    if (est.t - this.driftSince < p.driftHoldMs || !this.allowed()) return null;
    this.driftSince = null;
    const n = Math.max(1, Math.round(Math.abs(lines)));
    // driftY is measured − true: positive means the gaze reads lower than the line being read.
    const text = `Gaze Reader has been placing your eyes about ${n} ${n === 1 ? 'line' : 'lines'} too ${lines > 0 ? 'low' : 'high'}. ${REFRESH}`;
    return this.offer({ reason: 'drift', text });
  }

  /** The reader chose "Not now": returns the record to persist. */
  snooze(): TouchUpRecord {
    this.record = { ...this.record, snoozedUntil: this.wallNow() + this.policy.snoozeMs };
    return { ...this.record };
  }

  private offer(o: TouchUpOffer): TouchUpOffer {
    this.record = { ...this.record, offeredAt: this.wallNow() };
    return o;
  }
}

/** Why the offer is made, in the reader's terms. `z` > 0 means more of the dominant component than at calibration. */
export function lightingSentence(dominant: LightingComponent | null, z: number | null): string {
  switch (dominant) {
    case 'sclera':
      if (z !== null && z > 0) return "It's brighter than when you calibrated.";
      if (z !== null && z < 0) return "It's darker than when you calibrated.";
      return 'The light has changed since you calibrated.';
    case 'backlight':
      // backlight = log2(sclera / background): lower means the background got brighter.
      if (z !== null && z < 0) return "There's more light behind you than when you calibrated.";
      return 'The light behind you has changed since you calibrated.';
    case 'side':
      return 'The light comes from a different side than when you calibrated.';
    case 'glare':
      if (z !== null && z > 0) return 'There are new reflections on your glasses or eyes.';
      return 'The reflections on your glasses have changed since you calibrated.';
    default:
      return 'The light on your face has changed since you calibrated.';
  }
}
