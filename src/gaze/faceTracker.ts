import type { FaceLandmarkerOptions, FilesetResolver } from '@mediapipe/tasks-vision';
import { FACE_LANDMARKER_MODEL_URL, MEDIAPIPE_WASM_DIR } from '../core/constants';
import type { FeatureFrame, FeatureSource, Unsubscribe } from '../types';
import {
  cameraSupportError,
  openCamera,
  toTrackerError,
  TrackerError,
  type CameraHandle,
  type OpenCameraOptions,
} from './camera';
import { extractEyeFeatures, frameQuality, type BlendshapeLike, type LandmarkLike } from './features';

export { TrackerError } from './camera';

export type Delegate = 'GPU' | 'CPU';

// ───────────────────────────── MediaPipe seams ─────────────────────────────

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/** The part of a FaceLandmarkerResult we read (the real result type is assignable). */
export interface FaceResultLike {
  readonly faceLandmarks: readonly (readonly LandmarkLike[])[];
  readonly faceBlendshapes?: readonly { readonly categories: readonly BlendshapeLike[] }[];
  readonly facialTransformationMatrixes?: readonly { readonly data: readonly number[] }[];
}

export interface FaceLandmarkerLike {
  detectForVideo(input: TexImageSource, timestampMs: number): FaceResultLike;
  close(): void;
}

/** The subset of `@mediapipe/tasks-vision` we use; injectable for tests. */
export interface VisionModuleLike {
  FilesetResolver: { forVisionTasks(basePath?: string): Promise<WasmFileset> };
  FaceLandmarker: {
    createFromOptions(fileset: WasmFileset, options: FaceLandmarkerOptions): Promise<FaceLandmarkerLike>;
  };
}

export interface LandmarkerConfig {
  wasmBaseUrl: string;
  modelAssetPath: string;
  delegate: Delegate;
}

/** A loaded landmarker, shareable between sources. */
export interface LandmarkerHandle {
  /** May change from 'GPU' to 'CPU' if the GPU keeps failing at runtime. */
  readonly delegate: Delegate;
  /**
   * Runs detection. The timestamp handed to MediaPipe is `timeMs` rounded,
   * bumped so it is strictly greater than every earlier one for this
   * landmarker (MediaPipe rejects repeats, even across sources).
   */
  detect(input: TexImageSource, timeMs: number): FaceResultLike;
  close(): void;
}

/** Consecutive runtime failures on the GPU before we rebuild on the CPU (~1 s at 30 fps). */
const GPU_FAILURE_LIMIT = 30;

class ManagedLandmarker implements LandmarkerHandle {
  private lastTimestamp = -Infinity;
  private consecutiveFailures = 0;
  private demotion: 'idle' | 'pending' | 'failed' = 'idle';
  private closed = false;

  constructor(
    private inner: FaceLandmarkerLike,
    private current: Delegate,
    private readonly createCpu: () => Promise<FaceLandmarkerLike>,
  ) {}

  get delegate(): Delegate {
    return this.current;
  }

