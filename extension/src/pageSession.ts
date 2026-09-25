/**
 * Gaze Reader running on one web page: the in-page twin of the app controller.
 *
 * Owns a single shadow-DOM host holding every piece of UI (Dewey, gaze dot,
 * debug overlay, calibration, status pill), the reading pipeline
 * (fixations → line tracker → page-end detector → scroll controller), and the
 * gaze source (webcam frames relayed from the offscreen document, or the
 * mouse). `destroy()` releases the camera and removes every listener, timer
 * and element it created.
 *
 * Lighting: the frames carry lighting numbers from the offscreen document.
 * ConditionsWatch compares them, and the eyelids, with calibration; a change
 * becomes 'appearance-changed' (the line tracker re-learns its vertical
 * offset) and, rate-limited across tabs, an offer of the quick 5-dot refresh.
 * A large offset the tracker has learned leads to the same offer. The
 * accuracy check (popup, Alt+Shift+A) measures the offset on 5 dots and can
 * correct it.
 */
import type {
  AppSettings,
  CommandName,
  FeatureFrame,
  GazeSample,
  GazeSource,
  LayoutChangeReason,
  LineEstimate,
  LineLayout,
  Mountable,
  SpeechPriority,
  BuddyMood,
  TrackingState,
  Unsubscribe,
} from '../../src/types';
import { createEventBus } from '../../src/core/events';
import { createSettingsStore, type SettingsStore } from '../../src/core/settings';
import { IGNORE_ATTR } from '../../src/core/constants';
import { WebcamGazeSource } from '../../src/gaze/webcamGazeSource';
import { MouseGazeSource } from '../../src/gaze/mouseGazeSource';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { CalibrationOverlay, type CalibrationMode } from '../../src/ui/calibrationOverlay';
import { FixationDetector } from '../../src/signal/fixations';
import { LineTracker } from '../../src/reading/lineTracker';
import { PageEndDetector, lastFullyVisibleLine } from '../../src/reading/pageEndDetector';
import { measureLines } from '../../src/reader/lineGeometry';
import { ScrollController } from '../../src/reader/scrollController';
import { Buddy } from '../../src/buddy/buddy';
import { GazeDot } from '../../src/ui/gazeDot';
import { DebugOverlay } from '../../src/ui/debugOverlay';
import { Disposer, debounce, throttle } from './disposer';
import {
  KEYS,
  isSerializedGazeModel,
  loadCalibrationJSON,
  loadExtSettings,
  loadSettings,
  loadTouchUpRecord,
  makeOrigin,
  parseExtSettings,
  parseTouchUpRecord,
  saveCalibrationJSON,
  saveTouchUpRecord,
  syncSettings,
  watchKey,
  type ExtSettings,
  type ExtStorage,
  type TouchUpRecord,
} from './extStorage';
import { MODEL_COMPAT, OUTDATED_CALIBRATION_TEXT, calibrationStatus, type CalibrationStatus } from './calibrationStatus';
import { ConditionsWatch, type ConditionsUpdate, type LightingChange, type LightingState } from './conditions';
import { lightingTip } from './lightingTips';
import { findMainContent } from './findMainContent';
import type { PageCommand, PageState } from './messages';
import type { PageExtraCommand, PageExtraState } from './pageExtras';
import { findScroller, isWindow, readingViewport, scrollMetrics, type Scroller } from './pageGeometry';
import {
  PageModeMonitor,
  buildPseudoLayout,
  findPageModeScroller,
  largestVisualRect,
  modeLineCount,
  pressPageKeys,
  resolvePageTurn,
  type PageTurnVia,
  type ReadingMode,
} from './pageMode';
import { PagePill } from './pagePill';
import type { PortLike } from './ports';
import { RemoteFeatureSource, RemoteTrackerError, type RemoteSourceStatus } from './remoteFeatureSource';
import { isTypingContext, matchShortcut, type ShortcutAction } from './shortcuts';
import { TouchUpAdvisor, type TouchUpOffer } from './touchUp';
import { zoomAware, zoomAwareFromJSON, type ZoomAwareGazeModel } from './zoomModel';

export const HOST_TAG = 'gaze-reader-root';
/** The host must sit above everything the page draws; our components order themselves inside it with Z.*. */
const HOST_Z_INDEX = '2147483647';
/** Grace beyond scrollDurationMs before a stalled page-turn animation is finished instantly. */
const SCROLL_RESCUE_MS = 1_500;
/** Tracking-state detail while the webcam waits for a first calibration. */
const NOT_CALIBRATED = 'Not calibrated yet';
/** …or for a new one, because the stored calibration came from an older Gaze Reader. */
const CALIBRATION_OUTDATED = 'Recalibrate once (upgraded)';
/**
 * The line tracker's learned gaze offset is carried over (softened) when the
 * camera restarts or Gaze Reader is turned on again on this page, with the
 * same calibration, if it last learned within this long. Longer breaks are
 * likely to come with different light or posture.
 */
const KEEP_DRIFT_MS = 30 * 60_000;
/** How long a quick-refresh offer stays up if the reader ignores it. */
const TOUCH_UP_NOTICE_MS = 30_000;
/** How often Dewey hears how far through the page the reader is. */
const PROGRESS_EVERY_MS = 5_000;
/**
 * Confidence must stay low this long before the pill says "shaky": the blink score rises as the
 * lids lower to read the last lines, so every page end dips it for a moment.
 */
const POOR_AFTER_MS = 2_500;

/**
 * Dewey explains page mode once per page load, however often the reader turns
 * Gaze Reader off and on (the content script, and this module, live as long as the page).
 */
let pageModeExplained = false;

/** Tests: forget that Dewey already explained page mode on this "page load". */
export function resetPageModeNotice(): void {
  pageModeExplained = false;
}

/** Which calibration a line tracker's learned drift belongs to, and when it last learned (performance.now()). */
interface DriftOwner {
  trainedAt: number;
  at: number;
}

/**
 * The line tracker of the last webcam session on this page. Turning Gaze
 * Reader off and on again (same page, same calibration, within KEEP_DRIFT_MS)
 * then starts from the gaze offset it had learned instead of from zero.
 */
let keptTracker: { tracker: LineTracker; owner: DriftOwner } | null = null;

/** Tests: forget the tracker kept from an earlier session on this "page load". */
export function resetKeptTracker(): void {
  keptTracker = null;
}

function takeKeptTracker(model: ZoomAwareGazeModel | null): { tracker: LineTracker; owner: DriftOwner } | null {
  const kept = keptTracker;
  keptTracker = null;
  if (!kept || !model || kept.owner.trainedAt !== model.trainedAt) return null;
  return performance.now() - kept.owner.at < KEEP_DRIFT_MS ? kept : null;
}

export interface PageSessionDeps {
  storage: ExtStorage;
  /** Opens the port to the service worker for camera frames. */
  connectPort: () => PortLike;
  isContextValid: () => boolean;
  /** Ask the service worker to open (or focus) the camera setup page. */
  openSetup: () => void;
  /** The session ended itself: the reader clicked "off", or the extension went away. */
  onEnded: (reason: 'user' | 'orphaned') => void;
}

type SourceKind = 'webcam' | 'mouse';

