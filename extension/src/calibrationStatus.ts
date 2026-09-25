/**
 * What the calibration stored in chrome.storage.local means for this build.
 *
 * The gaze model changed in the lighting-robustness release (it no longer reads
 * vertical gaze from the eyelids, which light moves), so every calibration
 * saved by 1.0 is rejected on load. Starting a calibration without a word
 * would look like the extension forgot it; `outdated` lets the page and the
 * popup explain why instead.
 */
import { calibrationUpgradeNeeded, type ModelCompatibility } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { zoomAwareFromJSON } from './zoomModel';

/** A calibration saved by a build with different features is useless; reject it on load. */
export const MODEL_COMPAT: Readonly<ModelCompatibility> = Object.freeze({ featureNames: FEATURE_NAMES });

/**
 *  - `none`: nothing usable stored (never calibrated, forgotten, or damaged);
 *  - `current`: a model this build loads;
 *  - `outdated`: a model an older (or newer) Gaze Reader saved, which this build can't use.
 */
export type CalibrationStatus = 'none' | 'current' | 'outdated';

export function calibrationStatus(json: unknown): CalibrationStatus {
  if (json === undefined || json === null) return 'none';
  if (calibrationUpgradeNeeded(json)) return 'outdated';
  return zoomAwareFromJSON(json, MODEL_COMPAT) ? 'current' : 'none';
}

/**
 * The popup's cheaper view: anything stored that isn't outdated counts as a
 * calibration (so it can still be forgotten); the page validates it fully.
 */
export function storedCalibrationStatus(json: unknown): CalibrationStatus {
  if (json === undefined || json === null) return 'none';
  return calibrationUpgradeNeeded(json) ? 'outdated' : 'current';
}

/** Shown on the page (and, shorter, in the popup) when the stored calibration is outdated. */
export const OUTDATED_CALIBRATION_TEXT =
  'Gaze Reader now copes much better with changes in lighting, but your old calibration doesn’t fit the new tracking. Please calibrate once more (about a minute).';

export const OUTDATED_CALIBRATION_SHORT = 'Gaze Reader was upgraded: recalibrate once (about a minute).';
