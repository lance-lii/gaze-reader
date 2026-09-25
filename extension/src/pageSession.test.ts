// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents, AppSettings, EventBus, EventName, LayoutChangeReason } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { LineTracker } from '../../src/reading/lineTracker';
import { KEYS } from './extStorage';
import { PORT_TAB, type HubToTab } from './messages';
import { PagePill } from './pagePill';
import { HOST_TAG, PageSession, type PageSessionDeps } from './pageSession';
import { FakePort, FakeStorage, flush, portPair } from './testing/fakes';
import { eyeFeatures, linearGazeModel } from './testing/models';
import { zoomAware } from './zoomModel';

// The session's event bus is private; record every bus created so tests can listen in.
const { buses } = vi.hoisted(() => ({ buses: [] as EventBus[] }));
vi.mock('../../src/core/events', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/events')>();
  return {
    ...mod,
    createEventBus: (): EventBus => {
      const bus = mod.createEventBus();
      buses.push(bus);
      return bus;
    },
  };
});

/** Collects every payload of `type` emitted on the latest session's bus. */
function record<K extends EventName>(type: K): AppEvents[K][] {
  const seen: AppEvents[K][] = [];
  buses.at(-1)!.on(type, (p) => seen.push(p));
  return seen;
}

/** A stored calibration made on a page at `dpr`. */
function storedModel(dpr = 1) {
  return JSON.parse(JSON.stringify(zoomAware(linearGazeModel(), () => dpr).toJSON())) as unknown;
}

/** Counts add/removeEventListener on a target so leaks show up as a non-zero balance. */
function listenerLedger(target: EventTarget) {
  const live = new Map<string, number>();
  const ids = new Map<unknown, number>();
  const key = (type: string, cb: unknown, opts: unknown) => {
    const capture = typeof opts === 'boolean' ? opts : Boolean((opts as { capture?: boolean } | undefined)?.capture);
    if (!ids.has(cb)) ids.set(cb, ids.size);
    return `${type}|${String(capture)}|${String(ids.get(cb))}`;
  };
  // jsdom's window/document reject Node's own EventTarget methods: forward to the target's originals.
  const origAdd = target.addEventListener;
  const origRemove = target.removeEventListener;
  const add = vi.spyOn(target, 'addEventListener').mockImplementation(function (this: EventTarget, type, cb, opts) {
    const k = key(type, cb, opts);
    live.set(k, (live.get(k) ?? 0) + 1);
    return origAdd.call(this, type, cb, opts);
  });
  const remove = vi.spyOn(target, 'removeEventListener').mockImplementation(function (this: EventTarget, type, cb, opts) {
    const k = key(type, cb, opts);
    if (live.has(k)) live.set(k, Math.max(0, (live.get(k) ?? 0) - 1));
    return origRemove.call(this, type, cb, opts);
  });
  return {
    leaked: () => [...live.entries()].filter(([, n]) => n > 0).map(([k]) => k.split('|')[0]),
    restore: () => {
      add.mockRestore();
      remove.mockRestore();
    },
  };
}

function setup(settings: Partial<AppSettings> = {}) {
  const storage = new FakeStorage();
  storage.data.set(KEYS.settings, { v: 1, settings: { ...DEFAULT_SETTINGS, ...settings }, origin: 'seed', seq: 1 });
  const hubEnds: FakePort[] = [];
  const ended: string[] = [];
  let setupOpened = 0;
  let contextValid = true;
  const deps: PageSessionDeps = {
    storage,
    connectPort: () => {
      const [tabEnd, hubEnd] = portPair(PORT_TAB);
      hubEnds.push(hubEnd);
      return tabEnd;
    },
    isContextValid: () => contextValid,
    openSetup: () => {
      setupOpened++;
    },
    onEnded: (reason) => ended.push(reason),
  };
  const hubSend = (msg: HubToTab) => hubEnds.at(-1)!.postMessage(msg);
  return {
    storage,
    deps,
    hubEnds,
    ended,
    hubSend,
    get setupOpened() {
      return setupOpened;
    },
    invalidateContext: () => {
      contextValid = false;
    },
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const altShift = (code: string, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { code, altKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true }));

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no canvas (it would log "Not implemented"); the debug overlay copes with a null context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = `<article><p>${'Reading is a sequence of fixations and saccades. '.repeat(20)}</p></article>`;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.querySelectorAll(HOST_TAG).forEach((el) => el.remove());
  Reflect.deleteProperty(document, 'visibilityState'); // back to jsdom's own getter
});

