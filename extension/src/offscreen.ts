/**
 * Offscreen document: the only place the extension touches the camera.
 * Runs CameraFeatureSource (MediaPipe) and streams FeatureFrames to the
 * service worker, which relays them to the tab(s) reading along.
 */
import { CameraFeatureSource } from '../../src/gaze/faceTracker';
import type { FeatureFrame, TrackerErrorCode } from '../../src/types';
import {
  PORT_OFFSCREEN,
  errorMessage,
  isHubToOffscreen,
  isTrackerErrorCode,
  type CameraState,
  type CameraStatus,
  type OffscreenToHub,
} from './messages';
import { backoffDelay, safeDisconnect, safePost, type PortLike } from './ports';

/** Status heartbeat while running (carries fps for the popup). */
const HEARTBEAT_MS = 2_000;
/** No frames for this long while running means the pipeline silently stalled. */
const STALL_MS = 8_000;
/** If the service worker can't be reached for this long, release the camera. */
const ORPHAN_STOP_MS = 10_000;

const camera = new CameraFeatureSource({
  // No trailing slash: MediaPipe appends "/vision_wasm_internal.js" itself.
  wasmBaseUrl: chrome.runtime.getURL('mediapipe/wasm'),
  // This document is never rendered, so rAF/rVFC never fire: pull frames from the track instead.
  backgroundProcessing: true,
});

let state: CameraState = 'idle';
let port: PortLike | null = null;
let attempts = 0;
let lastFrameAt = 0;
let startSeq = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let orphanTimer: ReturnType<typeof setTimeout> | null = null;

camera.onFrame((frame: FeatureFrame) => {
  lastFrameAt = performance.now();
  if (state === 'running' && port) post({ type: 'frame', frame });
});

// The camera was unplugged or taken by another app; the source has already stopped.
camera.onError((err) => {
  if (state !== 'running') return;
  startSeq++;
  state = 'error';
  report({ state: 'error', code: err.code, message: err.message });
});

setInterval(() => {
  if (state !== 'running') return;
  if (performance.now() - lastFrameAt > STALL_MS) {
    const code: TrackerErrorCode = videoTrackEnded() ? 'no-camera' : 'unknown';
    stopCamera();
    state = 'error';
    report({ state: 'error', code, message: code === 'no-camera' ? 'The camera was disconnected.' : 'The camera stopped sending pictures.' });
    return;
  }
  report(runningStatus());
}, HEARTBEAT_MS);

connect();

// ─────────────────────────────── Camera control ──────────────────────────────

async function startCamera(): Promise<void> {
  if (state === 'running' || state === 'starting') {
    report(state === 'running' ? runningStatus() : { state });
    return;
  }
  const seq = ++startSeq;
  state = 'starting';
  report({ state: 'starting' });

  // An offscreen document can't show a permission prompt; the setup page must grant it first.
  const permission = await cameraPermission();
  if (seq !== startSeq) return;
  if (permission === 'prompt' || permission === 'denied') {
    state = 'error';
    report({
      state: 'error',
      code: 'camera-denied',
      message: permission === 'denied' ? 'Camera access is blocked for Gaze Reader.' : 'Gaze Reader needs permission to use the camera.',
    });
    return;
  }

  try {
    await camera.start();
    if (seq !== startSeq) return; // stopped while starting
    if (!camera.running) {
      state = 'stopped';
      report({ state: 'stopped' });
      return;
    }
    lastFrameAt = performance.now();
    state = 'running';
    report(runningStatus());
  } catch (err) {
    if (seq !== startSeq) return;
    camera.stop();
    state = 'error';
    const code = (err as { code?: unknown } | null)?.code;
    report({ state: 'error', code: isTrackerErrorCode(code) ? code : 'unknown', message: errorMessage(err) });
  }
}

function runningStatus(): CameraStatus {
  const fps = camera.fps;
  return Number.isFinite(fps) && fps >= 0 ? { state: 'running', fps: Math.round(fps * 10) / 10 } : { state: 'running' };
}

function stopCamera(): void {
  startSeq++;
  camera.stop();
  state = 'stopped';
}

async function cameraPermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state;
  } catch {
    return 'unknown'; // not queryable: just try getUserMedia
  }
}

function videoTrackEnded(): boolean {
  const stream = camera.video?.srcObject;
  if (!(stream instanceof MediaStream)) return false;
  const track = stream.getVideoTracks()[0];
  return !track || track.readyState === 'ended';
}

// ─────────────────────────────── Port to the SW ──────────────────────────────

function connect(): void {
  reconnectTimer = null;
  let p: PortLike;
  try {
    p = chrome.runtime.connect({ name: PORT_OFFSCREEN });
  } catch {
    scheduleReconnect();
    return;
  }
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(onDisconnect);
  if (orphanTimer !== null) clearTimeout(orphanTimer);
  orphanTimer = null;
  post({ type: 'hello', state });
}

function onMessage(msg: unknown): void {
  attempts = 0;
  if (!isHubToOffscreen(msg)) return;
  if (msg.type === 'camera-start') void startCamera();
  else {
    stopCamera();
    report({ state: 'stopped' });
  }
}

function onDisconnect(): void {
  if (port) {
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  }
  port = null;
  // The service worker was stopped; it wakes up when we reconnect. Keep the
  // camera running briefly so tabs resume seamlessly, but never indefinitely
  // without a coordinator.
  if (orphanTimer === null) {
    orphanTimer = setTimeout(() => {
      orphanTimer = null;
      if (!port && (state === 'running' || state === 'starting')) stopCamera();
    }, ORPHAN_STOP_MS);
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(connect, backoffDelay(attempts++, 100, 3_000));
}

function post(msg: OffscreenToHub): void {
  if (port && !safePost(port, msg)) {
    const dead = port;
    onDisconnect();
    safeDisconnect(dead);
  }
}

function report(status: CameraStatus): void {
  post({ type: 'camera-status', status });
}
