// @vitest-environment jsdom
/**
 * Controller integration tests: the real shell and modules, with only what
 * jsdom can't do stubbed (layout measurement, the network, canvas, the camera).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents, AppSettings, EventBus, FeatureFrame, GazeModel, LightingSignature, LineLayout, PageEndDecision, TextLine } from '../types';
import type { AccuracyCheckResult, CalibrationResult } from '../ui/calibrationOverlay';
import { AppearanceMonitor } from '../gaze/appearance';
import { CameraFeatureSource } from '../gaze/faceTracker';
import { LightingWatch, type LightingWatchUpdate } from '../gaze/lighting';
import { LineTracker } from '../reading/lineTracker';
import { parseRecording } from './diagnostics';
import { GuidanceGate, SustainedFlags } from './logic';
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
// The real calibration overlay, except that a test can see which mode it was opened in and
// script its outcome (the dots themselves are the overlay's own tests).
const overlays = vi.hoisted(() => ({
  modes: [] as (string | undefined)[],
  run: null as ((bus: EventBus) => Promise<CalibrationResult | null>) | null,
  check: null as AccuracyCheckResult | null,
}));
vi.mock('../ui/calibrationOverlay', async (importOriginal) => {
  const m = await importOriginal<typeof import('../ui/calibrationOverlay')>();
  class ScriptedOverlay extends m.CalibrationOverlay {
    private readonly testBus: EventBus;
    constructor(opts: ConstructorParameters<typeof m.CalibrationOverlay>[0]) {
      super(opts);
      overlays.modes.push(opts.mode);
      this.testBus = opts.bus;
    }
    override run(): Promise<CalibrationResult | null> {
      return overlays.run ? overlays.run(this.testBus) : super.run();
    }
    override get lastAccuracyCheck(): AccuracyCheckResult | null {
      return overlays.check ?? super.lastAccuracyCheck;
    }
  }
  return { ...m, CalibrationOverlay: ScriptedOverlay };
});

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

/**
 * A stand-in camera. Several listeners, like the real one: the gaze source, and the
 * controller's lighting/eyelid watch and diagnostics.
 */
