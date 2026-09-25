import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFrame } from '../../src/types';
import { PORT_TAB, type HubToTab } from './messages';
import { ClockSync, RemoteFeatureSource, RemoteTrackerError, type RemoteSourceState } from './remoteFeatureSource';
import { FakePort, flush, portPair } from './testing/fakes';

function frame(t: number, faceFound = true): FeatureFrame {
  return {
    t,
    faceFound,
    quality: faceFound ? 0.9 : 0,
    features: faceFound
      ? {
          vector: [0.1, 0.2, 0.3],
          headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 },
          blink: 0,
          openness: 0.3,
          faceScale: 0.1,
          faceCenter: { x: 0.5, y: 0.5 },
        }
      : null,
  };
}

/** Plays the service worker's side of the tab port. */
class FakeHub {
  readonly ends: FakePort[] = [];
  valid = true;
  failConnect = false;
  localNow = 10_000;

  readonly connect = (): FakePort => {
    if (this.failConnect) throw new Error('Could not establish connection');
    const [tabEnd, hubEnd] = portPair(PORT_TAB);
    this.ends.push(hubEnd);
    return tabEnd;
  };

  get current(): FakePort {
    return this.ends[this.ends.length - 1]!;
  }

  send(msg: HubToTab): void {
    this.current.postMessage(msg);
  }

  /** Messages the tab sent to the current hub end. */
  received(): unknown[] {
    return this.current.peer!.sent;
  }
}

