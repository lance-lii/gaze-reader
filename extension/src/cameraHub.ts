import {
  errorMessage,
  isOffscreenToHub,
  isTabToHub,
  type CameraState,
  type CameraStatus,
  type HubToOffscreen,
  type HubToTab,
} from './messages';
import { safeDisconnect, safePost, type PortLike } from './ports';

export interface CameraHubDeps {
  /** Create the offscreen document unless it already exists. */
  ensureOffscreen(): Promise<void>;
  /** Close the offscreen document if it exists. */
  closeOffscreen(): Promise<void>;
  /** Open (or focus) the camera setup page. */
  openSetup(returnTabId: number | null): void;
  log?: (...args: unknown[]) => void;
}

export interface CameraHubOptions {
  /** How long the camera stays on after the last tab stops watching (tab hidden / SW restart). */
  stopGraceMs?: number;
  /** How long the idle offscreen document (model loaded, camera off) is kept for a fast restart. */
  closeIdleMs?: number;
  /** Give up if the offscreen document hasn't connected this long after being created. */
  offscreenConnectTimeoutMs?: number;
  /** Give up after the offscreen document is lost this many times within `restartWindowMs`. */
  maxRestarts?: number;
  restartWindowMs?: number;
  now?: () => number;
}

interface TabEntry {
  tabId: number | null;
  subscribed: boolean;
}

/**
 * The service worker's brain: reference-counts tabs that want camera frames,
 * creates/closes the offscreen document on demand, starts/stops the camera,
 * and relays frames and status from the offscreen document to subscribed tabs.
 *
 * All state is in memory. When Chrome stops the service worker, every port
 * drops; tabs and the offscreen document reconnect and resubscribe, which
 * rebuilds this state from scratch.
 */
export class CameraHub {
  private readonly deps: CameraHubDeps;
  private readonly stopGraceMs: number;
  private readonly closeIdleMs: number;
  private readonly offscreenConnectTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly now: () => number;

