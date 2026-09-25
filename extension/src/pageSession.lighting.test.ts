// @vitest-environment jsdom
/**
 * Lighting at the session level: frames from the offscreen document carry
 * lighting numbers; the session compares them (and the eyelids) with the
 * calibration, tells the line tracker to re-learn its offset when they change,
 * offers the quick refresh (rate-limited across tabs), explains an outdated
 * calibration, runs the accuracy check, and keeps the learned offset when that
 * makes sense. jsdom has no layout, so line measurement is stubbed (20 lines,
 * 30 px apart), and the calibration overlay is a stand-in the test resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppEvents,
  AppSettings,
  CalibrationEnvironment,
  CalibrationReport,
  EventBus,
  EventName,
  EyeFeatures,
  FeatureFrame,
  GazeModel,
  LightingStats,
  LineEstimate,
  LineLayout,
  TextLine,
} from '../../src/types';
import type { MeasureOptions } from '../../src/reader/lineGeometry';
import type { AccuracyCheckResult, CalibrationOverlayOptions, CalibrationResult } from '../../src/ui/calibrationOverlay';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { featureSignature } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { buildLightingSignature } from '../../src/gaze/lighting';
import { LineTracker, type TrackedLineEstimate } from '../../src/reading/lineTracker';
import { DebugOverlay } from '../../src/ui/debugOverlay';
import { OUTDATED_CALIBRATION_TEXT } from './calibrationStatus';
import { KEYS, type TouchUpRecord } from './extStorage';
import { PORT_TAB, type HubToTab } from './messages';
import { PagePill, type PillNotice } from './pagePill';
import { HOST_TAG, PageSession, resetKeptTracker, type PageSessionDeps } from './pageSession';
import { FakePort, FakeStorage, flush, portPair } from './testing/fakes';
import { eyeFeatures, linearGazeModel } from './testing/models';
import { zoomAware } from './zoomModel';

const { buses, overlays } = vi.hoisted(() => ({
  buses: [] as EventBus[],
  overlays: [] as { opts: CalibrationOverlayOptions; finish: (r: CalibrationResult | null) => void }[],
}));

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

const PITCH = 30;
vi.mock('../../src/reader/lineGeometry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/reader/lineGeometry')>();
  return {
    ...mod,
    measureLines: (opts: MeasureOptions): LineLayout => {
      const v = opts.viewport;
      const lines: TextLine[] = [];
      for (let i = 0; i < 20; i++) {
        const top = v.top + 100 + i * PITCH;
        lines.push({ index: i, top, bottom: top + 22, left: 100, right: 900, centerY: top + 11, docTop: top - v.top + opts.scrollTop, charCount: 80, fullyVisible: true });
      }
      return {
        lines,
        viewport: v,
        column: { left: 100, right: 900, top: v.top, bottom: v.bottom },
        linePitch: PITCH,
        scrollTop: opts.scrollTop,
        scrollHeight: opts.scrollHeight,
        clientHeight: opts.clientHeight,
        measuredAt: 0,
      };
    },
  };
});

/** The calibration overlay, reduced to what the session sees: options in, a result out when the test says so. */
vi.mock('../../src/ui/calibrationOverlay', () => ({
  CalibrationOverlay: class {
    private finish: ((r: CalibrationResult | null) => void) | null = null;
    constructor(private readonly opts: CalibrationOverlayOptions) {}
    mount(): void {}
    run(): Promise<CalibrationResult | null> {
      return new Promise((resolve) => {
        this.finish = resolve;
        overlays.push({ opts: this.opts, finish: resolve });
      });
    }
    cancel(): void {
      this.finish?.(null);
    }
    destroy(): void {
      this.finish?.(null);
    }
  },
}));

const REPORT: CalibrationReport = { meanErrorPx: 20, meanErrorXPx: 10, meanErrorYPx: 15, perPoint: [], lambda: 1, sampleCount: 100, quality: 'good' };

/** What the overlay reports after the check's "Correct it" (or a tune-up): the old model read `lines` low. */
function checkResult(lines: number): AccuracyCheckResult {
  const before = { meanErrorPx: lines * PITCH, offsetXPx: 0, offsetYPx: lines * PITCH, offsetYLines: lines, targets: 5 };
  return { mode: 'check', before, after: { ...before, meanErrorPx: 8, offsetYPx: 3, offsetYLines: 0.1 }, applied: true, lighting: null, lightingChange: null };
}

/** Collects every payload of `type` emitted on the latest session's bus. */
function record<K extends EventName>(type: K): AppEvents[K][] {
  const seen: AppEvents[K][] = [];
  buses.at(-1)!.on(type, (p) => seen.push(p));
  return seen;
}

