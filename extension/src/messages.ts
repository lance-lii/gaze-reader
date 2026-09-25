/**
 * The extension's message protocol.
 *
 * Three kinds of contexts talk to each other:
 *
 *   offscreen doc ──(Port "gr-offscreen")──► service worker ──(Port "gr-tab")──► content script(s)
 *                 ◄──── camera-start/stop ─┘                ◄── subscribe/unsubscribe ─┘
 *
 * plus one-shot messages: popup/setup → service worker (`RuntimeRequest`) and
 * service worker/popup → content script (`PageRequest`).
 *
 * Every message crosses a process boundary as JSON, so every receiver
 * validates with the guards below before acting. Nothing here trusts shape.
 */
import type {
  CommandName,
  EyeFeatures,
  FeatureFrame,
  GazeSourceKind,
  HeadPose,
  TrackerErrorCode,
  TrackingState,
} from '../../src/types';

export const PORT_TAB = 'gr-tab';
export const PORT_OFFSCREEN = 'gr-offscreen';

/** Upper bound on the feature-vector length we accept (the real one is ~40). */
export const MAX_FEATURE_LENGTH = 512;

// ─────────────────────────────── Camera status ───────────────────────────────

export type CameraState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface CameraStatus {
  state: CameraState;
  /** Present when state is 'error'. */
  code?: TrackerErrorCode;
  message?: string;
  /** Processed frames per second, when running. */
  fps?: number;
}

// ─────────────────────────────── Port messages ───────────────────────────────

/** Content script → service worker, over PORT_TAB. */
export type TabToHub =
  | { type: 'subscribe' }
  /** `linger`: keep the camera warm for a moment (tab hidden) instead of stopping it right away (turned off). */
  | { type: 'unsubscribe'; linger: boolean };

/** Service worker → content script, over PORT_TAB. */
export type HubToTab = { type: 'frame'; frame: FeatureFrame } | { type: 'camera-status'; status: CameraStatus };

/** Offscreen document → service worker, over PORT_OFFSCREEN. */
export type OffscreenToHub =
  | { type: 'hello'; state: CameraState }
  | { type: 'frame'; frame: FeatureFrame }
  | { type: 'camera-status'; status: CameraStatus };

/** Service worker → offscreen document, over PORT_OFFSCREEN. */
export type HubToOffscreen = { type: 'camera-start' } | { type: 'camera-stop' };

// ───────────────────────────── One-shot messages ─────────────────────────────

/** Popup / setup page / content script → service worker (chrome.runtime.sendMessage). */
export type RuntimeRequest =
  | { type: 'set-tab-enabled'; tabId: number; enabled: boolean }
  | { type: 'camera-permission-granted' }
  | { type: 'open-setup'; returnTabId?: number };

export type RuntimeResponse = { ok: true; state?: PageState | null } | { ok: false; error: string };

/** Commands a page session understands (a subset of the app's CommandName plus 'disable'). */
export type PageCommand = Extract<
  CommandName,
  'recalibrate' | 'pause' | 'resume' | 'toggle-autoscroll' | 'page-forward' | 'page-back' | 'undo-turn' | 'toggle-debug' | 'toggle-gaze-dot'
>;

/** Service worker / popup → content script (chrome.tabs.sendMessage). */
export type PageRequest =
  | { type: 'page-ping' }
  | { type: 'page-query' }
  | { type: 'page-set-enabled'; enabled: boolean }
  | { type: 'page-command'; command: PageCommand };

/** What the popup shows about a tab. */
export interface PageState {
  enabled: boolean;
  tracking: TrackingState;
  source: GazeSourceKind | null;
  /** A gaze model is loaded (webcam mode). */
  calibrated: boolean;
  /** Auto-scroll paused by the reader. */
  paused: boolean;
  fps: number | null;
  detail: string | null;
}

// ─────────────────────────────────── Guards ──────────────────────────────────

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isOptString = (x: unknown): boolean => x === undefined || typeof x === 'string';

const TRACKER_ERROR_CODES: readonly TrackerErrorCode[] = [
  'camera-denied',
  'no-camera',
  'camera-in-use',
  'insecure-context',
  'model-load-failed',
  'unknown',
];
const CAMERA_STATES: readonly CameraState[] = ['idle', 'starting', 'running', 'stopped', 'error'];
const TRACKING_STATES: readonly TrackingState[] = [
  'off',
  'starting',
  'calibrating',
  'tracking',
  'no-face',
  'poor',
  'paused',
  'error',
];
const SOURCE_KINDS: readonly GazeSourceKind[] = ['webcam', 'mouse', 'simulated'];
export const PAGE_COMMANDS: readonly PageCommand[] = [
  'recalibrate',
  'pause',
  'resume',
  'toggle-autoscroll',
  'page-forward',
  'page-back',
  'undo-turn',
  'toggle-debug',
  'toggle-gaze-dot',
];

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (x: unknown): x is T =>
    typeof x === 'string' && (values as readonly string[]).includes(x);

