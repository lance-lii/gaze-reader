import { describe, expect, it } from 'vitest';
import type { CalibrationEnvironment } from '../../src/types';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { DPR_FIELD, ZoomAwareGazeModel, zoomAware, zoomAwareFromJSON } from './zoomModel';
import { eyeFeatures, linearGazeModel } from './testing/models';

const COMPAT = { featureNames: FEATURE_NAMES };

describe('ZoomAwareGazeModel', () => {
  it('predicts unchanged at the calibration zoom', () => {
    const model = zoomAware(linearGazeModel(), () => 1.5); // a 150 % display at 100 % page zoom
    expect(model.calibrationDpr).toBe(1.5);
    expect(model.scale()).toBe(1);
    expect(model.predict(eyeFeatures(1, 2))).toEqual({ x: 600, y: 600 });
  });

  it('maps a calibration from a 100 % page onto a page zoomed to 125 % (same spot on screen)', () => {
    let dpr = 1;
    const model = zoomAware(linearGazeModel(), () => dpr);
    const atCalibration = model.predict(eyeFeatures(3, 4))!; // (800, 800) CSS px at 100 %
    dpr = 1.25; // the reader opens a site they keep at 125 %
    const zoomed = model.predict(eyeFeatures(3, 4))!;
    // The viewport origin doesn't move with zoom; CSS px get 1.25× bigger on screen.
    expect(zoomed.x).toBeCloseTo(atCalibration.x / 1.25, 6);
    expect(zoomed.y).toBeCloseTo(atCalibration.y / 1.25, 6);
  });

  it('passes through "no prediction" and ignores a broken devicePixelRatio', () => {
    const model = new ZoomAwareGazeModel(linearGazeModel(), 1, () => Number.NaN);
    expect(model.scale()).toBe(1);
    const bad = eyeFeatures();
    bad.vector = bad.vector.slice(1); // wrong length → the inner model returns null
    expect(model.predict(bad)).toBeNull();
  });

  it('round-trips through storage JSON with its calibration zoom; old JSON assumes the current zoom', () => {
    const trained = zoomAware(linearGazeModel({ trainedAt: 42 }), () => 2);
    const json = JSON.parse(JSON.stringify(trained.toJSON())) as Record<string, unknown>;
    expect(json[DPR_FIELD]).toBe(2);

    const restored = zoomAwareFromJSON(json, COMPAT, () => 1)!;
    expect(restored.calibrationDpr).toBe(2);
    expect(restored.trainedAt).toBe(42);
    expect(restored.predict(eyeFeatures(1, 1))).toEqual({ x: 1200, y: 1000 });

    const legacy = { ...json };
    delete legacy[DPR_FIELD];
    const assumed = zoomAwareFromJSON(legacy, COMPAT, () => 1.25)!;
    expect(assumed.calibrationDpr).toBe(1.25);
    expect(assumed.scale()).toBe(1);

    expect(zoomAwareFromJSON({ ...json, featureLength: 3 }, COMPAT)).toBeNull();
    expect(zoomAwareFromJSON('junk', COMPAT)).toBeNull();
  });

  it('compares window sizes in screen pixels, so page zoom alone is not a "resized window"', () => {
    let dpr = 1;
    const model = zoomAware(linearGazeModel({ viewport: { width: 1000, height: 800 } }), () => dpr);
    dpr = 1.25;
    expect(model.viewportChange({ width: 800, height: 640 })).toBeCloseTo(0, 6); // same window, zoomed in
    expect(model.viewportChange({ width: 400, height: 640 })).toBeCloseTo(0.5, 6); // really half as wide
  });
});

describe('ZoomAwareGazeModel: calibration conditions', () => {
  const environment: CalibrationEnvironment = {
    lighting: {
      v: 1,
      n: 40,
      yaw: 0.02,
      pitch: 0.1,
      c: { sclera: -1.7, backlight: 1.2, side: 0.1, shade: -0.8, glare: 0.3, range: 1.5 },
      sd: { sclera: 0.05, backlight: 0.05, side: 0.04, shade: 0.05, glare: 0.1, range: 0.06 },
    },
    appearance: { v: 1, n: 300, opennessAt0: 0.31, opennessSlope: -0.1, opennessResidualSd: 0.012, squintMedian: 0.1, squintSd: 0.03 },
    capturedAt: 1_700_000_000_000,
  };

  it('passes the lighting and eyelid baseline through, also after a trip through storage', () => {
    const model = zoomAware(linearGazeModel({ environment }), () => 1);
    expect(model.environment).toEqual(environment);
    const json = JSON.parse(JSON.stringify(model.toJSON())) as unknown;
    expect(zoomAwareFromJSON(json, COMPAT, () => 1.5)!.environment).toEqual(environment);
    expect(zoomAware(linearGazeModel(), () => 1).environment).toBeNull();
  });

  it('puts the gaze on the eyelid baseline’s axis (calibration viewport heights), whatever the zoom', () => {
    let dpr = 1;
    const model = zoomAware(linearGazeModel({ viewport: { width: 1000, height: 800 } }), () => dpr);
    expect(model.gazeYNorm(eyeFeatures(0, 0))).toBeCloseTo(0.5, 9); // y = 400 of 800
    dpr = 2; // the same eyes on a page zoomed to 200 %: same place on screen, same place on the baseline
    expect(model.gazeYNorm(eyeFeatures(0, 2))).toBeCloseTo(0.75, 9);
    const bad = eyeFeatures();
    bad.vector = bad.vector.slice(1);
    expect(model.gazeYNorm(bad)).toBeNull();
  });
});