  private readonly tabs = new Map<PortLike, TabEntry>();
  private offscreen: PortLike | null = null;
  private camera: CameraState = 'idle';
  private fps: number | undefined;
  /** A camera-start was sent and has not been answered yet. */
  private startRequested = false;
  /** After an error, don't restart the camera until a tab asks again (avoids retry loops). */
  private blocked = false;
  private setupOpened = false;
  /** An offscreen document may exist (we created one, or one may survive a SW restart). */
  private docMayExist = true;
  /** We asked Chrome to close the document; its disconnect is not a crash. */
  private expectingClose = false;
  private ensuring: Promise<void> | null = null;
  /** Times the offscreen document was lost while in use, within the restart window. */
  private crashes: number[] = [];
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: CameraHubDeps, opts: CameraHubOptions = {}) {
    this.deps = deps;
    this.stopGraceMs = opts.stopGraceMs ?? 2_500;
    this.closeIdleMs = opts.closeIdleMs ?? 20_000;
    this.offscreenConnectTimeoutMs = opts.offscreenConnectTimeoutMs ?? 15_000;
    this.maxRestarts = opts.maxRestarts ?? 4;
    this.restartWindowMs = opts.restartWindowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get subscriberCount(): number {
    let n = 0;
    for (const entry of this.tabs.values()) if (entry.subscribed) n++;
    return n;
  }

  get cameraState(): CameraState {
    return this.camera;
  }

  get hasOffscreen(): boolean {
    return this.offscreen !== null;
  }

  /** Call once at service-worker startup: closes a leftover offscreen document nobody claims. */
  init(): void {
    this.reconcile(true);
  }

  attachTab(port: PortLike, tabId: number | null): void {
    if (this.disposed) return safeDisconnect(port);
    this.tabs.set(port, { tabId, subscribed: false });
    port.onMessage.addListener((msg) => this.onTabMessage(port, msg));
    port.onDisconnect.addListener(() => {
      if (!this.tabs.delete(port)) return;
      this.reconcile(true);
    });
  }

  attachOffscreen(port: PortLike): void {
    if (this.disposed) return safeDisconnect(port);
    // Only one offscreen document can exist; a new connection supersedes a stale one.
    if (this.offscreen && this.offscreen !== port) safeDisconnect(this.offscreen);
    this.offscreen = port;
    this.docMayExist = true;
    this.clearTimer('connectTimer');
    port.onMessage.addListener((msg) => {
      if (this.offscreen === port) this.onOffscreenMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      if (this.offscreen !== port) return;
      this.offscreen = null;
      this.camera = 'idle';
      this.fps = undefined;
      this.startRequested = false;
      const deliberate = this.expectingClose;
      this.expectingClose = false;
      if (this.subscriberCount > 0 && !this.blocked && !deliberate) this.onOffscreenLost();
      this.reconcile(true);
    });
  }

  /** The setup page obtained camera permission: retry for anyone still waiting. */
  permissionGranted(): void {
    this.blocked = false;
    this.reconcile(true);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer('stopTimer');
    this.clearTimer('closeTimer');
    this.clearTimer('connectTimer');
    for (const port of this.tabs.keys()) safeDisconnect(port);
    this.tabs.clear();
    if (this.offscreen) safeDisconnect(this.offscreen);
    this.offscreen = null;
  }

  // ──────────────────────────────── messages ────────────────────────────────

  private onTabMessage(port: PortLike, msg: unknown): void {
    const entry = this.tabs.get(port);
    if (!entry || !isTabToHub(msg)) return;
    if (msg.type === 'subscribe') {
      entry.subscribed = true;
      this.blocked = false;
      // Tell the newcomer where things stand right away, so its start() resolves
      // without waiting for the next status change.
      if (this.camera === 'running') this.send(port, { type: 'camera-status', status: this.runningStatus() });
      else if (this.camera === 'starting' || this.startRequested) {
        this.send(port, { type: 'camera-status', status: { state: 'starting' } });
      }
      this.reconcile(true);
    } else {
      entry.subscribed = false;
      this.reconcile(msg.linger);
    }
  }

  private onOffscreenMessage(msg: unknown): void {
    if (!isOffscreenToHub(msg)) return;
    switch (msg.type) {
      case 'frame': {
        const out: HubToTab = { type: 'frame', frame: msg.frame };
        for (const [port, entry] of this.tabs) if (entry.subscribed) this.send(port, out);
        return;
      }
      case 'hello':
        // The offscreen document (re)connected, e.g. after a service-worker restart.
        // Tabs that resubscribed in the meantime are waiting to hear the camera state.
        this.camera = msg.state;
        this.startRequested = false;
        if (msg.state === 'running') this.broadcast(this.runningStatus());
        else if (msg.state === 'starting') this.broadcast({ state: 'starting' });
        this.reconcile(true);
        return;
      case 'camera-status':
        this.onCameraStatus(msg.status);
        return;
    }
  }

  private onCameraStatus(status: CameraStatus): void {
    this.camera = status.state;
    if (status.state !== 'starting') this.startRequested = false;
    if (status.state === 'running') this.fps = status.fps;
    if (status.state === 'error') {
      this.blocked = true;
      if (status.code === 'camera-denied' && !this.setupOpened) {
        this.setupOpened = true;
        this.deps.openSetup(this.firstSubscribedTabId());
      }
    }
    this.broadcast(status.state === 'running' ? this.runningStatus() : status);
    this.reconcile(true);
  }

  // ─────────────────────────────── reconcile ────────────────────────────────

  /**
   * Drive the offscreen document and camera toward what the tabs want.
   * @param linger when nobody wants frames: wait `stopGraceMs` before stopping the camera.
   */
  private reconcile(linger: boolean): void {
    if (this.disposed) return;

    if (this.subscriberCount > 0) {
      this.clearTimer('stopTimer');
      this.clearTimer('closeTimer');
      if (this.blocked) return;
      if (!this.offscreen) {
        this.ensureOffscreen();
        return;
      }
      if (this.camera !== 'running' && this.camera !== 'starting' && !this.startRequested) {
        this.startRequested = true;
        this.setupOpened = false;
        this.command({ type: 'camera-start' });
        this.broadcast({ state: 'starting' });
      }
      return;
    }

    const cameraActive = this.camera === 'running' || this.camera === 'starting' || this.startRequested;
    if (cameraActive) {
      if (!linger) {
        this.clearTimer('stopTimer');
        this.stopCamera();
      } else if (this.stopTimer === null) {
        this.stopTimer = setTimeout(() => {
          this.stopTimer = null;
          if (this.subscriberCount === 0) this.stopCamera();
        }, this.stopGraceMs);
      }
    }
    if (this.docMayExist && this.closeTimer === null) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        if (this.subscriberCount === 0) this.closeOffscreen();
      }, this.closeIdleMs);
    }
  }

  private stopCamera(): void {
    this.startRequested = false;
    if (this.offscreen) this.command({ type: 'camera-stop' });
    this.camera = this.offscreen ? 'stopped' : 'idle';
  }

  private closeOffscreen(): void {
    this.docMayExist = false;
    this.expectingClose = this.offscreen !== null;
    this.camera = 'idle';
    this.deps.closeOffscreen().catch((err: unknown) => this.log('closeOffscreen failed', err));
  }

  /** The offscreen document vanished while tabs still need it (renderer crash, closed from outside). */
  private onOffscreenLost(): void {
    const t = this.now();
    this.crashes = this.crashes.filter((c) => t - c < this.restartWindowMs);
    this.crashes.push(t);
    if (this.crashes.length >= this.maxRestarts) {
      this.giveUp('The camera helper keeps stopping. Try turning Gaze Reader off and on again.');
      return;
    }
    this.log('offscreen document went away while in use; recreating it');
    this.broadcast({ state: 'starting' });
  }

  private ensureOffscreen(): void {
    if (this.ensuring) return;
    this.docMayExist = true;
    this.ensuring = this.deps
      .ensureOffscreen()
      .then(() => {
        if (this.offscreen || this.disposed) return;
        this.clearTimer('connectTimer');
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          if (!this.offscreen && this.subscriberCount > 0) this.giveUp('The camera helper did not start.');
        }, this.offscreenConnectTimeoutMs);
      })
      .catch((err: unknown) => {
        this.log('ensureOffscreen failed', err);
        this.giveUp(`Could not start the camera helper: ${errorMessage(err)}`);
      })
      .finally(() => {
        this.ensuring = null;
      });
  }

  private giveUp(message: string): void {
    this.blocked = true;
    this.startRequested = false;
    this.broadcast({ state: 'error', code: 'unknown', message });
  }

  // ──────────────────────────────── helpers ─────────────────────────────────

  private runningStatus(): CameraStatus {
    return this.fps === undefined ? { state: 'running' } : { state: 'running', fps: this.fps };
  }

  private firstSubscribedTabId(): number | null {
    for (const entry of this.tabs.values()) if (entry.subscribed && entry.tabId !== null) return entry.tabId;
    return null;
  }

  private broadcast(status: CameraStatus): void {
    const msg: HubToTab = { type: 'camera-status', status };
    for (const [port, entry] of this.tabs) if (entry.subscribed) this.send(port, msg);
  }

  private send(port: PortLike, msg: HubToTab): void {
    if (!safePost(port, msg)) {
      // Dead port whose disconnect event hasn't arrived yet.
      this.tabs.delete(port);
    }
  }

  private command(msg: HubToOffscreen): void {
    // A failed post means the port is dead; its onDisconnect handler does the cleanup.
    if (this.offscreen) safePost(this.offscreen, msg);
  }

  private clearTimer(name: 'stopTimer' | 'closeTimer' | 'connectTimer'): void {
    const id = this[name];
    if (id !== null) clearTimeout(id);
    this[name] = null;
  }

  private log(...args: unknown[]): void {
    this.deps.log?.('[gaze-reader hub]', ...args);
  }
}
