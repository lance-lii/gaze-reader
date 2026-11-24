/**
 * The main thread's side of the eye-picture network (eyeNet.ts): for every camera frame it cuts
 * the eye region out as a bitmap, hands it to the background thread (eyeNetWorker.ts), and
 * passes the frame on with the network's answer attached once it is back.
 *
 * Frames leave in the order they came. One that gets no answer in time (the worker is busy, the
 * eyes are out of the picture) leaves without one rather than hold the others up; a calibration
 * made on the network skips such a frame as it skips a blink.
 */
import type { FeatureFrame } from '../types';
import { eyeCorners, eyeNetExtras, eyeRegion } from './eyeNet';
import type { EyeNetReply, EyeNetRequest } from './eyeNetWorker';
import { FEATURE_INDEX } from './features';

/** What the picture is cut from: the camera's video element, or one of its frames. */
export type EyeNetSource = HTMLVideoElement | VideoFrame;

export interface EyeNetWorkerLike {
  postMessage(message: EyeNetRequest, transfer?: Transferable[]): void;
  onmessage: ((event: { data: EyeNetReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface EyeNetRunnerDeps {
  createWorker(): EyeNetWorkerLike;
  /** `createImageBitmap(source, x, y, width, height)`. */
  bitmapOf(source: EyeNetSource, x: number, y: number, width: number, height: number): Promise<ImageBitmap>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The shape of the pictures a network wants, known before the worker has read the weights. */
export interface EyeNetShape {
  id: string;
  width: number;
  height: number;
  span: number;
  /** How many numbers besides the pictures: 0, or 5 (the head). */
  extras: number;
}

/** A frame waits this long for its answer, then goes on without it: under two frames at 30 a second. */
export const EYE_NET_MAX_WAIT_MS = 50;
/** With this many frames already waiting, a new one is not sent to the network at all. */
export const EYE_NET_MAX_PENDING = 3;

interface Pending {
  seq: number;
  frame: FeatureFrame;
  emit: (frame: FeatureFrame) => void;
  done: boolean;
  timer: unknown;
}

export function defaultEyeNetRunnerDeps(): EyeNetRunnerDeps {
  return {
    createWorker: () => new Worker(new URL('./eyeNetWorker.ts', import.meta.url), { type: 'module' }) as unknown as EyeNetWorkerLike,
    bitmapOf: (source, x, y, width, height) => createImageBitmap(source, x, y, width, height),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export class EyeNetRunner {
  readonly id: string;
  private readonly worker: EyeNetWorkerLike;
  private readonly pending: Pending[] = [];
  private seq = 0;
  private ready = false;
  private dead = false;
  /** Answers received, and frames that left without one, since the last {@link takeCounts}. */
  private answered = 0;
  private missed = 0;
  private settleStart: (running: boolean) => void = () => {};
  /** Resolves once the worker has said whether it can run the network: true when it can. */
  readonly started: Promise<boolean> = new Promise<boolean>((resolve) => {
    this.settleStart = resolve;
  });

  /**
   * @param weights the weights file's contents, as the reader supplied them (the worker checks them again)
   * @param shape what {@link resolveEyeNet} made of the same file
   * @param onFailed called once if the worker cannot run the network; frames then pass through untouched
   */
  constructor(
    weights: unknown,
    private readonly shape: EyeNetShape,
    private readonly deps: EyeNetRunnerDeps = defaultEyeNetRunnerDeps(),
    private readonly onFailed: (message: string) => void = () => {},
  ) {
    this.id = shape.id;
    this.worker = deps.createWorker();
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = () => this.fail('The eye-picture network stopped working.');
    this.worker.postMessage({ type: 'load', weights });
  }

  /** True once the worker has the network and has not failed since. */
  get running(): boolean {
    return this.ready && !this.dead;
  }

  /**
   * Takes one camera frame; `emit` gets it back, in turn, with `features.eyeNet` set when the
   * network answered. Call while `source` still shows the frame the landmarks are of.
   */
  submit(
    source: EyeNetSource,
    frameWidth: number,
    frameHeight: number,
    landmarks: ArrayLike<{ x: number; y: number }>,
    frame: FeatureFrame,
    emit: (frame: FeatureFrame) => void,
  ): void {
    const features = frame.features;
    const corners = features && this.running && this.pending.length < EYE_NET_MAX_PENDING ? eyeCorners(landmarks, frameWidth, frameHeight) : null;
    const region = corners ? eyeRegion(corners, frameWidth, frameHeight, this.shape) : null;
    if (!features || !corners || !region) {
      // Nothing to ask the network: the frame still waits its turn behind those that are being asked about.
      if (features && this.running) this.missed++;
      this.pending.push({ seq: -1, frame, emit, done: true, timer: null });
      this.flush();
      return;
    }
    const seq = ++this.seq;
    const entry: Pending = { seq, frame, emit, done: false, timer: null };
    entry.timer = this.deps.setTimeout(() => this.settle(entry, null), EYE_NET_MAX_WAIT_MS);
    this.pending.push(entry);
    const local = corners.map((c, i) => c - (i % 2 === 0 ? region.x : region.y));
    const extra = this.shape.extras > 0 ? eyeNetExtras(features.vector, FEATURE_INDEX) : null;
    let bitmap: Promise<ImageBitmap>;
    try {
      bitmap = this.deps.bitmapOf(source, region.x, region.y, region.width, region.height);
    } catch {
      this.settle(entry, null);
      return;
    }
    bitmap.then(
      (b) => {
        if (entry.done || this.dead) {
          b.close();
          return;
        }
        this.worker.postMessage({ type: 'frame', seq, bitmap: b, corners: local, extra }, [b]);
      },
      () => this.settle(entry, null),
    );
  }

  /** How many frames got an answer and how many went without, since the last call. */
  takeCounts(): { answered: number; missed: number } {
    const counts = { answered: this.answered, missed: this.missed };
    this.answered = 0;
    this.missed = 0;
    return counts;
  }

  /** Stops the worker. Frames still waiting leave without an answer. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.settleStart(false);
    this.release();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }

  private receive(reply: EyeNetReply): void {
    if (this.dead) return;
    if (reply.type === 'ready') {
      this.ready = reply.id === this.id;
      if (!this.ready) this.fail('The eye-picture network is not the one that was loaded.');
      else this.settleStart(true);
      return;
    }
    if (reply.type === 'failed') {
      this.fail(reply.message);
      return;
    }
    const entry = this.pending.find((p) => p.seq === reply.seq);
    if (entry) this.settle(entry, Number.isFinite(reply.x) && Number.isFinite(reply.y) ? { x: reply.x, y: reply.y } : null);
  }

  private settle(entry: Pending, answer: { x: number; y: number } | null): void {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer !== null) this.deps.clearTimeout(entry.timer);
    entry.timer = null;
    if (answer && entry.frame.features) {
      entry.frame = { ...entry.frame, features: { ...entry.frame.features, eyeNet: { id: this.id, x: answer.x, y: answer.y } } };
      this.answered++;
    } else {
      this.missed++;
    }
    this.flush();
  }

  private flush(): void {
    while (this.pending.length > 0 && this.pending[0].done) {
      const entry = this.pending.shift()!;
      entry.emit(entry.frame);
    }
  }

  private release(): void {
    for (const entry of this.pending) {
      if (entry.timer !== null) this.deps.clearTimeout(entry.timer);
      entry.timer = null;
      entry.done = true;
    }
    this.flush();
  }

  private fail(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.release();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.settleStart(false);
    this.onFailed(message);
  }
}
