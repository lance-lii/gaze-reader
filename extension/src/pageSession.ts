/**
 * Gaze Reader running on one web page: the in-page twin of the app controller.
 *
 * Owns a single shadow-DOM host holding every piece of UI (Dewey, gaze dot,
 * debug overlay, calibration, status pill), the reading pipeline
 * (fixations → line tracker → page-end detector → scroll controller), and the
 * gaze source (webcam frames relayed from the offscreen document, or the
 * mouse). `destroy()` releases the camera and removes every listener, timer
 * and element it created.
 */
import type {
  AppSettings,
  CommandName,
  GazeSample,
  GazeSource,
  LayoutChangeReason,
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
import { CalibrationOverlay } from '../../src/ui/calibrationOverlay';
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
  loadSettings,
  makeOrigin,
  saveCalibrationJSON,
  syncSettings,
  watchKey,
  type ExtStorage,
} from './extStorage';
import { findMainContent } from './findMainContent';
import type { PageCommand, PageState } from './messages';
import { findScroller, isWindow, readingViewport, scrollMetrics, type Scroller } from './pageGeometry';
import { PagePill } from './pagePill';
import type { PortLike } from './ports';
import { RemoteFeatureSource, RemoteTrackerError, type RemoteSourceStatus } from './remoteFeatureSource';
import { isTypingContext, matchShortcut, type ShortcutAction } from './shortcuts';
import { zoomAware, zoomAwareFromJSON, type ZoomAwareGazeModel } from './zoomModel';

export const HOST_TAG = 'gaze-reader-root';
/** The host must sit above everything the page draws; our components order themselves inside it with Z.*. */
const HOST_Z_INDEX = '2147483647';
/** Grace beyond scrollDurationMs before a stalled page-turn animation is finished instantly. */
const SCROLL_RESCUE_MS = 1_500;
/** A calibration saved by a build with different features is useless; reject it on load. */
const MODEL_COMPAT = { featureNames: FEATURE_NAMES } as const;
/** Tracking-state detail while the webcam waits for a first calibration. */
const NOT_CALIBRATED = 'Not calibrated yet';
/** How often Dewey hears how far through the page the reader is. */
const PROGRESS_EVERY_MS = 5_000;
/**
 * Confidence must stay low this long before the pill says "shaky": the blink score rises as the
 * lids lower to read the last lines, so every page end dips it for a moment.
 */