describe('PageSession', () => {
  it('mounts one ignored shadow host, and destroy() removes every element, listener and timer', async () => {
    const win = listenerLedger(window);
    const doc = listenerLedger(document);
    const timersBefore = vi.getTimerCount();
    const t = setup({ gazeSource: 'mouse' });
    // A host orphaned by an earlier extension instance is replaced, not stacked.
    document.documentElement.append(document.createElement(HOST_TAG));

    const session = await PageSession.start(t.deps);
    await flush();
    const hosts = document.querySelectorAll(HOST_TAG);
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(host.hasAttribute('data-gr-ignore')).toBe(true);
    expect(host.style.getPropertyValue('position')).toBe('fixed');
    expect(host.style.getPropertyPriority('position')).toBe('important');
    expect(host.parentElement).toBe(document.documentElement);
    expect(session.state()).toMatchObject({ enabled: true, source: 'mouse', tracking: 'tracking' });

    session.destroy();
    expect(document.querySelectorAll(HOST_TAG)).toHaveLength(0);
    await flush();
    expect(win.leaked()).toEqual([]);
    expect(doc.leaked()).toEqual([]);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(localStorage.length).toBe(0); // never the page's storage
    win.restore();
    doc.restore();
  });

  it('handles keyboard shortcuts, but never while the reader types', async () => {
    const t = setup({ gazeSource: 'mouse' });
    const session = await PageSession.start(t.deps);
    document.body.insertAdjacentHTML('beforeend', '<input id="field"><div id="ce" contenteditable="true"></div>');

    altShift('KeyP', document.getElementById('field')!);
    altShift('KeyP', document.getElementById('ce')!);
    expect(session.state().paused).toBe(false);

    altShift('KeyP');
    expect(session.state()).toMatchObject({ paused: true, tracking: 'paused' });
    altShift('KeyP');
    expect(session.state().paused).toBe(false);

    altShift('KeyX');
    expect(t.ended).toEqual(['user']);
    session.destroy();
    altShift('KeyP'); // listener gone
    expect(session.state().paused).toBe(false);
  });

  it('syncs settings with chrome.storage.local: popup edits apply live, local edits persist', async () => {
    const t = setup({ gazeSource: 'mouse', showGazeDot: false });
    const session = await PageSession.start(t.deps);
    await t.storage.area.set({
      [KEYS.settings]: { v: 1, settings: { ...DEFAULT_SETTINGS, gazeSource: 'mouse', sensitivity: 'eager' }, origin: 'popup', seq: 2 },
    });
    await flush();
    altShift('KeyO'); // toggle gaze dot → local change → persisted
    await flush();
    const stored = t.storage.data.get(KEYS.settings) as { settings: AppSettings };
    expect(stored.settings.sensitivity).toBe('eager');
    expect(stored.settings.showGazeDot).toBe(true);
    session.destroy();
  });

  it('webcam: a denied camera shows what to do, and a grant from the setup page retries', async () => {
    const t = setup({ gazeSource: 'webcam' });
    const session = await PageSession.start(t.deps);
    await flush();
    expect(t.hubEnds).toHaveLength(1);
    expect(t.hubEnds[0]!.peer!.sent).toEqual([{ type: 'subscribe' }]);
    expect(session.state()).toMatchObject({ source: 'webcam', tracking: 'starting' });

    t.hubSend({ type: 'camera-status', status: { state: 'error', code: 'camera-denied' } });
    await flush(10);
    expect(session.state()).toMatchObject({ tracking: 'error', detail: 'Camera permission needed' });

    // Leaving and coming back to the tab does not hammer a denied camera...
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(t.hubEnds).toHaveLength(1);

    // ...but the setup page's grant does.
    await t.storage.area.set({ [KEYS.cameraGrantedAt]: Date.now() });
    await flush(10);
    expect(t.hubEnds).toHaveLength(2);
    expect(t.hubEnds[1]!.peer!.sent).toEqual([{ type: 'subscribe' }]);
    expect(session.state().tracking).toBe('starting');

    session.destroy();
    expect(t.hubEnds[1]!.connected).toBe(false);
    expect(t.hubEnds[1]!.peer!.sent.at(-1)).toEqual({ type: 'unsubscribe', linger: false });
  });

  it('switching to the mouse releases the camera immediately', async () => {
    const t = setup({ gazeSource: 'webcam' });
    const session = await PageSession.start(t.deps);
    await flush();
    t.hubSend({ type: 'camera-status', status: { state: 'running', fps: 30 } });
    await flush(10);
    await t.storage.area.set({
      [KEYS.settings]: { v: 1, settings: { ...DEFAULT_SETTINGS, gazeSource: 'mouse' }, origin: 'popup', seq: 5 },
    });
    await flush(10);
    expect(t.hubEnds[0]!.peer!.sent).toContainEqual({ type: 'unsubscribe', linger: false });
    expect(session.state()).toMatchObject({ source: 'mouse', tracking: 'tracking' });
    session.destroy();
  });

  it('finishes a page turn whose animation stalls (no animation frames) instead of freezing auto-scroll', async () => {
    // An app-like layout: the article scrolls inside #app, not the window.
    document.body.innerHTML = `<div id="app" style="overflow-y: auto"><article>${'<p>Some reading text that goes on for a while.</p>'.repeat(30)}</article></div>`;
    const app = document.getElementById('app')!;
    let top = 0;
    Object.defineProperty(app, 'scrollHeight', { configurable: true, value: 6000 });
    Object.defineProperty(app, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(app, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    app.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as typeof app.scrollTo;
    // A visible-but-not-painting window: animation frames never come.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const t = setup({ gazeSource: 'mouse', scrollDurationMs: 650 });
    const session = await PageSession.start(t.deps);
    altShift('ArrowDown');
    await vi.advanceTimersByTimeAsync(600);
    expect(top).toBe(0); // animation "running" but frozen
    await vi.advanceTimersByTimeAsync(2_000);
    const firstPage = top;
    expect(firstPage).toBeGreaterThan(500); // rescued: jumped to the destination

    altShift('ArrowDown'); // and the pipeline isn't stuck: the next turn works too
    await vi.advanceTimersByTimeAsync(2_500);
    expect(top).toBeGreaterThan(firstPage + 500);
    session.destroy();
    vi.unstubAllGlobals();
  });

  it('forgets undo history when the window width changes (the text reflows), not on height-only resizes', async () => {
    document.body.innerHTML = `<div id="app" style="overflow-y: auto"><article>${'<p>Some reading text that goes on for a while.</p>'.repeat(30)}</article></div>`;
    const app = document.getElementById('app')!;
    let top = 0;
    Object.defineProperty(app, 'scrollHeight', { configurable: true, value: 6000 });
    Object.defineProperty(app, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(app, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    app.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as typeof app.scrollTo;
    const saved = (['innerWidth', 'innerHeight'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(window, k)] as const);
    const resizeTo = (width: number, height: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      window.dispatchEvent(new Event('resize'));
    };
    resizeTo(1024, 768);

    const t = setup({ gazeSource: 'mouse', scrollDurationMs: 0 });
    const session = await PageSession.start(t.deps);
    const said = record('buddy-say');

    altShift('ArrowDown');
    await vi.advanceTimersByTimeAsync(500);
    expect(top).toBeGreaterThan(500);
    resizeTo(1024, 700); // height only: same text, same offsets
    await vi.advanceTimersByTimeAsync(300);
    altShift('KeyU');
    await vi.advanceTimersByTimeAsync(500);
    expect(top).toBe(0);

    altShift('ArrowDown');
    await vi.advanceTimersByTimeAsync(500);
    const turnedTo = top;
    expect(turnedTo).toBeGreaterThan(500);
    resizeTo(800, 700); // narrower: the text reflows
    await vi.advanceTimersByTimeAsync(300);
    altShift('KeyU');
    await vi.advanceTimersByTimeAsync(500);
    expect(top).toBe(turnedTo);
    expect(said.map((s) => s.text)).toContain('Nothing to undo yet.');
    session.destroy();
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(window, k, desc);
      else Reflect.deleteProperty(window, k);
    }
  });

  it('ends itself when the extension is reloaded underneath it', async () => {
    const t = setup({ gazeSource: 'mouse' });
    const session = await PageSession.start(t.deps);
    t.invalidateContext();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(t.ended).toContain('orphaned');
    session.destroy();
  });

  it('maps gaze correctly on a site kept at a different page zoom than the one calibrated on', async () => {
    const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 }); // this site: 125 %
    try {
      const t = setup({ gazeSource: 'webcam' });
      t.storage.data.set(KEYS.calibration, storedModel(1)); // calibrated on a 100 % page
      const session = await PageSession.start(t.deps);
      const gaze = record('gaze');
      await flush();
      t.hubSend({ type: 'camera-status', status: { state: 'running' } });
      await flush(10);
      expect(session.state()).toMatchObject({ tracking: 'tracking', calibrated: true });

      // At 100 % these features mean (800, 800) CSS px; the same screen spot is (640, 640) at 125 %.
      t.hubSend({ type: 'frame', frame: { t: 1, faceFound: true, quality: 0.9, features: eyeFeatures(3, 4) } });
      await flush(10);
      expect(gaze.at(-1)).toMatchObject({ valid: true, rawX: 640, rawY: 640 });
      session.destroy();
    } finally {
      if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr);
      else Reflect.deleteProperty(window, 'devicePixelRatio');
    }
  });

  it('treats changing page content as a reflow, keeping what the line tracker has learned', async () => {
    const t = setup({ gazeSource: 'mouse' });
    const session = await PageSession.start(t.deps);
    await vi.advanceTimersByTimeAsync(1_000);
    const setLayout = vi.spyOn(LineTracker.prototype, 'setLayout'); // calls through
    // An ad, an embed or a "3 min ago" timestamp updating inside the article.
    document.querySelector('article')!.insertAdjacentHTML('beforeend', '<p>Updated just now.</p>');
    await vi.advanceTimersByTimeAsync(400);
    const reasons: LayoutChangeReason[] = setLayout.mock.calls.map(([, reason]) => reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).not.toContain('content'); // 'content' would wipe the posterior and the fixation count
    session.destroy();
  });

  it('asks for a new calibration when the reader forgets it in the popup, and stays there across reconnects', async () => {
    const t = setup({ gazeSource: 'webcam' });
    t.storage.data.set(KEYS.calibration, storedModel());
    const session = await PageSession.start(t.deps);
    await flush();
    t.hubSend({ type: 'camera-status', status: { state: 'running' } });
    await flush(10);
    expect(session.state()).toMatchObject({ tracking: 'tracking', calibrated: true });

    const notify = vi.spyOn(PagePill.prototype, 'notify');
    await t.storage.area.remove([KEYS.calibration]); // popup: "Forget calibration"
    await flush(10);
    expect(session.state()).toMatchObject({ tracking: 'paused', detail: 'Not calibrated yet', calibrated: false });
    // The full calibration (13 dots + 4 checks) takes about a minute: don't promise 30 seconds.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: 'Webcam reading needs a one-minute calibration first.' }));

    // The service worker restarts: the tab reconnects, the camera is reported running again…
    t.hubEnds[0]!.disconnect();
    await flush(10);
    expect(session.state()).toMatchObject({ tracking: 'starting', detail: 'Reconnecting…' });
    await vi.advanceTimersByTimeAsync(300);
    expect(t.hubEnds).toHaveLength(2);
    t.hubSend({ type: 'camera-status', status: { state: 'running' } });
    await flush(10);
    // …and without a model that is still "needs calibration", not "reading along".
    expect(session.state()).toMatchObject({ tracking: 'paused', detail: 'Not calibrated yet' });
    session.destroy();
  });

  it('calls tracking shaky only when confidence stays low, not for the dip at the end of every page', async () => {
    const t = setup({ gazeSource: 'webcam' });
    t.storage.data.set(KEYS.calibration, storedModel());
    const session = await PageSession.start(t.deps);
    await flush();
    t.hubSend({ type: 'camera-status', status: { state: 'running' } });
    await flush(10);
    let frameT = 1;
    const frames = async (ms: number, quality: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) {
        frameT += 50;
        t.hubSend({ type: 'frame', frame: { t: frameT, faceFound: true, quality, features: eyeFeatures(0, 0) } });
        await vi.advanceTimersByTimeAsync(50);
      }
    };
    await frames(1000, 0.9);
    expect(session.state().tracking).toBe('tracking');
    await frames(1500, 0.1); // lowered lids on the last lines of the page
    expect(session.state().tracking).toBe('tracking');
    await frames(1000, 0.9);
    await frames(4000, 0.1); // bad light
    expect(session.state().tracking).toBe('poor');
    session.destroy();
  });

  it("a hidden tab doesn't report a lost face (it let go of the camera on purpose)", async () => {
    const t = setup({ gazeSource: 'webcam' });
    t.storage.data.set(KEYS.calibration, storedModel());
    const session = await PageSession.start(t.deps);
    const states = record('tracking-state');
    await flush();
    t.hubSend({ type: 'camera-status', status: { state: 'running' } });
    await flush(10);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states.map((s) => s.state)).not.toContain('no-face');
    session.destroy();
  });

  it("Dewey's menu offers Resume while this tab is paused", async () => {
    let root: ShadowRoot | null = null;
    const attach = HTMLElement.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      const r = attach.call(this, init);
      if (this.localName === HOST_TAG) root = r;
      return r;
    });
    const t = setup({ gazeSource: 'mouse' });
    const session = await PageSession.start(t.deps);
    const dewey = root!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    const autoscroll = () => root!.querySelector<HTMLButtonElement>('[data-action="autoscroll"]')!;

    dewey.click();
    expect(autoscroll().textContent).toBe('Pause auto-scroll');
    autoscroll().click();
    expect(session.state().paused).toBe(true);

    dewey.click();
    expect(autoscroll().textContent).toBe('Resume auto-scroll');
    autoscroll().click();
    expect(session.state().paused).toBe(false);
    // Pausing is per tab: the shared setting is untouched.
    expect((t.storage.data.get(KEYS.settings) as { settings: AppSettings }).settings.autoScroll).toBe(true);
    session.destroy();
  });

  it('answers pause and undo key presses at a priority Dewey shows right away', async () => {
    const t = setup({ gazeSource: 'mouse' });
    const session = await PageSession.start(t.deps);
    const said = record('buddy-say');
    altShift('KeyP');
    altShift('KeyP');
    altShift('KeyU');
    await flush();
    // 'normal' lines wait while the reader is mid-line, and 'low' ones are dropped at the default chattiness.
    expect(said.map((s) => [s.text, s.priority])).toEqual([
      ["Paused. I'll wait right here.", 'high'],
      ['Back to reading!', 'high'],
      ['Nothing to undo yet.', 'high'],
    ]);
    session.destroy();
  });

  it('tells Dewey how far through the article the reader is', async () => {
    const t = setup({ gazeSource: 'mouse' });
    const article = document.querySelector('article')!;
    article.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 1536 });
    const session = await PageSession.start(t.deps);
    const progress = record('book-progress');
    await vi.advanceTimersByTimeAsync(5_100);
    expect(progress.at(-1)).toMatchObject({ fraction: 0.5, pagesTurned: 0 }); // 768 px viewport of a 1536 px article
    session.destroy();
  });
});
