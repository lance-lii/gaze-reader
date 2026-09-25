import { IGNORE_ATTR } from '../core/constants';
import type { TrackerErrorCode } from '../types';

/** Friendly, actionable defaults for each failure mode. */
export const TRACKER_ERROR_MESSAGES: Readonly<Record<TrackerErrorCode, string>> = Object.freeze({
  'camera-denied': "Camera access was blocked. Allow the camera for this site (look for the camera icon in the address bar) and try again.",
  'no-camera': 'No camera was found. Connect or enable a webcam and try again.',
  'camera-in-use': 'The camera is busy or stopped responding. Close other apps or tabs that might be using it and try again.',
  'insecure-context': 'The camera only works on secure pages (https:// or localhost).',
  'model-load-failed': "Couldn't load the face-tracking model. Check your internet connection and try again.",
  unknown: 'Something went wrong while starting the camera.',
});

const TRACKER_ERROR_CODES = new Set<string>(Object.keys(TRACKER_ERROR_MESSAGES));

/** Error surfaced by the camera / face-tracking pipeline. `code` drives the user-facing message. */
export class TrackerError extends Error {
  readonly code: TrackerErrorCode;

  constructor(code: TrackerErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? TRACKER_ERROR_MESSAGES[code], options);
    this.name = 'TrackerError';
    this.code = code;
  }
}

export function isTrackerErrorCode(x: unknown): x is TrackerErrorCode {
  return typeof x === 'string' && TRACKER_ERROR_CODES.has(x);
}

/**
 * The TrackerErrorCode carried by any error-like value — including plain
 * objects that crossed a message port and lost their prototype — else 'unknown'.
 */
export function trackerErrorCode(err: unknown): TrackerErrorCode {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (isTrackerErrorCode(code)) return code;
  }
  return 'unknown';
}

const DOM_ERROR_CODES: Readonly<Record<string, TrackerErrorCode>> = {
  NotAllowedError: 'camera-denied',
  SecurityError: 'camera-denied',
  PermissionDeniedError: 'camera-denied', // legacy Chrome
  NotFoundError: 'no-camera',
  OverconstrainedError: 'no-camera',
  DevicesNotFoundError: 'no-camera', // legacy Chrome
  ConstraintNotSatisfiedError: 'no-camera', // legacy Chrome
  NotReadableError: 'camera-in-use',
  TrackStartError: 'camera-in-use', // legacy Chrome
  AbortError: 'camera-in-use', // Firefox: "Starting videoinput failed"
};

/** Maps a getUserMedia / camera failure to a TrackerError (TrackerErrors pass through). */
export function toTrackerError(err: unknown): TrackerError {
  if (err instanceof TrackerError) return err;
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  const code = DOM_ERROR_CODES[name];
  if (code) return new TrackerError(code, undefined, { cause: err });
  const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
  return new TrackerError('unknown', `${TRACKER_ERROR_MESSAGES.unknown}${detail}`, { cause: err });
}

export const DEFAULT_VIDEO_CONSTRAINTS: Readonly<MediaTrackConstraints> = Object.freeze({
  facingMode: 'user',
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30 },
});

export interface OpenCameraOptions {
  /** Element to play the stream in. Without one, a hidden element is created and removed again on stop(). */
  video?: HTMLVideoElement | null;
  /** Merged over DEFAULT_VIDEO_CONSTRAINTS. */
  constraints?: MediaTrackConstraints;
  /** How long to wait for the first video metadata before giving up. Default 10 s. */
  startTimeoutMs?: number;
}

export interface CameraHandle {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  readonly track: MediaStreamTrack;
  /** True when the video element was created by openCamera (and is removed by stop()). */
  readonly ownsVideo: boolean;
  /** Stops every track and detaches the video. Idempotent. */
  stop(): void;
}

/**
 * A video element that browsers keep decoding although nobody sees it: not
 * display:none (Chrome stops painting those) and not off-screen (Chrome pauses
 * muted autoplay video outside the viewport) — just 1 px, nearly transparent.
 */
export function createHiddenVideo(doc: Document = document): HTMLVideoElement {
  const video = doc.createElement('video');
  video.setAttribute(IGNORE_ATTR, '');
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  Object.assign(video.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0.001',
    pointerEvents: 'none',
    border: '0',
    margin: '0',
    padding: '0',
  } satisfies Partial<CSSStyleDeclaration>);
  (doc.body ?? doc.documentElement).appendChild(video);
  return video;
}

function prepareVideo(video: HTMLVideoElement): void {
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  // iOS Safari reads the attributes, not just the properties.
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.disablePictureInPicture = true;
}

const HAVE_METADATA = 1;

function waitForMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= HAVE_METADATA && video.videoWidth > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new TrackerError('unknown', "The camera video couldn't be decoded.", { cause: video.error }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TrackerError('camera-in-use', "The camera didn't start sending video. It may be in use by another app."));
    }, timeoutMs);
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function mediaDevicesOrNull(): MediaDevices | null {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return md && typeof md.getUserMedia === 'function' ? md : null;
}

/**
 * Why the camera can't be used here at all, or null if it might work.
 * Browsers only expose getUserMedia on secure origins (https, localhost).
 */
export function cameraSupportError(): TrackerError | null {
  return globalThis.isSecureContext === false || !mediaDevicesOrNull() ? new TrackerError('insecure-context') : null;
}

/**
 * Asks for the front camera and starts playing it. Rejects with a TrackerError.
 * The caller must stop() the handle; nothing else releases the camera.
 */
export async function openCamera(opts: OpenCameraOptions = {}): Promise<CameraHandle> {
  const mediaDevices = mediaDevicesOrNull();
  if (!mediaDevices || globalThis.isSecureContext === false) throw new TrackerError('insecure-context');

  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({
      video: { ...DEFAULT_VIDEO_CONSTRAINTS, ...opts.constraints },
      audio: false,
    });
  } catch (err) {
    throw toTrackerError(err);
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new TrackerError('no-camera');
  }

  const ownsVideo = !opts.video;
  const video = opts.video ?? createHiddenVideo();
  let stopped = false;
  const handle: CameraHandle = {
    stream,
    video,
    track,
    ownsVideo,
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const t of stream.getTracks()) t.stop();
      // A caller-supplied element may already show a newer stream; leave that one alone.
      if (video.srcObject === stream) {
        video.pause();
        video.srcObject = null;
      }
      if (ownsVideo) video.remove();
    },
  };

  try {
    prepareVideo(video);
    video.srcObject = stream;
    await waitForMetadata(video, opts.startTimeoutMs ?? 10_000);
    try {
      await video.play();
    } catch (err) {
      // Muted inline video is always allowed to autoplay, so this is rare; it is
      // not a permission problem with the camera itself.
      throw new TrackerError('unknown', `The browser refused to play the camera video (${describe(err)}).`, {
        cause: err,
      });
    }
    return handle;
  } catch (err) {
    handle.stop();
    throw toTrackerError(err);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
