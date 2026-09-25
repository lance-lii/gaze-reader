/**
 * The offscreen document's last look at a frame before it crosses to the
 * service worker. Every receiver validates frames (messages.ts) and drops a
 * frame whose optional `lighting` is malformed, gaze and all. The lighting
 * numbers are a side channel (about 6 of 30 frames a second carry them), so a
 * bad set is removed here instead: the eye features still get through.
 * Ports serialize as JSON, where NaN and ±Infinity silently become null.
 */
import type { FeatureFrame } from '../../src/types';
import { isLightingStats } from './messages';

export function outgoingFrame(frame: FeatureFrame): FeatureFrame {
  if (frame.lighting === undefined || isLightingStats(frame.lighting)) return frame;
  const rest: FeatureFrame = { ...frame };
  delete rest.lighting;
  return rest;
}