  detect(input: TexImageSource, timeMs: number): FaceResultLike {
    if (this.closed) throw new Error('The face landmarker has been closed.');
    const rounded = Number.isFinite(timeMs) ? Math.round(timeMs) : -Infinity;
    const ts = Math.max(rounded, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    try {
      const result = this.inner.detectForVideo(input, ts);
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      if (++this.consecutiveFailures >= GPU_FAILURE_LIMIT) this.demoteToCpu();
      throw err;
    }
  }

  /** A lost WebGL context makes every GPU detection throw; the CPU path keeps working. */
  private demoteToCpu(): void {
    if (this.current !== 'GPU' || this.demotion !== 'idle' || this.closed) return;
    this.demotion = 'pending';
    console.warn('[gaze] Face tracking keeps failing on the GPU; switching to the CPU.');
    this.createCpu().then(
      (cpu) => {
        if (this.closed) {
          cpu.close();
          return;
        }
        const old = this.inner;
        this.inner = cpu;
        this.current = 'CPU';
        this.consecutiveFailures = 0;
        this.demotion = 'idle';
        closeQuietly(old);
      },
      (err: unknown) => {
        this.demotion = 'failed';
        console.warn('[gaze] CPU fallback failed too.', err);
      },
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeQuietly(this.inner);
  }
}

function closeQuietly(landmarker: FaceLandmarkerLike): void {
  try {
    landmarker.close();
  } catch {
    /* already gone */
  }
}

export interface LandmarkerLoader {
  /** Cached per (wasm base, model, delegate): restarts are instant. Rejects with TrackerError('model-load-failed'). */
  load(cfg: LandmarkerConfig): Promise<LandmarkerHandle>;
  /** Closes and forgets every cached landmarker. Only call once no source is running. */
  dispose(): void;
}

function landmarkerOptions(modelAssetPath: string, delegate: Delegate): FaceLandmarkerOptions {
  return {
    baseOptions: { modelAssetPath, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };
}

/** FilesetResolver joins `${base}/${file}`, so a trailing slash would double up. */
const normalizeBase = (url: string): string => url.replace(/\/+$/, '');

export function createLandmarkerLoader(importVision: () => Promise<VisionModuleLike>): LandmarkerLoader {
  const cache = new Map<string, Promise<LandmarkerHandle>>();

  async function create(cfg: LandmarkerConfig): Promise<LandmarkerHandle> {
    const base = normalizeBase(cfg.wasmBaseUrl);
    let vision: VisionModuleLike;
    let fileset: WasmFileset;
    try {
      vision = await importVision();
      fileset = await vision.FilesetResolver.forVisionTasks(base);
    } catch (err) {
      throw new TrackerError('model-load-failed', "Couldn't load the face-tracking runtime.", { cause: err });
    }
    const make = (delegate: Delegate): Promise<FaceLandmarkerLike> =>
      vision.FaceLandmarker.createFromOptions(fileset, landmarkerOptions(cfg.modelAssetPath, delegate));

    try {
      return new ManagedLandmarker(await make(cfg.delegate), cfg.delegate, () => make('CPU'));
    } catch (err) {
      if (cfg.delegate !== 'GPU') throw new TrackerError('model-load-failed', undefined, { cause: err });
      console.warn('[gaze] GPU face tracking is unavailable; falling back to the CPU.', err);
    }
    try {
      return new ManagedLandmarker(await make('CPU'), 'CPU', () => make('CPU'));
    } catch (err) {
      throw new TrackerError('model-load-failed', undefined, { cause: err });
    }
  }

  return {
    load(cfg) {
      const key = `${normalizeBase(cfg.wasmBaseUrl)}|${cfg.modelAssetPath}|${cfg.delegate}`;
      let pending = cache.get(key);
      if (!pending) {
        const p = create(cfg);
        cache.set(key, p);
        // Forget failures so the next attempt (e.g. after going back online) retries.
        p.catch(() => {
          if (cache.get(key) === p) cache.delete(key);
        });
        pending = p;
      }
      return pending;
    },
    dispose() {
      for (const p of cache.values()) p.then((h) => h.close(), () => undefined);
      cache.clear();
    },
  };
}

const defaultLoader = createLandmarkerLoader(() => import('@mediapipe/tasks-vision'));

function defaultWasmBaseUrl(): string {
  const base = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;
  return new URL(MEDIAPIPE_WASM_DIR, base).href;
}

function resolveLandmarkerConfig(opts: Pick<CameraFeatureSourceOptions, 'wasmBaseUrl' | 'modelAssetPath' | 'delegate'>): LandmarkerConfig {
  return {
    wasmBaseUrl: opts.wasmBaseUrl ?? defaultWasmBaseUrl(),
    modelAssetPath: opts.modelAssetPath ?? FACE_LANDMARKER_MODEL_URL,
    delegate: opts.delegate ?? 'GPU',
  };
}

/** Loads (or returns the cached) shared landmarker. */
export function loadFaceLandmarker(cfg: LandmarkerConfig): Promise<LandmarkerHandle> {
  return defaultLoader.load(cfg);
}

/**
 * Starts downloading and compiling the model ahead of time (e.g. while the
 * onboarding screen explains the camera) so start() is quick. Never rejects.
 */
export function preloadFaceLandmarker(
  opts: Pick<CameraFeatureSourceOptions, 'wasmBaseUrl' | 'modelAssetPath' | 'delegate'> = {},
): Promise<boolean> {
  return defaultLoader.load(resolveLandmarkerConfig(opts)).then(
    () => true,
    () => false,
  );
}

/** Frees every cached landmarker (WASM + WebGL memory). Only call once no source is running. */
export function disposeFaceLandmarkers(): void {
  defaultLoader.dispose();
}

// ──────────────────────────────── Frame drivers ───────────────────────────────

const HAVE_CURRENT_DATA = 2;
const FRAME_INTERVAL_MS = 1000 / 30;
const WATCHDOG_IDLE_MS = 250;
/** No callback from rVFC/rAF for this long → the timer takes over. */
const DRIVER_STALL_MS = 500;
const MODEL_LOAD_TIMEOUT_MS = 60_000;
const FPS_ALPHA = 0.1;

type Cancel = () => void;

/** Fires once per new frame the compositor receives (Chromium, Safari, Firefox 132+). */
function driveByVideoFrames(video: HTMLVideoElement, tick: () => void): Cancel {
  let active = true;
  let handle = 0;
  const step = (): void => {
    if (!active) return;
    handle = video.requestVideoFrameCallback(step);
    tick();
  };
  handle = video.requestVideoFrameCallback(step);
  return () => {
    active = false;
    video.cancelVideoFrameCallback(handle);
  };
}

function driveByAnimationFrames(tick: () => void): Cancel {
  if (typeof requestAnimationFrame !== 'function') return () => undefined;
  let active = true;
  let handle = 0;
  const step = (): void => {
    if (!active) return;
    handle = requestAnimationFrame(step);
    tick();
  };
  handle = requestAnimationFrame(step);
  return () => {
    active = false;
    cancelAnimationFrame(handle);
  };
}

/**
 * rVFC and rAF stop when nothing is being painted — a display:none preview, an
 * unrendered offscreen document. A slow timer notices and polls at ~30 Hz until
 * the primary driver comes back. (Background tabs throttle timers anyway.)
 */
function driveByWatchdog(isStalled: () => boolean, tick: () => void): Cancel {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = (): void => {
    if (!active) return;
    const stalled = isStalled();
    if (stalled) tick();
    if (active) timer = setTimeout(loop, stalled ? FRAME_INTERVAL_MS : WATCHDOG_IDLE_MS);
  };
  timer = setTimeout(loop, WATCHDOG_IDLE_MS);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

interface TrackProcessorLike {
  readonly readable: ReadableStream<VideoFrame>;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessorLike;

/**
 * Pulls frames straight from the track (Chromium's MediaStreamTrackProcessor),
 * independent of rendering. Returns null when unsupported.
 */
function driveByTrackProcessor(track: MediaStreamTrack, onFrame: (frame: VideoFrame) => void): Cancel | null {
  const Ctor = (globalThis as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  if (typeof Ctor !== 'function') return null;
  let reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    reader = new (Ctor as TrackProcessorCtor)({ track, maxBufferSize: 2 }).readable.getReader();
  } catch {
    return null;
  }
  let active = true;
  void (async () => {
    while (active) {
      let chunk: ReadableStreamReadResult<VideoFrame>;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      const frame = chunk.value;
      try {
        if (active) onFrame(frame);
      } finally {
        // Unclosed frames exhaust the camera's buffer pool and stall capture.
        frame.close();
      }
    }
  })();
  return () => {
    active = false;
    reader.cancel().catch(() => undefined);
  };
}

function isExtensionPage(): boolean {
  const protocol = globalThis.location?.protocol ?? '';
  return /^(chrome|moz|safari-web)-extension:$/.test(protocol);
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ───────────────────────────── CameraFeatureSource ─────────────────────────────

export interface CameraFeatureSourceOptions {
  /** Default: new URL(MEDIAPIPE_WASM_DIR, document.baseURI).href */
  wasmBaseUrl?: string;
  /** Default: FACE_LANDMARKER_MODEL_URL */
  modelAssetPath?: string;
  /** Default 'GPU', with automatic fallback to the CPU. */
  delegate?: Delegate;
  /** Element to play the camera into (e.g. a preview); otherwise a hidden one is created. */
  video?: HTMLVideoElement;
  /** Extra camera constraints, merged over the defaults (640×480 @ 30 fps, front camera). */
  constraints?: MediaTrackConstraints;
  /**
   * Keep processing while the document is not rendered (the extension's
   * offscreen document), pulling frames with MediaStreamTrackProcessor where
   * available. Default: true on extension pages, false elsewhere.
   */
  backgroundProcessing?: boolean;
}

/** Injection seams (tests, alternative runtimes). */
export interface FaceTrackerDeps {
  openCamera(opts: OpenCameraOptions): Promise<CameraHandle>;
  loadLandmarker(cfg: LandmarkerConfig): Promise<LandmarkerHandle>;
  now(): number;
}

interface Session {
  readonly camera: CameraHandle;
  readonly landmarker: LandmarkerHandle;
  lastVideoTime: number;
  lastDriverTickAt: number;
  readonly cancels: Cancel[];
}

const NO_FACE = (t: number): FeatureFrame => ({ t, faceFound: false, features: null, quality: 0 });

/**
 * Webcam → MediaPipe Face Landmarker → EyeFeatures, one FeatureFrame per new
 * video frame. Everything stays on the device.
 */
export class CameraFeatureSource implements FeatureSource {
  private readonly opts: CameraFeatureSourceOptions;
  private readonly deps: FaceTrackerDeps;
  private readonly frameListeners = new Set<(frame: FeatureFrame) => void>();
  private readonly errorListeners = new Set<(err: TrackerError) => void>();

  /** Bumped by every stop(); an in-flight start() that sees a newer value backs out. */
  private generation = 0;
  private starting: Promise<void> | null = null;
  private pendingCamera: CameraHandle | null = null;
  private session: Session | null = null;

  private fpsEma = 0;
  private lastFrameAt: number | null = null;
  private landmarks: readonly LandmarkLike[] | null = null;
  private error: TrackerError | null = null;
  private frameErrorLogged = false;

  constructor(opts: CameraFeatureSourceOptions = {}, deps: Partial<FaceTrackerDeps> = {}) {
    this.opts = { ...opts };
    this.deps = {
      openCamera: deps.openCamera ?? openCamera,
      loadLandmarker: deps.loadLandmarker ?? loadFaceLandmarker,
      now: deps.now ?? (() => performance.now()),
    };
  }

  get running(): boolean {
    return this.session !== null;
  }

  /** The element the camera plays in (for previews); null when stopped and self-created. */
  get video(): HTMLVideoElement | null {
    return this.session?.camera.video ?? this.pendingCamera?.video ?? this.opts.video ?? null;
  }

  /** Processed frames per second (EMA); decays toward 0 if frames stop arriving. */
  get fps(): number {
    if (!this.session || this.lastFrameAt === null || this.fpsEma <= 0) return 0;
    const since = this.deps.now() - this.lastFrameAt;
    const expected = 1000 / this.fpsEma;
    return since > 2 * expected ? Math.min(this.fpsEma, 1000 / since) : this.fpsEma;
  }

  /** Landmarks of the latest frame with a face (normalized image coords), for preview overlays. */
  get lastLandmarks(): readonly LandmarkLike[] | null {
    return this.landmarks;
  }

  /** The most recent start or runtime failure; cleared by the next start(). */
  get lastError(): TrackerError | null {
    return this.error;
  }

  /** The delegate in use while running. */
  get delegate(): Delegate | null {
    return this.session?.landmarker.delegate ?? null;
  }

  onFrame(cb: (frame: FeatureFrame) => void): Unsubscribe {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  /** Failures after a successful start (camera unplugged or taken over). The source has already stopped. */
  onError(cb: (err: TrackerError) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  /**
   * Opens the camera and loads the model (in parallel). Idempotent: concurrent
   * calls share one attempt. Rejects with a TrackerError. If stop() is called
   * before it finishes, the promise resolves without starting (check `running`).
   */
  start(): Promise<void> {
    if (this.session) return Promise.resolve();
    if (this.starting) return this.starting;
    const attempt = this.doStart(++this.generation).finally(() => {
      if (this.starting === attempt) this.starting = null;
    });
    this.starting = attempt;
    return attempt;
  }

  /** Releases the camera and cancels the loop. The loaded model stays cached for a fast restart. */
  stop(): void {
    this.generation++;
    this.starting = null;
    this.pendingCamera?.stop();
    this.pendingCamera = null;
    const s = this.session;
    this.session = null;
    if (s) {
      for (const cancel of s.cancels) {
        try {
          cancel();
        } catch {
          /* keep tearing down */
        }
      }
      s.camera.stop();
    }
    this.fpsEma = 0;
    this.lastFrameAt = null;
    this.landmarks = null;
    this.frameErrorLogged = false;
  }

  private async doStart(gen: number): Promise<void> {
    this.error = null;
    const unsupported = cameraSupportError();
    if (unsupported) throw this.fail(unsupported);

    // The model download is the slow part; overlap it with the permission prompt.
    const model = this.deps.loadLandmarker(resolveLandmarkerConfig(this.opts));
    model.catch(() => undefined); // awaited below; don't flag it if the camera fails first

    let camera: CameraHandle;
    try {
      camera = await this.deps.openCamera({ video: this.opts.video, constraints: this.opts.constraints });
    } catch (err) {
      if (gen !== this.generation) return;
      throw this.fail(toTrackerError(err));
    }
    if (gen !== this.generation) {
      camera.stop();
      return;
    }
    this.pendingCamera = camera;

    let landmarker: LandmarkerHandle;
    try {
      landmarker = await withTimeout(
        model,
        MODEL_LOAD_TIMEOUT_MS,
        () => new TrackerError('model-load-failed', 'Loading the face-tracking model timed out. Check your connection and try again.'),
      );
    } catch (err) {
      camera.stop();
      if (gen !== this.generation) return;
      this.pendingCamera = null;
      throw this.fail(err instanceof TrackerError ? err : new TrackerError('model-load-failed', undefined, { cause: err }));
    }
    if (gen !== this.generation) {
      camera.stop();
      return;
    }
    this.pendingCamera = null;
    this.beginSession(camera, landmarker);
  }

  private fail(err: TrackerError): TrackerError {
    this.error = err;
    return err;
  }

  private beginSession(camera: CameraHandle, landmarker: LandmarkerHandle): void {
    const s: Session = { camera, landmarker, lastVideoTime: -1, lastDriverTickAt: this.deps.now(), cancels: [] };
    this.session = s;

    const onEnded = (): void => this.handleTrackEnded(s);
    camera.track.addEventListener('ended', onEnded);
    s.cancels.push(() => camera.track.removeEventListener('ended', onEnded));

    const background = this.opts.backgroundProcessing ?? isExtensionPage();
    if (background) {
      const cancel = driveByTrackProcessor(camera.track, (frame) => this.processFrame(s, frame));
      if (cancel) {
        s.cancels.push(cancel);
        return;
      }
    }

    const tick = (): void => {
      s.lastDriverTickAt = this.deps.now();
      this.processFrame(s);
    };
    const video = camera.video;
    s.cancels.push(
      typeof video.requestVideoFrameCallback === 'function' ? driveByVideoFrames(video, tick) : driveByAnimationFrames(tick),
      driveByWatchdog(
        () => this.deps.now() - s.lastDriverTickAt > DRIVER_STALL_MS,
        () => this.processFrame(s),
      ),
    );
  }

  private processFrame(s: Session, frame?: VideoFrame): void {
    if (this.session !== s) return;

    let input: TexImageSource;
    let aspectRatio: number;
    if (frame) {
      if (!(frame.displayWidth > 0 && frame.displayHeight > 0)) return;
      input = frame;
      aspectRatio = frame.displayWidth / frame.displayHeight;
    } else {
      const video = s.camera.video;
      if (video.readyState < HAVE_CURRENT_DATA || !(video.videoWidth > 0 && video.videoHeight > 0)) return;
      // Several drivers may fire for the same frame; process each frame once.
      if (video.currentTime === s.lastVideoTime) return;
      s.lastVideoTime = video.currentTime;
      input = video;
      aspectRatio = video.videoWidth / video.videoHeight;
    }

    const t = this.deps.now();
    let result: FaceResultLike;
    try {
      result = s.landmarker.detect(input, t);
    } catch (err) {
      // One bad frame (or a GPU hiccup) must not kill tracking.
      if (!this.frameErrorLogged) {
        this.frameErrorLogged = true;
        console.warn('[gaze] Face detection failed on a frame; continuing.', err);
      }
      this.landmarks = null;
      this.emit(NO_FACE(t));
      return;
    }
    this.frameErrorLogged = false;
    this.updateFps(t);

    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length === 0) {
      this.landmarks = null;
      this.emit(NO_FACE(t));
      return;
    }
    this.landmarks = landmarks;
    const features = extractEyeFeatures(
      landmarks,
      result.faceBlendshapes?.[0]?.categories ?? null,
      result.facialTransformationMatrixes?.[0]?.data ?? null,
      { aspectRatio },
    );
    this.emit({ t, faceFound: true, features, quality: frameQuality(features) });
  }

  private updateFps(t: number): void {
    if (this.lastFrameAt !== null) {
      const dt = t - this.lastFrameAt;
      if (dt > 0) {
        const instant = Math.min(1000 / dt, 240);
        this.fpsEma = this.fpsEma > 0 ? this.fpsEma + FPS_ALPHA * (instant - this.fpsEma) : instant;
      }
    }
    this.lastFrameAt = t;
  }

  private handleTrackEnded(s: Session): void {
    if (this.session !== s) return;
    const err = this.fail(
      new TrackerError('camera-in-use', 'The camera stopped sending video. It may have been unplugged or taken by another app.'),
    );
    this.emit(NO_FACE(this.deps.now()));
    this.stop();
    for (const cb of [...this.errorListeners]) {
      try {
        cb(err);
      } catch (listenerErr) {
        console.error('[gaze] onError listener threw', listenerErr);
      }
    }
  }

  private emit(frame: FeatureFrame): void {
    for (const cb of [...this.frameListeners]) {
      try {
        cb(frame);
      } catch (err) {
        console.error('[gaze] onFrame listener threw', err);
      }
    }
  }
}
