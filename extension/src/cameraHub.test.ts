import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFrame } from '../../src/types';
import { CameraHub } from './cameraHub';
import { PORT_OFFSCREEN, PORT_TAB, type OffscreenToHub } from './messages';
import { FakePort, flush, portPair } from './testing/fakes';

const FRAME: FeatureFrame = { t: 1, faceFound: false, quality: 0, features: null };

function setup() {
  const calls = { ensure: 0, close: 0, setup: [] as (number | null)[] };
  const hub = new CameraHub(
    {
      ensureOffscreen: async () => {
        calls.ensure++;
      },
      closeOffscreen: async () => {
        calls.close++;
      },
      openSetup: (tabId) => calls.setup.push(tabId),
    },
    { stopGraceMs: 1_000, closeIdleMs: 5_000, offscreenConnectTimeoutMs: 3_000, maxRestarts: 3, now: () => Date.now() },
  );

  /** Connect a tab; returns the tab's end of the port. */
  const tab = (tabId: number): FakePort => {
    const [tabEnd, hubEnd] = portPair(PORT_TAB);
    hub.attachTab(hubEnd, tabId);
    return tabEnd;
  };
  /** Connect the offscreen document; returns its end. */
  const offscreen = (): FakePort => {
    const [docEnd, hubEnd] = portPair(PORT_OFFSCREEN);
    hub.attachOffscreen(hubEnd);
    return docEnd;
  };
  const fromOffscreen = (doc: FakePort, msg: OffscreenToHub) => doc.postMessage(msg);
  return { hub, calls, tab, offscreen, fromOffscreen };
}

