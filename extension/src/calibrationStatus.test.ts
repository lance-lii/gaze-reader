import { describe, expect, it } from 'vitest';
import { featureSignature } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { calibrationStatus, storedCalibrationStatus } from './calibrationStatus';
import { linearGazeModel } from './testing/models';
import { zoomAware } from './zoomModel';

/** What chrome.storage.local holds after a calibration in this build (with the zoom field). */
const current = JSON.parse(JSON.stringify(zoomAware(linearGazeModel(), () => 1.25).toJSON())) as Record<string, unknown>;
/** …and what Gaze Reader 1.0 saved: the old model kind and its 27 features. */
const legacy = { ...current, kind: 'gr-ridge-poly2', featureLength: 27, featureSignature: featureSignature(FEATURE_NAMES.slice(0, 27)) };

describe('calibrationStatus', () => {
  it('tells a current calibration from one an older Gaze Reader saved, and from nothing', () => {
    expect(calibrationStatus(current)).toBe('current');
    expect(calibrationStatus(legacy)).toBe('outdated');
    expect(calibrationStatus({ ...current, version: 2 })).toBe('outdated'); // a newer one, after a downgrade
    for (const nothing of [undefined, null, 'junk', 42, {}, { version: 1 }, { ...current, wx: 'broken' }]) {
      expect(calibrationStatus(nothing)).toBe('none');
    }
  });

  it("the popup's cheaper view counts anything stored that isn't outdated", () => {
    expect(storedCalibrationStatus(current)).toBe('current');
    expect(storedCalibrationStatus({ version: 1 })).toBe('current'); // the page validates it, the popup can forget it
    expect(storedCalibrationStatus(legacy)).toBe('outdated');
    expect(storedCalibrationStatus(undefined)).toBe('none');
    expect(storedCalibrationStatus(null)).toBe('none');
  });
});