const OFFICE: LightingStats = {
  faceLuma: 0.5,
  faceLin: 0.2,
  faceRange: 1.5,
  faceClip: 0,
  frameLin: 0.18,
  bgLin: 0.18,
  bgClip: 0,
  scleraR: 0.3,
  scleraL: 0.3,
  backlight: 1.2,
  side: 0.1,
  shade: -0.8,
  glareR: 0.001,
  glareL: 0.001,
  irisGlintR: 0,
  irisGlintL: 0,
  facePx: 5000,
};
const LAMP: LightingStats = { ...OFFICE, side: 1.4, faceRange: 2.3 };
const WINDOW_BEHIND: LightingStats = { ...OFFICE, backlight: -2.2, bgClip: 0.4 };

const ENVIRONMENT: CalibrationEnvironment = {
  lighting: buildLightingSignature(Array.from({ length: 40 }, () => ({ stats: OFFICE, yaw: 0, pitch: 0 }))),
  appearance: { v: 1, n: 300, opennessAt0: 0.35, opennessSlope: -0.1, opennessResidualSd: 0.012, squintMedian: 0.1, squintSd: 0.03 },
  capturedAt: 1_700_000_000_000,
};

function storedModel(trainedAt = 1_700_000_000_000): unknown {
  return JSON.parse(JSON.stringify(zoomAware(linearGazeModel({ trainedAt, environment: ENVIRONMENT }), () => 1).toJSON())) as unknown;
}

function setup(opts: { settings?: Partial<AppSettings>; calibration?: unknown; storage?: FakeStorage } = {}) {
  const storage = opts.storage ?? new FakeStorage();
  storage.data.set(KEYS.settings, { v: 1, settings: { ...DEFAULT_SETTINGS, gazeSource: 'webcam', ...opts.settings }, origin: 'seed', seq: 1 });
  if (opts.calibration !== undefined) storage.data.set(KEYS.calibration, opts.calibration);
  const hubEnds: FakePort[] = [];
  let contextValid = true;
  const deps: PageSessionDeps = {
    storage,
    connectPort: () => {
      const [tabEnd, hubEnd] = portPair(PORT_TAB);
      hubEnds.push(hubEnd);
      return tabEnd;
    },
    isContextValid: () => contextValid,
    openSetup: () => undefined,
    onEnded: () => undefined,
  };
  let clock = 1_000;
  const hubSend = (msg: HubToTab) => hubEnds.at(-1)!.postMessage(msg);
  /** Streams 30 Hz frames for `ms`; every 5th carries lighting (about 6 Hz, as the offscreen probe does). */
  const stream = async (ms: number, frame: (i: number) => { features?: EyeFeatures; quality?: number; lighting?: LightingStats | null } = () => ({})) => {
    for (let i = 0; i * 33 < ms; i++) {
      clock += 33;
      const f = frame(i);
      const lighting = f.lighting === undefined ? OFFICE : f.lighting;
      const out: FeatureFrame = {
        t: clock,
        faceFound: true,
        quality: f.quality ?? 0.9,
        features: f.features ?? eyeFeatures(0, 0),
        ...(i % 5 === 0 && lighting ? { lighting } : {}),
      };
      hubSend({ type: 'frame', frame: out });
      await vi.advanceTimersByTimeAsync(33);
    }
  };
  const cameraRunning = async () => {
    await flush();
    hubSend({ type: 'camera-status', status: { state: 'running', fps: 30 } });
    await flush(10);
  };
  return {
    storage,
    deps,
    hubEnds,
    hubSend,
    stream,
    cameraRunning,
    invalidate: () => {
      contextValid = false;
    },
  };
}

/** Eyes that read along: fixations of ~300 ms stepping right along the page, then back (a return sweep). */
const reading = (i: number): { features: EyeFeatures } => {
  const step = Math.floor(i / 9) % 8; // 9 frames ≈ 300 ms per fixation
  return { features: eyeFeatures(-3 + step, 0) };
};

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const altShift = (code: string) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { code, altKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true }));

/** Every session a test starts, so a failed assertion can't leave one listening to the next test's keys. */
const live: PageSession[] = [];
async function start(deps: PageSessionDeps): Promise<PageSession> {
  const s = await PageSession.start(deps);
  live.push(s);
  return s;
}

const notices = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([n]) => n as PillNotice | null).filter((n): n is PillNotice => n !== null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = `<article><p>${'Reading is a sequence of fixations and saccades. '.repeat(20)}</p></article>`;
  overlays.length = 0;
  resetKeptTracker();
});

