import { describe, expect, it } from 'vitest';
import type { FeatureFrame } from '../../src/types';
import {
  MAX_FEATURE_LENGTH,
  PAGE_OFF,
  cameraLossCode,
  isCameraStatus,
  isFeatureFrame,
  isHubToOffscreen,
  isHubToTab,
  isOffscreenToHub,
  isPageRequest,
  isPageState,
  isRuntimeRequest,
  isRuntimeResponse,
  isTabToHub,
} from './messages';

function frame(overrides: Partial<FeatureFrame> = {}): FeatureFrame {
  return {
    t: 1234.5,
    faceFound: true,
    quality: 0.8,
    features: {
      vector: [0.1, -0.2, 0.3],
      headPose: { yaw: 0.01, pitch: -0.02, roll: 0, tx: 1, ty: 2, tz: -40 },
      blink: 0.05,
      openness: 0.3,
      faceScale: 0.12,
      faceCenter: { x: 0.5, y: 0.45 },
    },
    ...overrides,
  };
}

/** Messages cross processes as JSON: NaN becomes null, undefined disappears. */
const viaJson = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

describe('feature frame guard', () => {
  it('accepts a well-formed frame, before and after JSON transport', () => {
    expect(isFeatureFrame(frame())).toBe(true);
    expect(isFeatureFrame(viaJson(frame()))).toBe(true);
  });

  it('accepts a face-lost frame with null features', () => {
    expect(isFeatureFrame(frame({ faceFound: false, features: null, quality: 0 }))).toBe(true);
  });

  it('rejects non-finite numbers anywhere, including NaN that JSON turned into null', () => {
    expect(isFeatureFrame(frame({ t: Number.NaN }))).toBe(false);
    const badVector = frame();
    badVector.features!.vector[1] = Number.NaN;
    expect(isFeatureFrame(badVector)).toBe(false);
    expect(isFeatureFrame(viaJson(badVector))).toBe(false);
    const badPose = frame();
    badPose.features!.headPose.yaw = Number.POSITIVE_INFINITY;
    expect(isFeatureFrame(badPose)).toBe(false);
  });

  it('rejects out-of-range quality, empty or oversized vectors and missing fields', () => {
    expect(isFeatureFrame(frame({ quality: 1.5 }))).toBe(false);
    expect(isFeatureFrame(frame({ quality: -0.1 }))).toBe(false);
    const empty = frame();
    empty.features!.vector = [];
    expect(isFeatureFrame(empty)).toBe(false);
    const huge = frame();
    huge.features!.vector = new Array<number>(MAX_FEATURE_LENGTH + 1).fill(0);
    expect(isFeatureFrame(huge)).toBe(false);
    const { faceCenter: _dropped, ...noCenter } = frame().features!;
    expect(isFeatureFrame({ ...frame(), features: noCenter })).toBe(false);
    expect(isFeatureFrame({ t: 1, quality: 0.5, features: null })).toBe(false);
    expect(isFeatureFrame(null)).toBe(false);
    expect(isFeatureFrame([frame()])).toBe(false);
  });
});

describe('port message guards', () => {
  it('tab → hub', () => {
    expect(isTabToHub({ type: 'subscribe' })).toBe(true);
    expect(isTabToHub({ type: 'unsubscribe', linger: true })).toBe(true);
    expect(isTabToHub({ type: 'unsubscribe' })).toBe(false);
    expect(isTabToHub({ type: 'camera-start' })).toBe(false);
    expect(isTabToHub('subscribe')).toBe(false);
  });

  it('hub → tab', () => {
    expect(isHubToTab({ type: 'frame', frame: frame() })).toBe(true);
    expect(isHubToTab({ type: 'frame', frame: { t: 'soon' } })).toBe(false);
    expect(isHubToTab({ type: 'camera-status', status: { state: 'running', fps: 29.7 } })).toBe(true);
    expect(isHubToTab({ type: 'camera-status', status: { state: 'error', code: 'camera-denied' } })).toBe(true);
    expect(isHubToTab({ type: 'camera-status', status: { state: 'error', code: 'kaboom' } })).toBe(false);
    expect(isHubToTab({ type: 'camera-status', status: { state: 'dancing' } })).toBe(false);
    expect(isHubToTab({ type: 'camera-status', status: { state: 'running', fps: -1 } })).toBe(false);
  });

  it('offscreen ↔ hub', () => {
    expect(isOffscreenToHub({ type: 'hello', state: 'idle' })).toBe(true);
    expect(isOffscreenToHub({ type: 'hello', state: 'awake' })).toBe(false);
    expect(isOffscreenToHub({ type: 'frame', frame: viaJson(frame()) })).toBe(true);
    expect(isOffscreenToHub({ type: 'camera-status', status: { state: 'stopped', message: 'bye' } })).toBe(true);
    expect(isOffscreenToHub({ type: 'camera-status', status: { state: 'stopped', message: 42 } })).toBe(false);
    expect(isOffscreenToHub({ type: 'subscribe' })).toBe(false);
    expect(isHubToOffscreen({ type: 'camera-start' })).toBe(true);
    expect(isHubToOffscreen({ type: 'camera-stop' })).toBe(true);
    expect(isHubToOffscreen({ type: 'camera-restart' })).toBe(false);
  });
});