const HOST_CSS = `
:host {
  --gr-bg: #fffaf3; --gr-fg: #2b1d14; --gr-muted: #7a6656; --gr-accent: #c2410c; --gr-accent-fg: #ffffff;
  --gr-surface: #fffaf3; --gr-border: rgba(43, 29, 20, .14); --gr-shadow: 0 8px 28px rgba(43, 29, 20, .18);
  --gr-font-reading: Charter, "Iowan Old Style", Georgia, serif;
  --gr-font-ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--gr-fg); font: 14px/1.4 var(--gr-font-ui); color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :host {
    --gr-bg: #1c1612; --gr-fg: #f3e9df; --gr-muted: #b9a797; --gr-accent: #fb923c; --gr-accent-fg: #1c1612;
    --gr-surface: #2a211b; --gr-border: rgba(243, 233, 223, .16); --gr-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  }
}
`;

const CAMERA_ERROR_TEXT: Record<string, string> = {
  'camera-denied': 'Gaze Reader needs permission to use your camera. The setup tab explains why.',
  'no-camera': "I couldn't find a camera. Plug one in, or read with the mouse.",
  'camera-in-use': 'Another app is using the camera. Close it and try again.',
  'model-load-failed': "Couldn't download the face-tracking model. Are you offline?",
  'insecure-context': 'The camera is not available here.',
};

export class PageSession {
  static async start(deps: PageSessionDeps): Promise<PageSession> {
    const [settings, calibration, ext, touchUp] = await Promise.all([
      loadSettings(deps.storage.area),
      loadCalibrationJSON(deps.storage.area),
      loadExtSettings(deps.storage.area),
      loadTouchUpRecord(deps.storage.area),
    ]);
    const model = calibration ? zoomAwareFromJSON(calibration, MODEL_COMPAT) : null;
    const session = new PageSession(deps, settings, ext, model, calibrationStatus(calibration), touchUp);
    try {
      session.boot();
    } catch (err) {
      session.destroy(); // whatever boot() managed to set up
      throw err;
    }
    return session;
  }

  private readonly deps: PageSessionDeps;
  private readonly d = new Disposer();
  private readonly bus = createEventBus();
  private readonly store: SettingsStore;
  private readonly getSettings = (): AppSettings => this.store.get();

  private root!: ShadowRoot;
  private pill!: PagePill;
  private gazeDot: GazeDot | null = null;
  private debugOverlay: DebugOverlay | null = null;

  private readonly fixations = new FixationDetector();
  private readonly tracker: LineTracker;
  /** Which calibration the tracker's learned drift belongs to (null: none learned under the webcam). */
  private driftOwner: DriftOwner | null = null;
  private readonly pageEnd: PageEndDetector;
  private scroll: ScrollController | null = null;
  private scroller: Scroller | null = null;
  private scrollerDisposer: Disposer | null = null;
  private main: HTMLElement = document.body;
  private mainObservers: Disposer | null = null;
  private href = location.href;
  private layout: LineLayout | null = null;
  private ext: ExtSettings;
  /** Text mode follows measured lines; page mode (no measurable text) watches the bottom edge. */
  private readonly modeMonitor = new PageModeMonitor();
  private readingMode: ReadingMode = 'text';
  /** Page turns the current scroll controller did not count: key presses, and turns by earlier scrollers. */
  private otherTurns = 0;

  private model: ZoomAwareGazeModel | null;
  private remote: RemoteFeatureSource | null = null;
  private gaze: GazeSource | null = null;
  private offGaze: Unsubscribe | null = null;
  private sourceKind: SourceKind | null = null;
  private sourceGen = 0;
  private cameraRunning = false;
  /** What the stored calibration was when this session started (or changed): 'outdated' gets explained. */
  private calibrationState: CalibrationStatus;
  private calibration: CalibrationOverlay | null = null;
  private calibrationInterrupted = false;
  private calibrationDeclined = false;
  /** What to run once the camera is running: a (re)calibration, or the accuracy check / quick refresh. */
  private runWhenReady: CalibrationMode | null = null;
  private awaitingPermission = false;

  /** Lighting and eyelids compared with calibration (webcam only). */
  private readonly conditions: ConditionsWatch;
  private lighting: LightingState | null = null;
  /** What moved when the light last changed since calibration (for the offer's wording); null while it hasn't. */
  private lightingChange: LightingChange | null = null;
  private readonly touchUp: TouchUpAdvisor;

  /** Tracking state before the reader's pause is applied. */
  private base: TrackingState = 'starting';
  private detail: string | null = null;
  private shown: TrackingState | null = null;
  private shownDetail: string | null = null;
  private paused = false;
  private hidden = document.visibilityState === 'hidden';
  private turning = false;
  private ignoreScrollUntil = 0;
  private endAnnounced = false;
  private viewportWarned = false;
  private lastSampleAt = 0;
  private lastValidAt = 0;
  private confidence = 1;
  /** When the smoothed confidence dropped under the "poor" threshold (null while above it). */
  private lowSince: number | null = null;
  private readingMs = 0;
  private totalReadingMs = 0;
  private lastProgressAt = 0;
  private wordCount = 0;
  private lastTick = performance.now();
  private disposed = false;
  private buddyView: { from: AppSettings; view: AppSettings } | null = null;

  private constructor(
    deps: PageSessionDeps,
    settings: AppSettings,
    ext: ExtSettings,
    model: ZoomAwareGazeModel | null,
    calibrationState: CalibrationStatus,
    touchUp: TouchUpRecord | null,
  ) {
    this.deps = deps;
    this.ext = ext;
    this.model = model;
    this.calibrationState = model ? 'current' : calibrationState;
    // Never the page's localStorage: this store lives in memory and syncs with chrome.storage.local.
    this.store = createSettingsStore(this.bus, { persist: false, initial: settings });
    this.pageEnd = new PageEndDetector({ sensitivity: settings.sensitivity, glanceDownToTurn: settings.glanceDownToTurn });
    const kept = takeKeptTracker(model);
    this.tracker = kept?.tracker ?? new LineTracker();
    this.driftOwner = kept?.owner ?? null;
    this.conditions = new ConditionsWatch(model?.environment ?? null);
    // A calibration made moments ago (in another tab, before following a link) is fresh here too.
    this.touchUp = new TouchUpAdvisor({ record: touchUp, calibratedAt: model?.trainedAt ?? null });
  }

  // ─────────────────────────────── lifecycle ────────────────────────────────