function stubCamera() {
  let running = false;
  const listeners = new Set<(f: FeatureFrame) => void>();
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
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  });
  return {
    emit: (f: FeatureFrame) => {
      for (const cb of [...listeners]) cb(f);
    },
    subscribers: () => listeners.size,
  };
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
    overlays.modes = [];
    overlays.run = null;
    overlays.check = null;
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
    const camera = stubCamera();
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
    await until(() => camera.subscribers() >= 2, 'the webcam source to subscribe');
    for (let i = 0; i < 10; i++) {
      camera.emit(frame());
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

  it('explains a failed "Open from URL" next to the form, where it stays (regression: an 8 s toast)', async () => {
    document.querySelector<HTMLButtonElement>('.gr-lib-url-toggle')!.click();
    const form = document.querySelector<HTMLFormElement>('.gr-inline-form:not([hidden])')!;
    const input = form.querySelector('input')!;
    input.value = 'https://example.invalid/book.epub';
    form.requestSubmit();
    const error = form.querySelector<HTMLElement>('.gr-field__error')!;
    await until(() => (error.textContent ?? '') !== '', 'the inline error');
    expect(error.textContent).toMatch(/CORS/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(toastText()).not.toMatch(/Couldn’t open that book/);
  });

  it('queues U pressed while a forward turn is still sliding, and undoes it when it lands (regression)', async () => {
    let land: (() => void) | null = null;
    let animating = false;
    vi.spyOn(ReaderView.prototype, 'measureLayout').mockImplementation(() => layout(false));
    vi.spyOn(ScrollController.prototype, 'atEnd').mockReturnValue(false);
    vi.spyOn(ScrollController.prototype, 'animating', 'get').mockImplementation(() => animating);
    vi.spyOn(ScrollController.prototype, 'turnPage').mockImplementation(() => {
      animating = true;
      app.bus.emit('page-turn', { from: 0, to: 836, auto: true, reason: 'line-tracker', pageIndex: 1 });
      return new Promise<void>((resolve) => {
        land = () => {
          animating = false;
          resolve();
        };
      });
    });
    const undo = vi.spyOn(ScrollController.prototype, 'undo').mockResolvedValue(true);
    await openPastedText();
    const scroller = document.querySelector<HTMLElement>('.gr-reader')!;
    const key = (k: string) => scroller.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    key(' ');
    key('u'); // mid-turn
    key('u'); // held: still only one undo
    expect(undo).not.toHaveBeenCalled();
    land!();
    await until(() => undo.mock.calls.length > 0, 'the queued undo');
    await sleep(50);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(toastText()).not.toMatch(/no page turn to undo/);
  });

  it('forgets undo positions when the text reflows (font size), instead of jumping to unrelated text', async () => {
    await openPastedText();
    const clear = vi.spyOn(ScrollController.prototype, 'clearHistory');
    app.bus.emit('settings-patch', { fontSizePx: 26 });
    expect(clear).toHaveBeenCalled();
    const scroller = document.querySelector<HTMLElement>('.gr-reader')!;
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true }));
    await until(() => /no page turn to undo/.test(toastText()), 'the nothing-to-undo toast');
  });

  it('stops counting reading time when a mouse pointer is left resting (regression)', async () => {
    const realNow = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    const breaks = record(app, 'break-due');
    await openPastedText();
    const gaze = record(app, 'gaze');
    moveMouse(400, 300);
    await until(() => gaze.length > 3, 'mouse samples');
    const minutes = (): number => {
      const session = app['session'];
      if (!session) throw new Error('no session');
      return session.clock.minutes;
    };
    // A minute later with no input, while the resting pointer still yields valid samples.
    offset += 61_000;
    await sleep(400);
    const before = minutes();
    const samples = gaze.length;
    await sleep(700);
    expect(gaze.length).toBeGreaterThan(samples);
    expect(minutes()).toBe(before);
    expect(breaks).toHaveLength(0);
    // Moving the pointer again counts as reading.
    moveMouse(420, 320);
    await sleep(600);
    expect(minutes()).toBeGreaterThan(before);
  });

  it('lands focus on "Choose a file" when the first-run intro is skipped (it opened on page load)', async () => {
    app.destroy();
    localStorage.removeItem('gazeReader.onboarding.v1');
    root = document.createElement('div');
    document.body.appendChild(root);
    app = new AppController(root);
    const started = app.start();
    await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Skip intro' && !b.closest('[hidden]')), 'the intro');
    const skip = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Skip intro' && !b.closest('[hidden]'))!;
    skip.click();
    await started;
    expect(document.activeElement).toBe(document.querySelector('.gr-lib-choose'));
  });

  it('a stale "Refresh now" toast can’t stop the mouse source the reader switched to (regression)', async () => {
    app.destroy();
    const width = window.innerWidth;
    saved.model = {
      predict: () => ({ x: 500, y: 400 }),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      trainedAt: Date.now(),
      toJSON: () => ({ version: 1 }),
    };
    const camera = stubCamera();
    localStorage.setItem('gazeReader.settings.v1', JSON.stringify({ gazeSource: 'webcam', buddyEnabled: false }));
    root = document.createElement('div');
    document.body.appendChild(root);
    app = new AppController(root);
    await app.start();
    const states = record(app, 'tracking-state');
    await openPastedText();
    await until(() => camera.subscribers() >= 2, 'the webcam source to subscribe');
    await until(() => states.at(-1)?.state !== undefined && states.at(-1)?.state !== 'off', 'the webcam to run');
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: Math.round(width * 0.6) });
      window.dispatchEvent(new Event('resize'));
      await until(() => /Window size changed/.test(toastText()), 'the refresh suggestion');
      const refresh = [...document.querySelectorAll<HTMLButtonElement>('.gr-toast__actions button')].find((b) => b.textContent === 'Refresh now')!;
      const gaze = record(app, 'gaze');
      app.bus.emit('settings-patch', { gazeSource: 'mouse' });
      expect(toastText()).not.toMatch(/Window size changed/); // withdrawn with the webcam session
      refresh.click(); // a click that raced the dismissal
      moveMouse(400, 300);
      await until(() => gaze.some((g) => g.source === 'mouse'), 'mouse samples');
      await sleep(100);
      const count = gaze.length;
      moveMouse(420, 310);
      await until(() => gaze.length > count, 'more mouse samples');
      expect(states.at(-1)?.state).not.toBe('off');
      expect(document.querySelector('.gr-pill')!.textContent).not.toMatch(/Camera off/);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
  // ───────────────────────── Lighting, guidance, accuracy check, diagnostics ─────────────────────────

  const SIGNATURE: LightingSignature = {
    v: 1,
    n: 30,
    yaw: 0,
    pitch: 0.05,
    c: { sclera: -1.3, backlight: 0.2, side: 0, shade: -0.3, glare: 0.1, range: 1.2 },
    sd: { sclera: 0.05, backlight: 0.05, side: 0.05, shade: 0.05, glare: 0.05, range: 0.05 },
  };
  const REPORT = { meanErrorPx: 40, meanErrorXPx: 20, meanErrorYPx: 30, perPoint: [], lambda: 1, sampleCount: 100, quality: 'good' as const };

  /** A saved calibration that predicts (500, 400); its JSON has a ridge core, so a refresh of it can be recognised. */
  function calibratedModel(opts: { trainedAt?: number; adjustOy?: number } = {}): GazeModel {
    const core = { version: 1, kind: 'gr-ridge-poly2-iris5', featureLength: FEATURE_NAMES.length, mean: [0], std: [1], quad: [], expMean: [0], expStd: [1], wx: [1], bx: 0, wy: [1], by: 0, lambda: 1 };
    return {
      predict: () => ({ x: 500, y: 400 }),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      trainedAt: opts.trainedAt ?? 1000,
      environment: { lighting: SIGNATURE, appearance: null, capturedAt: 1000 },
      toJSON: () => ({ ...core, adjust: { sx: 1, ox: 0, sy: 1, oy: opts.adjustOy ?? 0 } }),
    };
  }

  const webcamFrame = (): FeatureFrame => ({
    t: performance.now(),
    faceFound: true,
    quality: 0.9,
    features: {
      vector: new Array<number>(FEATURE_NAMES.length).fill(0),
      headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 },
      blink: 0,
      openness: 0.3,
      squint: 0.1,
      faceScale: 0.12,
      faceCenter: { x: 0.5, y: 0.5 },
    },
  });

  /** Rebuilds the app on the webcam with `model` saved, opens a book and waits for tracking to run. */
  async function readWithWebcam(model: GazeModel | null, opts: { open?: boolean; settings?: Partial<AppSettings> } = {}) {
    app.destroy();
    saved.model = model;
    const camera = stubCamera();
    localStorage.setItem('gazeReader.settings.v1', JSON.stringify({ gazeSource: 'webcam', buddyEnabled: false, ...opts.settings }));
    root = document.createElement('div');
    document.body.appendChild(root);
    app = new AppController(root);
    await app.start();
    const states = record(app, 'tracking-state');
    if (opts.open !== false) {
      await openPastedText();
      if (model) {
        await until(() => camera.subscribers() >= 2, 'the webcam source to subscribe');
        await until(() => states.some((s) => s.state === 'tracking' || s.state === 'no-face'), 'tracking to run');
      }
    }
    return { camera, states };
  }

  const pressKey = (key: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.querySelector<HTMLElement>('.gr-reader')!.dispatchEvent(e);
    return e;
  };

  const toastButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.gr-toast__actions button')].find((b) => b.textContent === label);

  it('webcam: reports the light every second; a changed light re-learns the reading offset and offers a touch-up at a pause', async () => {
    let next: LightingWatchUpdate | null = null;
    const tick = vi.spyOn(LightingWatch.prototype, 'tick').mockImplementation(() => {
      const u = next;
      next = null;
      return u;
    });
    const reference = vi.spyOn(LightingWatch.prototype, 'setReference');
    vi.spyOn(GuidanceGate.prototype, 'mayOffer').mockReturnValue(true);
    vi.spyOn(GuidanceGate.prototype, 'isPause').mockReturnValue(true);
    const relearn = vi.spyOn(LineTracker.prototype, 'appearanceChangedAt');
    const { camera } = await readWithWebcam(calibratedModel());
    expect(reference).toHaveBeenCalledWith(SIGNATURE); // the calibration's light is the reference
    const states = record(app, 'lighting-state');
    const changes = record(app, 'appearance-changed');
    const says = record(app, 'buddy-say');
    await until(() => tick.mock.calls.length > 0, 'the lighting watch to tick');
    for (let i = 0; i < 3; i++) camera.emit(webcamFrame());

    const changedAt = performance.now() - 4000;
    const z = { sclera: 1.3, backlight: 0, side: 0, shade: 0, glare: 0.5, range: 0 };
    next = {
      state: { flags: ['glare'], distance: 1.4, changedSinceCalibration: true, dominant: 'sclera' },
      comparison: { distance: 1.4, dominant: 'sclera', z },
      transition: 'changed',
      changedAt,
    };
    await until(() => changes.length > 0, 'the appearance change');
    expect(changes[0]).toMatchObject({ t: changedAt, reason: 'lighting' });
    expect(relearn).toHaveBeenCalledWith(changedAt);
    expect(states.at(-1)).toMatchObject({ flags: ['glare'], changedSinceCalibration: true, dominant: 'sclera' });
    await until(() => /The light changed/.test(toastText()), 'the touch-up offer');
    expect(toastText()).toMatch(/A quick 5-dot refresh keeps page turns accurate/);
    expect(says.some((s) => /light/i.test(s.text))).toBe(true);

    // The same change seen again (the eyelids, a moment later) is not re-learned twice.
    next = { state: states.at(-1)!, comparison: null, transition: 'changed', changedAt: changedAt + 1000 };
    await until(() => next === null, 'another tick');
    await sleep(50);
    expect(changes).toHaveLength(1);

    // Changed again while already changed (a lamp, then the overhead light off): the bias moved
    // again, so the offset is re-learned once more.
    const againAt = changedAt + 20_000;
    next = { state: states.at(-1)!, comparison: null, transition: 'changed-again', changedAt: againAt };
    await until(() => changes.length > 1, 'the second appearance change');
    expect(changes[1]).toMatchObject({ t: againAt, reason: 'lighting' });
    expect(changes[1]!.detail).toMatch(/again/);
    expect(relearn).toHaveBeenCalledWith(againAt);

    // "Refresh now" runs the quick 5-dot refresh.
    overlays.run = async (bus) => {
      bus.emit('calibration', { phase: 'start' });
      bus.emit('calibration', { phase: 'cancelled' });
      return null;
    };
    toastButton('Refresh now')!.click();
    await until(() => overlays.modes.length > 0, 'the touch-up');
    expect(overlays.modes).toEqual(['quick']);
  });

  it('webcam: the eyelid monitor sees the lid-free gaze height, and a lid change re-learns the offset once', async () => {
    const update = vi.spyOn(AppearanceMonitor.prototype, 'update');
    const baseline = vi.spyOn(AppearanceMonitor.prototype, 'setBaseline');
    const { camera } = await readWithWebcam(calibratedModel());
    expect(baseline).toHaveBeenCalledWith(null, SIGNATURE.pitch);
    const changes = record(app, 'appearance-changed');
    camera.emit(webcamFrame());
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ gazeYNorm: 400 / window.innerHeight, quality: 0.9 }));
    update.mockImplementationOnce((input) => ({
      t: input.t - 2000,
      reason: 'lids',
      detail: 'narrower',
      detectedAt: input.t,
      direction: 'narrower',
      channel: 'openness',
      z: -4.2,
      squintZ: null,
      relativeShift: -0.1,
    }));
    camera.emit(webcamFrame());
    expect(changes).toHaveLength(1);
    expect(changes[0]!.reason).toBe('lids');
    expect(changes[0]!.detail).toMatch(/narrower/);
  });

  it('keeps the learned drift when a book is reopened with the same source, and re-learns it for another', async () => {
    const reset = vi.spyOn(LineTracker.prototype, 'reset');
    const relearn = vi.spyOn(LineTracker.prototype, 'appearanceChangedAt');
    await openPastedText();
    expect(reset.mock.calls.at(-1)).toEqual([{}]); // first book: start from "calibration is about right"
    app.bus.emit('command', { name: 'open-library' });
    await until(() => document.documentElement.dataset.screen === 'library', 'the library');
    await openPastedText();
    expect(reset.mock.calls.at(-1)).toEqual([{ keepDrift: true }]);
    // Switching to the demo mid-book: the mouse's offset doesn't apply to it.
    const before = relearn.mock.calls.length;
    app.bus.emit('settings-patch', { gazeSource: 'simulated' });
    await until(() => relearn.mock.calls.length > before, 'the offset to be re-learned');
  });

  it('A runs the accuracy check on the webcam and sums up the result; elsewhere it explains', async () => {
    await openPastedText();
    expect(pressKey('a').defaultPrevented).toBe(true);
    expect(toastText()).toMatch(/accuracy check is for eye tracking/);
    expect(overlays.modes).toEqual([]);

    await readWithWebcam(calibratedModel());
    const says = record(app, 'buddy-say');
    overlays.check = {
      mode: 'check',
      before: { meanErrorPx: 104, offsetXPx: 4, offsetYPx: 2.5 * 42, offsetYLines: 2.5, targets: 5 },
      after: { meanErrorPx: 30, offsetXPx: 0, offsetYPx: 2, offsetYLines: 0.05, targets: 5 },
      applied: false,
      lighting: SIGNATURE,
      lightingChange: { distance: 1.6, changed: true, dominant: 'sclera', text: 'your eyes are more brightly lit' },
    };
    overlays.run = async (bus) => {
      bus.emit('calibration', { phase: 'start' });
      bus.emit('calibration', { phase: 'done' });
      return null; // "Done": the model is unchanged
    };
    pressKey('a');
    await until(() => /Tracking has drifted/.test(toastText()), 'the check result');
    expect(overlays.modes).toEqual(['check']);
    // The overlay's words and rounding ("about 3 lines low" for 2.5), not a second opinion.
    expect(toastText()).toMatch(
      /Tracking reads about 3 lines low\. A quick 5-dot refresh re-centres it\. The light has changed since calibration: your eyes are more brightly lit\./,
    );
    expect(toastButton('Refresh now')).toBeDefined();
    expect(says.some((s) => /lines off|5-dot refresh/.test(s.text))).toBe(true);
    // Tracking goes on with the same model.
    await until(() => document.querySelector('.gr-pill')!.getAttribute('aria-label')!.includes('Camera on'), 'tracking again');
  });

  it('an applied accuracy-check correction keeps the line and re-learns the offset (no fresh start)', async () => {
    await readWithWebcam(calibratedModel());
    const reset = vi.spyOn(LineTracker.prototype, 'reset');
    const changes = record(app, 'appearance-changed');
    const refined = calibratedModel({ trainedAt: 2000, adjustOy: -105 });
    overlays.check = {
      mode: 'check',
      before: { meanErrorPx: 110, offsetXPx: 4, offsetYPx: 105, offsetYLines: 2.5, targets: 5 },
      after: null,
      applied: true,
      lighting: SIGNATURE,
      lightingChange: null,
    };
    overlays.run = async (bus) => {
      bus.emit('calibration', { phase: 'start' });
      bus.emit('calibration', { phase: 'done', report: REPORT });
      return { model: refined, report: REPORT, check: overlays.check! };
    };
    pressKey('a');
    await until(() => changes.some((c) => c.reason === 'refresh'), 'the refresh to reach the reading layer');
    await until(() => /Tracking corrected/.test(toastText()), 'the result');
    expect(toastText()).toMatch(/Tracking read about 3 lines low\. That’s fixed now\./);
    expect(reset).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('gazeReader.calibration.v1')!)).toMatchObject({ adjust: { oy: -105 } });
    // A full calibration, by contrast, starts the line tracker over.
    overlays.check = null;
    overlays.run = async (bus) => {
      bus.emit('calibration', { phase: 'start' });
      bus.emit('calibration', { phase: 'done', report: REPORT });
      return { model: { ...calibratedModel({ trainedAt: 3000 }), toJSON: () => ({ version: 1, kind: 'gr-ridge-poly2-iris5', wx: [2], wy: [3] }) }, report: REPORT };
    };
    app.bus.emit('command', { name: 'recalibrate' });
    await until(() => reset.mock.calls.length > 0, 'a fresh start');
    // Under the light it was just calibrated in: no uniform share in the drift prior.
    expect(reset.mock.calls.at(-1)).toEqual([{ calibrated: true }]);
  });

  it('asks before redoing a previous tracker’s calibration, and explains it once (regression: a minute of dots, unannounced, over the toast)', async () => {
    localStorage.setItem('gazeReader.calibration.v1', JSON.stringify({ version: 1, kind: 'gr-ridge-poly2', featureLength: 27 }));
    overlays.run = async (bus) => {
      bus.emit('calibration', { phase: 'start' });
      bus.emit('calibration', { phase: 'cancelled' });
      return null;
    };
    await readWithWebcam(null, { open: false }); // Dewey hidden: the toast is all the reader sees
    const cameraStart = vi.mocked(CameraFeatureSource.prototype.start);
    const says = record(app, 'buddy-say');
    await openPastedText();
    await until(() => /Please recalibrate once/.test(toastText()), 'the explanation');
    expect(toastText()).toMatch(/copes better with changing light/);
    await sleep(100);
    expect(overlays.modes).toEqual([]); // no calibration behind the reader's back…
    expect(cameraStart).not.toHaveBeenCalled(); // …and no camera switched on for nothing
    expect(says.filter((s) => /handle changing light better/.test(s.text))).toHaveLength(1);

    // "Calibrate" starts the full calibration at once, without explaining again.
    toastButton('Calibrate')!.click();
    await until(() => overlays.modes.length > 0, 'the calibration');
    expect(overlays.modes).toEqual(['standard']);
    expect(says.filter((s) => /handle changing light better/.test(s.text))).toHaveLength(1);
    // Cancelled: the reason is still given.
    await until(() => /Please recalibrate once/.test(toastText()), 'the not-calibrated toast');

    // Next visit: calibrating is still needed and starts right away; the explanation isn't repeated.
    await readWithWebcam(null, { open: false });
    const again = record(app, 'buddy-say');
    await openPastedText();
    await until(() => overlays.modes.length > 1, 'the second calibration');
    await sleep(50);
    expect(again.filter((s) => /handle changing light better/.test(s.text))).toHaveLength(0);
  });

  it('webcam: a light change while the book is settling in is offered once the gate opens, once per change (regression: dropped for the session)', async () => {
    const realNow = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    let changed = false;
    let transition: LightingWatchUpdate['transition'] = null;
    vi.spyOn(LightingWatch.prototype, 'tick').mockImplementation(() => {
      const t = transition;
      transition = null;
      return {
        state: { flags: [], distance: changed ? 1.4 : 0.2, changedSinceCalibration: changed, dominant: changed ? 'sclera' : null },
        comparison: null,
        transition: t,
        changedAt: t === 'changed' ? performance.now() - 4000 : null,
      };
    });
    const mayOffer = vi.spyOn(GuidanceGate.prototype, 'mayOffer'); // the real gate, watched
    await readWithWebcam(calibratedModel());
    const offers = (): number => (/The light changed/.test(toastText()) ? 1 : 0);

    // +10 s after opening the book the light is judged changed: too early (the book settles for 20 s).
    offset += 10_000;
    changed = true;
    transition = 'changed';
    await until(() => mayOffer.mock.results.some((r) => r.value === false), 'the gate to hold the offer back');
    await sleep(600);
    expect(offers()).toBe(0);

    // +21 s: the first pause (there's no reading at all here) brings the offer.
    offset += 11_000;
    await until(() => offers() === 1, 'the offer');
    expect(toastText()).toMatch(/A quick 5-dot refresh keeps page turns accurate/);
    toastButton('Not now')!.click();
    await until(() => offers() === 0, 'the offer to go');

    // Snooze and interval over, same light: that change has had its offer.
    offset += 31 * 60_000;
    const asked = mayOffer.mock.calls.length;
    await sleep(800);
    expect(offers()).toBe(0);
    expect(mayOffer.mock.calls.length).toBe(asked); // not even requested

    // The light goes back, then changes again: a new change, a new offer.
    changed = false;
    transition = 'restored';
    await sleep(400);
    changed = true;
    transition = 'changed';
    await until(() => offers() === 1, 'the second offer');
  });

  it('webcam: light coaching reaches a reader who set Dewey to quiet, as a message (regression: silently lost)', async () => {
    vi.spyOn(LightingWatch.prototype, 'tick').mockImplementation(() => ({
      state: { flags: ['backlit'], distance: 0.2, changedSinceCalibration: false, dominant: null },
      comparison: null,
      transition: null,
      changedAt: null,
    }));
    vi.spyOn(SustainedFlags.prototype, 'update').mockImplementation((_t, flags) => [...flags]);
    vi.spyOn(GuidanceGate.prototype, 'isPause').mockReturnValue(true);
    const backlit = /bright light behind you/;
    for (const [buddyChattiness, viaDewey] of [
      ['quiet', false],
      ['normal', true],
    ] as const) {
      await readWithWebcam(calibratedModel(), { settings: { buddyEnabled: true, buddyChattiness } });
      const says = record(app, 'buddy-say');
      if (viaDewey) {
        await until(() => says.some((s) => backlit.test(s.text)), 'Dewey’s line');
        expect(toastText()).not.toMatch(backlit);
      } else {
        await until(() => backlit.test(toastText()), 'the message');
        expect(says.some((s) => backlit.test(s.text))).toBe(false);
      }
    }
  });

  it('records tracking diagnostics from Settings and saves them as a JSON file (numbers only)', async () => {
    let blob: Blob | null = null;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (b: Blob) => {
        blob = b;
        return 'blob:test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await openPastedText();
    const gaze = record(app, 'gaze');
    app.bus.emit('command', { name: 'open-settings' });
    const recordBtn = document.querySelector<HTMLButtonElement>('.gr-settings__record')!;
    recordBtn.click();
    expect(document.querySelector<HTMLElement>('.gr-rec-chip')!.hidden).toBe(false);
    app.bus.emit('command', { name: 'close-settings' });
    for (let i = 0; i < 6; i++) {
      moveMouse(300 + 20 * i, 200);
      await sleep(40);
    }
    await until(() => gaze.length > 3, 'gaze samples');
    app.bus.emit('command', { name: 'open-settings' });
    recordBtn.click(); // stop and download
    expect(click).toHaveBeenCalledTimes(1);
    expect(blob).not.toBeNull();
    const rec = parseRecording(JSON.parse(await blob!.text()) as unknown)!;
    expect(rec).not.toBeNull();
    expect(rec.stoppedBy).toBe('user');
    expect(rec.settings.gazeSource).toBe('mouse');
    expect(rec.inputs.some((e) => e.k === 'gaze' && e.src === 'mouse' && e.fed === 1)).toBe(true);
    expect(rec.inputs.some((e) => e.k === 'gaze' && e.fed === 0)).toBe(true); // while Settings was open
    expect(rec.inputs.some((e) => e.k === 'layout')).toBe(true);
    expect(rec.environment.userAgent.length).toBeGreaterThan(0);
    expect(document.querySelector<HTMLElement>('.gr-rec-chip')!.hidden).toBe(true);
    expect(toastText()).toMatch(/Diagnostics saved/);
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });
});
