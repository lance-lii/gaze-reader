import { OneEuroFilter2D, type OneEuroParams } from '../signal/oneEuro';
import type { GazeSample, GazeSource, Unsubscribe } from '../types';

export interface MouseGazeSourceOptions {
  /** Gaussian jitter σ in px, read on every sample so settings apply live. Default 0. */
  noisePx?: () => number;
  /** Window whose pointer is followed. Default: the global window. */
  target?: Window;
  /** Samples per second. Default 30, like a webcam. */
  hz?: number;
  /** Uniform [0, 1) generator; inject a seeded PRNG for reproducible runs. Default Math.random. */
  random?: () => number;
  filter?: Partial<OneEuroParams>;
}

const RESET_AFTER_INVALID_MS = 300;

/**
 * Stand-in for eye tracking: the pointer is the gaze. Optional Gaussian noise
 * (then One Euro smoothing, like the webcam path) makes it behave like a real
 * tracker for testing the reading pipeline. With zero noise the pointer is
 * passed through unsmoothed.
 */
export class MouseGazeSource implements GazeSource {
  readonly kind = 'mouse' as const;

  private readonly noisePx: () => number;
  private readonly target: Window | null;
  private readonly intervalMs: number;
  private readonly random: () => number;
  private readonly filter: OneEuroFilter2D;
  private readonly listeners = new Set<(sample: GazeSample) => void>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private pointer: { x: number; y: number } | null = null;
  private inside = false;
  private spareNormal: number | null = null;
  private lastValidT: number | null = null;
  /** Stale coordinates reported with invalid samples; the viewport center until the first valid one. */
  private last: { x: number; y: number; rawX: number; rawY: number } | null = null;

  constructor(opts: MouseGazeSourceOptions = {}) {
    this.noisePx = opts.noisePx ?? (() => 0);
    this.target = opts.target ?? (typeof window !== 'undefined' ? window : null);
    const hz = opts.hz !== undefined && Number.isFinite(opts.hz) && opts.hz > 0 ? Math.min(opts.hz, 240) : 30;
    this.intervalMs = 1000 / hz;
    this.random = opts.random ?? Math.random;
    this.filter = new OneEuroFilter2D(opts.filter);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): Promise<void> {
    if (this.timer !== null) return Promise.resolve();
    const target = this.target;
    if (!target) return Promise.reject(new Error('MouseGazeSource needs a window to follow the pointer.'));
    const listen = { capture: true, passive: true } as const;
    // Capture phase on the window: page handlers that stop propagation can't hide the pointer.
    target.addEventListener('pointermove', this.handleMove, listen);
    target.addEventListener('mousemove', this.handleMove, listen);
    target.addEventListener('pointerout', this.handleOut, listen);
    target.addEventListener('mouseout', this.handleOut, listen);
    this.timer = setInterval(this.tick, this.intervalMs);
    return Promise.resolve();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const target = this.target;
    if (target) {
      target.removeEventListener('pointermove', this.handleMove, true);
      target.removeEventListener('mousemove', this.handleMove, true);
      target.removeEventListener('pointerout', this.handleOut, true);
      target.removeEventListener('mouseout', this.handleOut, true);
    }
    // A restart waits for a fresh move rather than trusting a stale position.
    this.pointer = null;
    this.inside = false;
    this.spareNormal = null;
    this.lastValidT = null;
    this.last = null;
    this.filter.reset();
  }

  onSample(cb: (sample: GazeSample) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private readonly handleMove = (e: MouseEvent): void => {
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.inside = true;
  };

  /** `relatedTarget === null` means the pointer left the document, not just an element. */
  private readonly handleOut = (e: MouseEvent): void => {
    if (e.relatedTarget === null) this.inside = false;
  };

  private readonly tick = (): void => {
    const t = performance.now();
    const p = this.inside ? this.pointer : null;
    if (!p) {
      this.last ??= this.viewportCenter();
      this.emit({ t, ...this.last, valid: false, confidence: 0, source: 'mouse' });
      return;
    }

    const sigmaRaw = this.noisePx();
    const sigma = Number.isFinite(sigmaRaw) && sigmaRaw > 0 ? sigmaRaw : 0;
    const rawX = p.x + sigma * this.normal();
    const rawY = p.y + sigma * this.normal();

    let x = rawX;
    let y = rawY;
    if (sigma > 0) {
      if (this.lastValidT === null || t - this.lastValidT > RESET_AFTER_INVALID_MS) this.filter.reset();
      ({ x, y } = this.filter.filter(rawX, rawY, t));
    } else {
      // Keep the filter from resuming from a stale point if noise is turned on later.
      this.filter.reset();
    }
    this.lastValidT = t;
    this.last = { x, y, rawX, rawY };
    this.emit({ t, x, y, rawX, rawY, valid: true, confidence: 1, source: 'mouse' });
  };

  private viewportCenter(): { x: number; y: number; rawX: number; rawY: number } {
    const x = (this.target?.innerWidth ?? 0) / 2 || 0;
    const y = (this.target?.innerHeight ?? 0) / 2 || 0;
    return { x, y, rawX: x, rawY: y };
  }

  /** Standard normal via Box–Muller; each draw of two uniforms yields two values. */
  private normal(): number {
    if (this.spareNormal !== null) {
      const z = this.spareNormal;
      this.spareNormal = null;
      return z;
    }
    let u = this.random();
    // log(0) is -Infinity; a broken generator must not hang or poison the stream.
    for (let i = 0; i < 8 && !(u > 0 && u < 1); i++) u = this.random();
    if (!(u > 0 && u < 1)) u = 0.5;
    let v = this.random();
    if (!(v >= 0 && v < 1)) v = 0;
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    this.spareNormal = r * Math.sin(theta);
    return r * Math.cos(theta);
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
