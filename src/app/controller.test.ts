// @vitest-environment jsdom
/**
 * Controller integration tests: the real shell and modules, with only what
 * jsdom can't do stubbed (layout measurement, the network, canvas, the camera).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents, FeatureFrame, GazeModel, LineLayout, PageEndDecision, TextLine } from '../types';
import { CameraFeatureSource } from '../gaze/faceTracker';
import { FEATURE_NAMES } from '../gaze/features';
import { MouseGazeSource } from '../gaze/mouseGazeSource';
import { ReaderView } from '../reader/readerView';
import { ScrollController } from '../reader/scrollController';
import { PageEndDetector } from '../reading/pageEndDetector';
import { AppController } from './controller';

// A saved calibration when a test wants one (the real loader reads localStorage).
const saved = vi.hoisted(() => ({ model: null as GazeModel | null }));
vi.mock('../gaze/calibrationModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gaze/calibrationModel')>()),
  loadCalibration: () => saved.model,
}));
// Never fetch MediaPipe from a test.
vi.mock('../gaze/faceTracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gaze/faceTracker')>()),
  preloadFaceLandmarker: () => Promise.resolve(false),
}));

const PITCH = 40;

/** Twelve lines from the top of the reader; the last one is cut off unless `endsOnScreen`. */
function layout(endsOnScreen: boolean): LineLayout {
  const lines: TextLine[] = Array.from({ length: 12 }, (_, i) => {
    const top = 80 + i * PITCH;
    return {
      index: i,
      top,
      bottom: top + 30,
      left: 100,
      right: 700,
      centerY: top + 15,
      docTop: top - 52,
      charCount: 60,
      fullyVisible: i < 11 || endsOnScreen,
    };
  });
  return {
    lines,
    viewport: { left: 0, top: 52, right: 1024, bottom: endsOnScreen ? 768 : 540 },
    column: { left: 100, top: 80, right: 700, bottom: 80 + 11 * PITCH + 30 },
    linePitch: PITCH,
    scrollTop: 0,
    scrollHeight: 4000,
    clientHeight: 716,
    measuredAt: performance.now(),
  };
}

