import { OneEuroFilter2D, type OneEuroParams } from '../signal/oneEuro';
import type { FeatureFrame, FeatureSource, GazeModel, GazeSample, GazeSource, Point, Unsubscribe } from '../types';

export interface BlinkGateOptions {
  /** Blink score above which a frame may be a blink. */
  threshold: number;
  /** Blink score treated as eyes closed no matter how long it lasts. */
  closedThreshold: number;
  /** Longer partial-closure episodes are lowered lids (reading the bottom of the screen), not blinks. */
  maxBlinkMs: number;
  /** Frames right after a blink are suppressed too: the iris landmark lags the lid. */
  settleMs: number;
  /**
   * Lid aperture (EyeFeatures.openness, / eye width) below which the eyes count
   * as closed while the blink score is above `threshold`. Some faces never
   * reach `closedThreshold` with their eyes shut; without this a long closure
   * would pass as "lowered lids". Lowered lids measure ≈ 0.12–0.2, shut < 0.08.
   */
  closedOpenness: number;
}

export const DEFAULT_BLINK_GATE: Readonly<BlinkGateOptions> = Object.freeze({
  threshold: 0.5,
  closedThreshold: 0.85,
  maxBlinkMs: 400,
  settleMs: 50,
  closedOpenness: 0.08,
});

/**
 * Decides which frames to drop around blinks.
 *
 * MediaPipe's eyeBlink scores also rise when the reader looks down, because
 * the upper lid follows the eye. Dropping every frame above 0.5 would blank
 * the gaze exactly when the reader reaches the last lines of the page, which is
 * when page turning needs it most. A blink is short (100–400 ms), so a
 * moderate score that persists is treated as lowered lids and let through,
 * while a near-closed score or a collapsed lid aperture is always dropped.
 */
export class BlinkGate {
  private readonly opts: BlinkGateOptions;
  private episodeStart: number | null = null;
  private lastSuppressedAt: number | null = null;

  constructor(opts: Partial<BlinkGateOptions> = {}) {
    this.opts = { ...DEFAULT_BLINK_GATE, ...opts };
  }

  /**
   * @param openness lid aperture / eye width (EyeFeatures.openness); optional.
   * @returns true if the frame at `t` should be treated as a blink (invalid).
   */
  update(t: number, blink: number, openness?: number): boolean {
    const { threshold, closedThreshold, maxBlinkMs, settleMs, closedOpenness } = this.opts;
    const score = Number.isFinite(blink) ? blink : 0;

    if (score > threshold) {
      this.episodeStart ??= t;
      const shut = score >= closedThreshold || (openness !== undefined && Number.isFinite(openness) && openness < closedOpenness);
      if (shut || t - this.episodeStart < maxBlinkMs) {
        this.lastSuppressedAt = t;
        return true;
      }
      return false;
    }

    this.episodeStart = null;
    return this.lastSuppressedAt !== null && t - this.lastSuppressedAt < settleMs;
  }

  reset(): void {
    this.episodeStart = null;
    this.lastSuppressedAt = null;
  }
}

export interface WebcamGazeSourceOptions {
  features: FeatureSource;
  /** Read on every frame, so a recalibration takes effect immediately. */
  getModel: () => GazeModel | null;
  filter?: Partial<OneEuroParams>;
  blink?: Partial<BlinkGateOptions>;
  /** Invalid stretch after which smoothing restarts instead of gliding from a stale point. Default 300 ms. */
  resetAfterInvalidMs?: number;
  /**
   * Predictions further than this many viewport sizes outside the viewport are
   * treated as invalid: the features are outside what calibration saw. Default 1.
   */
  maxOffscreenViewports?: number;
  /** Local clock (default performance.now). */
  now?: () => number;
}

interface LastPoint {
  x: number;
  y: number;
  rawX: number;
  rawY: number;
}

/** Frame times further than this from the local clock are re-stamped (see `stampOf`). */
const MAX_CLOCK_SKEW_MS = 1000;

/**
 * FeatureSource + calibrated GazeModel → smoothed GazeSamples, one per frame.
 * Does not own the FeatureSource: start() only subscribes.
 */
export class WebcamGazeSource implements GazeSource {
  readonly kind = 'webcam' as const;

  private readonly features: FeatureSource;
  private readonly getModel: () => GazeModel | null;
  private readonly filter: OneEuroFilter2D;
  private readonly blinkGate: BlinkGate;
  private readonly resetAfterInvalidMs: number;
  private readonly maxOffscreen: number;
  private readonly now: () => number;
  private readonly listeners = new Set<(sample: GazeSample) => void>();