afterEach(() => {
  for (const s of live.splice(0)) s.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.querySelectorAll(HOST_TAG).forEach((el) => el.remove());
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('PageSession lighting', () => {
  it('reports the light once a second; a change makes the tracker re-learn its offset and offers a quick refresh', async () => {
    const t = setup({ calibration: storedModel() });
    const session = await start(t.deps);
    const lightingStates = record('lighting-state');
    const changes = record('appearance-changed');
    const relearn = vi.spyOn(LineTracker.prototype, 'appearanceChangedAt');
    const notify = vi.spyOn(PagePill.prototype, 'notify');
    await t.cameraRunning();

    await t.stream(12_000);
    const steady = lightingStates.length;
    expect(steady).toBeGreaterThanOrEqual(10);
    expect(steady).toBeLessThanOrEqual(13);
    expect(lightingStates.at(-1)).toMatchObject({ flags: [], changedSinceCalibration: false });
    expect(changes).toEqual([]);
    const lampAt = performance.now();

    await t.stream(13_000, () => ({ lighting: LAMP }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ reason: 'lighting' });
    expect(Math.abs(changes[0]!.t - lampAt)).toBeLessThanOrEqual(300);
    expect(relearn).toHaveBeenCalledWith(changes[0]!.t);
    expect(lightingStates.at(-1)).toMatchObject({ changedSinceCalibration: true, dominant: 'side' });

    const offer = notices(notify).find((n) => /A quick 5-dot refresh/.test(n.text))!;
    expect(offer.text).toMatch(/^The light comes from a different side than when you calibrated\./);
    expect(offer.actions?.map((a) => a.label)).toEqual(['Refresh now', 'Not now']);
    await flush();
    const stored = t.storage.data.get(KEYS.touchUp) as TouchUpRecord;
    expect(stored.offeredAt).toBeGreaterThan(0);

    expect(session.extraState()).toEqual({
      lighting: { flags: ['side-lit'], changedSinceCalibration: true, dominant: 'side' },
      canCheck: true,
    });

    offer.actions![1]!.run(); // "Not now"
    await flush();
    expect((t.storage.data.get(KEYS.touchUp) as TouchUpRecord).snoozedUntil).toBeGreaterThan(Date.now() + 29 * 60_000);
    session.destroy();
  });

  it('asks once for every tab: another tab that sees the same change right after stays quiet', async () => {
    const storage = new FakeStorage();
    storage.data.set(KEYS.touchUp, { offeredAt: Date.now() - 60_000, snoozedUntil: 0 });
    const t = setup({ calibration: storedModel(), storage });
    const session = await start(t.deps);
    const changes = record('appearance-changed');
    const notify = vi.spyOn(PagePill.prototype, 'notify');
    await t.cameraRunning();
    await t.stream(12_000);
    await t.stream(13_000, () => ({ lighting: LAMP }));
    expect(changes).toHaveLength(1); // the tracker still re-learns…
    expect(notices(notify).filter((n) => /refresh/.test(n.text))).toEqual([]); // …but nobody asks again
    session.destroy();
  });

  it('offers a light change seen while offers are held back once they may be made again, once (regression: dropped for the episode)', async () => {
    const storage = new FakeStorage();
    // Another tab offered 9.5 minutes ago: nothing more for 30 s.
    storage.data.set(KEYS.touchUp, { offeredAt: Date.now() - (10 * 60_000 - 30_000), snoozedUntil: 0 });
    const t = setup({ calibration: storedModel(), storage });
    const session = await start(t.deps);
    const changes = record('appearance-changed');
    const notify = vi.spyOn(PagePill.prototype, 'notify');
    const offers = () => notices(notify).filter((n) => /A quick 5-dot refresh/.test(n.text));
    await t.cameraRunning();
    await t.stream(12_000);
    await t.stream(13_000, () => ({ lighting: LAMP }));
    expect(changes).toHaveLength(1); // judged changed at ≈ 18–23 s, while offers were held back
    expect(offers()).toEqual([]);
    await t.stream(10_000, () => ({ lighting: LAMP }));
    expect(offers()).toHaveLength(1);
    expect(offers()[0]!.text).toMatch(/^The light comes from a different side than when you calibrated\./);
    await t.stream(5_000, () => ({ lighting: LAMP }));
    expect(offers()).toHaveLength(1); // one per change
    session.destroy();
  });

  it('says what the light is doing wrong when tracking is shaky', async () => {
    const t = setup({ calibration: storedModel() });
    const session = await start(t.deps);
    await t.cameraRunning();
    await t.stream(1_000);
    await t.stream(4_000, () => ({ quality: 0.1, lighting: WINDOW_BEHIND }));
    expect(session.state()).toMatchObject({ tracking: 'poor', detail: 'Shaky: bright light behind you' });
    expect(session.extraState().lighting?.flags).toContain('backlit');
    session.destroy();
  });

  it('shows the eyelid monitor in the debug overlay (Alt+Shift+D)', async () => {
    const shown = vi.spyOn(DebugOverlay.prototype, 'showAppearance');
    const t = setup({ calibration: storedModel(), settings: { showDebugOverlay: true } });
    await start(t.deps);
    await t.cameraRunning();
    await t.stream(5_000);
    expect(shown).toHaveBeenCalled();
    const last = shown.mock.calls.at(-1)![0]!;
    expect(['learning', 'unknown', 'watching']).toContain(last.state);
    expect(Number.isFinite(last.levelVsCalibration)).toBe(true);
  });

  it('explains an outdated calibration instead of silently starting a new one', async () => {
    const legacy = {
      ...(storedModel() as Record<string, unknown>),
      kind: 'gr-ridge-poly2',
      featureLength: 27,
      featureSignature: featureSignature(FEATURE_NAMES.slice(0, 27)),
    };
    const t = setup({ calibration: legacy });
    const session = await start(t.deps);
    const said = record('buddy-say');
    const notify = vi.spyOn(PagePill.prototype, 'notify');
    await t.cameraRunning();
    expect(overlays).toHaveLength(0);
    expect(session.state()).toMatchObject({ tracking: 'paused', detail: 'Recalibrate once (upgraded)', calibrated: false });
    const notice = notices(notify).at(-1)!;
    expect(notice.text).toBe(OUTDATED_CALIBRATION_TEXT);
    expect(said.at(-1)).toMatchObject({ priority: 'high' });
    expect(said.at(-1)!.text).toMatch(/upgrade/);

    notice.actions![0]!.run(); // "Calibrate"
    await flush();
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.opts.mode).toBe('standard');
    expect(session.state().tracking).toBe('calibrating');
    session.destroy();
  });

  it('Alt+Shift+A checks the accuracy of the model in use; nothing changes unless it is corrected', async () => {
    const t = setup({ calibration: storedModel() });
    const session = await start(t.deps);
    const changes = record('appearance-changed');
    await t.cameraRunning();
    await t.stream(2_000, reading);
    const reset = vi.spyOn(LineTracker.prototype, 'reset');

    altShift('KeyA');
    await flush();
    expect(overlays).toHaveLength(1);
    const check = overlays[0]!;
    expect(check.opts.mode).toBe('check');
    const inUse = check.opts.baseModel as GazeModel;
    expect(inUse.trainedAt).toBe(1_700_000_000_000);
    expect(inUse.environment).toEqual(ENVIRONMENT); // through the zoom wrapper
    expect(session.state().tracking).toBe('calibrating');
    expect(session.extraState().canCheck).toBe(false); // already running

    check.finish(null); // "Done": the offset was small, or the reader kept the model
    await flush(10);
    expect(session.state().tracking).toBe('tracking');
    expect(changes).toEqual([]);

    // Again, and this time the reader corrects the offset.
    altShift('KeyA');
    await flush();
    const corrected = linearGazeModel({ trainedAt: 1_700_000_500_000, environment: ENVIRONMENT });
    overlays[1]!.finish({ model: corrected, report: REPORT, check: checkResult(2.1) });
    await flush(10);
    expect((t.storage.data.get(KEYS.calibration) as { trainedAt: number }).trainedAt).toBe(1_700_000_500_000);
    expect(changes).toEqual([expect.objectContaining({ reason: 'refresh' })]); // keep the line, re-learn the offset
    expect(reset).not.toHaveBeenCalled(); // not back to the top of the page
    expect(session.state()).toMatchObject({ tracking: 'tracking', calibrated: true });

    // A check can also end in a full calibration ("Full calibration" on its results): a new model, a fresh start.
    altShift('KeyA');
    await flush();
    overlays[2]!.finish({ model: linearGazeModel({ trainedAt: 1_700_000_600_000, environment: ENVIRONMENT }), report: REPORT });
    await flush(10);
    expect(changes).toHaveLength(1);
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: false, calibrated: true });
    session.destroy();
  });

  it('the accuracy check needs the webcam and a calibration', async () => {
    const mouse = setup({ settings: { gazeSource: 'mouse' }, calibration: storedModel() });
    const s1 = await start(mouse.deps);
    const said = record('buddy-say');
    s1.command('check-accuracy');
    expect(said.at(-1)!.text).toMatch(/webcam/);
    expect(s1.extraState().canCheck).toBe(false);
    s1.destroy();

    const fresh = setup();
    const s2 = await start(fresh.deps);
    await fresh.cameraRunning();
    expect(overlays.map((o) => o.opts.mode)).toEqual(['standard']); // first run: calibration starts by itself
    overlays[0]!.finish(null);
    await flush(10);
    s2.command('check-accuracy'); // nothing to check yet: calibrate instead
    await flush();
    expect(overlays.map((o) => o.opts.mode)).toEqual(['standard', 'standard']);
    s2.destroy();
  });

  it('the quick refresh on offer runs the 5-dot tune-up', async () => {
    const t = setup({ calibration: storedModel() });
    const session = await start(t.deps);
    await t.cameraRunning();
    session.command('touch-up');
    await flush();
    expect(overlays.map((o) => o.opts.mode)).toEqual(['quick']);
    session.destroy();
  });

  it('offers a refresh when the tracker has learned a large offset for a while', async () => {
    const t = setup({ calibration: storedModel() });
    const session = await start(t.deps);
    const notify = vi.spyOn(PagePill.prototype, 'notify');
    await t.cameraRunning();
    // A tracker that is sure the gaze reads 2.2 lines low.
    vi.spyOn(LineTracker.prototype, 'onFixation').mockImplementation((f): LineEstimate => {
      const est: TrackedLineEstimate = {
        t: f.end,
        lineIndex: 8,
        probability: 0.9,
        posterior: [],
        progressX: 0.5,
        lastSaccade: 'forward',
        driftY: 2.2 * PITCH,
        fixationsOnPage: 30,
        sigmaYPx: 25,
        excursions: 0,
        driftSdY: 0.2 * PITCH,
      };
      return est;
    });
    await t.stream(15_000, reading);
    expect(notices(notify).filter((n) => /too low/.test(n.text))).toEqual([]); // not yet: 20 s of evidence
    await t.stream(10_000, reading);
    const offers = notices(notify).filter((n) => /too low/.test(n.text));
    expect(offers).toHaveLength(1);
    expect(offers[0]!.text).toMatch(/^Gaze Reader has been placing your eyes about 2 lines too low\./);
    session.destroy();
  });

  it('keeps the learned offset when the camera comes back or Gaze Reader is turned on again, not after a new calibration', async () => {
    const t = setup({ calibration: storedModel() });
    const session = await start(t.deps);
    await t.cameraRunning();
    await t.stream(3_000, reading); // fixations: the tracker learns under this calibration
    const reset = vi.spyOn(LineTracker.prototype, 'reset');

    setVisibility('hidden');
    setVisibility('visible');
    await t.cameraRunning();
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: true });
    const tracker = reset.mock.contexts.at(-1);

    // Turned off and on again on this page: the same tracker, and what it learned, carries on.
    session.destroy();
    const again = await start(t.deps);
    await t.cameraRunning();
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: true });
    expect(reset.mock.contexts.at(-1)).toBe(tracker);

    // A new calibration: its offset starts from zero.
    await t.stream(1_000, reading);
    again.command('recalibrate');
    await flush();
    overlays.at(-1)!.finish({
      model: linearGazeModel({ trainedAt: 1_700_000_900_000, environment: ENVIRONMENT }),
      report: REPORT,
    });
    await flush(10);
    // Under the light it was just calibrated in: no uniform share in the drift prior either.
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: false, calibrated: true });
    again.destroy();
  });

  it('starts from zero with a different calibration, after a long break, or when the extension went away', async () => {
    const t = setup({ calibration: storedModel() });
    const first = await start(t.deps);
    await t.cameraRunning();
    await t.stream(2_000, reading);
    first.destroy();

    // Another tab calibrated meanwhile.
    t.storage.data.set(KEYS.calibration, storedModel(1_700_000_700_000));
    const reset = vi.spyOn(LineTracker.prototype, 'reset');
    const second = await start(t.deps);
    await t.cameraRunning();
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: false });
    await t.stream(2_000, reading);
    second.destroy();

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const third = await start(t.deps);
    await t.cameraRunning();
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: false });
    await t.stream(2_000, reading);
    t.invalidate();
    third.destroy(); // orphaned: nothing is kept for a copy that can't run again

    const fourth = await start({ ...t.deps, isContextValid: () => true });
    await t.cameraRunning();
    expect(reset).toHaveBeenLastCalledWith({ keepDrift: false });
    fourth.destroy();
  });
});