export const isTrackerErrorCode = oneOf(TRACKER_ERROR_CODES);
export const isCameraState = oneOf(CAMERA_STATES);
export const isTrackingState = oneOf(TRACKING_STATES);
export const isPageCommand = oneOf(PAGE_COMMANDS);
const isSourceKind = oneOf(SOURCE_KINDS);

const isPoint = (x: unknown): boolean => isObj(x) && isFiniteNum(x.x) && isFiniteNum(x.y);

function isHeadPose(x: unknown): x is HeadPose {
  return (
    isObj(x) &&
    isFiniteNum(x.yaw) &&
    isFiniteNum(x.pitch) &&
    isFiniteNum(x.roll) &&
    isFiniteNum(x.tx) &&
    isFiniteNum(x.ty) &&
    isFiniteNum(x.tz)
  );
}

export function isEyeFeatures(x: unknown): x is EyeFeatures {
  if (!isObj(x)) return false;
  const v = x.vector;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_FEATURE_LENGTH) return false;
  for (const n of v) if (!isFiniteNum(n)) return false;
  return (
    isHeadPose(x.headPose) &&
    isFiniteNum(x.blink) &&
    isFiniteNum(x.openness) &&
    isFiniteNum(x.faceScale) &&
    isPoint(x.faceCenter)
  );
}

export function isFeatureFrame(x: unknown): x is FeatureFrame {
  if (!isObj(x)) return false;
  if (!isFiniteNum(x.t) || !isBool(x.faceFound) || !isFiniteNum(x.quality)) return false;
  if (x.quality < 0 || x.quality > 1) return false;
  if (x.features === null) return true;
  return isEyeFeatures(x.features);
}

export function isCameraStatus(x: unknown): x is CameraStatus {
  if (!isObj(x) || !isCameraState(x.state)) return false;
  if (x.code !== undefined && !isTrackerErrorCode(x.code)) return false;
  if (x.fps !== undefined && !(isFiniteNum(x.fps) && x.fps >= 0)) return false;
  return isOptString(x.message);
}

export function isTabToHub(x: unknown): x is TabToHub {
  if (!isObj(x)) return false;
  if (x.type === 'subscribe') return true;
  return x.type === 'unsubscribe' && isBool(x.linger);
}

export function isHubToTab(x: unknown): x is HubToTab {
  if (!isObj(x)) return false;
  if (x.type === 'frame') return isFeatureFrame(x.frame);
  return x.type === 'camera-status' && isCameraStatus(x.status);
}

export function isOffscreenToHub(x: unknown): x is OffscreenToHub {
  if (!isObj(x)) return false;
  switch (x.type) {
    case 'hello':
      return isCameraState(x.state);
    case 'frame':
      return isFeatureFrame(x.frame);
    case 'camera-status':
      return isCameraStatus(x.status);
    default:
      return false;
  }
}

export function isHubToOffscreen(x: unknown): x is HubToOffscreen {
  return isObj(x) && (x.type === 'camera-start' || x.type === 'camera-stop');
}

const isTabId = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

export function isRuntimeRequest(x: unknown): x is RuntimeRequest {
  if (!isObj(x)) return false;
  switch (x.type) {
    case 'set-tab-enabled':
      return isTabId(x.tabId) && isBool(x.enabled);
    case 'camera-permission-granted':
      return true;
    case 'open-setup':
      return x.returnTabId === undefined || isTabId(x.returnTabId);
    default:
      return false;
  }
}

export function isPageRequest(x: unknown): x is PageRequest {
  if (!isObj(x)) return false;
  switch (x.type) {
    case 'page-ping':
    case 'page-query':
      return true;
    case 'page-set-enabled':
      return isBool(x.enabled);
    case 'page-command':
      return isPageCommand(x.command);
    default:
      return false;
  }
}

export function isPageState(x: unknown): x is PageState {
  return (
    isObj(x) &&
    isBool(x.enabled) &&
    isTrackingState(x.tracking) &&
    (x.source === null || isSourceKind(x.source)) &&
    isBool(x.calibrated) &&
    isBool(x.paused) &&
    (x.fps === null || (isFiniteNum(x.fps) && x.fps >= 0)) &&
    (x.detail === null || typeof x.detail === 'string')
  );
}

export function isRuntimeResponse(x: unknown): x is RuntimeResponse {
  if (!isObj(x)) return false;
  if (x.ok === true) return x.state === undefined || x.state === null || isPageState(x.state);
  return x.ok === false && typeof x.error === 'string';
}

/** The state a tab reports when Gaze Reader isn't running in it. */
export const PAGE_OFF: Readonly<PageState> = Object.freeze({
  enabled: false,
  tracking: 'off',
  source: null,
  calibrated: false,
  paused: false,
  fps: null,
  detail: null,
});

/** Best-effort extraction of a message from anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
