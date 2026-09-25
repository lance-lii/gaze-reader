import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFrame, LightingStats } from '../../src/types';
import { CameraHub } from './cameraHub';
import { outgoingFrame } from './frameRelay';
import { PORT_OFFSCREEN, PORT_TAB } from './messages';
import { RemoteFeatureSource } from './remoteFeatureSource';
import { flush, portPair, type FakePort } from './testing/fakes';
import { eyeFeatures } from './testing/models';

const LIGHT: LightingStats = {
  faceLuma: 0.52,
  faceLin: 0.21,
  faceRange: 1.6,
  faceClip: 0,
  frameLin: 0.18,
  bgLin: 0.2,
  bgClip: 0.01,
  scleraR: 0.33,
  scleraL: 0.31,
  backlight: 0.7,
  side: -0.2,
  shade: -0.6,
  glareR: 0.002,
  glareL: 0,
  irisGlintR: 0.05,
  irisGlintL: 0,
  facePx: 4800,
};

const frame = (lighting?: LightingStats): FeatureFrame => ({
  t: 1_000,
  faceFound: true,
  quality: 0.9,
  features: { ...eyeFeatures(1, 2), squint: 0.2 },
  ...(lighting ? { lighting } : {}),
});

/** Offscreen document → CameraHub (service worker) → RemoteFeatureSource (tab), over JSON-serializing fake ports. */
async function pipeline() {
  const hub = new CameraHub(
    { ensureOffscreen: async () => undefined, closeOffscreen: async () => undefined, openSetup: () => undefined },
    { stopGraceMs: 1_000, closeIdleMs: 5_000, offscreenConnectTimeoutMs: 3_000, maxRestarts: 3, now: () => Date.now() },
  );
  const source = new RemoteFeatureSource({
    connect: () => {
      const [tabEnd, hubEnd] = portPair(PORT_TAB);
      hub.attachTab(hubEnd, 7);
      return tabEnd;
    },
    isContextValid: () => true,
    now: () => 50_000,
  });
  const received: FeatureFrame[] = [];
  source.onFrame((f) => received.push(f));
  const started = source.start();
  await flush();
  const [doc, hubDoc]: [FakePort, FakePort] = portPair(PORT_OFFSCREEN);
  hub.attachOffscreen(hubDoc);
  doc.postMessage({ type: 'hello', state: 'idle' });
  await flush();
  doc.postMessage({ type: 'camera-status', status: { state: 'running', fps: 30 } });
  await flush(10);
  await started;
  const send = async (f: FeatureFrame) => {
    doc.postMessage({ type: 'frame', frame: f });
    await flush(10);
  };
  return { source, received, send };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lighting numbers from the offscreen document to the tab', () => {
  it('arrive with the frame, unchanged, together with the squint score', async () => {
    const p = await pipeline();
    await p.send(outgoingFrame(frame(LIGHT)));
    await p.send(outgoingFrame(frame()));
    expect(p.received).toHaveLength(2);
    expect(p.received[0]!.lighting).toEqual(LIGHT);
    expect(p.received[0]!.features?.squint).toBe(0.2);
    expect(p.received[1]).not.toHaveProperty('lighting');
    p.source.destroy();
  });

  it('a malformed set is dropped at the source, so the gaze still gets through', async () => {
    const broken = { ...LIGHT, faceRange: Number.NaN }; // JSON turns NaN into null
    const p = await pipeline();
    await p.send(frame(broken)); // as the tracker produced it
    expect(p.received).toHaveLength(0); // every receiver rejects the whole frame

    await p.send(outgoingFrame(frame(broken)));
    expect(p.received).toHaveLength(1);
    expect(p.received[0]).not.toHaveProperty('lighting');
    expect(p.received[0]!.features?.vector.slice(0, 2)).toEqual([1, 2]);
    p.source.destroy();
  });
});

describe('outgoingFrame', () => {
  it('passes good frames through as they are and never mutates its input', () => {
    const good = frame(LIGHT);
    expect(outgoingFrame(good)).toBe(good);
    const plain = frame();
    expect(outgoingFrame(plain)).toBe(plain);
    const bad = frame({ ...LIGHT, facePx: -1 });
    const out = outgoingFrame(bad);
    expect(out).not.toHaveProperty('lighting');
    expect(bad.lighting?.facePx).toBe(-1);
  });
});
