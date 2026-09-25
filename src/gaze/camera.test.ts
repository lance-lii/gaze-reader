// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IGNORE_ATTR } from '../core/constants';
import {
  cameraSupportError,
  DEFAULT_VIDEO_CONSTRAINTS,
  openCamera,
  settleWithin,
  toTrackerError,
  TRACKER_ERROR_MESSAGES,
  TrackerError,
  trackerErrorCode,
} from './camera';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it('toTrackerError keeps the code (and message) of a TrackerError-shaped object', () => {
    // e.g. a TrackerError that was structured-cloned or came from another realm.
    const cloned = { name: 'TrackerError', code: 'model-load-failed', message: 'Model fetch failed.' };
    const mapped = toTrackerError(cloned);
    expect(mapped).toBeInstanceOf(TrackerError);
    expect(mapped.code).toBe('model-load-failed');
    expect(mapped.message).toBe('Model fetch failed.');
    expect(mapped.cause).toBe(cloned);
    expect(toTrackerError({ code: 'no-camera' }).message).toBe(TRACKER_ERROR_MESSAGES['no-camera']);
    // A DOMException's legacy numeric `code` is not mistaken for one.
    expect(toTrackerError(new DOMException('x', 'NotAllowedError')).code).toBe('camera-denied');
  });
});

describe('settleWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the value through and leaves no timer behind', async () => {
    await expect(settleWithin(Promise.resolve(7), 1000, () => new Error('late'))).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on timeout, and a late rejection of the input stays handled', async () => {
    const d = deferred<number>();
    const p = settleWithin(d.promise, 50, () => new TrackerError('unknown', 'late'));
    vi.advanceTimersByTime(50);
    await expect(p).rejects.toMatchObject({ message: 'late' });
    d.reject(new Error('after the fact')); // would surface as an unhandled rejection if unobserved
    await flush();
  });

  it('rejects with the abort reason and removes its listener', async () => {
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    const reason = new TrackerError('camera-in-use');
    const p = settleWithin(new Promise<never>(() => undefined), 1000, () => new Error('late'), ctrl.signal);
    ctrl.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await expect(settleWithin(Promise.resolve(1), 1000, () => new Error('late'), ctrl.signal)).rejects.toBe(reason);
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

  it('does not prompt at all with an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(openCamera({ signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('releases a camera granted after an abort at once, leaving a shared element alone', async () => {
    const pending = deferred<MediaStream>();
    getUserMedia.mockReturnValue(pending.promise);
    const shared = document.createElement('video');
    const newer = {} as MediaStream; // what a newer attempt already put there
    shared.srcObject = newer;
    const ctrl = new AbortController();
    const opened = openCamera({ video: shared, signal: ctrl.signal });
    ctrl.abort(); // e.g. CameraFeatureSource.stop() while the permission prompt is open

    const { stream, tracks } = fakeStream();
    pending.resolve(stream);
    await expect(opened).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(shared.srcObject).toBe(newer);
    expect(document.querySelector('video')).toBeNull(); // no hidden element was created either
  });

  it('an abort while waiting for video releases the camera immediately, not at the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fakeMediaPipeline({ ready: false });
      const { stream, tracks } = fakeStream();
      getUserMedia.mockResolvedValue(stream);
      const ctrl = new AbortController();
      const opened = openCamera({ signal: ctrl.signal, startTimeoutMs: 10_000 });
      opened.catch(() => undefined);
      await flush();
      expect(document.querySelector('video')).not.toBeNull();
      expect(tracks[0].stop).not.toHaveBeenCalled();

      ctrl.abort();
      await expect(opened).rejects.toMatchObject({ name: 'AbortError' });
      expect(tracks[0].stop).toHaveBeenCalledTimes(1);
      expect(document.querySelector('video')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a play() that never settles, releasing the camera', async () => {
    fakeMediaPipeline({ play: () => new Promise<void>(() => undefined) });
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    await expect(openCamera({ startTimeoutMs: 20 })).rejects.toMatchObject({ name: 'TrackerError', code: 'unknown' });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
  });

  it('never leaves the camera on if the video element cannot be created', async () => {
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    await expect(openCamera()).rejects.toBeInstanceOf(TrackerError);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('reports a playback refusal without blaming camera permission', async () => {
    fakeMediaPipeline({ play: () => Promise.reject(new DOMException('autoplay', 'NotAllowedError')) });
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    await expect(openCamera()).rejects.toMatchObject({ code: 'unknown' });
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});