  private boot(): void {
    const d = this.d;
    for (const stale of Array.from(document.querySelectorAll(HOST_TAG))) stale.remove();
    this.createHost();
    d.add(() => this.bus.clear());

    d.add(syncSettings({ bus: this.bus, store: this.store, storage: this.deps.storage, origin: makeOrigin('tab') }));
    const settings = this.getSettings();

    this.pill = new PagePill({
      onTogglePause: () => this.setPaused(!this.paused),
      onRecalibrate: () => this.recalibrate(),
      onClose: () => this.deps.onEnded('user'),
    });
    this.pill.setCorner(settings.buddyCorner);
    this.pill.mount(this.root);
    d.add(() => this.pill.destroy());

    this.mountSafely('Dewey', () => new Buddy({ bus: this.bus, getSettings: this.buddySettings }));
    this.gazeDot = this.mountSafely('gaze dot', () => new GazeDot({ bus: this.bus, getSettings: this.getSettings }));
    this.debugOverlay = this.mountSafely('debug overlay', () => new DebugOverlay({ bus: this.bus, getSettings: this.getSettings }));
    this.gazeDot?.setVisible(settings.showGazeDot);
    this.debugOverlay?.setVisible(settings.showDebugOverlay);

    this.locateContent();
    this.remeasure('initial');

    d.add(this.bus.on('settings-changed', ({ settings: s, changed }) => this.onSettingsChanged(s, changed)));
    d.add(this.bus.on('command', ({ name }) => this.command(name)));
    // Whoever reports it (the lighting and eyelid watchers here, a quick refresh or accuracy check),
    // the gaze bias may have jumped: the line tracker keeps the line and re-learns the offset.
    d.add(this.bus.on('appearance-changed', ({ t }) => this.tracker.appearanceChangedAt(t)));

    let lastWidth = window.innerWidth;
    const onResize = debounce(d, () => {
      // A width (or zoom) change reflows the text, so stored undo offsets would land on
      // unrelated text. Height-only resizes keep the history.
      if (Math.abs(window.innerWidth - lastWidth) > 0.5) this.scroll?.clearHistory();
      lastWidth = window.innerWidth;
      this.remeasure('resize');
    }, 150);
    d.listen(window, 'resize', onResize, { passive: true });
    d.listen(document, 'visibilitychange', () => this.onVisibilityChange());
    d.listen(window, 'keydown', (e) => this.onKeyDown(e), { capture: true });
    d.add(() => {
      this.scrollerDisposer?.dispose();
      this.mainObservers?.dispose();
    });

    d.add(watchKey(this.deps.storage, KEYS.calibration, (value) => this.onStoredCalibration(value)));
    d.add(watchKey(this.deps.storage, KEYS.cameraGrantedAt, () => this.onPermissionGranted()));
    d.add(watchKey(this.deps.storage, KEYS.extSettings, (value) => (this.ext = parseExtSettings(value))));
    // Another tab offered the quick refresh, or the reader said "Not now" there.
    d.add(watchKey(this.deps.storage, KEYS.touchUp, (value) => this.touchUp.setRecord(parseTouchUpRecord(value))));
    d.interval(() => this.tick(), 1_000);

    d.add(() => {
      this.sourceGen++;
      this.calibration?.cancel();
      this.stopGaze();
      this.remote?.destroy();
      this.remote = null;
      this.scroll?.destroy();
      this.scroll = null;
    });

    this.wordCount = countWords(this.main.textContent ?? '');
    this.bus.emit('book-opened', {
      id: `page:${location.origin}${location.pathname}`,
      title: document.title.trim() || location.hostname || 'this page',
      author: null,
      wordCount: this.wordCount,
      resumed: false,
    });
    void this.startSource();
  }