/** Messages the hub sent to this end. */
const inbox = (end: FakePort) => end.peer!.sent;
const statuses = (end: FakePort) =>
  inbox(end)
    .filter((m) => (m as { type: string }).type === 'camera-status')
    .map((m) => (m as { status: { state: string } }).status.state);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CameraHub', () => {
  it('creates the offscreen document on the first subscriber and starts the camera once it connects', async () => {
    const { hub, calls, tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    expect(calls.ensure).toBe(1);
    expect(hub.subscriberCount).toBe(1);

    const doc = offscreen();
    fromOffscreen(doc, { type: 'hello', state: 'idle' });
    await flush();
    expect(inbox(doc)).toEqual([{ type: 'camera-start' }]);
    expect(statuses(t1)).toEqual(['starting']);

    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running', fps: 30 } });
    await flush();
    expect(statuses(t1)).toEqual(['starting', 'running']);
    expect(hub.cameraState).toBe('running');
  });

  it('relays frames only to subscribed tabs', async () => {
    const { tab, offscreen, fromOffscreen } = setup();
    const watching = tab(1);
    const idle = tab(2);
    watching.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running' } });
    fromOffscreen(doc, { type: 'frame', frame: FRAME });
    await flush();
    expect(inbox(watching)).toContainEqual({ type: 'frame', frame: FRAME });
    expect(inbox(idle)).toEqual([]);
  });

  it('tells a late subscriber the camera is already running and reuses it', async () => {
    const { calls, tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'hello', state: 'idle' });
    await flush();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running', fps: 24 } });
    await flush();
    const t2 = tab(2);
    t2.postMessage({ type: 'subscribe' });
    await flush();
    expect(inbox(t2)).toEqual([{ type: 'camera-status', status: { state: 'running', fps: 24 } }]);
    expect(calls.ensure).toBe(1);
    expect(inbox(doc).filter((m) => (m as { type: string }).type === 'camera-start')).toHaveLength(1);
  });

  it('stops the camera immediately when the last tab turns Gaze Reader off, then closes the document when idle', async () => {
    const { calls, tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running' } });
    await flush();
    t1.postMessage({ type: 'unsubscribe', linger: false });
    await flush();
    expect(inbox(doc).at(-1)).toEqual({ type: 'camera-stop' });
    expect(calls.close).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.close).toBe(1);
  });

  it('keeps the camera warm briefly when a tab is merely hidden, and cancels the stop if it comes back', async () => {
    const { tab, offscreen, fromOffscreen, hub } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running' } });
    await flush();
    t1.postMessage({ type: 'unsubscribe', linger: true });
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    expect(inbox(doc)).not.toContainEqual({ type: 'camera-stop' });
    t1.postMessage({ type: 'subscribe' });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inbox(doc)).not.toContainEqual({ type: 'camera-stop' });
    expect(hub.cameraState).toBe('running');
  });

  it('treats a closed tab like a hidden one (grace period, then stop)', async () => {
    const { tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running' } });
    await flush();
    t1.disconnect();
    await flush();
    expect(inbox(doc)).not.toContainEqual({ type: 'camera-stop' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inbox(doc)).toContainEqual({ type: 'camera-stop' });
  });

  it('opens the setup page once when the camera is denied, and does not retry until asked again', async () => {
    const { calls, tab, offscreen, fromOffscreen, hub } = setup();
    const t1 = tab(7);
    const t2 = tab(8);
    t1.postMessage({ type: 'subscribe' });
    t2.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'hello', state: 'idle' });
    await flush();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'error', code: 'camera-denied' } });
    await flush();
    expect(calls.setup).toEqual([7]);
    expect(statuses(t1).at(-1)).toBe('error');
    expect(statuses(t2).at(-1)).toBe('error');
    const starts = () => inbox(doc).filter((m) => (m as { type: string }).type === 'camera-start').length;
    expect(starts()).toBe(1);

    // Permission granted in the setup tab: the still-subscribed tab gets a fresh attempt.
    hub.permissionGranted();
    await flush();
    expect(starts()).toBe(2);
  });

  it('a fresh subscribe after an error retries the camera', async () => {
    const { tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'hello', state: 'idle' });
    await flush();
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'error', code: 'camera-in-use' } });
    await flush();
    t1.postMessage({ type: 'unsubscribe', linger: false });
    t1.postMessage({ type: 'subscribe' });
    await flush();
    expect(inbox(doc).filter((m) => (m as { type: string }).type === 'camera-start')).toHaveLength(2);
  });

  it('recreates a crashed offscreen document while tabs still need it, but gives up after repeated crashes', async () => {
    const { calls, tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    for (let i = 0; i < 3; i++) {
      const doc = offscreen();
      fromOffscreen(doc, { type: 'camera-status', status: { state: 'running' } });
      await flush();
      doc.disconnect(); // renderer crash
      await flush();
    }
    expect(calls.ensure).toBe(3);
    expect(statuses(t1).at(-1)).toBe('error');
  });

  it('reports an error if the offscreen document never connects', async () => {
    const { tab } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(statuses(t1).at(-1)).toBe('error');
  });

  it('after a service-worker restart, an offscreen hello re-announces the running camera to resubscribed tabs', async () => {
    const { hub, tab, offscreen, fromOffscreen } = setup();
    hub.init();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe' });
    await flush();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'hello', state: 'running' });
    await flush();
    expect(statuses(t1)).toContain('running');
    expect(inbox(doc)).not.toContainEqual({ type: 'camera-start' });
  });

  it('closes a leftover offscreen document nobody claims after a restart', async () => {
    const { hub, calls, offscreen, fromOffscreen } = setup();
    hub.init();
    const doc = offscreen();
    fromOffscreen(doc, { type: 'hello', state: 'running' });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inbox(doc)).toContainEqual({ type: 'camera-stop' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.close).toBe(1);
  });

  it('ignores malformed messages from either side', async () => {
    const { hub, tab, offscreen, fromOffscreen } = setup();
    const t1 = tab(1);
    t1.postMessage({ type: 'subscribe', please: true });
    t1.postMessage({ type: 'camera-start' });
    t1.postMessage('subscribe');
    await flush();
    expect(hub.subscriberCount).toBe(1); // extra fields are fine; the other two are ignored
    const doc = offscreen();
    doc.postMessage({ type: 'frame', frame: { t: 'x' } });
    fromOffscreen(doc, { type: 'camera-status', status: { state: 'running' } });
    await flush();
    expect(inbox(t1).some((m) => (m as { type: string }).type === 'frame')).toBe(false);
  });
});
