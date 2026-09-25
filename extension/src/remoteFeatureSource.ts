import type { FeatureFrame, FeatureSource, TrackerErrorCode, Unsubscribe } from '../../src/types';
import { PORT_TAB, isHubToTab, type CameraStatus, type TabToHub } from './messages';
import { backoffDelay, extensionContextValid, safeDisconnect, safePost, type PortLike } from './ports';

/**
 * Same shape as `TrackerError` in src/gaze/faceTracker.ts. Defined here so the
 * content-script bundle never imports faceTracker (and with it MediaPipe).
 */
export class RemoteTrackerError extends Error {
  readonly code: TrackerErrorCode;
  constructor(code: TrackerErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TrackerError';
    this.code = code;
  }
}

export type RemoteSourceState =
  | 'idle'
  /** Opening the port to the service worker. */
  | 'connecting'
  /** Subscribed; the camera is warming up. */
  | 'starting'
  | 'running'
  /** The port dropped (service worker restarted); reconnecting with backoff. */
  | 'reconnecting'
  | 'error'
  /** The extension was reloaded or removed: this content script can never talk to it again. */
  | 'orphaned';

export interface RemoteSourceStatus {
  state: RemoteSourceState;
  code?: TrackerErrorCode;
  message?: string;
}

export interface RemoteFeatureSourceOptions {
  /** Opens the port to the service worker. Default: chrome.runtime.connect({ name: PORT_TAB }). */
  connect?: () => PortLike;
  /** Default: chrome.runtime.id is still defined. */
  isContextValid?: () => boolean;
  /** Local clock. Default: performance.now. */
  now?: () => number;
  /** start() rejects if the camera isn't running after this long. Default 60 s (first run downloads the model). */
  startTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
}

/**
 * Maps timestamps from another document's `performance.now()` onto ours.
 *
 * The offscreen document has its own time origin, so its frame times are
 * meaningless here. `local − remote` for each frame equals the clock offset
 * plus the IPC delay; the running minimum of it converges to offset + the
 * smallest delay, which keeps the *spacing* between frames exact (fixation
 * durations and the One Euro filter depend on it) no matter how bursty the
 * relay is. A jump of more than `resyncMs` means the remote clock changed
 * (offscreen document recreated), so we start over.
 */
export class ClockSync {
  private offset: number | null = null;
  private lastRemote = -Infinity;
  private lastLocal = -Infinity;

  constructor(private readonly resyncMs = 1000) {}

  toLocal(remoteT: number, localNow: number): number {
    const lag = localNow - remoteT;
    if (this.offset === null || remoteT < this.lastRemote || lag < this.offset || lag - this.offset > this.resyncMs) {
      this.offset = lag;
    }
    this.lastRemote = remoteT;
    // Never run backwards, never run ahead of the local clock.
    const t = Math.min(localNow, Math.max(this.lastLocal, remoteT + this.offset));
    this.lastLocal = t;
    return t;
  }

  reset(): void {
    this.offset = null;
    this.lastRemote = -Infinity;
    this.lastLocal = -Infinity;
  }
}

interface Pending {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Pending {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Callers that drop the promise (e.g. a stop() racing a start()) must not produce unhandled rejections.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * A FeatureSource whose frames come from the offscreen document, relayed by
 * the service worker over a runtime Port.
 *
 * The port exists only while frames are wanted (start() … stop()), so an idle
 * tab never keeps the service worker awake. If the port drops while wanted —
 * the service worker was stopped by Chrome — we reconnect with backoff and
 * resubscribe; the camera itself keeps running in the offscreen document.
 */
export class RemoteFeatureSource implements FeatureSource {
  private readonly connectFn: () => PortLike;
  private readonly isContextValid: () => boolean;
  private readonly now: () => number;
  private readonly startTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;

  private port: PortLike | null = null;
  private wanted = false;
  private started = false;
  private destroyed = false;
  private attempts = 0;
  private pending: Pending | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private statusValue: RemoteSourceStatus = { state: 'idle' };
  private fpsValue: number | null = null;
  private readonly clock = new ClockSync();
  private readonly frameCbs = new Set<(frame: FeatureFrame) => void>();
  private readonly statusCbs = new Set<(status: RemoteSourceStatus) => void>();

  constructor(opts: RemoteFeatureSourceOptions = {}) {
    this.connectFn = opts.connect ?? (() => chrome.runtime.connect({ name: PORT_TAB }));
    this.isContextValid = opts.isContextValid ?? extensionContextValid;
    this.now = opts.now ?? (() => performance.now());
    this.startTimeoutMs = opts.startTimeoutMs ?? 60_000;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? 200;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 5_000;
    this.random = opts.random ?? Math.random;
  }

  get running(): boolean {
    return this.wanted && this.started;
  }

  get status(): RemoteSourceStatus {
    return this.statusValue;
  }

  /** Frames per second reported by the offscreen document, or null if unknown. */
  get fps(): number | null {
    return this.fpsValue;
  }

  start(): Promise<void> {
    if (this.destroyed) return Promise.reject(new RemoteTrackerError('unknown', 'This camera source was shut down.'));
    if (this.running) return Promise.resolve();
    if (this.pending) return this.pending.promise;

    const pending = deferred();
    this.pending = pending;
    this.wanted = true;
    this.started = false;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.fail('unknown', 'The camera took too long to start.');
    }, this.startTimeoutMs);