  /**
   * Dewey's view of the settings. Pausing is per tab here (settings are shared
   * by every tab), so the reader's pause shows up as auto-scroll off: his menu
   * then offers "Resume" rather than a second "Pause".
   */
  private readonly buddySettings = (): AppSettings => {
    const s = this.store.get();
    if (!this.paused || !s.autoScroll) return s;
    if (this.buddyView?.from !== s) this.buddyView = { from: s, view: { ...s, autoScroll: false } };
    return this.buddyView.view;
  };

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.d.dispose();
    // Turned off (not orphaned): a session started again on this page with the same calibration
    // resumes from the gaze offset learned here.
    if (this.driftOwner && this.deps.isContextValid()) keptTracker = { tracker: this.tracker, owner: this.driftOwner };
  }

  state(): PageState {
    return {
      enabled: !this.disposed,
      tracking: this.shown ?? this.base,
      source: this.sourceKind,
      calibrated: this.model !== null,
      paused: this.paused,
      fps: this.sourceKind === 'webcam' && this.cameraRunning ? (this.remote?.fps ?? null) : null,
      detail: this.shownDetail,
      pageMode: this.readingMode === 'page',
    };
  }

  /** What the popup shows about the light, and whether the accuracy check can run here. */
  extraState(): PageExtraState {
    const webcamLive = !this.disposed && this.sourceKind === 'webcam' && this.cameraRunning;
    const l = webcamLive ? this.lighting : null;
    return {
      lighting: l ? { flags: [...l.flags], changedSinceCalibration: l.changedSinceCalibration, dominant: l.dominant } : null,
      canCheck: !this.disposed && this.getSettings().gazeSource === 'webcam' && this.model !== null && !this.calibration,
    };
  }

  command(name: PageCommand | CommandName | ShortcutAction | PageExtraCommand): void {
    if (this.disposed) return;
    switch (name) {
      case 'check-accuracy':
        return this.runCheck('check');
      case 'touch-up':
        return this.runCheck('quick');
      case 'pause':
        return this.setPaused(true);
      case 'resume':
        return this.setPaused(false);
      case 'toggle-autoscroll':
      case 'toggle-pause':
        return this.setPaused(!this.paused);
      case 'recalibrate':
        return this.recalibrate();
      case 'page-forward':
        void this.turnPage(this.layout ? lastFullyVisibleLine(this.layout) : -1, false, 'keyboard');
        return;
      case 'page-back':
        if (this.turnVia() === 'keys') this.pressKeys('back');
        else void this.pageBack();
        return;
      case 'undo-turn':
        // A key-press turn can't be taken back exactly; the closest thing is the reader's previous page.
        if (this.turnVia() === 'keys') this.pressKeys('back');
        else void this.undoTurn();
        return;
      case 'toggle-debug':
        this.bus.emit('settings-patch', { showDebugOverlay: !this.getSettings().showDebugOverlay });
        return;
      case 'toggle-gaze-dot':
        this.bus.emit('settings-patch', { showGazeDot: !this.getSettings().showGazeDot });
        return;
      case 'toggle-help':
      case 'show-help':
        this.pill.toggleHelp();
        return;
      case 'open-settings':
        this.say('My settings live behind the Gaze Reader button in your toolbar.', 'high', 'thinking');
        return;
      case 'turn-off':
        this.deps.onEnded('user');
        return;
      case 'close-settings':
      case 'open-library':
        return;
    }
  }

  // ──────────────────────────────── DOM host ────────────────────────────────

  private createHost(): void {
    const host = document.createElement(HOST_TAG);
    host.setAttribute(IGNORE_ATTR, '');
    const important = (prop: string, value: string) => host.style.setProperty(prop, value, 'important');
    important('all', 'initial');
    important('display', 'block');
    important('position', 'fixed');
    important('top', '0');
    important('left', '0');
    important('width', '0');
    important('height', '0');
    important('overflow', 'visible');
    important('z-index', HOST_Z_INDEX);
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = HOST_CSS;
    root.append(style);
    // On <html>, not <body>: a transformed body would break position: fixed.
    document.documentElement.append(host);
    this.root = root;
    this.d.add(() => host.remove());
  }

  private mountSafely<T extends Mountable>(name: string, create: () => T): T | null {
    try {
      const component = create();
      component.mount(this.root);
      this.d.add(() => component.destroy());
      return component;
    } catch (err) {
      console.error(`[gaze-reader] could not show the ${name}`, err);
      return null;
    }
  }

  // ─────────────────────────── content & layout ─────────────────────────────

  /** (Re)discovers the main text and its scroller; called at start and after SPA navigations. */
  private locateContent(): void {
    this.main = findMainContent(document);
    this.href = location.href;
    this.observeMain();
    this.bindScroller(this.pickScroller());
  }

  /**
   * The element page turns scroll. In text mode, the one around the main
   * text. In page mode there may be no main text at all (the page is a
   * canvas), so the box around the picture of the page is a candidate too.
   */
  private pickScroller(): Scroller {
    if (this.readingMode === 'text') return findScroller(this.main);
    const viewport = readingViewport(window);
    return viewport ? findPageModeScroller(document, this.main, viewport) : findScroller(this.main);
  }

  private bindScroller(scroller: Scroller): void {
    if (scroller === this.scroller && this.scroll) return;
    this.scrollerDisposer?.dispose();
    this.otherTurns += this.scroll?.pagesTurned ?? 0;
    this.scroll?.destroy();
    this.scroller = scroller;
    this.scroll = new ScrollController({ scroller, bus: this.bus, getSettings: this.getSettings });
    const sd = new Disposer();
    const settled = debounce(sd, () => this.onScrollSettled(), 120);
    const onScroll = () => {
      if (this.turning || this.scroll?.animating || performance.now() < this.ignoreScrollUntil) return;
      this.pageEnd.notifyScrolled(performance.now());
      settled();
    };
    if (isWindow(scroller)) sd.listen(window, 'scroll', onScroll, { passive: true });
    else sd.listen(scroller, 'scroll', onScroll, { passive: true });
    this.scrollerDisposer = sd;
  }

  /**
   * Content that changes size or text (lazy images, live updates, infinite
   * scroll) invalidates the layout. It is still the same text, so this is a
   * reflow ('resize': the tracker carries its belief across by docTop), not new
   * content ('content' would wipe the posterior and the fixation count, and on
   * pages whose ads or timestamps tick every few seconds auto-scroll would never
   * build up enough evidence to turn).
   */
  private observeMain(): void {
    this.mainObservers?.dispose();
    const od = new Disposer();
    const changed = throttle(od, () => this.remeasure('resize'), 300);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(changed);
      ro.observe(this.main);
      od.add(() => ro.disconnect());
    }
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(changed);
      mo.observe(this.main, { childList: true, subtree: true, characterData: true });
      od.add(() => mo.disconnect());
    }
    this.mainObservers = od;
  }

  private remeasure(reason: LayoutChangeReason): LineLayout | null {
    if (this.disposed) return null;
    // Mid-turn the page is between positions; the turn remeasures when it lands.
    if (this.turning && reason !== 'page-turn') return this.layout;
    if (!this.main.isConnected || location.href !== this.href) {
      this.locateContent();
      reason = 'content';
    }
    const scroller = this.scroller;
    const viewport = scroller ? readingViewport(scroller) : null;
    if (!scroller || !viewport) {
      this.layout = null;
      return null;
    }
    const metrics = scrollMetrics(scroller);
    let layout: LineLayout;
    try {
      layout = measureLines({
        root: this.main,
        viewport,
        scrollTop: metrics.scrollTop,
        scrollHeight: metrics.scrollHeight,
        clientHeight: viewport.bottom - viewport.top,
      });
    } catch (err) {
      console.warn('[gaze-reader] measuring lines failed', err);
      return this.layout;
    }
    const mode = this.modeMonitor.observe(modeLineCount(layout, this.readingMode), performance.now());
    if (mode !== this.readingMode) {
      reason = 'content'; // different lines altogether: nothing the tracker learned carries over
      this.onReadingModeChanged(mode);
    }
    if (mode === 'page') {
      // No text to measure (a canvas or image reader): pseudo-lines over the picture of the page,
      // in the scroller page mode picked (which may differ from the one just measured).
      const pageScroller = this.scroller ?? scroller;
      const same = pageScroller === scroller;
      const pageViewport = same ? viewport : (readingViewport(pageScroller) ?? viewport);
      const m = same ? metrics : scrollMetrics(pageScroller);
      layout = buildPseudoLayout({
        viewport: pageViewport,
        scrollTop: m.scrollTop,
        scrollHeight: m.scrollHeight,
        clientHeight: pageViewport.bottom - pageViewport.top,
        content: largestVisualRect(document, pageViewport),
      });
    }
    this.layout = layout;
    this.tracker.setLayout(layout, reason);
    this.bus.emit('layout', layout);
    return layout;
  }

  private onReadingModeChanged(mode: ReadingMode): void {
    this.readingMode = mode;
    this.bindScroller(this.pickScroller());
    this.fixations.reset();
    this.pageEnd.notifyScrolled(performance.now()); // no turn on the very first sample of the new mode
    this.refreshState();
    if (mode !== 'page' || pageModeExplained) return;
    pageModeExplained = true;
    const how = this.getSettings().glanceDownToTurn
      ? 'Glance at the bottom edge of the page to turn it.'
      : 'Rest your eyes at the bottom right of the page to turn it.';
    this.say(`I can't read the text on this page, so I'll watch the bottom edge instead. ${how}`, 'high', 'thinking');
  }

  /** How the next page turn moves the page (see PageTurnMethod). */
  private turnVia(): PageTurnVia {
    return resolvePageTurn(this.ext.pageTurn, this.readingMode, this.scroller ? scrollMetrics(this.scroller) : null);
  }

  private onScrollSettled(): void {
    this.remeasure('scroll');
    this.fixations.reset();
    if (this.scroll && !this.scroll.atEnd()) this.endAnnounced = false;
  }

  // ─────────────────────────────── gaze source ──────────────────────────────

  private async startSource(): Promise<void> {
    const gen = ++this.sourceGen;
    this.interruptCalibration();
    this.stopGaze();
    if (this.disposed || this.hidden) return;
    const kind: SourceKind = this.getSettings().gazeSource === 'webcam' ? 'webcam' : 'mouse';
    this.sourceKind = kind;
    this.refreshState();
    this.resetPipeline();

    if (kind === 'mouse') {
      this.releaseCamera(false);
      const mouse = new MouseGazeSource({ noisePx: () => this.getSettings().mouseNoisePx, target: window });
      this.attachGaze(mouse);
      try {
        await mouse.start();
      } catch (err) {
        console.warn('[gaze-reader] mouse source failed', err);
      }
      if (gen !== this.sourceGen) return;
      this.setBase('tracking');
      return;
    }

    const remote = this.ensureRemote();
    this.setBase('starting');
    // A new camera session: the lighting and eyelid history starts over (the references stay).
    this.conditions.reset();
    this.lighting = null;
    try {
      await remote.start();
    } catch (err) {
      if (gen === this.sourceGen && !this.disposed) this.onCameraError(err);
      return;
    }
    if (gen !== this.sourceGen || this.disposed) return;
    this.cameraRunning = true;
    this.awaitingPermission = false;
    this.pill.notify(null);
    const webcam = new WebcamGazeSource({ features: remote, getModel: () => this.model });
    this.attachGaze(webcam);
    await webcam.start();
    if (gen !== this.sourceGen) return;

    const pending = this.runWhenReady;
    this.runWhenReady = null;
    if (!this.model) {
      if (pending === 'standard') void this.calibrate('standard'); // the reader asked for it
      else if (this.calibrationDeclined) this.needCalibration();
      else if (this.calibrationState === 'outdated') this.explainOutdatedCalibration();
      else void this.calibrate('standard');
    } else if (pending) {
      void this.calibrate(pending);
    } else {
      this.setBase('tracking');
      this.checkCalibrationViewport();
    }
  }

  private ensureRemote(): RemoteFeatureSource {
    if (this.remote) return this.remote;
    const remote = new RemoteFeatureSource({ connect: this.deps.connectPort, isContextValid: this.deps.isContextValid });
    this.d.add(remote.onStatus((s) => this.onRemoteStatus(s)));
    this.d.add(remote.onFrame((frame) => this.onFrame(frame)));
    this.remote = remote;
    return remote;
  }

  /**
   * Every camera frame (the gaze itself comes through WebcamGazeSource): the
   * light and the eyelids, compared with calibration. Not while calibrating
   * (the dots move the eyes to the screen's edges, and the overlay measures the
   * light itself) and not without a model to compare with.
   */
  private onFrame(frame: FeatureFrame): void {
    const model = this.model;
    if (this.disposed || this.sourceKind !== 'webcam' || !this.cameraRunning || this.calibration || !model) return;
    const gazeYNorm = frame.features ? model.gazeYNorm(frame.features) : null;
    this.applyConditions(this.conditions.onFrame(frame, gazeYNorm));
  }

  private applyConditions(u: ConditionsUpdate): void {
    if (u.lighting) {
      this.lighting = u.lighting;
      this.bus.emit('lighting-state', u.lighting);
      if (this.base === 'poor') this.setBase('poor', this.poorDetail());
    }
    // The bus listener passes it on to the line tracker.
    if (u.appearance) this.bus.emit('appearance-changed', u.appearance);
    if (u.lightingChanged) this.lightingChange = u.lightingChanged;
    // A changed light stays a reason for the quick refresh until it has been offered once: the
    // advisor's gate may be closed right now (just calibrated, another tab's offer, snoozed), so
    // ask again on every lighting update. The advisor makes one offer per episode.
    if (u.lighting?.changedSinceCalibration && this.lightingChange) {
      const offer = this.touchUp.lightingChanged(this.lightingChange.dominant, this.lightingChange.z);
      if (offer) this.offerTouchUp(offer);
    } else if (u.lighting && !u.lighting.changedSinceCalibration) {
      this.lightingChange = null;
      this.touchUp.noteLightingRestored();
    }
  }

  private attachGaze(source: GazeSource): void {
    this.gaze = source;
    this.offGaze = source.onSample((s) => this.onSample(s));
  }

  private stopGaze(): void {
    this.offGaze?.();
    this.offGaze = null;
    this.gaze?.stop();
    this.gaze = null;
  }

  /** @param linger keep the camera warm for a quick return (tab hidden). */
  private releaseCamera(linger: boolean): void {
    this.cameraRunning = false;
    this.remote?.stop({ linger });
  }

  private onRemoteStatus(s: RemoteSourceStatus): void {
    if (this.disposed || this.sourceKind !== 'webcam') return;
    switch (s.state) {
      case 'orphaned':
        this.deps.onEnded('orphaned');
        return;
      case 'reconnecting':
        if (this.cameraRunning) this.setBase('starting', 'Reconnecting…');
        return;
      case 'starting':
        // The service worker is restarting the camera for us (e.g. the offscreen document crashed).
        if (this.cameraRunning && !this.calibration) this.setBase('starting', 'Restarting the camera…');
        return;
      case 'running':
        if (this.cameraRunning && this.base === 'starting') this.settleWebcamState();
        return;
      case 'error':
        // Errors while starting are handled by startSource(); this is a camera that died mid-read.
        if (this.cameraRunning) {
          this.cameraRunning = false;
          this.stopGaze();
          this.interruptCalibration();
          this.onCameraError(new RemoteTrackerError(s.code ?? 'unknown', s.message));
        }
        return;
      default:
        return;
    }
  }

  /** The camera is back (after a reconnect or restart): return to whatever the webcam path was doing. */
  private settleWebcamState(): void {
    if (this.calibration) this.setBase('calibrating');
    else if (!this.model) this.setBase('paused', this.calibrationState === 'outdated' ? CALIBRATION_OUTDATED : NOT_CALIBRATED);
    else this.setBase('tracking');
  }

  private onCameraError(err: unknown): void {
    const code = err instanceof RemoteTrackerError ? err.code : 'unknown';
    if (this.remote?.status.state === 'orphaned') return;
    const text = CAMERA_ERROR_TEXT[code] ?? `Camera problem: ${err instanceof Error ? err.message : String(err)}`;
    const useMouse = { label: 'Use the mouse', run: () => this.bus.emit('settings-patch', { gazeSource: 'mouse' }) };
    const retry = { label: 'Try again', run: () => void this.startSource() };
    this.setBase('error', code === 'camera-denied' ? 'Camera permission needed' : 'Camera problem');
    if (code === 'camera-denied') {
      this.awaitingPermission = true;
      this.pill.notify({
        text,
        tone: 'warn',
        actions: [{ label: 'Open camera setup', run: () => this.deps.openSetup() }, useMouse],
      });
      this.say("I need your camera's permission to see where you're reading.", 'high', 'worried');
    } else {
      this.pill.notify({ text, tone: 'error', actions: [retry, useMouse] });
      this.say(text, 'high', 'worried');
    }
  }

  private onPermissionGranted(): void {
    if (!this.awaitingPermission || this.getSettings().gazeSource !== 'webcam') return;
    this.awaitingPermission = false;
    this.pill.notify(null);
    // Leaving 'error' lets the visibility handler start the camera when the reader comes back.
    this.setBase('starting');
    this.say('Thank you! Now I can see where you read.', 'high', 'happy');
    void this.startSource(); // no-op while this tab is hidden (the setup tab is in front)
  }

  // ─────────────────────────────── calibration ──────────────────────────────

  private recalibrate(): void {
    if (this.disposed || this.calibration) return;
    if (this.getSettings().gazeSource !== 'webcam') {
      this.say('Calibration is only needed for webcam mode.', 'high', 'thinking');
      return;
    }
    this.calibrationDeclined = false;
    this.whenCameraReady('standard');
  }

  /**
   * The accuracy check ('check': 5 dots measure the offset; the reader may
   * correct it) or the quick refresh ('quick': 5 dots re-centre the model).
   * Both need a calibration to work on: without one, this is a calibration.
   */
  private runCheck(mode: 'check' | 'quick'): void {
    if (this.disposed || this.calibration) return;
    if (this.getSettings().gazeSource !== 'webcam') {
      this.say('The accuracy check is for reading with the webcam.', 'high', 'thinking');
      return;
    }
    if (!this.model) {
      this.recalibrate();
      return;
    }
    this.whenCameraReady(mode);
  }

  private whenCameraReady(mode: CalibrationMode): void {
    if (this.remote?.running && this.gaze) void this.calibrate(mode);
    else {
      this.runWhenReady = mode;
      void this.startSource();
    }
  }

  private async calibrate(requested: CalibrationMode = 'standard'): Promise<void> {
    const remote = this.remote;
    if (this.calibration || this.disposed || !remote?.running) return;
    const current = this.model;
    const mode: CalibrationMode = current ? requested : 'standard';
    const overlay = new CalibrationOverlay({
      features: remote,
      bus: this.bus,
      video: null, // the camera lives in the offscreen document; positioning feedback comes from the features
      mode,
      // The check measures the model as it is used here (zoom included); a correction is fitted on its core.
      baseModel: mode === 'standard' ? (current?.inner ?? null) : current,
      featureNames: FEATURE_NAMES,
      // "≈ N lines" in the results uses this page's real line spacing.
      linePitchPx: () => this.layout?.linePitch,
    });
    const gen = this.sourceGen;
    this.calibration = overlay;
    this.calibrationInterrupted = false;
    this.setBase('calibrating');
    this.pill.setHidden(true);
    let result: Awaited<ReturnType<CalibrationOverlay['run']>> = null;
    try {
      overlay.mount(this.root);
      result = await overlay.run();
    } catch (err) {
      console.warn('[gaze-reader] calibration failed', err);
    } finally {
      overlay.destroy();
      if (this.calibration === overlay) this.calibration = null;
      if (!this.disposed) this.pill.setHidden(false);
    }
    if (this.disposed) return;
    const sourceChanged = gen !== this.sourceGen; // tab hidden, or the reader switched source

    if (result) {
      // Trained (or corrected) at this page's zoom; the wrapper records it so other sites map correctly.
      this.adoptModel(zoomAware(result.model));
      if (sourceChanged) return;
      // A tune-up or the check's "Correct it" re-centres the model in use and says so in `check`;
      // without it this was a full calibration (asked for, or where a tune-up couldn't help).
      if (mode === 'standard' || result.check === undefined) {
        this.resetPipeline({ calibrated: true });
      } else {
        // The same reader, mid-page, with the offset just corrected: keep the line, re-learn the
        // drift (the old one belongs to the uncorrected model).
        const what = mode === 'check' ? 'accuracy check' : 'quick refresh';
        this.bus.emit('appearance-changed', { t: performance.now(), reason: 'refresh', detail: `${what} corrected the offset` });
        this.fixations.reset();
        this.pageEnd.notifyScrolled(performance.now());
      }
      this.setBase('tracking');
    } else if (sourceChanged || this.calibrationInterrupted) {
      // Whoever interrupted owns the state now: the new source, the camera-error
      // notice, or the visibility handler (which recalibrates when the tab returns).
    } else if (!this.model) {
      this.calibrationDeclined = true;
      this.needCalibration();
    } else {
      // Cancelled, or an accuracy check that left the model as it was.
      this.fixations.reset();
      this.pageEnd.notifyScrolled(performance.now());
      this.setBase('tracking');
    }
  }

  /** A new or corrected model: saved for every tab, and the new reference for the light and the eyelids. */
  private adoptModel(model: ZoomAwareGazeModel): void {
    this.model = model;
    this.calibrationState = 'current';
    this.viewportWarned = false;
    this.calibrationDeclined = false;
    this.conditions.setEnvironment(model.environment);
    this.touchUp.noteCalibrated();
    void saveCalibrationJSON(this.deps.storage.area, model.toJSON());
  }

  /** Cancel a running calibration for a reason other than the reader pressing Esc. */
  private interruptCalibration(): void {
    if (!this.calibration) return;
    this.calibrationInterrupted = true;
    this.calibration.cancel();
  }

  private needCalibration(): void {
    if (this.calibrationState === 'outdated') {
      this.explainOutdatedCalibration();
      return;
    }
    this.setBase('paused', NOT_CALIBRATED);
    this.pill.notify({
      text: 'Webcam reading needs a one-minute calibration first.',
      tone: 'info',
      actions: [
        { label: 'Calibrate', run: () => this.recalibrate() },
        { label: 'Use the mouse', run: () => this.bus.emit('settings-patch', { gazeSource: 'mouse' }) },
      ],
    });
  }

  /**
   * The stored calibration came from an older Gaze Reader, whose tracking read
   * the eyelids (which light moves). Starting a calibration without a word
   * would look like the extension forgot it, so say why and let the reader start it.
   */
  private explainOutdatedCalibration(): void {
    this.setBase('paused', CALIBRATION_OUTDATED);
    this.pill.notify({
      text: OUTDATED_CALIBRATION_TEXT,
      tone: 'info',
      actions: [
        { label: 'Calibrate', run: () => this.recalibrate() },
        { label: 'Use the mouse', run: () => this.bus.emit('settings-patch', { gazeSource: 'mouse' }) },
      ],
    });
    this.say('My eye tracking got an upgrade for changing light! One new calibration and we’re set.', 'high', 'excited');
  }

  /** Paused only because there is no usable calibration yet. */
  private awaitingCalibration(): boolean {
    return this.base === 'paused' && (this.detail === NOT_CALIBRATED || this.detail === CALIBRATION_OUTDATED);
  }

  private onStoredCalibration(value: unknown): void {
    // Another tab calibrated, or the reader chose "Forget calibration" in the popup: pick it up.
    if (value === undefined) {
      this.calibrationState = 'none';
      if (!this.model) {
        if (this.detail === CALIBRATION_OUTDATED && this.base === 'paused') this.needCalibration();
        return;
      }
      this.model = null;
      this.conditions.setEnvironment(null);
      this.lighting = null;
      // Reading on without a model would just look like "can't see your eyes".
      if (this.sourceKind === 'webcam' && this.cameraRunning && !this.calibration) {
        this.resetPipeline();
        this.needCalibration();
      }
      return;
    }
    if (!isSerializedGazeModel(value)) return;
    const model = zoomAwareFromJSON(value, MODEL_COMPAT);
    if (model && model.trainedAt !== this.model?.trainedAt) {
      this.model = model;
      this.calibrationState = 'current';
      this.viewportWarned = false;
      this.conditions.setEnvironment(model.environment);
      this.touchUp.noteCalibrated(Math.min(Date.now(), model.trainedAt));
      if (this.awaitingCalibration()) {
        this.pill.notify(null);
        this.setBase('tracking');
      }
    }
  }

  /** A model trained for a very different window size maps gaze poorly (page zoom is already accounted for). */
  private checkCalibrationViewport(): void {
    const m = this.model;
    if (!m || this.viewportWarned) return;
    if (m.viewportChange({ width: window.innerWidth, height: window.innerHeight }) < 0.2) return;
    this.viewportWarned = true;
    this.pill.notify({
      text: 'Your window size changed since you calibrated. Recalibrating (about a minute) keeps page turns accurate.',
      tone: 'info',
      actions: [{ label: 'Recalibrate', run: () => this.recalibrate() }],
      timeoutMs: 15_000,
    });
  }

  // ──────────────────────────────── pipeline ────────────────────────────────

  private onSample(s: GazeSample): void {
    if (this.disposed) return;
    this.lastSampleAt = performance.now();
    this.bus.emit('gaze', s);
    this.updateQuality(s);
    if (this.calibration) return;

    // Page mode's pseudo-lines are never read line by line: the line tracker would learn a
    // meaningless gaze offset there (±5 lines of it), which the gaze dot would then subtract. It
    // sits out page mode and keeps what it learned on real text.
    const text = this.readingMode === 'text';
    const { completed } = this.fixations.push(s);
    if (completed) {
      const estimate = text ? this.tracker.onFixation(completed) : null;
      this.bus.emit('fixation', completed);
      if (estimate) {
        this.bus.emit('line-estimate', estimate);
        this.noteEstimate(estimate);
      }
    }
    if (text) this.tracker.onSample(s);

    const scroll = this.scroll;
    if (!scroll || this.turning || scroll.animating || this.paused || !this.getSettings().autoScroll) return;
    // Page mode's pseudo-lines were never read: only the geometric rules (glance-down, bottom-dwell) may fire.
    const estimate = this.readingMode === 'page' ? null : this.tracker.estimate;
    const decision = this.pageEnd.update({ t: s.t, gaze: s, estimate, layout: this.layout });
    if (!decision.trigger) return;
    if (this.turnVia() === 'scroll' && scroll.atEnd()) {
      this.pageEnd.notifyScrolled(s.t);
      if (!this.endAnnounced) {
        this.endAnnounced = true;
        this.say("That's the end of the page. Nice reading!", 'normal', 'happy');
      }
      return;
    }
    this.bus.emit('page-end', decision);
    void this.turnPage(decision.targetLineIndex, true, decision.reason);
  }

  private async turnPage(targetLineIndex: number, auto: boolean, reason: string): Promise<void> {
    const scroll = this.scroll;
    if (!scroll || this.turning || this.disposed) return;
    if (this.turnVia() === 'keys') {
      this.pressKeys('forward', auto, reason);
      return;
    }
    const layout = this.layout ?? this.remeasure('scroll');
    const anchorDocTop = layout?.lines[targetLineIndex]?.docTop ?? null;
    const destination = scroll.computeTarget(layout, targetLineIndex, this.getSettings().overlapLines);
    this.turning = true;
    try {
      await this.withScrollDeadline(scroll, scroll.turnPage(layout, targetLineIndex, { auto, reason }), destination);
    } catch (err) {
      console.warn('[gaze-reader] page turn failed', err);
    } finally {
      this.turning = false;
      // The last programmatic scroll event can arrive after the animation promise settles.
      this.ignoreScrollUntil = performance.now() + 150;
    }
    if (this.disposed) return;
    const next = this.remeasure('page-turn');
    if (next) {
      // Reading resumes at the first line below the one that anchored the turn.
      const resume = anchorDocTop === null ? 0 : next.lines.findIndex((l) => l.docTop > anchorDocTop + 1);
      this.tracker.afterPageTurn(Math.max(0, resume));
    }
    this.fixations.reset();
    this.pageEnd.notifyScrolled(performance.now());
  }

  /**
   * Turns the page the way the reader's own keyboard would (ArrowRight +
   * PageDown, or back with ArrowLeft + PageUp). Best effort: many readers
   * ignore synthetic key events. Whatever the page shows next, reading starts
   * over at its top.
   */
  private pressKeys(direction: 'forward' | 'back', auto = false, reason = 'keyboard'): void {
    if (this.disposed || this.turning) return;
    pressPageKeys(document, direction);
    if (direction === 'forward') {
      this.otherTurns++;
      this.bus.emit('page-turn', { from: 0, to: 0, auto, reason, pageIndex: this.pagesTurned() });
    }
    this.fixations.reset();
    this.tracker.afterPageTurn(0);
    this.pageEnd.notifyScrolled(performance.now());
  }

  private pagesTurned(): number {
    return (this.scroll?.pagesTurned ?? 0) + this.otherTurns;
  }

  private async pageBack(): Promise<void> {
    await this.manualMove(async (scroll) => {
      await scroll.pageBack(this.layout);
      return true;
    });
  }

  private async undoTurn(): Promise<void> {
    const undone = await this.manualMove((scroll) => scroll.undo());
    // Direct feedback to a key press: 'high', or Dewey would hold it while the reader is mid-line
    // (and at the default chattiness drop a 'low' line altogether).
    if (!undone && !this.disposed) this.say('Nothing to undo yet.', 'high', 'thinking');
  }

  /** Runs a reader-initiated scroll, then re-syncs the pipeline. Resolves to whether anything moved. */
  private async manualMove(move: (scroll: ScrollController) => Promise<boolean>): Promise<boolean> {
    const scroll = this.scroll;
    if (!scroll || this.turning || this.disposed) return false;
    this.turning = true;
    let moved = false;
    try {
      moved = await this.withScrollDeadline(scroll, move(scroll), null);
    } catch (err) {
      console.warn('[gaze-reader] scrolling failed', err);
    } finally {
      this.turning = false;
      this.ignoreScrollUntil = performance.now() + 150;
    }
    if (moved) this.afterManualMove();
    return moved;
  }

  /**
   * Awaits a scroll animation, but never forever. ScrollController animates
   * with requestAnimationFrame, which stalls in a window that reports itself
   * visible but isn't painting (occluded, compositor hiccup); a turn that
   * never settles would leave `turning` stuck and auto-scroll dead. Past the
   * deadline we jump to the destination (or stop where we are):
   * scrollTo(top, 0) cancels the stuck animation, which settles its promise.
   */
  private async withScrollDeadline<T>(scroll: ScrollController, move: Promise<T>, destination: number | null): Promise<T> {
    const timer = setTimeout(() => {
      const top = destination ?? (this.scroller ? scrollMetrics(this.scroller).scrollTop : null);
      if (top !== null) void scroll.scrollTo(top, 0);
    }, this.getSettings().scrollDurationMs + SCROLL_RESCUE_MS);
    try {
      return await move;
    } finally {
      clearTimeout(timer);
    }
  }

  private afterManualMove(): void {
    if (this.disposed) return;
    this.remeasure('scroll');
    this.fixations.reset();
    this.pageEnd.notifyScrolled(performance.now());
  }

  /**
   * After each fixation under the webcam: whose drift the tracker is learning,
   * and whether that drift is large enough to offer the quick refresh. Page
   * mode's pseudo-lines were never read, so their "drift" says nothing.
   */
  private noteEstimate(estimate: LineEstimate): void {
    const model = this.model;
    if (this.sourceKind !== 'webcam' || !model || this.readingMode !== 'text') return;
    this.driftOwner = { trainedAt: model.trainedAt, at: performance.now() };
    const pitch = this.layout?.linePitch ?? 0;
    const offer = this.paused ? null : this.touchUp.onEstimate(estimate, pitch);
    if (offer) this.offerTouchUp(offer);
  }

  /** Suggests the quick 5-dot refresh (already rate-limited by the advisor). */
  private offerTouchUp(offer: TouchUpOffer): void {
    if (this.disposed || this.calibration || this.hidden || !this.model || this.sourceKind !== 'webcam') return;
    const area = this.deps.storage.area;
    void saveTouchUpRecord(area, this.touchUp.current);
    this.pill.notify({
      text: offer.text,
      tone: 'info',
      actions: [
        { label: 'Refresh now', run: () => this.runCheck('quick') },
        { label: 'Not now', run: () => void saveTouchUpRecord(area, this.touchUp.snooze()) },
      ],
      timeoutMs: TOUCH_UP_NOTICE_MS,
    });
  }

  /**
   * Starts the reading pipeline over (new source, new calibration, camera
   * back). The line tracker keeps the gaze offset it learned (softened) when it
   * was learned under the webcam with this same calibration, recently: the
   * camera coming back after a hidden tab or a reconnect, or Gaze Reader turned
   * on again on this page. The tracker's prior copes with an unknown offset,
   * but a known one avoids relearning it on every page. `calibrated`: a full
   * calibration just ran, under this light (reset({ calibrated: true })).
   */
  private resetPipeline(opts: { calibrated?: boolean } = {}): void {
    const model = this.model;
    const owner = this.driftOwner;
    const keepDrift =
      this.sourceKind === 'webcam' &&
      model !== null &&
      owner !== null &&
      owner.trainedAt === model.trainedAt &&
      performance.now() - owner.at < KEEP_DRIFT_MS;
    if (!keepDrift) this.driftOwner = null;
    this.fixations.reset();
    this.tracker.reset(!keepDrift && opts.calibrated === true ? { keepDrift, calibrated: true } : { keepDrift });
    this.pageEnd.reset();
    if (this.layout) this.tracker.setLayout(this.layout, 'initial');
    // Fresh baselines, so the watchdogs don't report "no face" before the first frame.
    this.lastValidAt = performance.now();
    this.lastSampleAt = performance.now();
    this.confidence = 1;
    this.lowSince = null;
  }

  // ─────────────────────────────── tracking state ───────────────────────────

  private updateQuality(s: GazeSample): void {
    if (this.sourceKind !== 'webcam' || !isLiveState(this.base)) return;
    const now = performance.now();
    if (s.valid) {
      this.lastValidAt = now;
      this.confidence += 0.1 * (s.confidence - this.confidence);
      this.lowSince = this.confidence < 0.3 ? (this.lowSince ?? now) : null;
      // Hysteresis so the pill doesn't flicker between "shaky" and "reading".
      const poor =
        this.base === 'poor' ? this.confidence < 0.4 : this.lowSince !== null && now - this.lowSince >= POOR_AFTER_MS;
      if (poor) this.setBase('poor', this.poorDetail());
      else this.setBase('tracking');
    } else if (now - this.lastValidAt > 1_000) {
      this.setBase('no-face');
    }
  }

  /** "Shaky" plus what the lighting measurements say is wrong, when they say something. */
  private poorDetail(): string | null {
    const tip = this.lighting ? lightingTip(this.lighting.flags) : null;
    return tip ? `Shaky: ${tip}` : null;
  }

  private setBase(state: TrackingState, detail: string | null = null): void {
    if (state === this.base && detail === this.detail) return; // called per gaze sample
    this.base = state;
    this.detail = detail;
    this.refreshState();
  }

  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) this.pageEnd.notifyScrolled(performance.now()); // no instant turn right after resuming
    this.say(paused ? "Paused. I'll wait right here." : 'Back to reading!', 'high', paused ? 'idle' : 'happy');
    this.refreshState();
  }

  private refreshState(): void {
    if (this.disposed) return;
    const pausedByReader = this.paused && isLiveState(this.base);
    const state: TrackingState = pausedByReader ? 'paused' : this.base;
    const detail = pausedByReader ? null : this.detail;
    if (state !== this.shown || detail !== this.shownDetail) {
      this.shown = state;
      this.shownDetail = detail;
      this.bus.emit('tracking-state', detail === null ? { state } : { state, detail });
    }
    this.pill.setStatus({ state, source: this.sourceKind, paused: this.paused, detail });
  }

  private tick(): void {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (!this.deps.isContextValid()) {
      this.deps.onEnded('orphaned');
      return;
    }
    if (location.href !== this.href) this.remeasure('content'); // SPA navigation
    // Little or no text in view: nothing else says when page mode should start, or when text is back.
    else if (this.modeMonitor.needsPolling) this.remeasure('resize');
    // A hidden tab has released the camera on purpose: no "can't see you" for that.
    if (this.hidden) return;

    // Frames stopped arriving altogether (e.g. the service worker is restarting).
    if (this.sourceKind === 'webcam' && isLiveState(this.base) && now - this.lastSampleAt > 1_500) this.setBase('no-face');
    // Frames carry the lighting comparison; this lets its flags go stale when they stop.
    if (this.sourceKind === 'webcam' && this.cameraRunning && this.model && !this.calibration) {
      this.applyConditions(this.conditions.tick(now));
    }
    if (this.debugOverlay?.visible) {
      const lids = this.sourceKind === 'webcam' && this.model ? this.conditions.lidMonitor : null;
      this.debugOverlay.showAppearance(
        lids
          ? { state: lids.state, residualZ: lids.residualZ, squintZ: lids.squintZ, levelVsCalibration: lids.levelVsCalibration }
          : null,
      );
    }

    const s = this.getSettings();
    if (this.shown === 'tracking' && dt < 5_000) {
      this.readingMs += dt;
      this.totalReadingMs += dt;
      if (s.breakReminders && this.readingMs >= s.breakIntervalMin * 60_000) {
        this.bus.emit('break-due', { minutesReading: Math.round(this.readingMs / 60_000) });
        this.readingMs = 0;
      }
    }
    if (now - this.lastProgressAt >= PROGRESS_EVERY_MS) {
      this.lastProgressAt = now;
      this.emitProgress();
    }
  }

  /** Lets Dewey cheer milestones (25/50/75 % of the article, every 10 pages) as he does in the app. */
  private emitProgress(): void {
    const viewport = this.layout?.viewport;
    if (!viewport || !this.main.isConnected) return;
    const r = this.main.getBoundingClientRect();
    if (!(r.height > 0)) return;
    // How much of the main text has been on screen: 1 once its end is visible.
    const fraction = Math.min(1, Math.max(0, (viewport.bottom - r.top) / r.height));
    this.bus.emit('book-progress', {
      fraction,
      wordsRead: Math.round(fraction * this.wordCount),
      wpm: null,
      pagesTurned: this.pagesTurned(),
      minutesReading: Math.floor(this.totalReadingMs / 60_000),
    });
  }

  // ─────────────────────────────── events ───────────────────────────────────

  private onSettingsChanged(s: AppSettings, changed: (keyof AppSettings)[]): void {
    if (changed.includes('gazeSource')) {
      this.pill.notify(null);
      void this.startSource();
    }
    if (changed.includes('sensitivity') || changed.includes('glanceDownToTurn')) {
      this.pageEnd.configure({ sensitivity: s.sensitivity, glanceDownToTurn: s.glanceDownToTurn });
    }
    if (changed.includes('showGazeDot')) this.gazeDot?.setVisible(s.showGazeDot);
    if (changed.includes('showDebugOverlay')) this.debugOverlay?.setVisible(s.showDebugOverlay);
    if (changed.includes('buddyCorner')) this.pill.setCorner(s.buddyCorner);
  }

  private onVisibilityChange(): void {
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      // Another tab is in front: stop using the camera for this one.
      this.sourceGen++;
      this.interruptCalibration();
      this.stopGaze();
      if (this.sourceKind === 'webcam') this.releaseCamera(true);
    } else if (this.base !== 'error') {
      // Errors wait for "Try again" or the permission grant. Retrying a denied
      // camera here would make the service worker refocus the setup tab every
      // time the reader came back to their article.
      void this.startSource();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = matchShortcut(e);
    if (!action || isTypingContext(e)) return;
    if (this.calibration && action !== 'turn-off') return;
    e.preventDefault();
    e.stopPropagation();
    this.command(action);
  }

  private say(text: string, priority: SpeechPriority, mood: BuddyMood): void {
    this.bus.emit('buddy-say', { text, priority, mood });
  }
}

/** States in which live gaze quality decides what we show. */
function isLiveState(s: TrackingState): boolean {
  return s === 'tracking' || s === 'no-face' || s === 'poor';
}

function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}