const POOR_AFTER_MS = 2_500;

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
    const [settings, calibration] = await Promise.all([
      loadSettings(deps.storage.area),
      loadCalibrationJSON(deps.storage.area),
    ]);
    const session = new PageSession(deps, settings, calibration ? zoomAwareFromJSON(calibration, MODEL_COMPAT) : null);
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
  private readonly tracker = new LineTracker();
  private readonly pageEnd: PageEndDetector;
  private scroll: ScrollController | null = null;
  private scroller: Scroller | null = null;
  private scrollerDisposer: Disposer | null = null;
  private main: HTMLElement = document.body;
  private mainObservers: Disposer | null = null;
  private href = location.href;
  private layout: LineLayout | null = null;

  private model: ZoomAwareGazeModel | null;
  private remote: RemoteFeatureSource | null = null;
  private gaze: GazeSource | null = null;
  private offGaze: Unsubscribe | null = null;
  private sourceKind: SourceKind | null = null;
  private sourceGen = 0;
  private cameraRunning = false;
  private calibration: CalibrationOverlay | null = null;
  private calibrationInterrupted = false;
  private calibrationDeclined = false;
  private recalibrateWhenReady = false;
  private awaitingPermission = false;

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

  private constructor(deps: PageSessionDeps, settings: AppSettings, model: ZoomAwareGazeModel | null) {
    this.deps = deps;
    this.model = model;
    // Never the page's localStorage: this store lives in memory and syncs with chrome.storage.local.
    this.store = createSettingsStore(this.bus, { persist: false, initial: settings });
    this.pageEnd = new PageEndDetector({ sensitivity: settings.sensitivity, glanceDownToTurn: settings.glanceDownToTurn });
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

    const onResize = debounce(d, () => this.remeasure('resize'), 150);
    d.listen(window, 'resize', onResize, { passive: true });
    d.listen(document, 'visibilitychange', () => this.onVisibilityChange());
    d.listen(window, 'keydown', (e) => this.onKeyDown(e), { capture: true });
    d.add(() => {
      this.scrollerDisposer?.dispose();
      this.mainObservers?.dispose();
    });

    d.add(watchKey(this.deps.storage, KEYS.calibration, (value) => this.onStoredCalibration(value)));
    d.add(watchKey(this.deps.storage, KEYS.cameraGrantedAt, () => this.onPermissionGranted()));
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
    };
  }

  command(name: PageCommand | CommandName | ShortcutAction): void {
    if (this.disposed) return;
    switch (name) {
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
        void this.pageBack();
        return;
      case 'undo-turn':
        void this.undoTurn();
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

    const scroller = findScroller(this.main);
    if (scroller === this.scroller && this.scroll) return;
    this.scrollerDisposer?.dispose();
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
    this.layout = layout;
    this.tracker.setLayout(layout, reason);
    this.bus.emit('layout', layout);
    return layout;
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

    if (!this.model || this.recalibrateWhenReady) {
      this.recalibrateWhenReady = false;
      if (!this.model && this.calibrationDeclined) this.needCalibration();
      else void this.calibrate();
    } else {
      this.setBase('tracking');
      this.checkCalibrationViewport();
    }
  }

  private ensureRemote(): RemoteFeatureSource {
    if (this.remote) return this.remote;
    const remote = new RemoteFeatureSource({ connect: this.deps.connectPort, isContextValid: this.deps.isContextValid });
    this.d.add(remote.onStatus((s) => this.onRemoteStatus(s)));
    this.remote = remote;
    return remote;
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
    else if (!this.model) this.setBase('paused', NOT_CALIBRATED);
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
    if (this.remote?.running && this.gaze) void this.calibrate();
    else {
      this.recalibrateWhenReady = true;
      void this.startSource();
    }
  }

  private async calibrate(): Promise<void> {
    const remote = this.remote;
    if (this.calibration || this.disposed || !remote?.running) return;
    const overlay = new CalibrationOverlay({
      features: remote,
      bus: this.bus,
      video: null, // the camera lives in the offscreen document; positioning feedback comes from the features
      mode: 'standard',
      baseModel: this.model?.inner ?? null,
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
      // Trained at this page's zoom; the wrapper records it so other sites map correctly.
      this.model = zoomAware(result.model);
      this.viewportWarned = false;
      this.calibrationDeclined = false;
      void saveCalibrationJSON(this.deps.storage.area, this.model.toJSON());
      if (sourceChanged) return;
      this.resetPipeline();
      this.setBase('tracking');
    } else if (sourceChanged || this.calibrationInterrupted) {
      // Whoever interrupted owns the state now: the new source, the camera-error
      // notice, or the visibility handler (which recalibrates when the tab returns).
    } else if (!this.model) {
      this.calibrationDeclined = true;
      this.needCalibration();
    } else {
      this.setBase('tracking');
    }
  }

  /** Cancel a running calibration for a reason other than the reader pressing Esc. */
  private interruptCalibration(): void {
    if (!this.calibration) return;
    this.calibrationInterrupted = true;
    this.calibration.cancel();
  }

  private needCalibration(): void {
    this.setBase('paused', NOT_CALIBRATED);
    this.pill.notify({
      text: 'Webcam reading needs a 30-second calibration first.',
      tone: 'info',
      actions: [
        { label: 'Calibrate', run: () => this.recalibrate() },
        { label: 'Use the mouse', run: () => this.bus.emit('settings-patch', { gazeSource: 'mouse' }) },
      ],
    });
  }

  private onStoredCalibration(value: unknown): void {
    // Another tab calibrated, or the reader chose "Forget it" in the popup: pick it up.
    if (value === undefined) {
      if (!this.model) return;
      this.model = null;
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
      this.viewportWarned = false;
      if (this.base === 'paused' && this.detail === NOT_CALIBRATED) {
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
      text: 'Your window size changed since you calibrated. A quick recalibration keeps page turns accurate.',
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

    const { completed } = this.fixations.push(s);
    if (completed) {
      const estimate = this.tracker.onFixation(completed);
      this.bus.emit('fixation', completed);
      this.bus.emit('line-estimate', estimate);
    }
    this.tracker.onSample(s);

    const scroll = this.scroll;
    if (!scroll || this.turning || scroll.animating || this.paused || !this.getSettings().autoScroll) return;
    const decision = this.pageEnd.update({ t: s.t, gaze: s, estimate: this.tracker.estimate, layout: this.layout });
    if (!decision.trigger) return;
    if (scroll.atEnd()) {
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

  private resetPipeline(): void {
    this.fixations.reset();
    this.tracker.reset();
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
      this.setBase(poor ? 'poor' : 'tracking');
    } else if (now - this.lastValidAt > 1_000) {
      this.setBase('no-face');
    }
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
    // A hidden tab has released the camera on purpose: no "can't see you" for that.
    if (this.hidden) return;

    // Frames stopped arriving altogether (e.g. the service worker is restarting).
    if (this.sourceKind === 'webcam' && isLiveState(this.base) && now - this.lastSampleAt > 1_500) this.setBase('no-face');

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
      pagesTurned: this.scroll?.pagesTurned ?? 0,
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
