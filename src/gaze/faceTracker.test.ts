// @vitest-environment jsdom
import type { FaceLandmarkerOptions } from '@mediapipe/tasks-vision';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EyeFeatures, FeatureFrame, LightingStats } from '../types';
import type { CameraHandle, OpenCameraOptions } from './camera';
import {
  CameraFeatureSource,
  createLandmarkerLoader,
  preloadFaceLandmarker,
  TrackerError,
  type Delegate,
  type FaceLandmarkerLike,
  type FaceResultLike,
  type LandmarkerHandle,
  type VisionModuleLike,
} from './faceTracker';
import type { LandmarkLike } from './features';
import { LightingProbe, type LightingBackend, type LightingProbeLike, type LightingSource } from './lighting';
import { FakeCanvas, FakeVideoFrame, renderScene, type FrameRegistry } from './lightingTestScene';

// ─────────────────────────────── helpers ───────────────────────────────

const FRAME_MS = 1000 / 30;
/** The real clock, captured before the fake timers replace performance.now (for cost measurements). */
const realNow: () => number = performance.now.bind(performance);
const INPUT = {} as TexImageSource;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A frontal synthetic face (normalized coords of a 4:3 frame). */
function faceLandmarks(): LandmarkLike[] {
  const pts: LandmarkLike[] = Array.from({ length: 478 }, (_, i) => {
    const a = (i / 478) * 2 * Math.PI;
    return { x: 0.5 + 0.1 * Math.cos(a), y: 0.52 + 0.15 * Math.sin(a), z: 0 };
  });
  const set = (i: number, x: number, y: number): void => {
    pts[i] = { x, y, z: 0 };
  };
  set(33, 0.41, 0.45); set(133, 0.47, 0.45); set(159, 0.44, 0.44); set(145, 0.44, 0.46); set(468, 0.44, 0.45);
  set(362, 0.53, 0.45); set(263, 0.59, 0.45); set(386, 0.56, 0.44); set(374, 0.56, 0.46); set(473, 0.56, 0.45);
  set(152, 0.5, 0.68);
  return pts;
}

const FACE_RESULT: FaceResultLike = {
  faceLandmarks: [faceLandmarks()],
  faceBlendshapes: [{ categories: [{ categoryName: 'eyeBlinkLeft', score: 0.05 }, { categoryName: 'eyeLookDownLeft', score: 0.3 }] }],
  facialTransformationMatrixes: [{ data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1] }],
};

class FakeHandle implements LandmarkerHandle {
  delegate: Delegate = 'GPU';
  readonly calls: { input: TexImageSource; t: number }[] = [];
  result: FaceResultLike = FACE_RESULT;
  throwing = false;
  detect(input: TexImageSource, t: number): FaceResultLike {
    this.calls.push({ input, t });
    if (this.throwing) throw new Error('detect failed');
    return this.result;
  }
  close(): void {}
}

interface FakeVideoState {
  ready: number;
  width: number;
  height: number;
  frozen: boolean;
}

/** currentTime advances with the (fake) clock at 30 fps, like a live camera. */
function fakeVideo(): { video: HTMLVideoElement; state: FakeVideoState } {
  const video = document.createElement('video');
  const state: FakeVideoState = { ready: 4, width: 640, height: 480, frozen: false };
  let time = 0;
  Object.defineProperties(video, {
    readyState: { get: () => state.ready },
    videoWidth: { get: () => state.width },
    videoHeight: { get: () => state.height },
    currentTime: {
      get: () => {
        if (!state.frozen) time = Math.floor(performance.now() / FRAME_MS) / 30;
        return time;
      },
    },
  });
  return { video, state };
}

function fakeCamera(video: HTMLVideoElement) {
  const track = Object.assign(new EventTarget(), { readyState: 'live' as MediaStreamTrackState });
  const stop = vi.fn();
  const handle: CameraHandle = {
    stream: {} as MediaStream,
    video,
    track: track as unknown as MediaStreamTrack,
    ownsVideo: false,
    stop,
  };
  return { handle, track, stop };
}