    if (this.port) {
      this.setStatus({ state: 'starting' });
      this.subscribe();
    } else {
      this.attempts = 0;
      this.setStatus({ state: 'connecting' });
      this.connect();
    }
    return pending.promise;
  }

  /**
   * @param opts.linger keep the camera warm briefly (the tab was hidden) rather
   *   than stopping it at once (the reader turned Gaze Reader off).
   */
  stop(opts: { linger?: boolean } = {}): void {
    if (!this.wanted && !this.port) return;
    this.wanted = false;
    this.started = false;
    this.clearTimers();
    this.rejectPending(new RemoteTrackerError('unknown', 'Stopped before the camera started.'));
    this.dropPort({ type: 'unsubscribe', linger: opts.linger ?? false });
    this.clock.reset();
    this.fpsValue = null;
    if (this.statusValue.state !== 'orphaned') this.setStatus({ state: 'idle' });
  }

  onFrame(cb: (frame: FeatureFrame) => void): Unsubscribe {
    this.frameCbs.add(cb);
    return () => {
      this.frameCbs.delete(cb);
    };
  }

  onStatus(cb: (status: RemoteSourceStatus) => void): Unsubscribe {
    this.statusCbs.add(cb);
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    this.frameCbs.clear();
    this.statusCbs.clear();
  }

  // ─────────────────────────────── internals ────────────────────────────────

  private connect(): void {
    this.reconnectTimer = null;
    if (!this.wanted || this.destroyed) return;
    if (!this.isContextValid()) return this.orphan();

    let port: PortLike;
    try {
      port = this.connectFn();
    } catch {
      if (!this.isContextValid()) return this.orphan();
      return this.scheduleReconnect();
    }
    this.port = port;
    port.onMessage.addListener(this.handleMessage);
    port.onDisconnect.addListener(this.handleDisconnect);
    if (this.statusValue.state !== 'reconnecting') this.setStatus({ state: 'starting' });
    this.subscribe();
  }

  private subscribe(): void {
    const msg: TabToHub = { type: 'subscribe' };
    if (this.port && !safePost(this.port, msg)) this.handleDisconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.wanted) return;
    const delay = backoffDelay(this.attempts++, this.reconnectInitialMs, this.reconnectMaxMs, this.random);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private readonly handleMessage = (message: unknown): void => {
    if (!this.wanted || !isHubToTab(message)) return;
    this.attempts = 0; // the link is healthy again
    if (message.type === 'camera-status') {
      this.handleCameraStatus(message.status);
      return;
    }
    // A frame means the camera is running even if its status message was lost.
    if (!this.started) this.markRunning();
    else if (this.statusValue.state !== 'running') this.setStatus({ state: 'running' });
    const raw = message.frame;
    const frame: FeatureFrame = { ...raw, t: this.clock.toLocal(raw.t, this.now()) };
    for (const cb of [...this.frameCbs]) {
      try {
        cb(frame);
      } catch (err) {
        console.error('[gaze-reader] frame listener threw', err);
      }
    }
  };

  private handleCameraStatus(status: CameraStatus): void {
    switch (status.state) {
      case 'running':
        if (status.fps !== undefined) this.fpsValue = status.fps;
        if (!this.started) this.markRunning();
        else if (this.statusValue.state !== 'running') this.setStatus({ state: 'running' });
        return;
      case 'error':
        this.fail(status.code ?? 'unknown', status.message);
        return;
      default:
        // starting / stopped / idle while we still want frames: the service
        // worker is (re)starting the camera for us. Keep waiting.
        if (this.statusValue.state !== 'starting') this.setStatus({ state: 'starting' });
    }
  }

  private markRunning(): void {
    this.started = true;
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const pending = this.pending;
    this.pending = null;
    this.setStatus({ state: 'running' });
    pending?.resolve();
  }

  private readonly handleDisconnect = (): void => {
    this.detachPort();
    if (!this.wanted || this.destroyed) return;
    if (!this.isContextValid()) return this.orphan();
    this.setStatus({ state: 'reconnecting' });
    this.scheduleReconnect();
  };

  private fail(code: TrackerErrorCode, message?: string): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.started = false;
    this.clearTimers();
    this.dropPort({ type: 'unsubscribe', linger: false });
    this.clock.reset();
    this.fpsValue = null;
    this.setStatus({ state: 'error', code, message });
    this.rejectPending(new RemoteTrackerError(code, message));
  }

  private orphan(): void {
    this.wanted = false;
    this.started = false;
    this.clearTimers();
    this.detachPort();
    this.setStatus({
      state: 'orphaned',
      code: 'unknown',
      message: 'Gaze Reader was updated or reloaded. Refresh the page to use it here again.',
    });
    this.rejectPending(new RemoteTrackerError('unknown', this.statusValue.message));
  }

  private dropPort(farewell: TabToHub): void {
    const port = this.port;
    if (!port) return;
    this.detachPort();
    safePost(port, farewell);
    safeDisconnect(port);
  }

  private detachPort(): void {
    const port = this.port;
    if (!port) return;
    this.port = null;
    port.onMessage.removeListener(this.handleMessage);
    port.onDisconnect.removeListener(this.handleDisconnect);
  }

  private rejectPending(err: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.reconnectTimer = null;
    this.startTimer = null;
  }

  private setStatus(status: RemoteSourceStatus): void {
    this.statusValue = status;
    for (const cb of [...this.statusCbs]) {
      try {
        cb(status);
      } catch (err) {
        console.error('[gaze-reader] status listener threw', err);
      }
    }
  }
}
