import type { CalibrationEnvironment, EyeFeatures, GazeModel, Point, SerializedGazeModel } from '../../src/types';
import { deserializeGazeModel, type ModelCompatibility } from '../../src/gaze/calibrationModel';

/**
 * Page zoom for a calibration that travels between websites.
 *
 * The app has one origin and one zoom level, but the extension shares a single
 * calibration across every site, and Chrome remembers a zoom level per site. A
 * model predicts gaze in the CSS px of the page it was trained on; at another
 * zoom the same spot on the screen has different CSS coordinates. The viewport's
 * top-left corner stays put on screen whatever the zoom, so the fix is a pure
 * scale about the viewport origin by (dpr at calibration) / (dpr now), where
 * devicePixelRatio = display scale × page zoom.
 */

/** Field added to the stored model JSON (deserializeGazeModel ignores unknown fields). */
export const DPR_FIELD = 'extDevicePixelRatio';

type DprSource = () => number;

export function currentDevicePixelRatio(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

export class ZoomAwareGazeModel implements GazeModel {
  constructor(
    readonly inner: GazeModel,
    /** devicePixelRatio of the page the model was trained on. */
    readonly calibrationDpr: number,
    private readonly dpr: DprSource = currentDevicePixelRatio,
  ) {}

  /** Viewport at calibration time, in the CSS px of that page. */
  get viewport(): { width: number; height: number } {
    return this.inner.viewport;
  }

  get trainedAt(): number {
    return this.inner.trainedAt;
  }

  /**
   * Lighting and eyelid appearance when the model was calibrated (or last
   * refreshed). Page zoom doesn't change them: the lighting signature is made
   * of light ratios and the eyelid baseline is in viewport heights.
   */
  get environment(): CalibrationEnvironment | null {
    return this.inner.environment ?? null;
  }

  /** Current CSS px per calibration-time CSS px (1 at the calibration zoom). */
  scale(): number {
    const k = this.calibrationDpr / this.dpr();
    return Number.isFinite(k) && k > 0 ? k : 1;
  }

  predict(features: EyeFeatures): Point | null {
    const p = this.inner.predict(features);
    if (!p) return null;
    const k = this.scale();
    return k === 1 ? p : { x: p.x * k, y: p.y * k };
  }

  /**
   * Where the reader looks as a fraction of the calibration viewport's height
   * (0 = top): the x-axis of the eyelid baseline (AppearanceBaseline). Zoom
   * independent, because the prediction and the height are both in the CSS px
   * of the calibration page. Null when the features are unusable.
   */
  gazeYNorm(features: EyeFeatures): number | null {
    const h = this.inner.viewport.height;
    if (!(h > 0)) return null;
    const p = this.inner.predict(features);
    return p && Number.isFinite(p.y) ? p.y / h : null;
  }

  toJSON(): SerializedGazeModel {
    return { ...this.inner.toJSON(), [DPR_FIELD]: this.calibrationDpr };
  }

  /**
   * Largest relative change of the window's size since calibration, compared
   * in screen pixels so a different page zoom alone doesn't count.
   */
  viewportChange(now: { width: number; height: number }): number {
    const k = this.scale();
    const rel = (current: number, calibrated: number) => Math.abs(current - calibrated * k) / Math.max(1, calibrated * k);
    return Math.max(rel(now.width, this.viewport.width), rel(now.height, this.viewport.height));
  }
}

/** Wraps a freshly trained model: it was calibrated at the current zoom. */
export function zoomAware(model: GazeModel, dpr: DprSource = currentDevicePixelRatio): ZoomAwareGazeModel {
  return model instanceof ZoomAwareGazeModel ? model : new ZoomAwareGazeModel(model, dpr(), dpr);
}

/**
 * Restores a stored calibration. JSON saved before the zoom field existed is
 * assumed to match the current zoom (the old behaviour). Null when invalid or
 * built for different features.
 */
export function zoomAwareFromJSON(
  json: unknown,
  expect: ModelCompatibility = {},
  dpr: DprSource = currentDevicePixelRatio,
): ZoomAwareGazeModel | null {
  const inner = deserializeGazeModel(json, expect);
  if (!inner) return null;
  const stored = (json as Record<string, unknown>)[DPR_FIELD];
  const calibrationDpr = typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : dpr();
  return new ZoomAwareGazeModel(inner, calibrationDpr, dpr);
}