function harness(
  opts: {
    camera?: Deferred<CameraHandle>;
    model?: Deferred<LandmarkerHandle>;
    backgroundProcessing?: boolean;
    createLightingProbe?: () => LightingProbeLike | null;
  } = {},
) {
  const { video, state } = fakeVideo();
  const cam = fakeCamera(video);
  const lm = new FakeHandle();
  const openCamera = vi.fn((_opts: OpenCameraOptions) => opts.camera?.promise ?? Promise.resolve(cam.handle));
  const loadLandmarker = vi.fn(() => opts.model?.promise ?? Promise.resolve<LandmarkerHandle>(lm));
  const src = new CameraFeatureSource(
    { wasmBaseUrl: 'https://app.test/mediapipe/wasm', backgroundProcessing: opts.backgroundProcessing ?? false },
    { openCamera, loadLandmarker, ...(opts.createLightingProbe ? { createLightingProbe: opts.createLightingProbe } : {}) },
  );
  const frames: FeatureFrame[] = [];
  src.onFrame((f) => frames.push(f));
  return { src, video, state, cam, lm, openCamera, loadLandmarker, frames };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'MediaStreamTrackProcessor');
});

// ─────────────────────────────── loader ───────────────────────────────

class FakeInner implements FaceLandmarkerLike {
  readonly timestamps: number[] = [];
  closed = false;
  failing = false;
  constructor(readonly delegate: Delegate) {}
  detectForVideo(_input: TexImageSource, ts: number): FaceResultLike {
    this.timestamps.push(ts);
    if (this.failing) throw new Error('WebGL context lost');
    return { faceLandmarks: [] };
  }
  close(): void {
    this.closed = true;
  }
}

function fakeVision(opts: { failGpu?: boolean; failCpu?: boolean } = {}) {
  const created: FakeInner[] = [];
  const forVisionTasks = vi.fn((base?: string) => Promise.resolve({ wasmLoaderPath: `${base}/l.js`, wasmBinaryPath: `${base}/b.wasm` }));
  const createFromOptions = vi.fn((_fileset: unknown, options: FaceLandmarkerOptions): Promise<FaceLandmarkerLike> => {
    const delegate = options.baseOptions?.delegate ?? 'CPU';
    if ((delegate === 'GPU' && opts.failGpu) || (delegate === 'CPU' && opts.failCpu)) {
      return Promise.reject(new Error(`${delegate} unavailable`));
    }
    const inner = new FakeInner(delegate);
    created.push(inner);
    return Promise.resolve(inner);
  });
  const vision: VisionModuleLike = { FilesetResolver: { forVisionTasks }, FaceLandmarker: { createFromOptions } };
  const importVision = vi.fn(() => Promise.resolve(vision));
  return { importVision, forVisionTasks, createFromOptions, created };
}

const CFG = { wasmBaseUrl: 'https://app.test/mediapipe/wasm/', modelAssetPath: 'https://models.test/face.task', delegate: 'GPU' as const };

