// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IGNORE_ATTR } from '../core/constants';
import {
  cameraSupportError,
  DEFAULT_VIDEO_CONSTRAINTS,
  openCamera,
  toTrackerError,
  TRACKER_ERROR_MESSAGES,
  TrackerError,
  trackerErrorCode,
} from './camera';

interface FakeTrack {
  kind: 'video';
  stop: ReturnType<typeof vi.fn>;
}

function fakeStream(withVideo = true): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = withVideo ? [{ kind: 'video', stop: vi.fn() }] : [];
  const stream = {
    getVideoTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
  return { stream, tracks };
}

let getUserMedia: ReturnType<typeof vi.fn>;

function installMediaDevices(secure = true): void {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
}

/** jsdom doesn't decode media: pretend metadata is available and playback works. */
function fakeMediaPipeline(opts: { ready?: boolean; play?: () => Promise<void> } = {}): void {
  const ready = opts.ready ?? true;
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(ready ? 4 : 0);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(ready ? 640 : 0);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(opts.play ?? (() => Promise.resolve()));
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
}

beforeEach(() => {
  getUserMedia = vi.fn();
  installMediaDevices();
  fakeMediaPipeline();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(window, 'isSecureContext');
});

describe('TrackerError', () => {
  it('carries a code, a friendly default message and the cause', () => {
    const cause = new Error('low level');
    const err = new TrackerError('no-camera', undefined, { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TrackerError');
    expect(err.code).toBe('no-camera');
    expect(err.message).toBe(TRACKER_ERROR_MESSAGES['no-camera']);
    expect(err.cause).toBe(cause);
    expect(new TrackerError('unknown', 'custom').message).toBe('custom');
  });

  it('maps getUserMedia failures to codes', () => {
    const table: [string, string][] = [
      ['NotAllowedError', 'camera-denied'],
      ['SecurityError', 'camera-denied'],
      ['NotFoundError', 'no-camera'],
      ['OverconstrainedError', 'no-camera'],
      ['NotReadableError', 'camera-in-use'],
      ['AbortError', 'camera-in-use'],
      ['TypeError', 'unknown'],
    ];
    for (const [name, code] of table) {
      const mapped = toTrackerError(new DOMException('x', name));
      expect(mapped.code, name).toBe(code);
      expect(mapped.cause).toBeInstanceOf(DOMException);
    }
    const passthrough = new TrackerError('model-load-failed');
    expect(toTrackerError(passthrough)).toBe(passthrough);
    expect(toTrackerError('weird').code).toBe('unknown');
    expect(toTrackerError(new Error('odd')).message).toContain('odd');
  });

  it('recovers codes from errors that lost their prototype crossing a port', () => {
    expect(trackerErrorCode({ code: 'camera-denied', message: 'x' })).toBe('camera-denied');
    expect(trackerErrorCode(new TrackerError('insecure-context'))).toBe('insecure-context');
    expect(trackerErrorCode({ code: 'ENOENT' })).toBe('unknown');
    expect(trackerErrorCode(null)).toBe('unknown');
    expect(trackerErrorCode('camera-denied')).toBe('unknown');
  });
});

describe('cameraSupportError', () => {
  it('flags insecure contexts and browsers without getUserMedia', () => {
    expect(cameraSupportError()).toBeNull();
    installMediaDevices(false);
    expect(cameraSupportError()?.code).toBe('insecure-context');
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    expect(cameraSupportError()?.code).toBe('insecure-context');
  });
});

describe('openCamera', () => {
  it('requests the front camera at 640×480 @ 30 fps without audio', async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const cam = await openCamera();
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    expect(DEFAULT_VIDEO_CONSTRAINTS.facingMode).toBe('user');
    cam.stop();
  });

  it('creates a hidden-but-decoding video and removes it on stop', async () => {
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const cam = await openCamera();
    const v = cam.video;
    expect(cam.ownsVideo).toBe(true);
    expect(document.body.contains(v)).toBe(true);
    expect(v.hasAttribute(IGNORE_ATTR)).toBe(true);
    expect(v.srcObject).toBe(stream);
    expect(v.muted && v.playsInline && v.autoplay).toBe(true);
    expect(v.style.display).not.toBe('none');
    expect(v.style.visibility).not.toBe('hidden');
    expect(v.style.position).toBe('fixed');
    expect(v.style.width).toBe('1px');
    expect(Number(v.style.opacity)).toBeGreaterThan(0);
    expect(Number(v.style.opacity)).toBeLessThan(0.01);
    expect(v.style.pointerEvents).toBe('none');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    cam.stop();
    cam.stop();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(document.body.contains(v)).toBe(false);
    expect(v.srcObject).toBeNull();
  });

  it('plays into a supplied element, which it never removes', async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const video = document.createElement('video');
    document.body.appendChild(video);
    const cam = await openCamera({ video });
    expect(cam.video).toBe(video);
    expect(cam.ownsVideo).toBe(false);
    cam.stop();
    expect(document.body.contains(video)).toBe(true);
    expect(video.srcObject).toBeNull();
  });

  it("doesn't detach a newer stream from a shared element", async () => {
    const first = fakeStream();
    const second = fakeStream();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const video = document.createElement('video');
    const a = await openCamera({ video });
    const b = await openCamera({ video });
    a.stop();
    expect(video.srcObject).toBe(second.stream);
    expect(second.tracks[0].stop).not.toHaveBeenCalled();
    b.stop();
    expect(video.srcObject).toBeNull();
  });

  it('merges extra constraints', async () => {
    getUserMedia.mockResolvedValue(fakeStream().stream);
    const cam = await openCamera({ constraints: { deviceId: { exact: 'cam-2' } } });
    expect(getUserMedia.mock.calls[0][0].video).toMatchObject({ facingMode: 'user', deviceId: { exact: 'cam-2' } });
    cam.stop();
  });

  it('rejects with mapped TrackerErrors', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(openCamera()).rejects.toMatchObject({ name: 'TrackerError', code: 'camera-denied' });
    getUserMedia.mockRejectedValueOnce(new DOMException('none', 'NotFoundError'));
    await expect(openCamera()).rejects.toMatchObject({ code: 'no-camera' });
    getUserMedia.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
    await expect(openCamera()).rejects.toMatchObject({ code: 'camera-in-use' });
  });

  it('rejects on insecure pages without prompting', async () => {
    installMediaDevices(false);
    await expect(openCamera()).rejects.toMatchObject({ code: 'insecure-context' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('treats a stream without a video track as no camera', async () => {
    getUserMedia.mockResolvedValue(fakeStream(false).stream);
    await expect(openCamera()).rejects.toMatchObject({ code: 'no-camera' });
  });

  it('gives up if no video arrives, releasing the camera', async () => {
    fakeMediaPipeline({ ready: false });
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    await expect(openCamera({ startTimeoutMs: 20 })).rejects.toMatchObject({ code: 'camera-in-use' });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
  });

  it('waits for loadedmetadata when the video is not ready yet', async () => {
    let ready = false;
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => (ready ? 4 : 0));
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockImplementation(() => (ready ? 640 : 0));
    getUserMedia.mockResolvedValue(fakeStream().stream);
    const pending = openCamera({ startTimeoutMs: 5000 });
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    ready = true;
    document.querySelector('video')?.dispatchEvent(new Event('loadedmetadata'));
    const cam = await pending;
    expect(cam.video.srcObject).not.toBeNull();
    cam.stop();
  });

  it('reports a playback refusal without blaming camera permission', async () => {
    fakeMediaPipeline({ play: () => Promise.reject(new DOMException('autoplay', 'NotAllowedError')) });
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    await expect(openCamera()).rejects.toMatchObject({ code: 'unknown' });
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});