  private unsubscribe: Unsubscribe | null = null;
  private lastModel: GazeModel | null = null;
  private lastValidT: number | null = null;
  private lastT = -Infinity;
  private last: LastPoint | null = null;

  constructor(opts: WebcamGazeSourceOptions) {
    this.features = opts.features;
    this.getModel = opts.getModel;
    this.filter = new OneEuroFilter2D(opts.filter);
    this.blinkGate = new BlinkGate(opts.blink);
    // NaN would silently disable the reset, or reject every sample; Infinity is a valid "never".
    this.resetAfterInvalidMs = nonNegativeOr(opts.resetAfterInvalidMs, 300);
    this.maxOffscreen = nonNegativeOr(opts.maxOffscreenViewports, 1);
    this.now = opts.now ?? (() => performance.now());
  }

  get running(): boolean {
    return this.unsubscribe !== null;
  }

  start(): Promise<void> {
    if (!this.unsubscribe) this.unsubscribe = this.features.onFrame(this.handleFrame);
    return Promise.resolve();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.filter.reset();
    this.blinkGate.reset();
    this.lastModel = null;
    this.lastValidT = null;
    this.lastT = -Infinity;
    this.last = null;
  }

  onSample(cb: (sample: GazeSample) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private readonly handleFrame = (frame: FeatureFrame): void => {
    const t = this.stampOf(frame);
    const point = this.predict(frame, t);
    if (point) this.emitValid(t, point, frame.quality);
    else this.emitInvalid(t);
  };

  /**
   * Frame times should already be local performance.now() values, but a remote
   * source (the extension's offscreen document) has a different time origin.
   * Out-of-range times are replaced with the local clock, which only adds
   * transport latency.
   */
  private stampOf(frame: FeatureFrame): number {
    const now = this.now();
    let t = Number.isFinite(frame.t) && frame.t <= now + 5 && now - frame.t < MAX_CLOCK_SKEW_MS ? frame.t : now;
    if (t < this.lastT) t = this.lastT; // never let time run backwards for consumers
    this.lastT = t;
    return t;
  }

  private predict(frame: FeatureFrame, t: number): Point | null {
    const f = frame.faceFound ? frame.features : null;
    if (!f) {
      this.blinkGate.reset();
      return null;
    }
    if (this.blinkGate.update(t, f.blink, f.openness)) return null;

    let model: GazeModel | null;
    try {
      model = this.getModel();
    } catch {
      model = null; // still exactly one (invalid) sample for this frame
    }
    if (model !== this.lastModel) {
      // A new calibration maps features differently; don't smooth across it.
      this.lastModel = model;
      this.filter.reset();
    }
    if (!model) return null;

    let p: Point | null;
    try {
      p = model.predict(f);
    } catch {
      return null;
    }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return this.plausible(p, model) ? p : null;
  }

  private plausible(p: Point, model: GazeModel): boolean {
    const w = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : model.viewport.width;
    const h = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : model.viewport.height;
    if (!(w > 0 && h > 0)) return true;
    const m = this.maxOffscreen;
    return p.x >= -m * w && p.x <= (1 + m) * w && p.y >= -m * h && p.y <= (1 + m) * h;
  }

  private emitValid(t: number, raw: Point, quality: number): void {
    if (this.lastValidT === null || t - this.lastValidT > this.resetAfterInvalidMs) this.filter.reset();
    const s = this.filter.filter(raw.x, raw.y, t);
    this.lastValidT = t;
    this.last = { x: s.x, y: s.y, rawX: raw.x, rawY: raw.y };
    this.emit({
      t,
      x: s.x,
      y: s.y,
      rawX: raw.x,
      rawY: raw.y,
      valid: true,
      confidence: Number.isFinite(quality) ? Math.min(1, Math.max(0, quality)) : 0,
      source: 'webcam',
    });
  }

  private emitInvalid(t: number): void {
    const last = this.last ?? defaultPoint();
    this.emit({ t, x: last.x, y: last.y, rawX: last.rawX, rawY: last.rawY, valid: false, confidence: 0, source: 'webcam' });
  }

  private emit(sample: GazeSample): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(sample);
      } catch (err) {
        console.error('[gaze] onSample listener threw', err);
      }
    }
  }
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return value !== undefined && value >= 0 ? value : fallback;
}

/** Where stale coordinates point before the first valid sample: the viewport center. */
function defaultPoint(): LastPoint {
  const x = typeof window !== 'undefined' ? window.innerWidth / 2 || 0 : 0;
  const y = typeof window !== 'undefined' ? window.innerHeight / 2 || 0 : 0;
  return { x, y, rawX: x, rawY: y };
}