describe('createLandmarkerLoader', () => {
  it('loads once per configuration and requests the right graph', async () => {
    const v = fakeVision();
    const loader = createLandmarkerLoader(v.importVision);
    const a = loader.load(CFG);
    const b = loader.load({ ...CFG, wasmBaseUrl: 'https://app.test/mediapipe/wasm' });
    expect(a).toBe(b);
    const handle = await a;
    expect(handle.delegate).toBe('GPU');
    expect(v.importVision).toHaveBeenCalledTimes(1);
    expect(v.forVisionTasks).toHaveBeenCalledWith('https://app.test/mediapipe/wasm'); // no doubled slash
    expect(v.createFromOptions).toHaveBeenCalledTimes(1);
    expect(v.createFromOptions.mock.calls[0][1]).toEqual({
      baseOptions: { modelAssetPath: CFG.modelAssetPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    expect(loader.load({ ...CFG, delegate: 'CPU' })).not.toBe(a);
  });

  it('falls back to the CPU when the GPU delegate cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = fakeVision({ failGpu: true });
    const handle = await createLandmarkerLoader(v.importVision).load(CFG);
    expect(handle.delegate).toBe('CPU');
    expect(warn).toHaveBeenCalled();
  });

  it('surfaces total failure as model-load-failed and retries on the next load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = fakeVision({ failGpu: true, failCpu: true });
    const loader = createLandmarkerLoader(v.importVision);
    const err = await loader.load(CFG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect((err as TrackerError).code).toBe('model-load-failed');
    await flush();
    await loader.load(CFG).catch(() => undefined);
    expect(v.createFromOptions).toHaveBeenCalledTimes(4);
  });

  it('reports a runtime that fails to import as model-load-failed', async () => {
    const loader = createLandmarkerLoader(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    await expect(loader.load(CFG)).rejects.toMatchObject({ code: 'model-load-failed' });
  });

  it('hands MediaPipe strictly increasing integer timestamps', async () => {
    const v = fakeVision();
    const handle = await createLandmarkerLoader(v.importVision).load(CFG);
    for (const t of [1000.4, 1000.4, 999, Number.NaN, 1003.2, 2000]) handle.detect(INPUT, t);
    expect(v.created[0].timestamps).toEqual([1000, 1001, 1002, 1003, 1004, 2000]);
  });

  it('never hands MediaPipe a non-finite or negative timestamp, even first', async () => {
    const v = fakeVision();
    const handle = await createLandmarkerLoader(v.importVision).load(CFG);
    for (const t of [Number.NaN, -50, Number.POSITIVE_INFINITY, 10]) handle.detect(INPUT, t);
    expect(v.created[0].timestamps).toEqual([0, 1, 2, 10]);
  });

  it('shares the timestamp sequence between everyone using the cached landmarker', async () => {
    const v = fakeVision();
    const loader = createLandmarkerLoader(v.importVision);
    const [a, b] = await Promise.all([loader.load(CFG), loader.load(CFG)]);
    a.detect(INPUT, 500);
    b.detect(INPUT, 500);
    expect(v.created[0].timestamps).toEqual([500, 501]);
  });

  it('switches to the CPU when the GPU keeps failing at runtime', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = fakeVision();
    const handle = await createLandmarkerLoader(v.importVision).load(CFG);
    const gpu = v.created[0];
    gpu.failing = true;
    for (let i = 0; i < 29; i++) expect(() => handle.detect(INPUT, i)).toThrow();
    expect(v.createFromOptions).toHaveBeenCalledTimes(1);
    expect(() => handle.detect(INPUT, 29)).toThrow();
    await flush();
    expect(v.createFromOptions).toHaveBeenCalledTimes(2);
    expect(handle.delegate).toBe('CPU');
    expect(gpu.closed).toBe(true);
    handle.detect(INPUT, 30);
    expect(v.created[1].timestamps).toEqual([30]);
  });

  it('gives up on the CPU fallback after one failed attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = fakeVision();
    const handle = await createLandmarkerLoader(v.importVision).load(CFG);
    v.created[0].failing = true;
    v.createFromOptions.mockImplementation(() => Promise.reject(new Error('no CPU either')));
    for (let i = 0; i < 90; i++) {
      expect(() => handle.detect(INPUT, i)).toThrow();
      await flush();
    }
    expect(v.createFromOptions).toHaveBeenCalledTimes(2);
    expect(handle.delegate).toBe('GPU');
  });

  it('dispose() closes every cached landmarker', async () => {
    const v = fakeVision();
    const loader = createLandmarkerLoader(v.importVision);
    await loader.load(CFG);
    loader.dispose();
    await flush();
    expect(v.created[0].closed).toBe(true);
  });
});

// ─────────────────────────────── source ───────────────────────────────

describe('CameraFeatureSource', () => {
  it('opens the camera and loads the model in parallel', async () => {
    const camera = deferred<CameraHandle>();
    const h = harness({ camera });
    const started = h.src.start();
    expect(h.openCamera).toHaveBeenCalledTimes(1);
    expect(h.loadLandmarker).toHaveBeenCalledTimes(1); // before the camera answered
    expect(h.loadLandmarker.mock.calls[0]).toEqual([
      expect.objectContaining({ wasmBaseUrl: 'https://app.test/mediapipe/wasm', delegate: 'GPU' }),
    ]);
    expect(h.src.running).toBe(false);
    camera.resolve(h.cam.handle);
    await started;
    expect(h.src.running).toBe(true);
    expect(h.src.video).toBe(h.video);
    expect(h.src.delegate).toBe('GPU');
    h.src.stop();
  });

  it('processes every new video frame exactly once and reports fps', async () => {
    const h = harness();
    await h.src.start();
    vi.advanceTimersByTime(1000);
    // rAF runs at 60 Hz; the camera only produces 30 new frames per second.
    expect(h.lm.calls.length).toBeGreaterThanOrEqual(29);
    expect(h.lm.calls.length).toBeLessThanOrEqual(31);
    expect(h.frames).toHaveLength(h.lm.calls.length);
    expect(h.lm.calls.every((c) => c.input === h.video)).toBe(true);

    const last = h.frames.at(-1);
    expect(last?.faceFound).toBe(true);
    expect(last?.features?.vector.length).toBeGreaterThan(20);
    expect(last?.features?.faceScale).toBeCloseTo(0.12, 6); // 4:3 aspect applied
    expect(last?.features?.headPose.tz).toBe(-50);
    expect(last?.quality).toBeGreaterThan(0.9);
    expect(last?.t).toBe(h.lm.calls.at(-1)?.t);
    expect(h.src.lastLandmarks).toBe(FACE_RESULT.faceLandmarks[0]);
    expect(h.src.fps).toBeGreaterThan(27);
    expect(h.src.fps).toBeLessThan(33);
    h.src.stop();
  });

  it('skips frames while the video is not ready or has not advanced', async () => {
    const h = harness();
    h.state.ready = 1;
    await h.src.start();
    vi.advanceTimersByTime(500);
    expect(h.lm.calls).toHaveLength(0);
    h.state.ready = 4;
    h.state.frozen = true;
    vi.advanceTimersByTime(500);
    expect(h.lm.calls.length).toBeLessThanOrEqual(1);
    h.src.stop();
  });

  it('keeps running through detection errors, emitting face-lost frames', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    await h.src.start();
    h.lm.throwing = true;
    vi.advanceTimersByTime(300);
    expect(h.frames.length).toBeGreaterThan(5);
    expect(h.frames.every((f) => !f.faceFound && f.features === null && f.quality === 0)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1); // not once per frame
    h.lm.throwing = false;
    vi.advanceTimersByTime(100);
    expect(h.frames.at(-1)?.faceFound).toBe(true);
    h.src.stop();
  });

  it('reports frames without a face', async () => {
    const h = harness();
    await h.src.start();
    vi.advanceTimersByTime(100);
    h.lm.result = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
    vi.advanceTimersByTime(100);
    expect(h.frames.at(-1)).toEqual({ t: expect.any(Number), faceFound: false, features: null, quality: 0 });
    expect(h.src.lastLandmarks).toBeNull();
    h.src.stop();
  });

  it('stop() releases the camera and leaves no timer or frame callback behind', async () => {
    const h = harness();
    await h.src.start();
    vi.advanceTimersByTime(300);
    h.src.stop();
    expect(h.cam.stop).toHaveBeenCalledTimes(1);
    expect(h.src.running).toBe(false);
    expect(h.src.fps).toBe(0);
    expect(h.src.lastLandmarks).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const n = h.lm.calls.length;
    vi.advanceTimersByTime(1000);
    expect(h.lm.calls).toHaveLength(n);
    h.src.stop(); // idempotent
  });

  it('restarts after stop()', async () => {
    const h = harness();
    await h.src.start();
    h.src.stop();
    await h.src.start();
    expect(h.src.running).toBe(true);
    expect(h.openCamera).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(200);
    expect(h.frames.length).toBeGreaterThan(0);
    h.src.stop();
  });

  it('shares one attempt between concurrent start() calls', async () => {
    const h = harness();
    const a = h.src.start();
    const b = h.src.start();
    expect(a).toBe(b);
    await a;
    await h.src.start();
    expect(h.openCamera).toHaveBeenCalledTimes(1);
    h.src.stop();
  });

  it('backs out if stopped while the permission prompt is open', async () => {
    const camera = deferred<CameraHandle>();
    const h = harness({ camera });
    const started = h.src.start();
    h.src.stop();
    camera.resolve(h.cam.handle);
    await expect(started).resolves.toBeUndefined();
    expect(h.cam.stop).toHaveBeenCalled();
    expect(h.src.running).toBe(false);
    vi.advanceTimersByTime(500);
    expect(h.lm.calls).toHaveLength(0);
  });

  it('releases a camera granted after stop() without waiting for the model', async () => {
    const camera = deferred<CameraHandle>();
    const model = deferred<LandmarkerHandle>();
    const h = harness({ camera, model });
    const started = h.src.start();
    h.src.stop();
    camera.resolve(h.cam.handle);
    await flush();
    expect(h.cam.stop).toHaveBeenCalled(); // the model is still downloading
    expect(h.src.video).toBeNull();
    await expect(started).resolves.toBeUndefined();
    model.resolve(h.lm);
  });

  it('releases the camera immediately if stopped while the model loads', async () => {
    const model = deferred<LandmarkerHandle>();
    const h = harness({ model });
    const started = h.src.start();
    await flush();
    expect(h.src.video).toBe(h.video); // the preview can show the camera during the download
    h.src.stop();
    expect(h.cam.stop).toHaveBeenCalled();
    // The stale attempt settles right away, without waiting for the model or its timeout.
    await expect(started).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    model.resolve(h.lm);
    await flush();
    expect(h.src.running).toBe(false);
  });

  it('stop() cancels an in-flight camera open, so a late grant is released at once', async () => {
    const camera = deferred<CameraHandle>();
    const h = harness({ camera });
    const started = h.src.start();
    const signal = h.openCamera.mock.calls[0][0].signal;
    expect(signal?.aborted).toBe(false);
    h.src.stop();
    expect(signal?.aborted).toBe(true);
    camera.resolve(h.cam.handle);
    await expect(started).resolves.toBeUndefined();
    expect(h.src.running).toBe(false);
  });

  it('fails fast if the camera is unplugged while the model downloads', async () => {
    const model = deferred<LandmarkerHandle>();
    const h = harness({ model });
    const runtimeErrors: TrackerError[] = [];
    h.src.onError((e) => runtimeErrors.push(e));
    const started = h.src.start().catch((e: unknown) => e);
    await flush();
    expect(h.src.video).toBe(h.video);

    h.cam.track.readyState = 'ended';
    h.cam.track.dispatchEvent(new Event('ended'));
    const err = await started; // without waiting for the model or its 60 s timeout
    expect(err).toBeInstanceOf(TrackerError);
    expect((err as TrackerError).code).toBe('camera-in-use');
    expect(h.src.lastError).toBe(err);
    expect(h.cam.stop).toHaveBeenCalled();
    expect(h.src.running).toBe(false);
    expect(h.src.video).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(runtimeErrors).toHaveLength(0); // start() failures reject; onError is for after start

    model.resolve(h.lm);
    await flush();
    expect(h.src.running).toBe(false);
    expect(h.lm.calls).toHaveLength(0);
  });

  it('does not start a session on a track that ended before the model arrived', async () => {
    const h = harness();
    h.cam.track.readyState = 'ended'; // the 'ended' event fired before anyone listened
    await expect(h.src.start()).rejects.toMatchObject({ code: 'camera-in-use' });
    expect(h.src.running).toBe(false);
    expect(h.cam.stop).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(h.lm.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with model-load-failed, not a raw TypeError, when the default WASM URL cannot be resolved', async () => {
    Object.defineProperty(document, 'baseURI', { value: 'about:blank', configurable: true });
    try {
      const openCamera = vi.fn((_opts: OpenCameraOptions) => Promise.resolve(fakeCamera(fakeVideo().video).handle));
      const src = new CameraFeatureSource({}, { openCamera, loadLandmarker: () => Promise.resolve<LandmarkerHandle>(new FakeHandle()) });
      const err = await src.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TrackerError);
      expect((err as TrackerError).code).toBe('model-load-failed');
      expect(src.lastError).toBe(err);
      expect(openCamera).not.toHaveBeenCalled();
      // "Never rejects" includes never throwing synchronously.
      await expect(preloadFaceLandmarker()).resolves.toBe(false);
    } finally {
      Reflect.deleteProperty(document, 'baseURI');
    }
  });

  it('a fresh start() after a cancelled one works', async () => {
    const camera = deferred<CameraHandle>();
    const h = harness({ camera });
    const first = h.src.start();
    h.src.stop();
    const second = h.src.start();
    expect(second).not.toBe(first);
    camera.resolve(h.cam.handle); // both attempts share the fake; the stale one backs out
    await Promise.all([first, second]);
    expect(h.src.running).toBe(true);
    h.src.stop();
  });

  it('rejects with the mapped camera error', async () => {
    const h = harness();
    h.openCamera.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const err = await h.src.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect((err as TrackerError).code).toBe('camera-denied');
    expect(h.src.lastError).toBe(err);
    expect(h.src.running).toBe(false);
  });

  it('releases the camera and rejects when the model fails to load', async () => {
    const h = harness();
    h.loadLandmarker.mockRejectedValueOnce(new TrackerError('model-load-failed'));
    await expect(h.src.start()).rejects.toMatchObject({ code: 'model-load-failed' });
    expect(h.cam.stop).toHaveBeenCalled();
    expect(h.src.running).toBe(false);
    expect(h.src.video).toBeNull();
  });

  it('times out a model download that never finishes', async () => {
    const model = deferred<LandmarkerHandle>();
    const h = harness({ model });
    const started = h.src.start().catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await started).toMatchObject({ code: 'model-load-failed' });
    expect(h.cam.stop).toHaveBeenCalled();
  });

  it('fails fast on insecure pages without downloading the model', async () => {
    const loadLandmarker = vi.fn(() => Promise.resolve<LandmarkerHandle>(new FakeHandle()));
    const src = new CameraFeatureSource({}, { loadLandmarker }); // real openCamera; jsdom has no mediaDevices
    await expect(src.start()).rejects.toMatchObject({ code: 'insecure-context' });
    expect(loadLandmarker).not.toHaveBeenCalled();
    expect(src.lastError?.code).toBe('insecure-context');
  });

  it('stops and reports when the camera track ends', async () => {
    const h = harness();
    const errors: TrackerError[] = [];
    h.src.onError((e) => errors.push(e));
    await h.src.start();
    vi.advanceTimersByTime(100);
    h.cam.track.dispatchEvent(new Event('ended'));
    expect(h.src.running).toBe(false);
    expect(h.cam.stop).toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('camera-in-use');
    expect(h.frames.at(-1)?.faceFound).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an unbiased fps when frame times jitter', async () => {
    let enqueue!: (f: VideoFrame) => void;
    class FakeProcessor {
      readonly readable = new ReadableStream<VideoFrame>({
        start(controller) {
          enqueue = (f) => controller.enqueue(f);
        },
      });
    }
    Object.assign(globalThis, { MediaStreamTrackProcessor: FakeProcessor });
    const h = harness({ backgroundProcessing: true });
    await h.src.start();
    // 30 fps on average, delivered alternately 15 ms and 51.7 ms apart. Averaging
    // instantaneous rates would read ≈ 43 fps here.
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(i % 2 ? 15 : 2 * FRAME_MS - 15);
      enqueue({ displayWidth: 640, displayHeight: 480, close: () => undefined } as unknown as VideoFrame);
      await flush();
    }
    expect(h.lm.calls).toHaveLength(120);
    expect(h.src.fps).toBeGreaterThan(28.5);
    expect(h.src.fps).toBeLessThan(31.5);
    h.src.stop();
  });

  it('lets fps decay when frames stop arriving', async () => {
    const h = harness();
    await h.src.start();
    vi.advanceTimersByTime(1000);
    h.state.frozen = true;
    vi.advanceTimersByTime(2000);
    expect(h.src.fps).toBeLessThan(1);
    h.src.stop();
  });

  it('isolates a throwing frame listener', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness();
    h.src.onFrame(() => {
      throw new Error('listener bug');
    });
    await h.src.start();
    vi.advanceTimersByTime(200);
    expect(h.frames.length).toBeGreaterThan(3);
    expect(error).toHaveBeenCalled();
    h.src.stop();
  });

  it('prefers requestVideoFrameCallback and cancels it on stop', async () => {
    const h = harness();
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let next = 1;
    const request = vi.fn((cb: VideoFrameRequestCallback) => {
      callbacks.set(next, cb);
      return next++;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    Object.assign(h.video, { requestVideoFrameCallback: request, cancelVideoFrameCallback: cancel });
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');

    await h.src.start();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(FRAME_MS);
      const [id, cb] = [...callbacks.entries()][0];
      callbacks.delete(id);
      cb(performance.now(), {} as VideoFrameCallbackMetadata);
    }
    expect(h.lm.calls.length).toBeGreaterThanOrEqual(4);
    expect(raf).not.toHaveBeenCalled();
    h.src.stop();
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to a timer when frame callbacks stall (hidden preview, offscreen page)', async () => {
    const h = harness();
    // A video that never reports frames to the compositor.
    Object.assign(h.video, { requestVideoFrameCallback: vi.fn(() => 1), cancelVideoFrameCallback: vi.fn() });
    await h.src.start();
    vi.advanceTimersByTime(400);
    expect(h.lm.calls).toHaveLength(0);
    vi.advanceTimersByTime(1600);
    expect(h.lm.calls.length).toBeGreaterThan(30);
    h.src.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pulls frames from MediaStreamTrackProcessor in background mode and closes each one', async () => {
    const frames = Array.from({ length: 3 }, () => ({ displayWidth: 640, displayHeight: 480, close: vi.fn() }));
    let cancelled = false;
    class FakeProcessor {
      readonly readable: ReadableStream<VideoFrame>;
      constructor(readonly init: { track: MediaStreamTrack }) {
        this.readable = new ReadableStream<VideoFrame>({
          start(controller) {
            for (const f of frames) controller.enqueue(f as unknown as VideoFrame);
          },
          cancel() {
            cancelled = true;
          },
        });
      }
    }
    Object.assign(globalThis, { MediaStreamTrackProcessor: FakeProcessor });
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');

    const h = harness({ backgroundProcessing: true });
    await h.src.start();
    await flush();
    expect(h.lm.calls.map((c) => c.input)).toEqual(frames);
    expect(frames.every((f) => f.close.mock.calls.length === 1)).toBe(true);
    expect(h.frames.every((f) => f.faceFound)).toBe(true);
    expect(raf).not.toHaveBeenCalled();
    h.src.stop();
    await flush();
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to the video element if the track processor gives out mid-session', async () => {
    let controller!: ReadableStreamDefaultController<VideoFrame>;
    class FakeProcessor {
      readonly readable = new ReadableStream<VideoFrame>({
        start(c) {
          controller = c;
        },
      });
    }
    Object.assign(globalThis, { MediaStreamTrackProcessor: FakeProcessor });
    const h = harness({ backgroundProcessing: true });
    await h.src.start();
    const frame = { displayWidth: 640, displayHeight: 480, close: vi.fn() };
    controller.enqueue(frame as unknown as VideoFrame);
    await flush();
    expect(h.lm.calls).toHaveLength(1);

    controller.error(new Error('processor died'));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(h.lm.calls.length).toBeGreaterThan(25);
    expect(h.lm.calls.slice(1).every((c) => c.input === h.video)).toBe(true);
    expect(h.src.running).toBe(true);
    h.src.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─────────────────────────────── lighting ───────────────────────────────

const STATS: LightingStats = {
  faceLuma: 0.5,
  faceLin: 0.2,
  faceRange: 1.5,
  faceClip: 0,
  frameLin: 0.18,
  bgLin: 0.18,
  bgClip: 0,
  scleraR: 0.3,
  scleraL: 0.3,
  backlight: 1.2,
  side: 0.1,
  shade: -0.8,
  glareR: 0.001,
  glareL: 0.001,
  irisGlintR: 0,
  irisGlintL: 0,
  facePx: 5000,
};

/** A probe that hands out stats on every `every`-th frame and records what it was given. */
class FakeProbe implements LightingProbeLike {
  backend: LightingBackend = 'copy';
  readonly calls: { source: LightingSource; closedAtCall: boolean | null; features: EyeFeatures | null; quality: number; t: number }[] = [];
  resets = 0;
  disposed = 0;
  throwing = false;
  constructor(private readonly every = 5) {}
  maybeMeasure(source: LightingSource, _landmarks: readonly LandmarkLike[], features: EyeFeatures | null, quality: number, t: number): void {
    if (this.throwing) throw new Error('probe bug');
    const closed = (source as { closed?: unknown }).closed;
    this.calls.push({ source, closedAtCall: typeof closed === 'boolean' ? closed : null, features, quality, t });
  }
  take(): LightingStats | undefined {
    return this.calls.length % this.every === 0 ? { ...STATS } : undefined;
  }
  reset(): void {
    this.resets++;
  }
  dispose(): void {
    this.disposed++;
  }
}

function trackProcessor(): { enqueue: (f: object) => void } {
  let controller!: ReadableStreamDefaultController<VideoFrame>;
  class FakeProcessor {
    readonly readable = new ReadableStream<VideoFrame>({
      start(c) {
        controller = c;
      },
    });
  }
  Object.assign(globalThis, { MediaStreamTrackProcessor: FakeProcessor });
  return { enqueue: (f) => controller.enqueue(f as VideoFrame) };
}

/** A closable frame stand-in that records when the tracker closes it. */
function closableFrame(): { displayWidth: number; displayHeight: number; closed: boolean; close: () => void } {
  const f = {
    displayWidth: 640,
    displayHeight: 480,
    closed: false,
    close: () => {
      f.closed = true;
    },
  };
  return f;
}

describe('CameraFeatureSource lighting', () => {
  it('attaches lighting only to frames with a fresh measurement (video path)', async () => {
    const probe = new FakeProbe(5);
    const h = harness({ createLightingProbe: () => probe });
    await h.src.start();
    vi.advanceTimersByTime(1000);
    h.src.stop();
    const withLighting = h.frames.filter((f) => f.lighting);
    expect(h.frames.length).toBeGreaterThan(25);
    expect(withLighting.length).toBe(Math.floor(probe.calls.length / 5));
    expect(withLighting[0].lighting).toEqual(STATS);
    expect(probe.calls.every((c) => c.source === h.video)).toBe(true);
    expect(probe.calls[0].quality).toBe(h.frames[0].quality);
    expect(probe.calls[0].features).toBe(h.frames[0].features);
    expect(h.src.lightingBackend).toBe('copy');
    expect(probe.resets).toBe(1); // stop() drops pending work
  });

  it('hands the probe the VideoFrame before the driver closes it', async () => {
    const probe = new FakeProbe(1);
    const tp = trackProcessor();
    const h = harness({ backgroundProcessing: true, createLightingProbe: () => probe });
    await h.src.start();
    const frames = Array.from({ length: 4 }, closableFrame);
    for (const f of frames) {
      tp.enqueue(f);
      await flush();
    }
    expect(probe.calls.map((c) => c.source)).toEqual(frames);
    expect(probe.calls.every((c) => c.closedAtCall === false)).toBe(true);
    expect(frames.every((f) => f.closed)).toBe(true);
    expect(h.frames.every((f) => f.lighting)).toBe(true);
    h.src.stop();
  });

  it('keeps tracking when the probe throws, and drops the probe for good', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const probe = new FakeProbe(1);
    probe.throwing = true;
    const h = harness({ createLightingProbe: () => probe });
    await h.src.start();
    vi.advanceTimersByTime(500);
    expect(h.frames.length).toBeGreaterThan(10);
    expect(h.frames.every((f) => f.faceFound && f.features && !f.lighting)).toBe(true);
    expect(probe.disposed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.src.lightingBackend).toBe('off');
    h.src.stop();
    await h.src.start();
    vi.advanceTimersByTime(200);
    expect(warn).toHaveBeenCalledTimes(1); // not re-created
    h.src.stop();
  });

  it('runs without lighting when the probe is turned off or cannot be built', async () => {
    const makers: (() => LightingProbeLike | null)[] = [
      () => null,
      () => {
        throw new Error('no probe');
      },
    ];
    for (const make of makers) {
      const h = harness({ createLightingProbe: make });
      await h.src.start();
      vi.advanceTimersByTime(300);
      expect(h.frames.length).toBeGreaterThan(5);
      expect(h.frames.some((f) => f.lighting)).toBe(false);
      expect(h.src.lightingBackend).toBe('off');
      h.src.stop();
    }
  });

  it('measures real frames end to end in the extension path, closing every clone', async () => {
    const scene = renderScene();
    const registry: FrameRegistry = { clones: 0, closes: 0, copies: 0, open: new Set() };
    const tp = trackProcessor();
    const h = harness({
      backgroundProcessing: true,
      createLightingProbe: () => new LightingProbe({ backend: 'copy', createCanvas: (w, hh) => new FakeCanvas(w, hh, { created: [], draws: 0, reads: 0 }) }),
    });
    h.lm.result = { ...FACE_RESULT, faceLandmarks: [scene.landmarks] };
    await h.src.start();
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(FRAME_MS);
      tp.enqueue(new FakeVideoFrame(scene, { format: 'NV12', fullRange: false, copy: 'resolve', rowPadding: 0 }, registry));
      await flush();
    }
    const lit = h.frames.filter((f) => f.lighting);
    expect(lit.length).toBeGreaterThanOrEqual(10); // 2 s at ≈ 6.7 Hz
    expect(lit.length).toBeLessThanOrEqual(14);
    expect(lit[0].lighting!.scleraR).toBeGreaterThan(0.5);
    expect(registry.open.size).toBe(0); // originals closed by the driver, clones by the probe
    expect(registry.clones).toBe(lit.length);
    h.src.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds little synchronous work per frame (measured with fakes)', async () => {
    const scene = renderScene();
    const run = async (withProbe: boolean): Promise<{ perFrameUs: number; lit: number }> => {
      const tp = trackProcessor();
      const h = harness({
        backgroundProcessing: true,
        createLightingProbe: () => (withProbe ? new LightingProbe({ backend: 'copy', createCanvas: null }) : null),
      });
      h.lm.result = { ...FACE_RESULT, faceLandmarks: [scene.landmarks] };
      // From the end of detection to the frame reaching listeners: features + lighting + emit.
      let detectDone = 0;
      const inner = h.lm.detect.bind(h.lm);
      h.lm.detect = (input: TexImageSource, t: number): FaceResultLike => {
        const r = inner(input, t);
        detectDone = realNow();
        return r;
      };
      let total = 0;
      h.src.onFrame(() => {
        total += realNow() - detectDone;
      });
      await h.src.start();
      const N = 600;
      for (let i = 0; i < N; i++) {
        vi.advanceTimersByTime(FRAME_MS);
        tp.enqueue(new FakeVideoFrame(scene, { format: 'NV12', fullRange: false, copy: 'resolve', rowPadding: 0 }));
        await flush();
      }
      h.src.stop();
      return { perFrameUs: (total / N) * 1000, lit: h.frames.filter((f) => f.lighting).length };
    };
    await run(true); // warm up
    const off = await run(false);
    const on = await run(true);
    const added = on.perFrameUs - off.perFrameUs;
    console.info(
      `[faceTracker lighting cost] per frame: ${off.perFrameUs.toFixed(1)} µs without, ${on.perFrameUs.toFixed(1)} µs with the probe (+${added.toFixed(1)} µs; ${on.lit} measurements in 600 frames)`,
    );
    expect(on.lit).toBeGreaterThan(100);
    expect(added).toBeLessThan(100); // µs per frame on average; a frame at 30 fps lasts 33 000 µs
  });
});
