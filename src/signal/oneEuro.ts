import type { Point } from '../types';

/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose
 * cutoff rises with signal speed. Heavy smoothing while the eyes rest on a
 * word, little lag during a saccade.
 */
export interface OneEuroParams {
  /** Hz. Lower = smoother at rest. */
  minCutoff: number;
  /** Cutoff slope vs. speed (per unit/s). Higher = less lag when moving. */
  beta: number;
  /** Hz. Cutoff for the derivative estimate. */
  dCutoff: number;
}

/** Tuned for gaze in CSS px at 30–60 Hz. */
export const GAZE_ONE_EURO: Readonly<OneEuroParams> = Object.freeze({ minCutoff: 0.8, beta: 0.004, dCutoff: 1.0 });

function smoothingFactor(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export class OneEuroFilter {
  private params: OneEuroParams;
  private prevX: number | null = null;
  private prevDx = 0;
  private prevT: number | null = null;

  constructor(params: Partial<OneEuroParams> = {}) {
    this.params = { ...GAZE_ONE_EURO, ...params };
  }

  setParams(params: Partial<OneEuroParams>): void {
    this.params = { ...this.params, ...params };
  }

  /** @param tMs timestamp in milliseconds */
  filter(x: number, tMs: number): number {
    if (this.prevX === null || this.prevT === null || !Number.isFinite(this.prevX)) {
      this.prevX = x;
      this.prevT = tMs;
      this.prevDx = 0;
      return x;
    }
    // Guard against duplicate or out-of-order timestamps.
    const dt = Math.max((tMs - this.prevT) / 1000, 1e-3);
    const dx = (x - this.prevX) / dt;
    const aD = smoothingFactor(this.params.dCutoff, dt);
    const edx = this.prevDx + aD * (dx - this.prevDx);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(edx);
    const a = smoothingFactor(cutoff, dt);
    const out = this.prevX + a * (x - this.prevX);
    this.prevX = out;
    this.prevDx = edx;
    this.prevT = tMs;
    return out;
  }

  reset(): void {
    this.prevX = null;
    this.prevT = null;
    this.prevDx = 0;
  }
}

export class OneEuroFilter2D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(params: Partial<OneEuroParams> = {}) {
    this.fx = new OneEuroFilter(params);
    this.fy = new OneEuroFilter(params);
  }

  setParams(params: Partial<OneEuroParams>): void {
    this.fx.setParams(params);
    this.fy.setParams(params);
  }

  filter(x: number, y: number, tMs: number): Point {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