describe('one-shot message guards', () => {
  it('runtime requests', () => {
    expect(isRuntimeRequest({ type: 'set-tab-enabled', tabId: 12, enabled: true })).toBe(true);
    expect(isRuntimeRequest({ type: 'set-tab-enabled', tabId: -1, enabled: true })).toBe(false);
    expect(isRuntimeRequest({ type: 'set-tab-enabled', tabId: 1.5, enabled: true })).toBe(false);
    expect(isRuntimeRequest({ type: 'set-tab-enabled', tabId: 3, enabled: 'yes' })).toBe(false);
    expect(isRuntimeRequest({ type: 'camera-permission-granted' })).toBe(true);
    expect(isRuntimeRequest({ type: 'open-setup' })).toBe(true);
    expect(isRuntimeRequest({ type: 'open-setup', returnTabId: 7 })).toBe(true);
    expect(isRuntimeRequest({ type: 'open-setup', returnTabId: 'seven' })).toBe(false);
    expect(isRuntimeRequest({ type: 'page-status', enabled: true })).toBe(true);
    expect(isRuntimeRequest({ type: 'page-status', enabled: 1 })).toBe(false);
    expect(isRuntimeRequest({ type: 'rm -rf' })).toBe(false);
  });

  it('page requests', () => {
    expect(isPageRequest({ type: 'page-ping' })).toBe(true);
    expect(isPageRequest({ type: 'page-query' })).toBe(true);
    expect(isPageRequest({ type: 'page-set-enabled', enabled: false })).toBe(true);
    expect(isPageRequest({ type: 'page-set-enabled' })).toBe(false);
    expect(isPageRequest({ type: 'page-command', command: 'recalibrate' })).toBe(true);
    expect(isPageRequest({ type: 'page-command', command: 'open-library' })).toBe(false);
  });

  it('page state and responses', () => {
    expect(isPageState(PAGE_OFF)).toBe(true);
    const on = { ...PAGE_OFF, enabled: true, tracking: 'tracking', source: 'webcam', calibrated: true, fps: 30 };
    expect(isPageState(on)).toBe(true);
    expect(isPageState({ ...on, tracking: 'confused' })).toBe(false);
    expect(isPageState({ ...on, fps: Number.NaN })).toBe(false);
    expect(isPageState({ ...on, pageMode: true })).toBe(true);
    expect(isPageState({ ...on, pageMode: 'yes' })).toBe(false);
    expect(isRuntimeResponse({ ok: true })).toBe(true);
    expect(isRuntimeResponse({ ok: true, state: on })).toBe(true);
    expect(isRuntimeResponse({ ok: true, state: { enabled: 'maybe' } })).toBe(false);
    expect(isRuntimeResponse({ ok: false, error: 'nope' })).toBe(true);
    expect(isRuntimeResponse({ ok: false })).toBe(false);
  });

  it('camera status', () => {
    expect(isCameraStatus({ state: 'starting' })).toBe(true);
    expect(isCameraStatus({ state: 'error', code: 'model-load-failed', message: 'offline' })).toBe(true);
    expect(isCameraStatus({ code: 'unknown' })).toBe(false);
  });
});

describe('cameraLossCode', () => {
  it('blames a revoked permission, not the device, when the grant is gone', () => {
    expect(cameraLossCode('camera-in-use', 'prompt')).toBe('camera-denied');
    expect(cameraLossCode('no-camera', 'denied')).toBe('camera-denied');
    expect(cameraLossCode('camera-in-use', 'granted')).toBe('camera-in-use');
    expect(cameraLossCode('unknown', 'unknown')).toBe('unknown');
  });
});