function setup(opts: { startTimeoutMs?: number } = {}) {
  const hub = new FakeHub();
  const source = new RemoteFeatureSource({
    connect: hub.connect,
    isContextValid: () => hub.valid,
    now: () => hub.localNow,
    startTimeoutMs: opts.startTimeoutMs ?? 5_000,
    reconnectInitialMs: 100,
    reconnectMaxMs: 1_000,
    random: () => 0.5, // no jitter
  });
  const states: RemoteSourceState[] = [];
  source.onStatus((s) => states.push(s.state));
  const frames: FeatureFrame[] = [];
  source.onFrame((f) => frames.push(f));
  return { hub, source, states, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteFeatureSource', () => {
  it('subscribes on start, resolves once the camera runs, and delivers validated frames on the local clock', async () => {
    const { hub, source, frames, states } = setup();
    const started = source.start();
    await flush();
    expect(hub.received()).toEqual([{ type: 'subscribe' }]);
    expect(source.running).toBe(false);

    hub.send({ type: 'camera-status', status: { state: 'starting' } });
    hub.send({ type: 'camera-status', status: { state: 'running', fps: 30 } });
    await flush();
    await expect(started).resolves.toBeUndefined();
    expect(source.running).toBe(true);
    expect(source.fps).toBe(30);
    expect(states).toEqual(['connecting', 'starting', 'running']);

    // The offscreen clock (t ≈ 500) is unrelated to ours (≈ 10 000).
    hub.localNow = 10_000;
    hub.send({ type: 'frame', frame: frame(500) });
    await flush();
    hub.localNow = 10_060; // delivered late…
    hub.send({ type: 'frame', frame: frame(533) });
    await flush();
    hub.localNow = 10_061; // …and in a burst
    hub.send({ type: 'frame', frame: frame(566) });
    await flush();
    expect(frames.map((f) => f.t)).toEqual([10_000, 10_033, 10_061]);
    // Spacing of the first two is exact despite the 60 ms delivery gap; nothing lands in the future.
    for (const f of frames) expect(f.t).toBeLessThanOrEqual(hub.localNow);
  });

  it('drops malformed frames and ignores foreign messages', async () => {
    const { hub, source, frames } = setup();
    void source.start();
    await flush();
    hub.send({ type: 'camera-status', status: { state: 'running' } });
    hub.current.postMessage({ type: 'frame', frame: { ...frame(1), quality: Number.NaN } });
    hub.current.postMessage({ type: 'frame', frame: { t: 2, faceFound: 'yes' } });
    hub.current.postMessage({ type: 'reboot' });
    hub.send({ type: 'frame', frame: frame(3, false) });
    await flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.faceFound).toBe(false);
  });

  it('treats the first frame as proof the camera runs even if the status was lost', async () => {
    const { hub, source } = setup();
    const started = source.start();
    await flush();
    hub.send({ type: 'frame', frame: frame(10) });
    await flush();
    await expect(started).resolves.toBeUndefined();
    expect(source.running).toBe(true);
  });

  it('rejects start() with the tracker error code and releases the subscription', async () => {
    const { hub, source, states } = setup();
    const started = source.start();
    await flush();
    const hubEnd = hub.current;
    hub.send({ type: 'camera-status', status: { state: 'error', code: 'camera-denied', message: 'Permission needed' } });
    await flush();
    const err = await started.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteTrackerError);
    expect((err as RemoteTrackerError).code).toBe('camera-denied');
    expect(source.running).toBe(false);
    expect(source.status).toMatchObject({ state: 'error', code: 'camera-denied' });
    expect(hubEnd.peer!.sent).toContainEqual({ type: 'unsubscribe', linger: false });
    expect(hubEnd.connected).toBe(false);
    expect(states.at(-1)).toBe('error');
  });

  it('reports a camera that dies mid-session as an error status', async () => {
    const { hub, source } = setup();
    void source.start();
    await flush();
    hub.send({ type: 'camera-status', status: { state: 'running' } });
    await flush();
    hub.send({ type: 'camera-status', status: { state: 'error', code: 'no-camera' } });
    await flush();
    expect(source.running).toBe(false);
    expect(source.status.code).toBe('no-camera');
  });

  it('reconnects with backoff after the service worker restarts, then resubscribes', async () => {
    const { hub, source, frames, states } = setup();
    void source.start();
    await flush();
    hub.send({ type: 'camera-status', status: { state: 'running' } });
    await flush();

    hub.failConnect = true; // the worker is still waking up
    hub.current.disconnect();
    await flush();
    expect(states.at(-1)).toBe('reconnecting');
    expect(source.running).toBe(true); // still wanted; frames will resume

    await vi.advanceTimersByTimeAsync(100); // attempt 1 fails
    expect(hub.ends).toHaveLength(1);
    hub.failConnect = false;
    await vi.advanceTimersByTimeAsync(199); // attempt 2 is due at 200 ms
    expect(hub.ends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.ends).toHaveLength(2);
    await flush();
    expect(hub.received()).toEqual([{ type: 'subscribe' }]);

    hub.send({ type: 'frame', frame: frame(42) });
    await flush();
    expect(frames).toHaveLength(1);
    expect(states.at(-1)).toBe('running');
  });

  it('goes quiet for good when the extension context is invalidated', async () => {
    const { hub, source } = setup();
    const started = source.start();
    await flush();
    hub.valid = false; // extension reloaded
    hub.current.disconnect();
    await flush();
    const err = await started.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteTrackerError);
    expect(source.status.state).toBe('orphaned');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.ends).toHaveLength(1); // no reconnect attempts
  });

  it('times out when the camera never starts', async () => {
    const { source, hub } = setup({ startTimeoutMs: 1_000 });
    const started = source.start();
    await flush();
    const hubEnd = hub.current;
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await started.catch((e: unknown) => e);
    expect((err as RemoteTrackerError).code).toBe('unknown');
    expect(hubEnd.peer!.sent).toContainEqual({ type: 'unsubscribe', linger: false });
  });

  it('stop() unsubscribes (lingering if asked), disconnects and stops delivering frames', async () => {
    const { hub, source, frames } = setup();
    void source.start();
    await flush();
    hub.send({ type: 'camera-status', status: { state: 'running' } });
    await flush();
    const hubEnd = hub.current;
    source.stop({ linger: true });
    expect(hubEnd.peer!.sent.at(-1)).toEqual({ type: 'unsubscribe', linger: true });
    expect(hubEnd.connected).toBe(false);
    expect(source.running).toBe(false);
    expect(source.status.state).toBe('idle');
    await flush();
    expect(frames).toHaveLength(0);
  });

  it('survives rapid start/stop/start and shares one pending start', async () => {
    const { hub, source } = setup();
    const a = source.start();
    const b = source.start();
    expect(b).toBe(a);
    source.stop();
    await expect(a).rejects.toBeInstanceOf(RemoteTrackerError);
    const c = source.start();
    await flush();
    expect(hub.ends).toHaveLength(2);
    hub.send({ type: 'camera-status', status: { state: 'running' } });
    await flush();
    await expect(c).resolves.toBeUndefined();
    await expect(source.start()).resolves.toBeUndefined(); // already running
  });

  it('destroy() drops listeners and refuses to start again', async () => {
    const { source, frames } = setup();
    source.destroy();
    await expect(source.start()).rejects.toBeInstanceOf(RemoteTrackerError);
    expect(frames).toHaveLength(0);
  });

  it('isolates a throwing frame listener', async () => {
    const { hub, source, frames } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    source.onFrame(() => {
      throw new Error('bad listener');
    });
    void source.start();
    await flush();
    hub.send({ type: 'frame', frame: frame(1) });
    await flush();
    expect(frames).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('ClockSync', () => {
  it('keeps frame spacing, never runs backwards or ahead, and resyncs when the remote clock restarts', () => {
    const c = new ClockSync(1_000);
    expect(c.toLocal(100, 5_000)).toBe(5_000);
    expect(c.toLocal(133, 5_040)).toBe(5_033);
    expect(c.toLocal(166, 5_070)).toBe(5_066);
    // Offscreen document recreated: its clock starts near zero again.
    expect(c.toLocal(5, 6_000)).toBe(6_000);
    expect(c.toLocal(38, 6_035)).toBe(6_033);
  });

  it('stays monotonic and within one delivery jitter of the true spacing under bursty relay', () => {
    const c = new ClockSync(1_000);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let prev = -Infinity;
    let maxSpacingError = 0;
    let local = 20_000;
    for (let i = 0; i < 300; i++) {
      const remote = 1_000 + i * 33;
      local = Math.max(local, 20_000 + i * 33 + 2 + rand() * 60); // 2–62 ms delivery delay
      const t = c.toLocal(remote, local);
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThanOrEqual(local);
      if (i > 50) maxSpacingError = Math.max(maxSpacingError, Math.abs(t - prev - 33));
      prev = t;
    }
    // Once the minimum delay has been seen, spacing is exact.
    expect(maxSpacingError).toBeLessThan(1);
  });
});