const PAGE_END: PageEndDecision = { trigger: true, reason: 'line-tracker', confidence: 0.9, targetLineIndex: 10, detail: 'test' };
const IDLE: PageEndDecision = { trigger: false, reason: 'none', confidence: 0, targetLineIndex: -1, detail: '' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function record<K extends keyof AppEvents>(app: AppController, type: K): AppEvents[K][] {
  const seen: AppEvents[K][] = [];
  app.bus.on(type, (p) => seen.push(p));
  return seen;
}

async function openPastedText(text = 'The eyes jump along the line. '.repeat(120)): Promise<void> {
  const toggle = document.querySelector<HTMLButtonElement>('.gr-lib-paste-toggle')!;
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  const form = document.querySelector<HTMLFormElement>('.gr-inline-form:not([hidden])')!;
  form.querySelector('textarea')!.value = text;
  form.requestSubmit();
  await until(() => document.documentElement.dataset.screen === 'reader', 'the reader to open');
}

const toastText = () => [...document.querySelectorAll('.gr-toast:not([data-leaving])')].map((t) => t.textContent).join(' | ');

function moveMouse(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

describe('AppController', () => {
  let root: HTMLElement;
  let app: AppController;

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('gazeReader.onboarding.v1', JSON.stringify({ done: true }));
    localStorage.setItem('gazeReader.settings.v1', JSON.stringify({ gazeSource: 'mouse', buddyEnabled: false }));
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    root = document.createElement('div');
    document.body.appendChild(root);
    app = new AppController(root);
    await app.start();
  });

  afterEach(() => {
    app.destroy();
    root.remove();
    Reflect.deleteProperty(document, 'hidden');
    saved.model = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops the running gaze source when opening a book fails (regression: camera left on behind the library)', async () => {
    await openPastedText();
    const gaze = record(app, 'gaze');
    moveMouse(400, 300);
    await until(() => gaze.length > 0, 'mouse gaze samples');

    const stop = vi.spyOn(MouseGazeSource.prototype, 'stop');
    vi.spyOn(ReaderView.prototype, 'open').mockImplementationOnce(() => {
      throw new Error('render failed');
    });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { types: ['Files'], files: [new File(['A second book. '.repeat(50)], 'second.txt', { type: 'text/plain' })] },
    });
    window.dispatchEvent(drop);

    await until(() => document.documentElement.dataset.screen === 'library', 'the library to come back');
    expect(stop).toHaveBeenCalled();
    expect(document.title).toBe('Gaze Reader');
    expect(toastText()).toMatch(/Couldn’t open that book/);
    const before = gaze.length;
    moveMouse(420, 320);
    await sleep(120);
    expect(gaze.length).toBe(before);
  });

  describe('at the end of the book', () => {
    async function readUntilPageEnd(endsOnScreen: boolean, opts: { paused?: boolean } = {}) {
      vi.spyOn(ReaderView.prototype, 'measureLayout').mockImplementation(() => layout(endsOnScreen));
      const turn = vi.spyOn(ScrollController.prototype, 'turnPage').mockResolvedValue(undefined);
      vi.spyOn(ScrollController.prototype, 'atEnd').mockReturnValue(false);
      let fire = false;
      vi.spyOn(PageEndDetector.prototype, 'update').mockImplementation(() => (fire ? PAGE_END : IDLE));
      const finished = record(app, 'book-finished');
      const pageEnds = record(app, 'page-end');
      await openPastedText();
      const layouts = record(app, 'layout');
      await until(() => layouts.length > 0, 'the first layout');
      moveMouse(650, 480);
      if (opts.paused) app.bus.emit('settings-patch', { autoScroll: false });
      fire = true;
      await until(() => finished.length > 0 || turn.mock.calls.length > 0, 'a page-end response');
      return { turn, finished, pageEnds };
    }

    it('finishes instead of turning onto blank padding when the last line is on screen (regression)', async () => {
      const { turn, finished } = await readUntilPageEnd(true);
      expect(turn).not.toHaveBeenCalled();
      expect(finished).toHaveLength(1);
      expect(finished[0]!.title).toBe('Pasted text');
      await sleep(100);
      expect(finished).toHaveLength(1); // once
      expect(toastText()).toMatch(/The end!/);
    });

    it('finishes even while auto-scroll is paused (the reader paged through by hand)', async () => {
      const { turn, finished } = await readUntilPageEnd(true, { paused: true });
      expect(turn).not.toHaveBeenCalled();
      expect(finished).toHaveLength(1);
    });

    it('still turns the page when more text follows below', async () => {
      const { turn, finished, pageEnds } = await readUntilPageEnd(false);
      expect(finished).toHaveLength(0);
      expect(pageEnds).toHaveLength(1);
      expect(turn).toHaveBeenCalledTimes(1);
      const [turnLayout, target, opts] = turn.mock.calls[0]!;
      expect(turnLayout?.lines).toHaveLength(12);
      expect(target).toBe(PAGE_END.targetLineIndex);
      expect(opts).toEqual({ auto: true, reason: 'line-tracker' });
    });
  });

  it('tells the reader how to bring Dewey back after he hides himself, and keeps keyboard paging working', async () => {
    await openPastedText();
    app.bus.emit('settings-patch', { buddyEnabled: true });
    expect(toastText()).not.toMatch(/taking a break/);
    document.querySelector<HTMLElement>('.gr-buddy button')!.focus(); // his menu had focus
    app.bus.emit('settings-patch', { buddyEnabled: false }); // "Hide Dewey" in his menu
    expect(toastText()).toMatch(/Dewey is taking a break/);
    expect(document.activeElement).toBe(document.querySelector('.gr-reader'));
    const undo = [...document.querySelectorAll<HTMLButtonElement>('.gr-toast__actions button')].find((b) => b.textContent === 'Undo')!;
    undo.click();
    expect(JSON.parse(localStorage.getItem('gazeReader.settings.v1')!)).toMatchObject({ buddyEnabled: true });
  });

  it('keyboard: P pauses (pill says so), shortcuts wait while typing, and nothing reacts after destroy', async () => {
    const states = record(app, 'tracking-state');
    // In the library, typing an "s" into the paste box is just typing (S would open Settings).
    document.querySelector<HTMLButtonElement>('.gr-lib-paste-toggle')!.click();
    const area = document.querySelector('textarea')!;
    const typed = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
    area.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
    expect(document.querySelector<HTMLElement>('.gr-modal.gr-settings')!.hidden).toBe(true);
    await openPastedText();
    moveMouse(400, 300);
    await until(() => states.at(-1)?.state === 'tracking', 'tracking');

    const scroller = document.querySelector<HTMLElement>('.gr-reader')!;
    const p = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
    scroller.dispatchEvent(p);
    expect(p.defaultPrevented).toBe(true);
    await until(() => states.at(-1)?.state === 'paused', 'paused');
    expect(document.querySelector('.gr-pill__label')!.textContent).toBe('Paused');
    expect(document.querySelector('.gr-topbar')!.getAttribute('data-persist')).toBe('true');

    app.destroy();
    expect(root.childElementCount).toBe(0);
    const s = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
    window.dispatchEvent(s);
    expect(s.defaultPrevented).toBe(false);
  });

  it('a page key during a turn lands the turn instead of stranding the page halfway (regression)', async () => {
    // A turn that animates until something stops it, like ScrollController's.
    let animating = false;
    let land: (() => void) | null = null;
    vi.spyOn(ReaderView.prototype, 'measureLayout').mockImplementation(() => layout(false));
    vi.spyOn(ScrollController.prototype, 'atEnd').mockReturnValue(false);
    vi.spyOn(ScrollController.prototype, 'animating', 'get').mockImplementation(() => animating);
    const turn = vi.spyOn(ScrollController.prototype, 'turnPage').mockImplementation(() => {
      animating = true;
      app.bus.emit('page-turn', { from: 0, to: 836, auto: false, reason: 'manual', pageIndex: 1 });
      return new Promise<void>((resolve) => {
        land = () => {
          animating = false;
          resolve();
        };
      });
    });
    const scrollTo = vi.spyOn(ScrollController.prototype, 'scrollTo').mockImplementation(async () => land?.());
    const back = vi.spyOn(ScrollController.prototype, 'pageBack').mockResolvedValue(undefined);
    await openPastedText();

    // ScrollController's own "a key cancels the animation" listener is registered after the controller's.
    const laterListener = vi.fn();
    window.addEventListener('keydown', laterListener);
    const scroller = document.querySelector<HTMLElement>('.gr-reader')!;
    const key = (init: KeyboardEventInit) => scroller.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

    key({ key: ' ' });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(laterListener).toHaveBeenCalledTimes(1); // not turning yet when it was pressed

    key({ key: 'PageUp' }); // back, mid-turn: let the turn finish
    expect(back).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    key({ key: ' ' }); // forward again, mid-turn: land it at its target right now
    expect(scrollTo).toHaveBeenCalledWith(836, 0);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(laterListener).toHaveBeenCalledTimes(1); // neither mid-turn key reached the cancel listener
    window.removeEventListener('keydown', laterListener);
  });

  it('holds the tracking state while the tab is hidden and restarts the no-face clock on return (regression)', async () => {
    // Rebuild the app with a saved calibration and a stand-in camera.
    app.destroy();
    saved.model = {
      predict: () => ({ x: 500, y: 400 }),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      trainedAt: Date.now(),
      toJSON: () => ({ version: 1 }),
    };
    let running = false;
    let emitFrame: ((f: FeatureFrame) => void) | null = null;
    vi.spyOn(CameraFeatureSource.prototype, 'start').mockImplementation(async () => {
      running = true;
    });
    vi.spyOn(CameraFeatureSource.prototype, 'stop').mockImplementation(() => {
      running = false;
    });
    vi.spyOn(CameraFeatureSource.prototype, 'running', 'get').mockImplementation(() => running);
    vi.spyOn(CameraFeatureSource.prototype, 'video', 'get').mockReturnValue(null);
    vi.spyOn(CameraFeatureSource.prototype, 'lastLandmarks', 'get').mockReturnValue(null);
    vi.spyOn(CameraFeatureSource.prototype, 'onError').mockImplementation(() => () => undefined);
    vi.spyOn(CameraFeatureSource.prototype, 'onFrame').mockImplementation((cb) => {
      emitFrame = cb;
      return () => {
        emitFrame = null;
      };
    });
    const frame = (): FeatureFrame => ({
      t: performance.now(),
      faceFound: true,
      quality: 0.9,
      features: {
        vector: new Array<number>(FEATURE_NAMES.length).fill(0),
        headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 },
        blink: 0,
        openness: 0.3,
        faceScale: 0.12,
        faceCenter: { x: 0.5, y: 0.5 },
      },
    });

    localStorage.setItem('gazeReader.settings.v1', JSON.stringify({ gazeSource: 'webcam', buddyEnabled: false }));
    root = document.createElement('div');
    document.body.appendChild(root);
    app = new AppController(root);
    await app.start();
    const states = record(app, 'tracking-state');
    await openPastedText();
    await until(() => emitFrame !== null, 'the webcam source to subscribe');
    for (let i = 0; i < 10; i++) {
      emitFrame!(frame());
      await sleep(20);
    }
    expect(states.at(-1)?.state).toBe('tracking');
    expect(document.querySelector('.gr-pill')!.getAttribute('aria-label')).toMatch(/Camera on/);

    // The tab goes to the background: frames dry up (throttled), yet nobody is "missing".
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(1600);
    expect(states.map((s) => s.state)).not.toContain('no-face');

    // Back again: a fresh grace period rather than an instant "Looking for you".
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(400);
    expect(states.at(-1)?.state).toBe('tracking');
    // …and the clock really is running again.
    await until(() => states.at(-1)?.state === 'no-face', 'no-face after a real absence', 2500);
  });
});
