/**
 * The app shell's brain: wires the gaze sources, the reading pipeline, the
 * reader, Dewey and the chrome together, and owns every lifecycle.
 *
 *   source ─► gaze ─► FixationDetector ─► LineTracker ─► PageEndDetector ─► ScrollController
 *
 * Methods are grouped by concern: lifecycle · screens · books · session &
 * progress · pipeline · page turning · layout · sources · calibration ·
 * tracking state · commands & settings · DOM events.
 */
import { CSS_PREFIX } from '../core/constants';
import { createEventBus } from '../core/events';
import { createSettingsStore, type SettingsStore } from '../core/settings';
import { readJSON, writeJSON } from '../core/storage';
import { FULL_APP_URL, IS_ARTIFACT } from '../core/target';
import type {
  AppEvents,
  AppSettings,
  Book,
  BuddyMood,
  CalibrationReport,
  CommandName,
  EventBus,
  FeatureFrame,
  GazeModel,
  GazeSample,
  GazeSource,
  GazeSourceKind,
  LayoutChangeReason,
  LightingFlag,
  LineEstimate,
  LineLayout,
  PageEndDecision,
  ReadingPosition,
  SpeechPriority,
  Unsubscribe,
} from '../types';
import { Buddy, chattinessAllows } from '../buddy/buddy';
import { QuipPicker, type QuipKey } from '../buddy/quips';
import { BUDDY_CLASS } from '../buddy/styles';
import { AppearanceMonitor } from '../gaze/appearance';
import {
  clearCalibration,
  currentChromeTop,
  loadCalibration,
  modelChromeTop,
  saveCalibration,
  savedCalibrationNeedsUpgrade,
} from '../gaze/calibrationModel';
import { CameraFeatureSource, preloadFaceLandmarker } from '../gaze/faceTracker';
import { FEATURE_NAMES } from '../gaze/features';
import { LightingWatch, parseLightingSignature } from '../gaze/lighting';
import { MouseGazeSource } from '../gaze/mouseGazeSource';
import { WebcamGazeSource } from '../gaze/webcamGazeSource';
import { isTrackedLineEstimate } from '../reading/lineTracker';
import { listSampleBooks, loadBookFromFile, loadBookFromText, loadBookFromUrl, loadSampleBook, type SampleBookInfo } from '../reader/bookLoader';
import { deleteBook, getBook, getProgress, listBooks, saveBook, saveProgress } from '../reader/library';
import { ReaderView } from '../reader/readerView';
import { ScrollController } from '../reader/scrollController';
import { LineTracker } from '../reading/lineTracker';
import { PageEndDetector } from '../reading/pageEndDetector';
import { SimulatedReaderSource } from '../reading/simulatedReader';
import { FixationDetector } from '../signal/fixations';
import { CalibrationOverlay, type AccuracyCheckResult, type CalibrationMode } from '../ui/calibrationOverlay';
import { CameraPreview } from '../ui/cameraPreview';
import { DEWEY_FULL_APP_LINE, FULL_APP_LABEL, WEBCAM_UNAVAILABLE_TEXT, WEBCAM_UNAVAILABLE_TITLE } from '../ui/fullApp';
import { DebugOverlay } from '../ui/debugOverlay';
import { DriftCorrection, GazeDot } from '../ui/gazeDot';
import { HelpDialog } from '../ui/helpDialog';
import { LibraryScreen } from '../ui/libraryScreen';
import { Onboarding, hasCompletedOnboarding } from '../ui/onboarding';
import { SettingsPanel } from '../ui/settingsPanel';
import { Toaster, type ToastAction } from '../ui/toast';
import { Topbar } from '../ui/topbar';
import {
  AppearanceChangeFilter,
  BreakTimer,
  DriftWatch,
  GuidanceGate,
  PINNED_MAX_DRIFT_SD_LINES,
  PINNED_MIN_PROBABILITY,
  ProgressMeter,
  ReadingClock,
  SHORTCUTS,
  SustainedFlags,
  TYPICAL_WPM,
  TrackingStateMachine,
  accuracyCheckView,
  calibrationFitsViewport,
  calibrationOriginFits,
  cameraErrorInfo,
  coachFlag,
  computeWpm,
  correctedGazeBus,
  driftOwnerKey,
  errorMessage,
  firstFullyVisibleIndex,
  formatLines,
  formatMinutes,
  formatPercent,
  lastFullyVisibleIndex,
  minutesLeft,
  previewCorner,
  resolveTheme,
  resumeLineIndex,
  sameRidgeCore,
  sameStatus,
  shortcutFor,
  shouldIgnoreShortcut,
  textEndsOnScreen,
  trackerErrorCode,
  type SourcePhase,
  type TrackingStatus,
} from './logic';
import {
  DiagnosticsRecorder,
  RECORDED_EVENTS,
  describeEnvironment,
  downloadRecording,
  videoTrackOf,
  type PipelineControl,
} from './diagnostics';
import { HostThemeWatcher } from './hostTheme';

type Screen = 'library' | 'reader';

/** Why the webcam must not (re)start on its own until the reader asks for it again. */
type WebcamHold = { reason: 'failed'; detail: string } | { reason: 'uncalibrated' };

interface ReadingSession {
  readonly book: Book;
  readonly clock: ReadingClock;
  readonly meter: ProgressMeter;
  readonly breaks: BreakTimer;
  lastProgressEmitAt: number;
  finished: boolean;
  undos: number;
}

const HEARTBEAT_MS = 250;
const PROGRESS_EVERY_MS = 5000;
const HIDDEN_STOP_MS = 60_000;
const SCROLL_SETTLE_MS = 120;
const SAVE_POSITION_MS = 1000;
const ESTIMATE_EMIT_MS = 100;
/** Reading counts as active while gaze was valid this recently… */
const ACTIVE_GAZE_WINDOW_MS = 5000;
/** …or the reader touched the keyboard / wheel / pointer this recently (camera off). */
const ACTIVE_INPUT_WINDOW_MS = 60_000;
const POOR_HINT_AFTER_MS = 8000;
const PRELOAD_DELAY_MS = 2500;
/** Artifact build: how long Dewey lets a new reader settle in before mentioning the full app. */
const FULL_APP_MENTION_DELAY_MS = 20_000;
/** A touch-up offer that found no quiet moment for this long is dropped (the next trigger may raise it again). */
const OFFER_TTL_MS = 120_000;
/** LightingWatch's hold before "back to the calibration's light" is declared (its default). */
const LIGHTING_HOLD_MS = 5000;
/** The eyelid monitor's state reaches the debug panel at most this often. */
const APPEARANCE_DEBUG_MS = 250;
/** Remembers that the "tracker upgraded, please recalibrate once" explanation was given. */
const UPGRADE_EXPLAINED_KEY = 'calibrationUpgradeExplained.v1';

/** What a calibration run did to the model. */
type CalibrationOutcome = 'standard' | 'refresh' | 'unchanged';

/** Why the reader is offered a 5-dot touch-up. */
interface TouchUpOffer {
  reason: 'lighting' | 'drift';
  since: number;
  /** Drift offers: how far off, and which way (+1 = reads low). */
  lines?: number;
  direction?: number;
}

const TYPOGRAPHY_KEYS: readonly (keyof AppSettings)[] = ['fontSizePx', 'lineHeight', 'fontFamily', 'columnWidthCh'];
const OVERLAY_KEYS: readonly (keyof AppSettings)[] = ['showGazeDot', 'showDebugOverlay', 'showCameraPreview', 'buddyCorner', 'buddyEnabled'];
/** When several re-measures coalesce, the strongest reason wins. */
const MEASURE_PRIORITY: Readonly<Record<LayoutChangeReason, number>> = {
  scroll: 0,
  content: 1,
  resize: 2,
  'page-turn': 3,
  initial: 4,
};

/** Warms up the face tracker. The Artifact build has none: there it does nothing, and the loader tree-shakes away. */
function preloadTracker(): void {
  if (!IS_ARTIFACT) void preloadFaceLandmarker();
}

/** Named timeouts, so every pending timer can be found and cleared. */
class Timers {
  private readonly ids = new Map<string, ReturnType<typeof setTimeout>>();

  set(name: string, fn: () => void, ms: number): void {
    this.clear(name);
    this.ids.set(
      name,
      setTimeout(() => {
        this.ids.delete(name);
        fn();
      }, ms),
    );
  }

  clear(name: string): void {
    const id = this.ids.get(name);
    if (id !== undefined) clearTimeout(id);
    this.ids.delete(name);
  }

  clearAll(): void {
    for (const id of this.ids.values()) clearTimeout(id);
    this.ids.clear();
  }
}

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') ?? false;
}

export class AppController {
  readonly bus: EventBus;
  private readonly store: SettingsStore;
  private readonly root: HTMLElement;
  private readonly ac = new AbortController();
  private readonly timers = new Timers();
  private readonly unsubs: Unsubscribe[] = [];
  private started = false;
  private destroyed = false;

  // Views
  private readonly screens: HTMLElement;
  private readonly readerScreen: HTMLElement;
  private readonly library: LibraryScreen;
  private readonly topbar: Topbar;
  private readonly reader: ReaderView;
  private readonly settingsPanel: SettingsPanel;
  private readonly help: HelpDialog;
  private readonly onboarding: Onboarding;
  private readonly toasts: Toaster;
  private readonly preview: CameraPreview;
  private readonly buddy: Buddy;
  private gazeDot: GazeDot;
  /** True while the dot is forced on for the demo (it's rebuilt when this flips). */
  private gazeDotForced = false;
  private readonly debug: DebugOverlay;
  private screen: Screen = 'library';
  private readonly darkQuery: MediaQueryList | null;
  /** Artifact build only: the host frame's theme stamp, which "auto" follows. */
  private readonly hostTheme: HostThemeWatcher | null;

  // Books & reading pipeline
  private readonly fixations = new FixationDetector();
  private readonly lineTracker = new LineTracker();
  private readonly pageEnd: PageEndDetector;
  private scroll: ScrollController | null = null;
  private layout: LineLayout | null = null;
  private session: ReadingSession | null = null;
  private openSeq = 0;
  private samples: readonly SampleBookInfo[] | null = null;
  private hasRecent = false;
  private turning = false;
  /** Where the forward turn in flight is heading (from its `page-turn` event); null otherwise. */
  private turnTarget: number | null = null;
  /** U pressed while a forward turn was still sliding: undo it as soon as it lands. */
  private pendingUndo = false;
  private scrollSettling = false;
  private pipelineWasBlocked = false;
  private lastEstimateEmitAt = Number.NEGATIVE_INFINITY;
  private pendingMeasure: LayoutChangeReason | null = null;
  private contentObserver: ResizeObserver | null = null;

  // Gaze sources
  private sourceKind: GazeSourceKind | null = null;
  private source: GazeSource | null = null;
  private offSample: Unsubscribe | null = null;
  /** Bumped by every source change; async bring-ups that see a newer value back out. */
  private sourceGen = 0;
  private camera: CameraFeatureSource | null = null;
  private offCameraError: Unsubscribe | null = null;
  /** undefined = not loaded from storage yet. */
  private model: GazeModel | null | undefined = undefined;
  private savedCalibration = false;
  private calibration: CalibrationOverlay | null = null;
  private forceCalibration = false;
  private webcamHold: WebcamHold | null = null;
  private hiddenLong = false;
  private readonly introduced = new Set<GazeSourceKind>();

  // Tracking state
  private readonly tracking = new TrackingStateMachine();
  private phase: SourcePhase = 'off';
  private phaseDetail: string | undefined;
  private status: TrackingStatus | null = null;
  private pillKey = '';
  private poorHintShown = false;
  private lastValidGazeAt = Number.NEGATIVE_INFINITY;
  private lastInputAt = Number.NEGATIVE_INFINITY;

  // Loops & misc
  private heartbeatId: ReturnType<typeof setInterval> | null = null;
  private heartbeatCount = 0;
  private progressRaf = 0;
  private dragDepth = 0;
  private greeted = false;
  /** Artifact build: Dewey has mentioned (or is about to mention) the full app. */
  private fullAppMentioned = false;
  private lastError = { key: '', at: 0 };

  // Lighting & eyelid appearance (webcam only), and the guidance they lead to
  private readonly lightingWatch = new LightingWatch();
  private readonly appearance = new AppearanceMonitor(null);
  private offCameraFrames: Unsubscribe | null = null;
  private lightingState: AppEvents['lighting-state'] | null = null;
  private lastAppearanceDebugAt = Number.NEGATIVE_INFINITY;
  private readonly changeFilter = new AppearanceChangeFilter();
  private readonly sustainedFlags = new SustainedFlags();
  private readonly driftWatch = new DriftWatch();
  private readonly guidance = new GuidanceGate();
  private pendingOffer: TouchUpOffer | null = null;
  /**
   * The quick refresh was offered for the current "light changed since calibration" episode.
   * Until then the changed light is a standing reason to offer it, re-requested every lighting
   * tick, so a gate that was closed when the light changed (a book still settling in, a recent
   * calibration) only delays the offer. Cleared when the light is back, the reference changes or
   * the camera stops.
   */
  private lightingEpisodeOffered = false;
  private pendingCoach: LightingFlag | null = null;
  /** The saved calibration was made by an older tracker: explained once, then calibrate. */
  private upgradePending = false;
  private readonly quips = new QuipPicker();
  /** What the line tracker's learned drift belongs to (driftOwnerKey). */
  private driftOwner: string | null = null;
  /** The drift-corrected gaze Dewey's eyes follow (the gaze dot corrects itself). */
  private readonly driftCorrection = new DriftCorrection();
  /** Latest phase announced by the calibration overlay (tells "Done" from a cancel). */
  private lastCalibrationPhase: AppEvents['calibration']['phase'] | null = null;
  private lastReport: CalibrationReport | null = null;

  // Diagnostics
  private readonly recorder: DiagnosticsRecorder;

  constructor(root: HTMLElement) {
    this.root = root;
    this.bus = createEventBus();
    this.store = createSettingsStore(this.bus);
    const getSettings = (): AppSettings => this.store.get();
    const settings = getSettings();
    this.darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    // Before our first data-theme write: whatever is on <html> now is the Artifact host's stamp.
    this.hostTheme = IS_ARTIFACT
      ? new HostThemeWatcher(document.documentElement, () => {
          if (!this.destroyed) this.applyTheme();
        })
      : null;

    root.replaceChildren();
    root.classList.add('gr-app');

    // Screens (made inert while a dialog is open).
    this.screens = document.createElement('div');
    this.screens.className = 'gr-screens';
    this.library = new LibraryScreen({
      onOpenFile: (file) => void this.openFromFile(file),
      onOpenText: (text, title) => void this.openFromText(text, title),
      onOpenUrl: (url) => void this.openFromUrl(url),
      onOpenSample: (id) => void this.openSample(id),
      onOpenBook: (id) => void this.openSaved(id),
      onDeleteBook: (id, title) => void this.removeBook(id, title),
      onRetrySamples: () => void this.loadSamples(),
      onCommand: (name) => this.bus.emit('command', { name }),
    });
    this.library.mount(this.screens);

    this.readerScreen = document.createElement('div');
    this.readerScreen.className = 'gr-reader-screen';
    this.readerScreen.hidden = true;
    this.topbar = new Topbar({ bus: this.bus, getSettings, onSelectSource: (kind) => this.selectSource(kind) });
    this.topbar.mount(this.readerScreen);
    const stage = document.createElement('div');
    stage.className = 'gr-reader-stage';
    this.readerScreen.appendChild(stage);
    this.screens.appendChild(this.readerScreen);
    root.appendChild(this.screens);

    this.reader = new ReaderView({ mount: stage, bus: this.bus });
    this.reader.applySettings(settings);
    this.pageEnd = new PageEndDetector({ sensitivity: settings.sensitivity, glanceDownToTurn: settings.glanceDownToTurn });

    this.recorder = new DiagnosticsRecorder({ onLimit: () => this.onRecordingLimit() });

    // Floating layers, bottom to top.
    this.preview = new CameraPreview({ onHide: () => this.hidePreview() });
    this.debug = new DebugOverlay({ bus: this.bus, getSettings });
    this.gazeDot = this.createGazeDot();
    // Dewey's eyes follow the gaze where the reading layer believes it is (drift-corrected).
    this.buddy = new Buddy({ bus: correctedGazeBus(this.bus, (s) => this.driftCorrection.correct(s)), getSettings });
    this.toasts = new Toaster();
    this.onboarding = new Onboarding({ bus: this.bus, onClose: () => this.syncModalState() });
    this.settingsPanel = new SettingsPanel({
      bus: this.bus,
      getSettings,
      hasSavedCalibration: () => {
        this.currentModel();
        return this.savedCalibration;
      },
      onForgetCalibration: () => this.forgetCalibration(),
      onRecalibrate: () => this.recalibrate(),
      onCheckAccuracy: () => this.runCommand('check-accuracy'),
      onShowHelp: () => this.runCommand('show-help'),
      onReplayIntro: () => {
        this.closePanels();
        void this.runOnboarding();
      },
      onClose: () => this.syncModalState(),
      // Downloads don't exist in the Artifact frame.
      ...(IS_ARTIFACT
        ? {}
        : {
            diagnostics: {
              status: () => ({
                recording: this.recorder.recording,
                elapsedMs: this.recorder.elapsedMs,
                limitMs: this.recorder.limitMs,
                hasData: this.recorder.hasData,
              }),
              start: () => this.startRecording(),
              stop: () => this.stopRecording(true),
              download: () => this.downloadRecording(),
            },
          }),
    });
    this.help = new HelpDialog({ onClose: () => this.syncModalState() });
    for (const layer of [this.preview, this.debug, this.gazeDot, this.buddy, this.toasts, this.onboarding, this.settingsPanel, this.help]) {
      layer.mount(root);
    }

    this.bindBus();
    this.bindDom();
    this.applyTheme();
    this.updateOverlays();
    this.refreshTracking(performance.now());
  }

  // ─────────────────────────────── Lifecycle ───────────────────────────────

  /** Shows the library, loads samples and recent books, and runs the first-run intro. */
  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.showScreen('library');
    const samplesReady = this.loadSamples();
    void this.refreshRecent();
    if (!hasCompletedOnboarding()) {
      await this.runOnboarding(samplesReady);
    } else {
      this.greetLibrary();
      this.schedulePreload();
    }
  }

  /** Surfaces an error to the reader (used by the global error handlers in main.ts). */
  reportError(code: string, message: string): void {
    if (!this.destroyed) this.bus.emit('error', { code, message });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.savePositionNow();
    this.destroyed = true;
    this.sourceGen++;
    this.teardownSource();
    this.recorder.discard();
    this.camera = null;
    this.stopHeartbeat();
    this.timers.clearAll();
    if (this.progressRaf) cancelAnimationFrame(this.progressRaf);
    this.progressRaf = 0;
    this.unobserveContent();
    this.hostTheme?.destroy();
    this.ac.abort();
    for (const off of this.unsubs.splice(0)) off();
    this.scroll?.destroy();
    this.scroll = null;
    this.session = null;
    this.reader.destroy();
    for (const c of [this.help, this.settingsPanel, this.onboarding, this.toasts, this.buddy, this.gazeDot, this.debug, this.preview, this.topbar, this.library]) {
      c.destroy();
    }
    this.bus.clear();
    this.root.replaceChildren();
    this.root.classList.remove('gr-app');
    const html = document.documentElement;
    delete html.dataset.screen;
    delete html.dataset.buddyCorner;
    delete html.dataset.buddy;
  }

  // ──────────────────────────────── Screens ────────────────────────────────

  private showScreen(screen: Screen): void {
    this.screen = screen;
    const reading = screen === 'reader';
    if (reading) this.library.hide();
    else this.library.show();
    this.readerScreen.hidden = !reading;
    this.root.dataset.screen = screen;
    // The reader is a fixed, full-viewport scroller; the page itself must not scroll under it.
    document.documentElement.dataset.screen = screen;
    this.topbar.setAutoHide(reading);
    this.updateOverlays();
  }

  private modalOpen(): boolean {
    return this.settingsPanel.isOpen || this.help.isOpen || this.onboarding.isOpen;
  }

  private syncModalState(): void {
    const blocking = this.modalOpen() || this.calibration !== null;
    this.screens.inert = blocking;
    // A closing dialog may have nowhere to hand focus back to (e.g. a button in
    // another dialog that just closed); keep keyboard paging working.
    const active = document.activeElement;
    if (!blocking && this.session && this.screen === 'reader' && (!active || active === document.body)) this.focusReader();
  }

  /** Closes the settings drawer and help; returns whether anything was open. */
  private closePanels(): boolean {
    const wasOpen = this.settingsPanel.isOpen || this.help.isOpen;
    this.help.close();
    this.settingsPanel.close();
    this.syncModalState();
    return wasOpen;
  }

  private applyTheme(): void {
    const s = this.store.get();
    const theme = resolveTheme(s.theme, this.darkQuery?.matches ?? false, this.hostTheme?.theme ?? null);
    const html = document.documentElement;
    if (this.hostTheme) this.hostTheme.write(theme);
    else html.dataset.theme = theme;
    html.dataset.readingFont = s.fontFamily;
    html.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
    const bg = getComputedStyle(html).getPropertyValue('--gr-bg').trim();
    if (bg) {
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
      }
      meta.content = bg;
    }
  }

  private greetLibrary(): void {
    if (this.greeted) return;
    this.greeted = true;
    this.timers.set(
      'greet',
      () => {
        if (this.session) return;
        this.bus.emit('buddy-say', {
          text: this.hasRecent ? 'Welcome back! Your books are right where you left them.' : "Hi, I'm Dewey! Pick a book and I'll read along.",
          priority: 'normal',
          mood: 'happy',
        });
      },
      700,
    );
  }

  private async runOnboarding(samplesReady: Promise<void> = Promise.resolve()): Promise<void> {
    const pending = this.onboarding.run();
    this.syncModalState();
    const choice = await pending;
    this.syncModalState();
    if (this.destroyed) return;
    if (!choice) {
      this.focusLibraryIfLost();
      this.greetLibrary();
      return;
    }
    if (choice === 'webcam') preloadTracker();
    this.selectSource(choice);
    if (this.session) return;
    // Get them reading straight away, with the guide to how reading eyes work.
    await samplesReady;
    const first = this.samples?.[0];
    if (first && !this.session && !this.destroyed) await this.openSample(first.id);
    else {
      this.focusLibraryIfLost();
      this.greetLibrary();
    }
  }

  /** A dialog that opened on page load has nowhere to hand focus back to; land on the library's primary action. */
  private focusLibraryIfLost(): void {
    if (this.screen !== 'library') return;
    const a = document.activeElement;
    // Checked before the browser's focus fixup, while activeElement may still be the now-hidden Skip or Next button.
    if (!(a instanceof HTMLElement) || a === document.body || a.closest('[hidden]')) this.library.focusPrimary();
  }

  // ───────────────────────────────── Books ─────────────────────────────────

  private async loadSamples(): Promise<void> {
    this.library.setSamples({ status: 'loading' });
    try {
      const samples = await listSampleBooks();
      if (this.destroyed) return;
      this.samples = samples;
      this.library.setSamples({ status: 'ready', samples });
    } catch (err) {
      console.warn('[app] could not load the sample books', err);
      if (!this.destroyed) this.library.setSamples({ status: 'error', message: 'The sample books could not be loaded.' });
    }
  }

  private async refreshRecent(): Promise<void> {
    try {
      const entries = await listBooks();
      if (this.destroyed) return;
      this.hasRecent = entries.length > 0;
      this.library.setRecent(entries);
    } catch (err) {
      console.warn('[app] could not list saved books', err);
    }
  }

  private openFromFile(file: File): Promise<boolean> {
    return this.openWith(`Opening “${file.name}”…`, () => loadBookFromFile(file), 'file');
  }

  private openFromText(text: string, title: string | null): Promise<boolean> {
    // The loader detects the format (text, Markdown or HTML) and a title when none is given.
    return this.openWith(
      'Preparing your text…',
      async () => loadBookFromText(text, { ...(title ? { title } : {}), source: 'paste' }),
      'paste',
    );
  }

  private openFromUrl(url: string): Promise<boolean> {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the raw text */
    }
    return this.openWith(`Fetching from ${host}…`, () => loadBookFromUrl(url), 'url');
  }

  private openSample(id: string): Promise<boolean> {
    return this.openWith('Opening the sample…', () => loadSampleBook(id));
  }

  private openSaved(id: string): Promise<boolean> {
    return this.openWith('Opening…', async () => {
      const book = await getBook(id);
      if (!book) throw new Error('That book is no longer saved on this device.');
      return book;
    });
  }

  /**
   * Loads a book with a busy indicator; only the most recent request wins. `origin` names the
   * library control that started it, so a failure is explained right there (and stays) instead
   * of in a toast far from the form.
   */
  private async openWith(label: string, load: () => Promise<Book>, origin?: 'url' | 'paste' | 'file'): Promise<boolean> {
    const seq = ++this.openSeq;
    const fromLibrary = this.screen === 'library';
    this.library.setBusy(label);
    const busyToast = this.screen === 'reader' ? this.toasts.show({ id: 'opening', message: label, durationMs: 0 }) : null;
    try {
      const book = await load();
      if (seq !== this.openSeq || this.destroyed) return false;
      await this.openBook(book, seq);
      this.library.resetForms();
      return true;
    } catch (err) {
      if (seq !== this.openSeq || this.destroyed) return false;
      console.warn('[app] could not open the book', err);
      if (origin && fromLibrary && this.screen === 'library') {
        this.library.showOpenError(origin, errorMessage(err));
      } else {
        // Stays until dismissed: the explanation can be long, and nothing else holds it open.
        this.toasts.show({ id: 'open-failed', tone: 'error', title: 'Couldn’t open that book', message: errorMessage(err), durationMs: 0 });
      }
      return false;
    } finally {
      if (busyToast) this.toasts.dismiss(busyToast);
      if (seq === this.openSeq && !this.destroyed) this.library.setBusy(null);
    }
  }

  private async openBook(book: Book, seq: number): Promise<void> {
    if (this.session?.book.id === book.id) {
      this.toasts.show({ id: 'already-open', message: `“${book.title}” is already open.` });
      return;
    }
    // Saving and restoring progress are conveniences: failures must not block reading.
    try {
      await saveBook(book);
    } catch (err) {
      console.warn('[app] could not save the book to the library', err);
    }
    let position: ReadingPosition | null = null;
    try {
      position = await getProgress(book.id);
    } catch {
      position = null;
    }
    if (seq !== this.openSeq || this.destroyed) return;

    this.endSession();
    this.closePanels();
    // Show the reader before rendering: position restore needs a laid-out scroller.
    this.showScreen('reader');
    try {
      this.reader.open(book, position);
    } catch (err) {
      try {
        this.reader.close();
      } catch {
        /* already broken */
      }
      // endSession() above closed the previous book, but its gaze source (possibly the
      // camera) is still running. The library has no status pill, so stop it here.
      this.topbar.setBook(null);
      document.title = 'Gaze Reader';
      this.showScreen('library');
      this.syncSource();
      void this.refreshRecent();
      throw err;
    }
    this.startSession(book, position);
  }

  private closeBook(): void {
    const session = this.session;
    const pages = this.scroll?.pagesTurned ?? 0;
    this.endSession();
    this.topbar.setBook(null);
    document.title = 'Gaze Reader';
    this.showScreen('library');
    this.syncSource();
    void this.refreshRecent();
    this.library.focusPrimary();
    if (session && pages > 0) {
      this.bus.emit('buddy-say', {
        text: pages === 1 ? 'One page further than before. Nice!' : `${pages} pages this time. Lovely reading!`,
        priority: 'normal',
        mood: 'happy',
      });
    }
  }

  private async removeBook(id: string, title: string): Promise<void> {
    // Where the removed card sat, so keyboard focus stays in the list instead of jumping to the top.
    const cards = [...this.library.el.querySelectorAll('.gr-card--book')];
    const index = Math.max(0, cards.findIndex((c) => c.contains(document.activeElement)));
    let book: Book | null = null;
    let progress: ReadingPosition | null = null;
    try {
      [book, progress] = await Promise.all([getBook(id), getProgress(id)]);
      await deleteBook(id);
    } catch (err) {
      console.warn('[app] could not remove the book', err);
      this.toasts.show({ tone: 'error', message: `Couldn’t remove “${title}”.` });
      return;
    }
    await this.refreshRecent();
    if (!(document.activeElement instanceof HTMLElement) || document.activeElement === document.body) this.library.focusRecent(index);
    const saved = book;
    this.toasts.show({
      id: `removed:${id}`,
      message: `Removed “${title}” from this device.`,
      actions: saved ? [{ label: 'Undo', primary: true, run: () => void this.restoreBook(saved, progress) }] : [],
      // Long enough for a keyboard or screen-reader user to reach Undo (WCAG 2.2.1).
      durationMs: 20_000,
    });
  }

  private async restoreBook(book: Book, progress: ReadingPosition | null): Promise<void> {
    try {
      await saveBook(book);
      if (progress) await saveProgress(progress);
    } catch (err) {
      console.warn('[app] could not restore the book', err);
      this.toasts.show({ tone: 'error', message: `Couldn’t restore “${book.title}”.` });
    }
    await this.refreshRecent();
  }

  // ──────────────────────────── Session & progress ────────────────────────────

  private startSession(book: Book, position: ReadingPosition | null): void {
    this.scroll = new ScrollController({ scroller: this.reader.scroller, bus: this.bus, getSettings: () => this.store.get() });
    this.session = {
      book,
      clock: new ReadingClock(),
      meter: new ProgressMeter(book.wordCount),
      breaks: new BreakTimer(),
      lastProgressEmitAt: performance.now(),
      finished: false,
      undos: 0,
    };
    this.layout = null;
    // Same source and calibration as the last book: keep the vertical offset already learned.
    this.resetPipeline('auto');
    this.guidance.startSession(performance.now());
    this.driftWatch.reset();
    this.pendingOffer = null;
    this.pendingCoach = null;
    this.topbar.setBook(book);
    document.title = `${book.title} · Gaze Reader`;
    this.focusReader();
    this.bus.emit('book-opened', {
      id: book.id,
      title: book.title,
      author: book.author,
      wordCount: book.wordCount,
      resumed: (position?.fraction ?? 0) > 0.001,
    });
    this.observeContent();
    this.scheduleMeasure('initial', 50);
    this.updateProgressUi();
    this.startHeartbeat();
    // The simulated reader remembers where it was in the previous book; start it afresh.
    if (this.sourceKind === 'simulated') {
      this.sourceGen++;
      this.teardownSource();
    }
    this.syncSource();
  }

  /** Saves and forgets the current book without changing screens. */
  private endSession(): void {
    if (!this.session) return;
    this.savePositionNow();
    this.emitProgress(performance.now());
    this.session = null;
    this.stopHeartbeat();
    for (const name of ['save-position', 'scroll-settle', 'measure', 'poor-hint', 'resize-hint']) this.timers.clear(name);
    this.pendingMeasure = null;
    this.unobserveContent();
    this.scroll?.destroy();
    this.scroll = null;
    this.turning = false;
    this.pendingUndo = false;
    this.scrollSettling = false;
    this.reader.close();
    this.layout = null;
    // The line tracker keeps its drift for the next book (startSession decides whether it fits).
    this.resetPipeline('none');
    this.pendingOffer = null;
    this.toasts.dismiss('touch-up');
  }

  private focusReader(): void {
    const scroller = this.reader.scroller;
    if (!scroller.hasAttribute('tabindex')) scroller.tabIndex = -1;
    scroller.focus({ preventScroll: true });
  }

  private startHeartbeat(): void {
    if (this.heartbeatId === null) this.heartbeatId = setInterval(this.heartbeat, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatId !== null) clearInterval(this.heartbeatId);
    this.heartbeatId = null;
  }

  private readonly heartbeat = (): void => {
    const now = performance.now();
    // Background tabs throttle camera frames to about 1 Hz, which would read as
    // "face lost" (and worry Dewey). Hold the state until the tab is visible again.
    if (!document.hidden) this.refreshTracking(now);
    this.recorder.tick(); // stops a recording at its time limit (onRecordingLimit)
    const session = this.session;
    if (!session) return;
    if (!document.hidden) {
      this.tickLighting(now);
      this.pollGuidance(now);
    }
    const s = this.store.get();
    const active = this.isActivelyReading(now);
    const dt = session.clock.tick(now, active);
    session.meter.update(this.reader.progress(), session.clock.minutes);
    if (session.breaks.tick(dt, active, s.breakIntervalMin, s.breakReminders)) this.breakDue(session);
    if (now - session.lastProgressEmitAt >= PROGRESS_EVERY_MS) this.emitProgress(now);
    if (++this.heartbeatCount % 4 === 0) this.updateProgressUi();
  };

  private isActivelyReading(now: number): boolean {
    if (document.hidden || this.screen !== 'reader' || this.modalOpen() || this.calibration) return false;
    return now - this.lastValidGazeAt < ACTIVE_GAZE_WINDOW_MS || now - this.lastInputAt < ACTIVE_INPUT_WINDOW_MS;
  }

  private emitProgress(now: number): void {
    const session = this.session;
    if (!session) return;
    session.lastProgressEmitAt = now;
    const fraction = Math.min(1, Math.max(0, this.reader.progress() || 0));
    const minutes = session.clock.minutes;
    this.bus.emit('book-progress', {
      fraction,
      wordsRead: Math.round(fraction * session.book.wordCount),
      wpm: computeWpm(session.meter.wordsAdvanced, session.meter.minutesAtLastAdvance),
      pagesTurned: this.scroll?.pagesTurned ?? 0,
      minutesReading: Math.round(minutes * 10) / 10,
    });
  }

  private scheduleProgressUi(): void {
    if (this.progressRaf) return;
    this.progressRaf = requestAnimationFrame(() => {
      this.progressRaf = 0;
      this.updateProgressUi();
    });
  }

  private updateProgressUi(): void {
    const session = this.session;
    if (!session) return;
    const fraction = this.reader.progress();
    const wpm = computeWpm(session.meter.wordsAdvanced, session.meter.minutesAtLastAdvance) ?? TYPICAL_WPM;
    const left = formatMinutes(minutesLeft(fraction, session.book.wordCount, wpm));
    this.topbar.setProgress(fraction, formatPercent(fraction), fraction >= 0.995 || !left ? '' : `${left} left`);
  }

  private breakDue(session: ReadingSession): void {
    this.bus.emit('break-due', { minutesReading: Math.round(session.clock.minutes) });
    // Dewey delivers the reminder; without him, a toast does.
    if (!this.store.get().buddyEnabled) {
      this.toasts.show({
        id: 'break',
        title: 'Time for an eye break',
        message: 'Look at something about 6 metres (20 feet) away for 20 seconds.',
        durationMs: 15_000,
      });
    }
  }

  private finishBook(): void {
    const session = this.session;
    if (!session || session.finished) return;
    session.finished = true;
    this.bus.emit('book-finished', {
      title: session.book.title,
      minutesReading: Math.round(session.clock.minutes),
      pagesTurned: this.scroll?.pagesTurned ?? 0,
    });
    this.savePositionNow();
    this.emitProgress(performance.now());
    this.toasts.show({
      id: 'finished',
      tone: 'success',
      title: 'The end!',
      message: `You finished “${session.book.title}”.`,
      actions: [{ label: 'Back to the library', primary: true, run: () => this.closeBook() }],
      durationMs: 12_000,
    });
  }

  private scheduleSavePosition(): void {
    this.timers.set('save-position', () => this.savePositionNow(), SAVE_POSITION_MS);
  }

  private savePositionNow(): void {
    if (!this.session) return;
    let pos: ReadingPosition | null = null;
    try {
      pos = this.reader.getPosition();
    } catch {
      pos = null;
    }
    if (!pos) return;
    saveProgress(pos).catch((err: unknown) => console.warn('[app] could not save reading progress', err));
  }

  // ──────────────────────────────── Pipeline ────────────────────────────────

  private readonly onSample = (s: GazeSample): void => {
    if (!this.session || s.source !== this.sourceKind) return;
    this.bus.emit('gaze', s);
    this.tracking.push(s);
    // A mouse source keeps emitting valid samples from a pointer left resting, so it is no proof
    // anyone is there; real pointer movement counts as input instead (see bindDom).
    if (s.valid && s.source !== 'mouse') this.lastValidGazeAt = s.t;

    if (this.pipelineBlocked()) {
      this.pipelineWasBlocked = true;
      this.recorder.gaze(s, false);
      return;
    }
    this.recorder.gaze(s, true);
    if (this.pipelineWasBlocked) {
      // Don't let a fixation straddle a pause (dialog, scroll, calibration).
      // (A recording replays this from the samples' "fed" flags.)
      this.pipelineWasBlocked = false;
      this.fixations.reset();
    }

    const { completed } = this.fixations.push(s);
    if (completed) {
      this.bus.emit('fixation', completed);
      const estimate = this.lineTracker.onFixation(completed);
      this.bus.emit('line-estimate', estimate);
      this.recorder.estimate(estimate, true);
      this.lastEstimateEmitAt = s.t;
      this.onReadingEstimate(estimate);
    }
    const live = this.lineTracker.onSample(s);
    if (live && s.t - this.lastEstimateEmitAt >= ESTIMATE_EMIT_MS) {
      this.bus.emit('line-estimate', live);
      this.recorder.estimate(live, false);
      this.lastEstimateEmitAt = s.t;
    }
    const decision = this.pageEnd.update({ t: s.t, gaze: s, estimate: this.lineTracker.estimate, layout: this.layout });
    if (this.debug.visible) this.debug.showDecision(decision);
    if (decision.trigger) this.onPageEnd(decision);
  };

  /** A fixation was placed on a line: note reading (guidance waits for pauses) and watch the drift. */
  private onReadingEstimate(e: LineEstimate): void {
    if (e.lineIndex < 0) return;
    this.guidance.noteReading(e.t);
    if (this.sourceKind !== 'webcam') return;
    const pitch = this.layout?.linePitch ?? NaN;
    const sd = isTrackedLineEstimate(e) ? (e.driftSdY ?? NaN) : NaN;
    const pinned = e.probability >= PINNED_MIN_PROBABILITY && !(sd > PINNED_MAX_DRIFT_SD_LINES * pitch);
    if (this.driftWatch.push(e.t, e.driftY, pitch, pinned)) {
      this.requestOffer({ reason: 'drift', since: e.t, lines: this.driftWatch.peakLines, direction: this.driftWatch.direction });
    }
  }

  /** The reading model only sees samples while the text is still and the reader is looking at it. */
  private pipelineBlocked(): boolean {
    return (
      this.layout === null ||
      this.phase !== 'running' ||
      this.screen !== 'reader' ||
      document.hidden ||
      this.turning ||
      this.scrollSettling ||
      (this.scroll?.animating ?? false) ||
      this.calibration !== null ||
      this.modalOpen()
    );
  }

  /**
   * Resets fixations and the page-end detector, and the line tracker as asked:
   *  - 'none' keeps it (and its learned drift);
   *  - 'auto' starts it over but keeps the drift when it was learned with the same gaze source
   *    and calibration (reopening a book), otherwise starts from "calibration is about right";
   *  - 'fresh' always starts over (a new calibration): the light is the calibration's, so the
   *    drift prior drops its "the light may differ" uniform share (reset({ calibrated: true })).
   */
  private resetPipeline(tracker: 'none' | 'auto' | 'fresh'): void {
    this.fixations.reset();
    this.pageEnd.reset();
    let keepDrift = false;
    const calibrated = tracker === 'fresh';
    if (tracker !== 'none') {
      const owner = this.currentDriftOwner();
      keepDrift = tracker === 'auto' && owner !== null && owner === this.driftOwner;
      this.lineTracker.reset(keepDrift ? { keepDrift: true } : calibrated ? { calibrated: true } : {});
      this.driftOwner = owner;
      this.driftWatch.reset();
    }
    this.recordInput({ k: 'pipeline-reset', t: performance.now(), full: tracker !== 'none', keepDrift, ...(calibrated ? { calibrated } : {}) });
    this.pipelineWasBlocked = false;
    this.lastEstimateEmitAt = Number.NEGATIVE_INFINITY;
  }

  /** Who the drift learned from here on belongs to: the source that is (or will be) running, and its calibration. */
  private currentDriftOwner(): string | null {
    const kind = this.sourceKind ?? this.store.get().gazeSource;
    return driftOwnerKey(kind, kind === 'webcam' ? this.currentModel()?.trainedAt : null);
  }

  /** A different gaze source (or calibration) took over mid-book: keep the line, re-learn the offset. */
  private adoptDriftOwner(): void {
    const owner = this.currentDriftOwner();
    if (owner === this.driftOwner) return;
    this.driftOwner = owner;
    this.driftWatch.reset();
    const t = performance.now();
    this.lineTracker.appearanceChangedAt(t);
    this.recordInput({ k: 'appearance', t, at: t });
  }

  private resetFixations(unblock: boolean): void {
    this.fixations.reset();
    if (unblock) this.pipelineWasBlocked = false;
    this.recordInput({ k: 'fixations-reset', t: performance.now(), unblock });
  }

  /** Starts the page-end detector's cooldown (every scroll, automatic or not). */
  private notifyScrolled(): void {
    const t = performance.now();
    this.pageEnd.notifyScrolled(t);
    this.recordInput({ k: 'scrolled', t });
  }

  private recordInput(entry: PipelineControl): void {
    if (this.recorder.recording) this.recorder.input(entry);
  }

  // ────────────────────────────── Page turning ──────────────────────────────

  private onPageEnd(decision: PageEndDecision): void {
    const scroll = this.scroll;
    if (!scroll || this.turning || scroll.animating) return;
    // The reader has reached the last line of the book. The reader view keeps
    // generous padding below the text, so the scroller isn't "at the end" yet,
    // but turning would only show a blank page with nothing left to read.
    // Pausing auto-scroll stops page turns, not the finale: a reader who paged
    // through by hand still finished the book.
    if (scroll.atEnd() || this.onLastPage(this.layout)) {
      this.finishBook();
      this.notifyScrolled();
      return;
    }
    if (!this.store.get().autoScroll) return;
    void this.turnPage({ auto: true, reason: decision.reason, decision });
  }

  private async pageForward(): Promise<void> {
    const scroll = this.scroll;
    if (!scroll || !this.session) return;
    if (this.turning) {
      // Pressed again mid-turn: the reader is ahead of the animation, so land it now.
      if (scroll.animating && this.turnTarget !== null) void scroll.scrollTo(this.turnTarget, 0);
      return;
    }
    if (scroll.atEnd()) {
      this.finishBook();
      return;
    }
    // Measure afresh: while a manual scroll settles, the stored layout describes the old position.
    const layout = this.measure('scroll') ?? this.layout;
    const lastPage = this.onLastPage(layout);
    await this.turnPage({ auto: false, reason: 'manual', layout });
    // An explicit "next page" on the last page still moves, then celebrates.
    if (lastPage && this.scroll === scroll) this.finishBook();
  }

  private async turnPage(opts: { auto: boolean; reason: string; decision?: PageEndDecision; layout?: LineLayout | null }): Promise<void> {
    const scroll = this.scroll;
    if (!scroll || this.turning || scroll.animating) return;
    // An automatic turn must use the layout the decision's line index refers to.
    const layout = opts.layout ?? this.layout ?? this.measure('scroll');
    const lines = layout?.lines ?? [];
    const target =
      opts.decision && opts.decision.targetLineIndex >= 0 && opts.decision.targetLineIndex < lines.length
        ? opts.decision.targetLineIndex
        : lastFullyVisibleIndex(lines);
    const oldDocTop = lines[target]?.docTop ?? null;
    const startTop = this.reader.scroller.scrollTop;
    if (opts.decision) this.bus.emit('page-end', opts.decision);
    this.turning = true;
    this.turnTarget = null;
    try {
      await scroll.turnPage(layout, target, { auto: opts.auto, reason: opts.reason });
    } catch (err) {
      console.warn('[app] page turn failed', err);
    } finally {
      this.turning = false;
      this.turnTarget = null;
    }
    const undoNext = this.pendingUndo;
    this.pendingUndo = false;
    if (this.scroll !== scroll || !this.session) return;
    if (Math.abs(this.reader.scroller.scrollTop - startTop) < 1) {
      // Nothing moved, so the reading model is still right; just start the cooldown.
      this.notifyScrolled();
    } else {
      this.afterJump('turn', oldDocTop);
    }
    // Same path as pressing U just after the turn landed; undoTurn sets `turning` synchronously.
    if (undoNext) void this.undoTurn();
  }

  /** Every remaining line of the book is on screen (see textEndsOnScreen in logic.ts). */
  private onLastPage(layout: LineLayout | null): boolean {
    if (!layout) return false;
    return textEndsOnScreen(layout.lines, layout.viewport.bottom, this.textBottom());
  }

  /**
   * Viewport y of the bottom of the book's text: the last chapter, which the
   * reader view renders just before its "End of book" marker. Null when that
   * structure isn't found (then the line layout decides).
   */
  private textBottom(): number | null {
    const end = this.reader.content.querySelector(`:scope > .${CSS_PREFIX}end`);
    const lastChapter = end?.previousElementSibling;
    if (!lastChapter) return null;
    const r = lastChapter.getBoundingClientRect();
    return r.height > 0 ? r.bottom : null;
  }

  private async pageBack(): Promise<void> {
    const scroll = this.scroll;
    if (!scroll || this.turning || scroll.animating) return;
    this.turning = true;
    try {
      await scroll.pageBack(this.layout);
    } catch (err) {
      console.warn('[app] page back failed', err);
    } finally {
      this.turning = false;
    }
    if (this.scroll === scroll && this.session) this.afterJump('back');
  }

  private async undoTurn(): Promise<void> {
    const scroll = this.scroll;
    const session = this.session;
    if (!scroll || !session) return;
    if (this.turning) {
      // Pressed while a forward turn is still sliding: take it back as soon as it lands.
      // (turnTarget is set only during a forward turn, so an undo or page-back animation
      // still ignores it, and holding U can't queue several undos.)
      if (this.turnTarget !== null) this.pendingUndo = true;
      return;
    }
    this.turning = true;
    let undone = false;
    try {
      undone = await scroll.undo();
    } catch (err) {
      console.warn('[app] undo failed', err);
    } finally {
      this.turning = false;
    }
    if (this.scroll !== scroll || this.session !== session) return;
    if (!undone) {
      this.toasts.show({ id: 'undo', message: 'There’s no page turn to undo.' });
      return;
    }
    this.afterJump('undo');
    session.undos++;
    if (session.undos === 2 && this.store.get().sensitivity !== 'relaxed') {
      this.toasts.show({
        id: 'undo',
        title: 'Pages turning too early?',
        message: 'Relaxed sensitivity waits until you have clearly finished the page.',
        actions: [{ label: 'Use Relaxed', primary: true, run: () => this.store.update({ sensitivity: 'relaxed' }) }],
      });
    }
  }

  /** After any programmatic jump: re-measure, re-seat the line tracker, start the cooldown. */
  private afterJump(kind: 'turn' | 'back' | 'undo', oldDocTop: number | null = null): void {
    this.timers.clear('scroll-settle');
    this.scrollSettling = false;
    const layout = this.measure(kind === 'undo' ? 'scroll' : 'page-turn');
    if (layout && kind !== 'undo') {
      const resume = kind === 'turn' ? resumeLineIndex(layout.lines, oldDocTop, layout.linePitch) : firstFullyVisibleIndex(layout.lines);
      if (resume >= 0) {
        this.lineTracker.afterPageTurn(resume);
        this.recordInput({ k: 'resume', t: performance.now(), line: resume });
      }
    }
    this.notifyScrolled();
    this.resetFixations(false);
    this.updateProgressUi();
    this.scheduleSavePosition();
  }

  // ───────────────────────────────── Layout ─────────────────────────────────

  private measure(reason: LayoutChangeReason): LineLayout | null {
    if (!this.session || this.screen !== 'reader') return null;
    let layout: LineLayout;
    try {
      layout = this.reader.measureLayout();
    } catch (err) {
      console.warn('[app] measuring the text failed', err);
      return this.layout;
    }
    this.layout = layout;
    this.lineTracker.setLayout(layout, reason);
    if (this.recorder.recording) this.recorder.layout(layout, reason, performance.now());
    this.bus.emit('layout', layout);
    return layout;
  }

  /** Debounced re-measure; coalesced requests keep the strongest reason. */
  private scheduleMeasure(reason: LayoutChangeReason, delayMs = 150): void {
    if (!this.session) return;
    const pending = this.pendingMeasure;
    if (pending === null || MEASURE_PRIORITY[reason] > MEASURE_PRIORITY[pending]) this.pendingMeasure = reason;
    this.timers.set(
      'measure',
      () => {
        const r = this.pendingMeasure ?? reason;
        this.pendingMeasure = null;
        // A turn in flight re-measures when it lands.
        if (this.turning || this.scroll?.animating) return;
        this.measure(r);
      },
      delayMs,
    );
  }

  private observeContent(): void {
    this.unobserveContent();
    if (typeof ResizeObserver === 'undefined') return;
    // Catches late font loads and typography changes that reflow the text.
    let last: { width: number; height: number } | null = null;
    this.contentObserver = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) {
        // A reflow (typography, window width, zoom, late fonts or images) moves the text, so
        // stored undo offsets would land on unrelated text. Height-only window resizes don't
        // change the content box, so they keep the history.
        if (last && (Math.abs(box.width - last.width) > 0.5 || Math.abs(box.height - last.height) > 0.5)) {
          this.scroll?.clearHistory();
        }
        last = { width: box.width, height: box.height };
      }
      this.scheduleMeasure('content');
    });
    this.contentObserver.observe(this.reader.content);
  }

  private unobserveContent(): void {
    this.contentObserver?.disconnect();
    this.contentObserver = null;
  }

  private readonly onReaderScroll = (): void => {
    this.scheduleProgressUi();
    if (!this.session || this.turning || this.scroll?.animating) return;
    // The trailing scroll event of a jump we have already measured.
    if (!this.scrollSettling && this.layout && Math.abs(this.reader.scroller.scrollTop - this.layout.scrollTop) < 1) return;
    this.scrollSettling = true;
    this.notifyScrolled();
    this.timers.set(
      'scroll-settle',
      () => {
        this.scrollSettling = false;
        if (!this.session) return;
        this.measure('scroll');
        this.resetFixations(false);
        this.scheduleSavePosition();
      },
      SCROLL_SETTLE_MS,
    );
  };

  // ──────────────────────────────── Sources ────────────────────────────────

  private viewportSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** The source that should be running right now, or null. */
  private desiredSource(): GazeSourceKind | null {
    if (this.destroyed || !this.session || this.hiddenLong) return null;
    const kind = this.store.get().gazeSource;
    if (kind === 'webcam' && this.webcamHold) return null;
    return kind;
  }

  /** Brings the running source in line with desiredSource(). Idempotent; safe to call at any time. */
  private syncSource(): void {
    const want = this.desiredSource();
    if (want !== null && want === this.sourceKind) return;
    const gen = ++this.sourceGen;
    this.teardownSource();
    if (want === null) {
      this.setIdlePhase();
      return;
    }
    this.sourceKind = want;
    void this.bringUp(want, gen);
  }

  /** The user picked a source (top bar, toast action, onboarding). Re-picking the current one retries it. */
  private selectSource(kind: GazeSourceKind): void {
    if (IS_ARTIFACT && kind === 'webcam') {
      this.webcamUnavailable();
      return;
    }
    if (kind === 'webcam') this.webcamHold = null;
    const s = this.store.get();
    const patch: Partial<AppSettings> = {};
    // The demo exists to show automatic page turns.
    if (kind === 'simulated' && !s.autoScroll) patch.autoScroll = true;
    if (s.gazeSource !== kind) patch.gazeSource = kind;
    if (Object.keys(patch).length > 0) this.store.update(patch);
    if (patch.gazeSource === undefined) this.syncSource();
    if (kind === 'webcam' && !this.session) preloadTracker();
  }

  private async bringUp(kind: GazeSourceKind, gen: number): Promise<void> {
    const stale = (): boolean => gen !== this.sourceGen || this.destroyed;
    try {
      let source: GazeSource;
      if (kind === 'webcam') {
        const camera = await this.prepareWebcam(gen);
        if (stale()) return;
        if (!camera) {
          this.teardownSource();
          this.setIdlePhase();
          return;
        }
        source = new WebcamGazeSource({ features: camera, getModel: () => this.model ?? null });
      } else {
        this.setPhase('starting');
        source =
          kind === 'mouse'
            ? new MouseGazeSource({ noisePx: () => this.store.get().mouseNoisePx })
            : new SimulatedReaderSource({
                getLayout: () => this.layout,
                wpm: () => this.store.get().simulatedWpm,
                seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0,
              });
      }
      const off = source.onSample(this.onSample);
      try {
        await source.start();
      } catch (err) {
        off();
        throw err;
      }
      if (stale()) {
        off();
        source.stop();
        return;
      }
      this.source = source;
      this.offSample = off;
      // A drift learned with another source (or calibration) doesn't apply to this one.
      if (this.session) this.adoptDriftOwner();
      this.setPhase('running');
      this.introduceSource(kind);
    } catch (err) {
      if (stale()) return;
      console.error(`[app] could not start the ${kind} source`, err);
      this.teardownSource();
      if (kind === 'webcam') {
        this.cameraFailed(err);
        this.setIdlePhase();
      } else {
        this.setPhase('error', errorMessage(err));
        this.toasts.show({ id: 'source', tone: 'error', title: 'Couldn’t start', message: errorMessage(err) });
      }
    }
  }

  /** Stops whatever is running (or starting), including the camera and any calibration. */
  private teardownSource(): void {
    // Its 'Refresh now' button belongs to the webcam session being torn down.
    this.toasts.dismiss('refresh-calibration');
    this.offSample?.();
    this.offSample = null;
    this.source?.stop();
    this.source = null;
    this.sourceKind = null;
    // Resolves the pending run() with null; the bring-up sees a stale generation and backs out.
    this.calibration?.cancel();
    this.offCameraError?.();
    this.offCameraError = null;
    this.offCameraFrames?.();
    this.offCameraFrames = null;
    this.camera?.stop();
    this.stopConditionWatch();
    this.resetFixations(true);
    this.updateOverlays();
  }

  /**
   * Starts the camera and makes sure there is a usable calibration. Returns
   * the running camera, or null (after telling the reader why) when the
   * webcam can't be used.
   */
  private async prepareWebcam(gen: number): Promise<CameraFeatureSource | null> {
    // Unreachable in the Artifact build (the webcam can't be selected there); the early
    // return also keeps the camera and face-tracker code out of that bundle.
    if (IS_ARTIFACT) return null;
    if (!this.forceCalibration && !this.currentModel() && this.explainUpgradeIfNeeded()) {
      // Say why before a minute of dots, and let the reader choose when (as the extension does):
      // the overlay would cover a toast, the page is inert under it, and Dewey may be hidden.
      // The camera isn't switched on for nothing. "Calibrate" (recalibrate()) clears the hold.
      this.webcamHold = { reason: 'uncalibrated' };
      this.showNotCalibrated();
      return null;
    }
    const stale = (): boolean => gen !== this.sourceGen || this.destroyed;
    this.setPhase('starting');
    this.camera ??= new CameraFeatureSource();
    const camera = this.camera;
    try {
      await camera.start();
    } catch (err) {
      if (!stale()) this.cameraFailed(err);
      return null;
    }
    if (stale()) return null;
    if (!camera.running) {
      this.cameraFailed(camera.lastError ?? new Error('The camera did not start.'));
      return null;
    }
    this.offCameraError?.();
    this.offCameraError = camera.onError((err) => this.onCameraRuntimeError(err));
    // Lighting and eyelid watch, diagnostics (subscribed before any calibration, so a recording has its frames).
    this.offCameraFrames?.();
    this.offCameraFrames = camera.onFrame(this.onCameraFrame);
    this.updateOverlays();

    const model = this.currentModel();
    if (!model || this.forceCalibration) {
      const outcome = await this.calibrate('standard', gen);
      if (!outcome) return null;
      this.afterCalibration(outcome, 'bring-up');
      return camera;
    }
    const fit = this.calibrationFit(model);
    if (fit !== 'fits') {
      const text =
        fit === 'size'
          ? 'Your window changed size, so let’s do a quick 5-dot refresh.'
          : 'Your window layout changed (fullscreen or toolbar), so let’s do a quick 5-dot refresh.';
      this.bus.emit('buddy-say', { text, priority: 'high', mood: 'thinking' });
      const outcome = await this.calibrate('quick', gen);
      if (!outcome) return null;
      this.afterCalibration(outcome, 'bring-up');
      return camera;
    }
    return camera;
  }

  private cameraFailed(err: unknown): void {
    const code = trackerErrorCode(err);
    const info = cameraErrorInfo(code);
    console.warn(`[app] camera unavailable (${code})`, err);
    this.webcamHold = { reason: 'failed', detail: info.title };
    const actions: ToastAction[] = [];
    if (info.retryable) actions.push({ label: 'Try again', primary: true, run: () => this.selectSource('webcam') });
    actions.push({ label: 'Use my mouse', primary: !info.retryable, run: () => this.selectSource('mouse') });
    actions.push({ label: 'Watch a demo', run: () => this.selectSource('simulated') });
    this.toasts.show({ id: 'camera', tone: 'error', title: info.title, message: info.message, actions, durationMs: 20_000 });
    this.bus.emit('buddy-say', { text: info.buddyLine, priority: 'high', mood: 'worried' });
  }

  /** The camera stopped on its own after starting (unplugged, taken by another app). */
  private onCameraRuntimeError(err: unknown): void {
    if (this.sourceKind !== 'webcam') return;
    this.cameraFailed(err);
    this.syncSource();
  }

  private introduceSource(kind: GazeSourceKind): void {
    if (this.introduced.has(kind)) return;
    this.introduced.add(kind);
    if (IS_ARTIFACT) this.mentionFullApp(FULL_APP_MENTION_DELAY_MS);
    if (kind === 'mouse') {
      this.bus.emit('buddy-say', { text: 'Point at the line you’re reading. I’ll turn the page at the bottom.', priority: 'high', mood: 'happy' });
    } else if (kind === 'simulated') {
      this.bus.emit('buddy-say', { text: 'Watch me read! When I reach the last line, the page turns itself.', priority: 'high', mood: 'excited' });
    }
  }

  /** Artifact build: the webcam was asked for (top bar, the C shortcut). Say why not, and where it works. */
  private webcamUnavailable(): void {
    if (!IS_ARTIFACT) return; // (lets the web build drop the body)
    this.toasts.show({
      id: 'webcam-unavailable',
      title: WEBCAM_UNAVAILABLE_TITLE,
      message: WEBCAM_UNAVAILABLE_TEXT,
      links: [{ label: FULL_APP_LABEL, href: FULL_APP_URL }],
      durationMs: 12_000,
    });
    this.mentionFullApp(0);
  }

  /** Artifact build: Dewey mentions the full version once per visit. */
  private mentionFullApp(delayMs: number): void {
    if (!IS_ARTIFACT || this.fullAppMentioned) return;
    this.fullAppMentioned = true;
    this.timers.set(
      'full-app',
      () => this.bus.emit('buddy-say', { text: DEWEY_FULL_APP_LINE, priority: 'normal', mood: 'happy' }),
      delayMs,
    );
  }

  private hidePreview(): void {
    this.store.update({ showCameraPreview: false });
    this.toasts.show({ id: 'preview', message: 'Camera preview hidden. You can bring it back in Settings.' });
  }

  /**
   * GazeDot shows only when the host allows it AND `showGazeDot` is on. The
   * demo must show it regardless (the dot *is* the demo), so while the demo
   * runs the dot sees a settings view with the flag set; nothing is persisted.
   */
  private createGazeDot(): GazeDot {
    return new GazeDot({
      bus: this.bus,
      getSettings: () => {
        const s = this.store.get();
        return this.gazeDotForced ? { ...s, showGazeDot: true } : s;
      },
    });
  }

  private updateOverlays(): void {
    const s = this.store.get();
    const reading = this.screen === 'reader';
    const demo = this.sourceKind === 'simulated';
    if (demo !== this.gazeDotForced) {
      // The dot reads its setting when mounted, so rebuild it (it's a single element).
      this.gazeDotForced = demo;
      this.gazeDot.destroy();
      this.gazeDot = this.createGazeDot();
      this.gazeDot.mount(this.root);
    }
    const camera = this.camera;
    const webcamLive = this.sourceKind === 'webcam' && camera !== null && camera.running && this.phase !== 'calibrating';
    // Lets layouts keep clear of Dewey (e.g. onboarding on a phone).
    const html = document.documentElement;
    html.dataset.buddyCorner = s.buddyCorner;
    html.dataset.buddy = s.buddyEnabled ? 'on' : 'off';
    this.preview.setCorner(previewCorner(s.buddyCorner));
    this.preview.attach(webcamLive ? camera : null);
    this.preview.setVisible(reading && webcamLive && s.showCameraPreview);
    this.gazeDot.setVisible(reading && (s.showGazeDot || demo));
    this.debug.setVisible(reading && s.showDebugOverlay);
  }

  // ─────────────────────────────── Calibration ───────────────────────────────

  private currentModel(): GazeModel | null {
    if (this.model === undefined) {
      this.model = loadCalibration({ featureLength: FEATURE_NAMES.length, featureNames: FEATURE_NAMES });
      this.savedCalibration = this.model !== null;
      this.applyEnvironment(this.model);
    }
    return this.model;
  }

  /**
   * Runs the calibration overlay on the running camera. Resolves with what happened to the
   * model: a new calibration ('standard'), a quick refresh or an applied accuracy-check
   * correction of the same calibration ('refresh'), or no change ('unchanged': a cancelled
   * refresh, or a check closed with "Done"). Null when there is no usable model afterwards.
   */
  private async calibrate(mode: CalibrationMode, gen: number): Promise<CalibrationOutcome | null> {
    const stale = (): boolean => gen !== this.sourceGen || this.destroyed;
    const camera = this.camera;
    if (!camera?.running || this.calibration) return null;
    const base = this.currentModel();
    this.closePanels();
    this.setPhase('calibrating');
    const overlay = new CalibrationOverlay({
      features: camera,
      bus: this.bus,
      video: camera.video,
      mode: mode !== 'standard' && base ? mode : 'standard',
      baseModel: base,
      // Accuracy is reported as "≈ N lines" at the reader's actual text size.
      linePitchPx: () => this.layout?.linePitch ?? null,
      featureNames: FEATURE_NAMES,
    });
    this.calibration = overlay;
    this.lastCalibrationPhase = null;
    this.syncModalState();
    overlay.mount(this.root);
    let result: { model: GazeModel; report: CalibrationReport } | null = null;
    let check: AccuracyCheckResult | null = null;
    try {
      result = await overlay.run();
      check = overlay.lastAccuracyCheck;
    } finally {
      if (this.calibration === overlay) this.calibration = null;
      this.forceCalibration = false;
      // Un-inert the page before the overlay goes, so focus can return to the reader.
      this.syncModalState();
      overlay.destroy();
      if (this.session && (!document.activeElement || document.activeElement === document.body)) this.focusReader();
    }
    if (stale()) return null;
    const finished = this.lastCalibrationPhase === 'done';
    if (result) {
      const outcome: CalibrationOutcome = base && sameRidgeCore(result.model.toJSON(), base.toJSON()) ? 'refresh' : 'standard';
      this.adoptModel(result.model, result.report);
      if (mode === 'check' && outcome === 'refresh') this.reportAccuracyCheck(check);
      return outcome;
    }
    if (base) {
      if (mode === 'check' && finished) {
        // "Done": the model stays as it is; the reader has just seen how it does.
        this.guidance.noteFixed(performance.now());
        this.reportAccuracyCheck(check);
      }
      return 'unchanged';
    }
    this.webcamHold = { reason: 'uncalibrated' };
    this.bus.emit('buddy-say', { text: 'No rush! We can calibrate whenever you like, or try the mouse.', priority: 'high', mood: 'thinking' });
    this.showNotCalibrated();
    return null;
  }

  /** There is no usable calibration and none is running: say why, and offer the ways forward. */
  private showNotCalibrated(): void {
    const upgrade = this.upgradePending;
    this.toasts.show({
      id: 'camera',
      tone: 'warn',
      title: upgrade ? 'Please recalibrate once' : 'Not calibrated yet',
      message: upgrade
        ? 'Gaze Reader now copes better with changing light, so calibrations from the previous version can’t be used. It takes about a minute. You can also read with your mouse, or watch the demo.'
        : 'A one-minute calibration lets Dewey follow your eyes. You can also read with your mouse, or watch the demo.',
      actions: [
        { label: 'Calibrate', primary: true, run: () => this.recalibrate() },
        { label: 'Use my mouse', run: () => this.selectSource('mouse') },
        { label: 'Watch a demo', run: () => this.selectSource('simulated') },
      ],
      durationMs: 20_000,
    });
  }

  /** A calibration run produced a model: save it and make it the reference for light and eyelids. */
  private adoptModel(model: GazeModel, report: CalibrationReport): void {
    this.model = model;
    saveCalibration(model);
    this.savedCalibration = true;
    this.webcamHold = null;
    this.upgradePending = false;
    this.lastReport = report;
    this.applyEnvironment(model);
    const now = performance.now();
    this.recorder.model(model, report, now);
    // The tracking was just corrected: no touch-up offers for a while.
    this.guidance.noteFixed(now);
    this.pendingOffer = null;
    this.toasts.dismiss('touch-up');
  }

  /**
   * Brings the reading layer in line with a calibration run. A new calibration starts the line
   * tracker over; a refresh keeps the line the reader is on and re-learns the offset (the refresh
   * absorbed it into the model, so the drift learned so far is now wrong).
   */
  private afterCalibration(outcome: CalibrationOutcome, context: 'bring-up' | 'in-place'): void {
    if (outcome === 'standard') {
      this.resetPipeline('fresh');
      if (context === 'in-place' && this.layout) {
        this.lineTracker.setLayout(this.layout, 'initial');
        if (this.recorder.recording) this.recorder.layout(this.layout, 'initial', performance.now());
      }
      return;
    }
    if (context === 'in-place') this.resetPipeline('none');
    if (outcome === 'refresh') {
      this.driftOwner = this.currentDriftOwner();
      this.driftWatch.reset();
      this.bus.emit('appearance-changed', { t: performance.now(), reason: 'refresh', detail: 'calibration refreshed' });
    }
  }

  /** The lighting signature and eyelid baseline stored with the model become the references. */
  private applyEnvironment(model: GazeModel | null): void {
    const env = model?.environment ?? null;
    const lighting = parseLightingSignature(env?.lighting ?? null);
    this.lightingWatch.setReference(lighting);
    this.appearance.setBaseline(env?.appearance ?? null, lighting?.pitch ?? null);
    this.changeFilter.reset();
    this.sustainedFlags.reset();
    this.driftWatch.reset();
    // A new reference light: whatever was offered for the old one doesn't count.
    this.lightingEpisodeOffered = false;
  }

  private recalibrate(): void {
    if (IS_ARTIFACT) {
      this.webcamUnavailable();
      return;
    }
    this.forceCalibration = true;
    this.webcamHold = null;
    if (!this.session) {
      this.toasts.show({ id: 'calibrate-later', message: 'Open a book and calibration will start right away.' });
    }
    if (this.store.get().gazeSource !== 'webcam') {
      this.store.update({ gazeSource: 'webcam' }); // → settings-changed → syncSource → calibrates
    } else if (this.sourceKind === 'webcam' && this.phase === 'running' && this.source) {
      void this.recalibrateInPlace('standard');
    } else if (this.phase !== 'calibrating') {
      this.syncSource();
    }
  }

  /** The 5-dot touch-up (a quick refresh of the calibration in use). */
  private touchUp(): void {
    this.toasts.dismiss('touch-up');
    if (this.sourceKind === 'webcam' && this.phase === 'running' && this.currentModel()) void this.recalibrateInPlace('quick');
  }

  /** The 'check-accuracy' command: a few dots measured against the calibration in use. */
  private checkAccuracy(): void {
    if (IS_ARTIFACT) {
      this.webcamUnavailable();
      return;
    }
    if (!this.session) {
      this.toasts.show({ id: 'check', message: 'Open a book, then press A to check how well your eyes are followed.' });
      return;
    }
    if (this.store.get().gazeSource !== 'webcam') {
      this.toasts.show({
        id: 'check',
        message: 'The accuracy check is for eye tracking. Switch to your eyes first.',
        actions: [{ label: 'Use my eyes', primary: true, run: () => this.selectSource('webcam') }],
      });
      return;
    }
    if (this.phase === 'calibrating' || this.calibration) return;
    if (!this.currentModel()) {
      this.recalibrate();
      return;
    }
    if (this.sourceKind !== 'webcam' || this.phase !== 'running' || !this.source) {
      this.toasts.show({ id: 'check', message: 'The camera is still getting ready. Try again in a moment.' });
      return;
    }
    void this.recalibrateInPlace('check');
  }

  /** Recalibrates (or refreshes, or checks) without restarting the camera; gaze processing pauses meanwhile. */
  private async recalibrateInPlace(mode: CalibrationMode): Promise<void> {
    const gen = this.sourceGen;
    const source = this.source;
    // Only a live webcam session can be recalibrated in place: a stale 'Refresh now' toast
    // clicked after switching to the mouse or demo must not stop that source.
    if (!source || this.calibration || this.sourceKind !== 'webcam' || this.phase !== 'running' || !this.camera?.running) return;
    this.offSample?.();
    this.offSample = null;
    source.stop();
    let outcome: CalibrationOutcome | null = null;
    try {
      outcome = await this.calibrate(mode, gen);
    } catch (err) {
      console.error('[app] calibration failed', err);
    }
    if (gen !== this.sourceGen || this.destroyed) return;
    if (!outcome) {
      this.teardownSource();
      this.setIdlePhase();
      return;
    }
    this.offSample = source.onSample(this.onSample);
    await source.start();
    if (gen !== this.sourceGen || this.destroyed) return;
    this.afterCalibration(outcome, 'in-place');
    this.setPhase('running');
  }

  /** Tells the reader how the accuracy check went, in a line (the overlay showed the details). */
  private reportAccuracyCheck(check: AccuracyCheckResult | null): void {
    if (!check) return;
    const b = check.before;
    // The same measurement the overlay judged (offsetVerdict), so the toast agrees with its badge.
    const xFrac = b.offsetXFrac ?? (window.innerWidth > 0 ? b.offsetXPx / window.innerWidth : 0);
    const view = accuracyCheckView({
      meanErrorPx: b.meanErrorPx,
      offsetXPx: b.offsetXPx,
      offsetYPx: b.offsetYPx,
      offsetYLines: b.offsetYLines,
      ...(Number.isFinite(xFrac) ? { offsetXFrac: xFrac } : {}),
      ...(b.maxDotYLines !== undefined && Number.isFinite(b.maxDotYLines) ? { maxDotYLines: b.maxDotYLines } : {}),
      applied: check.applied,
    });
    const change = check.lightingChange;
    const light = change?.changed && change.text ? ` The light has changed since calibration: ${change.text}.` : '';
    // The reader chose "Done" on an offset worth correcting: the fix stays one click away.
    const actions: ToastAction[] = view.offerTouchUp
      ? [{ label: 'Refresh now', primary: true, run: () => this.touchUp() }]
      : view.offerRecalibrate
        ? [{ label: 'Recalibrate', primary: true, run: () => this.recalibrate() }]
        : [];
    this.toasts.show({
      id: 'check',
      tone: view.tone,
      title: view.title,
      message: `${view.message}${light}`,
      actions,
      durationMs: actions.length > 0 ? 15_000 : 9000,
    });
    this.deweySay(view.quip, 'normal', view.tone === 'success' ? 'happy' : 'thinking');
  }

  private forgetCalibration(): void {
    clearCalibration();
    this.model = null;
    this.savedCalibration = false;
    this.applyEnvironment(null);
    if (this.sourceKind === 'webcam') {
      this.webcamHold = { reason: 'uncalibrated' };
      this.syncSource();
    }
  }

  /**
   * The saved calibration was made by an earlier tracker (1.0 read vertical gaze from the lids,
   * which light moves). Notes that (the "not calibrated" toast then says "Please recalibrate
   * once"), and says so the first time. True only on that first, explaining visit: the caller then
   * asks before calibrating (showNotCalibrated) instead of starting a minute of dots unannounced.
   */
  private explainUpgradeIfNeeded(): boolean {
    if (!savedCalibrationNeedsUpgrade()) return false;
    this.upgradePending = true;
    if (readJSON<unknown>(UPGRADE_EXPLAINED_KEY, null) !== null) return false;
    writeJSON(UPGRADE_EXPLAINED_KEY, { at: Date.now() });
    this.deweySay('trackerUpgraded', 'high', 'happy');
    return true;
  }

  private schedulePreload(): void {
    if (this.store.get().gazeSource !== 'webcam') return;
    // Warm the face model while the reader browses, so opening a book is quick.
    this.timers.set('preload', preloadTracker, PRELOAD_DELAY_MS);
  }

  /**
   * Whether the saved calibration still lines up with the window: 'size' when the viewport
   * changed size (or zoom), 'origin' when the viewport moved inside the window (fullscreen,
   * toolbar or bookmarks bar), which shifts every prediction with the window origin unchanged.
   */
  private calibrationFit(model: GazeModel): 'fits' | 'size' | 'origin' {
    if (!calibrationFitsViewport(model.viewport, this.viewportSize())) return 'size';
    if (!calibrationOriginFits(modelChromeTop(model), currentChromeTop(), this.layout?.linePitch)) return 'origin';
    return 'fits';
  }

  private maybeSuggestRefresh(): void {
    const model = this.model;
    if (!model || this.sourceKind !== 'webcam' || this.phase !== 'running') return;
    const fit = this.calibrationFit(model);
    if (fit === 'fits') return;
    this.toasts.show({
      id: 'refresh-calibration',
      title: fit === 'size' ? 'Window size changed' : 'Window layout changed',
      message:
        fit === 'size'
          ? 'A quick 5-dot refresh keeps page turns accurate.'
          : 'Fullscreen or a toolbar moved the page. A quick 5-dot refresh keeps page turns accurate.',
      actions: [{ label: 'Refresh now', primary: true, run: () => void this.recalibrateInPlace('quick') }],
    });
  }

  // ─────────────────────────── Lighting & guidance ───────────────────────────
  // Light changes how open the eyes are (a squint in bright light or glare, wide eyes in dim
  // light), and that moves webcam gaze by lines. Two watchers look for it on the camera frames:
  // LightingWatch compares the light with the calibration's, AppearanceMonitor watches the
  // eyelids. Either one reports an 'appearance-changed', which makes the line tracker re-learn
  // its vertical offset; a changed light (or a large offset held for a while) also earns a
  // rate-limited offer of the 5-dot touch-up, shown only when the reader pauses.

  private readonly onCameraFrame = (frame: FeatureFrame): void => {
    this.recorder.frame(frame);
    if (this.sourceKind !== 'webcam' || this.phase !== 'running' || this.calibration || !this.session || document.hidden) return;
    this.lightingWatch.onFrame(frame);
    const model = this.model ?? null;
    const f = frame.faceFound ? frame.features : null;
    let gazeYNorm: number | null = null;
    if (model && f && model.viewport.height > 0) {
      let p: { x: number; y: number } | null = null;
      try {
        p = model.predict(f);
      } catch {
        p = null;
      }
      // The model reads no lid features, so its y is a fair "where the eyes look" for the lid baseline.
      if (p && Number.isFinite(p.y)) gazeYNorm = p.y / model.viewport.height;
    }
    const change = this.appearance.update({ t: frame.t, features: f, quality: frame.quality, gazeYNorm });
    if (change) this.cameraChange(change.t, 'lids', `${change.direction} eyes (${change.channel}, z ${change.z.toFixed(1)})`, frame.t);
    if (this.debug.visible && frame.t - this.lastAppearanceDebugAt >= APPEARANCE_DEBUG_MS) {
      this.lastAppearanceDebugAt = frame.t;
      this.debug.showAppearance({
        state: this.appearance.state,
        residualZ: this.appearance.residualZ,
        squintZ: this.appearance.squintZ,
        levelVsCalibration: this.appearance.levelVsCalibration,
      });
    }
  };

  /** The camera stopped: forget this session's lighting window and eyelid history. */
  private stopConditionWatch(): void {
    this.lightingWatch.reset();
    this.appearance.reset();
    this.sustainedFlags.reset();
    this.pendingCoach = null;
    this.lightingEpisodeOffered = false; // the watch starts over
    if (this.pendingOffer?.reason === 'lighting') this.pendingOffer = null;
    if (this.lightingState) {
      this.lightingState = null;
      this.bus.emit('lighting-state', { flags: [], distance: null, changedSinceCalibration: false, dominant: null });
    }
    this.debug.showAppearance(null);
  }

  /** About once a second while the webcam runs: the 'lighting-state' event, changes, coaching. */
  private tickLighting(now: number): void {
    if (this.sourceKind !== 'webcam' || this.phase !== 'running' || this.calibration) return;
    const u = this.lightingWatch.tick(now);
    if (!u) return;
    this.lightingState = u.state;
    this.bus.emit('lighting-state', u.state);
    if (u.transition === 'changed' || u.transition === 'changed-again') {
      // 'changed-again': already changed, and now as much again (a lamp, then the overhead light
      // off). The bias moved again, so the reading layer re-learns it; still one offer per episode.
      const d = u.comparison ? ` D ${u.comparison.distance.toFixed(2)}` : '';
      const what = u.transition === 'changed' ? 'light changed since calibration' : 'light changed again';
      this.cameraChange(u.changedAt ?? now, 'lighting', `${what} (${u.state.dominant ?? 'unknown'}${d})`, now);
    } else if (u.transition === 'restored') {
      // Back to the calibration's light: the gaze bias goes back too.
      this.cameraChange(now - LIGHTING_HOLD_MS, 'lighting', 'light back to the calibration’s', now);
      if (this.pendingOffer?.reason === 'lighting') this.pendingOffer = null;
      this.lightingEpisodeOffered = false;
    }
    // A changed light stays a reason for the quick refresh until it has been offered once: the
    // gate may be closed right now (settling in, just calibrated, snoozed), so ask again each tick.
    // requestOffer does nothing while an offer is pending or the gate is closed.
    if (u.state.changedSinceCalibration && !this.lightingEpisodeOffered) this.requestOffer({ reason: 'lighting', since: now });
    const flag = coachFlag(this.sustainedFlags.update(now, u.state.flags));
    if (flag && !this.guidance.hasCoached && this.pendingCoach === null) this.pendingCoach = flag;
  }

  /**
   * A change the camera saw (eyelids, lighting). One physical change is often seen by both
   * watchers seconds apart; it is reported (and re-learned) once.
   */
  private cameraChange(onset: number, reason: 'lids' | 'lighting', detail: string, now: number): void {
    if (!this.changeFilter.accept(reason, onset, now)) return;
    this.bus.emit('appearance-changed', { t: onset, reason, detail });
  }

  /** Any 'appearance-changed' (camera, refresh): the line tracker keeps the line and re-learns the offset. */
  private onAppearanceChanged(c: AppEvents['appearance-changed']): void {
    if (!Number.isFinite(c.t)) return;
    this.lineTracker.appearanceChangedAt(c.t);
    this.recordInput({ k: 'appearance', t: performance.now(), at: c.t });
    this.driftWatch.reset();
  }

  private requestOffer(offer: TouchUpOffer): void {
    if (this.sourceKind !== 'webcam' || !this.session || this.pendingOffer) return;
    if (!this.guidance.mayOffer(offer.since)) return;
    this.pendingOffer = offer;
  }

  /**
   * Delivers pending guidance when the reader isn't reading a line: right after a page turn, or
   * during a pause of a few seconds. Called from the heartbeat and on every page turn.
   */
  private pollGuidance(now: number): void {
    if (!this.session || this.screen !== 'reader' || this.modalOpen() || this.calibration || document.hidden) return;
    const offer = this.pendingOffer;
    if (offer) {
      if (now - offer.since > OFFER_TTL_MS || this.sourceKind !== 'webcam' || this.phase !== 'running' || !this.guidance.mayOffer(now)) {
        this.pendingOffer = null;
      } else if (this.guidance.isPause(now)) {
        this.pendingOffer = null;
        this.showTouchUpOffer(offer, now);
        return; // one thing at a time
      }
    }
    const coach = this.pendingCoach;
    if (coach && this.guidance.isPause(now)) {
      this.pendingCoach = null;
      if (this.guidance.hasCoached || this.sourceKind !== 'webcam') return;
      this.guidance.noteCoached();
      const key: QuipKey = coach === 'backlit' ? 'lightBacklit' : coach === 'glare' ? 'lightGlare' : 'lightDark';
      // Through Dewey only when he will say a normal-priority line ('quiet' drops it): the
      // once-per-book budget above must buy something the reader sees.
      const s = this.store.get();
      if (s.buddyEnabled && chattinessAllows(s.buddyChattiness, 'normal')) this.deweySay(key, 'normal', 'thinking');
      else {
        const text = this.quips.pick(key);
        if (text) this.toasts.show({ id: 'light-coach', message: text });
      }
    }
  }

  private showTouchUpOffer(offer: TouchUpOffer, now: number): void {
    this.guidance.noteOffered(now);
    const lighting = offer.reason === 'lighting';
    // One offer per lighting episode; set when shown, so an offer dropped unshown can come back.
    if (lighting) this.lightingEpisodeOffered = true;
    const dir = (offer.direction ?? 0) > 0 ? 'low' : 'high';
    this.deweySay(lighting ? 'lightChanged' : 'driftOffer', 'normal', 'thinking');
    this.toasts.show({
      id: 'touch-up',
      title: lighting ? 'The light changed' : 'Tracking has drifted',
      message: lighting
        ? 'A quick 5-dot refresh keeps page turns accurate.'
        : `Your gaze has been reading about ${formatLines(offer.lines ?? 1.5)} too ${dir}. A quick 5-dot refresh keeps page turns accurate.`,
      actions: [
        { label: 'Refresh now', primary: true, run: () => this.touchUp() },
        { label: 'Not now', run: () => this.guidance.snooze(performance.now()) },
      ],
      durationMs: 15_000,
    });
  }

  /** Dewey says a line from his repertoire (QUIPS); returns it, or null when there was none. */
  private deweySay(key: QuipKey, priority: SpeechPriority, mood?: BuddyMood): string | null {
    const text = this.quips.pick(key);
    if (text) this.bus.emit('buddy-say', { text, priority, ...(mood ? { mood } : {}) });
    return text;
  }

  // ─────────────────────────────── Diagnostics ───────────────────────────────

  private startRecording(): void {
    if (IS_ARTIFACT || this.recorder.recording) return;
    const now = performance.now();
    const s = this.store.get();
    this.recorder.start({
      settings: s,
      environment: describeEnvironment({ track: videoTrackOf(this.camera?.video), lightingBackend: this.camera?.lightingBackend ?? null }),
      featureNames: FEATURE_NAMES,
      model: this.model ?? null,
      report: this.lastReport,
    });
    // The replay starts from what the pipeline is configured with now.
    this.recorder.input({ k: 'configure', t: now, sensitivity: s.sensitivity, glanceDownToTurn: s.glanceDownToTurn });
    if (this.layout) this.recorder.layout(this.layout, 'initial', now);
    this.topbar.setRecording(true);
    this.settingsPanel.refreshDiagnostics();
  }

  private stopRecording(download: boolean): void {
    if (!this.recorder.recording) {
      if (download) this.downloadRecording();
      return;
    }
    this.recorder.stop('user');
    this.topbar.setRecording(false);
    if (download) this.downloadRecording();
    this.settingsPanel.refreshDiagnostics();
  }

  private downloadRecording(): void {
    if (IS_ARTIFACT) return; // no downloads in the Artifact frame (and no recorder UI)
    const rec = this.recorder.toJSON();
    if (!rec) return;
    if (downloadRecording(rec)) this.toasts.show({ id: 'diagnostics', tone: 'success', message: 'Diagnostics saved as a JSON file (numbers only, no video).' });
    else this.toasts.show({ id: 'diagnostics', tone: 'error', message: 'The diagnostics file couldn’t be saved.' });
  }

  /** The 10-minute limit stopped the recording. */
  private onRecordingLimit(): void {
    this.topbar.setRecording(false);
    this.settingsPanel.refreshDiagnostics();
    this.toasts.show({
      id: 'diagnostics',
      title: 'Diagnostics recorded',
      message: 'Ten minutes of tracking numbers (no video) are ready to save.',
      actions: [{ label: 'Download', primary: true, run: () => this.downloadRecording() }],
      durationMs: 0,
    });
  }

  // ───────────────────────────── Tracking state ─────────────────────────────

  private setPhase(phase: SourcePhase, detail?: string): void {
    this.phase = phase;
    this.phaseDetail = detail;
    const now = performance.now();
    if (phase === 'running') this.tracking.reset(now);
    this.refreshTracking(now);
    this.updateOverlays();
  }

  private setIdlePhase(): void {
    const hold = this.store.get().gazeSource === 'webcam' ? this.webcamHold : null;
    if (hold?.reason === 'failed') this.setPhase('error', hold.detail);
    else if (hold?.reason === 'uncalibrated') this.setPhase('off', 'Not calibrated');
    else this.setPhase('off');
  }

  private refreshTracking(now: number): void {
    const status = this.tracking.evaluate(now, {
      phase: this.phase,
      kind: this.sourceKind,
      autoScroll: this.store.get().autoScroll,
      detail: this.phaseDetail,
    });
    const cameraOn = this.camera?.running ?? false;
    const kind = this.sourceKind;
    const key = `${status.state}|${status.detail ?? ''}|${kind ?? ''}|${cameraOn}`;
    if (key !== this.pillKey) {
      this.pillKey = key;
      this.topbar.setStatus({ ...status, kind, cameraOn });
    }
    if (sameStatus(this.status, status)) return;
    this.status = status;
    this.bus.emit('tracking-state', status);
    if (status.state === 'poor' && !this.poorHintShown) this.timers.set('poor-hint', () => this.showPoorHint(), POOR_HINT_AFTER_MS);
    else if (status.state !== 'poor') this.timers.clear('poor-hint');
  }

  private showPoorHint(): void {
    if (this.status?.state !== 'poor' || this.poorHintShown) return;
    this.poorHintShown = true;
    this.toasts.show({
      id: 'poor',
      tone: 'warn',
      title: 'Tracking is a little unsure',
      message: 'More light on your face, and sitting about an arm’s length away, usually help.',
      actions: [{ label: 'Recalibrate', run: () => this.recalibrate() }],
    });
  }

  // ─────────────────────────── Commands & settings ───────────────────────────

  private bindBus(): void {
    this.unsubs.push(
      this.bus.on('command', ({ name }) => this.runCommand(name)),
      this.bus.on('settings-changed', ({ settings, changed }) => this.onSettingsChanged(settings, changed)),
      this.bus.on('error', ({ code, message }) => this.showError(code, message)),
      // Emitted synchronously by ScrollController.turnPage, while `turning` is set.
      this.bus.on('page-turn', ({ to }) => {
        if (this.turning) this.turnTarget = to;
        // The eyes travel back up the page anyway: a moment guidance may use.
        const now = performance.now();
        this.guidance.notePageTurn(now);
        this.pollGuidance(now);
      }),
      this.bus.on('line-estimate', (e) => this.driftCorrection.noteEstimate(e)),
      this.bus.on('calibration', ({ phase }) => {
        this.lastCalibrationPhase = phase;
        // A new calibration starts the drift over; Dewey's eyes shouldn't keep correcting for the old one.
        if (phase === 'start') this.driftCorrection.reset();
      }),
      this.bus.on('appearance-changed', (c) => this.onAppearanceChanged(c)),
    );
    // Diagnostics: the events a recording keeps (no-ops unless recording).
    for (const type of RECORDED_EVENTS) {
      this.unsubs.push(
        this.bus.on(type, (data) => {
          if (this.recorder.recording) this.recorder.event(type, data, performance.now());
        }),
      );
    }
  }

  private runCommand(name: CommandName): void {
    if (this.destroyed) return;
    const s = this.store.get();
    switch (name) {
      case 'toggle-autoscroll':
        this.setAutoScroll(!s.autoScroll);
        break;
      case 'pause':
        this.setAutoScroll(false);
        break;
      case 'resume':
        this.setAutoScroll(true);
        break;
      case 'recalibrate':
        this.recalibrate();
        break;
      case 'open-settings':
        this.help.close();
        this.settingsPanel.open();
        this.syncModalState();
        break;
      case 'close-settings':
        this.settingsPanel.close();
        this.syncModalState();
        break;
      case 'page-forward':
        void this.pageForward();
        break;
      case 'page-back':
        void this.pageBack();
        break;
      case 'undo-turn':
        void this.undoTurn();
        break;
      case 'toggle-debug':
        this.store.update({ showDebugOverlay: !s.showDebugOverlay });
        break;
      case 'toggle-gaze-dot':
        this.store.update({ showGazeDot: !s.showGazeDot });
        break;
      case 'open-library':
        this.closeBook();
        break;
      case 'show-help':
        this.settingsPanel.close();
        this.help.toggle();
        this.syncModalState();
        break;
      case 'check-accuracy':
        this.checkAccuracy();
        break;
    }
  }

  private setAutoScroll(on: boolean): void {
    if (this.store.get().autoScroll === on) return;
    this.store.update({ autoScroll: on });
    // Let the reader see the pill change.
    if (this.screen === 'reader') this.topbar.reveal();
  }

  private onSettingsChanged(s: AppSettings, changed: readonly (keyof AppSettings)[]): void {
    const any = (keys: readonly (keyof AppSettings)[]): boolean => keys.some((k) => changed.includes(k));
    if (this.recorder.recording) {
      const patch: Partial<AppSettings> = {};
      for (const k of changed) Object.assign(patch, { [k]: s[k] });
      this.recorder.settingsChanged(patch, performance.now());
    }
    if (any(['theme', 'fontFamily'])) this.applyTheme();
    if (any(TYPOGRAPHY_KEYS)) {
      // The text reflows: stored undo offsets would point at unrelated text.
      this.scroll?.clearHistory();
      this.reader.applySettings(s);
      this.scheduleMeasure('content', 60);
    }
    if (any(['sensitivity', 'glanceDownToTurn'])) {
      this.pageEnd.configure({ sensitivity: s.sensitivity, glanceDownToTurn: s.glanceDownToTurn });
      this.recordInput({ k: 'configure', t: performance.now(), sensitivity: s.sensitivity, glanceDownToTurn: s.glanceDownToTurn });
    }
    if (changed.includes('autoScroll')) {
      // Resuming shouldn't fire on a dwell that built up while paused.
      if (s.autoScroll) {
        this.pageEnd.reset();
        this.recordInput({ k: 'page-end-reset', t: performance.now() });
      }
      this.refreshTracking(performance.now());
    }
    if (changed.includes('gazeSource')) {
      // Choosing the webcam (from anywhere) is a fresh request: retry even after a failure.
      if (s.gazeSource === 'webcam') this.webcamHold = null;
      this.syncSource();
    }
    if (any(OVERLAY_KEYS)) this.updateOverlays();
    if (changed.includes('buddyEnabled') && !s.buddyEnabled && !this.settingsPanel.isOpen) this.deweyHidden();
  }

  /** Dewey hid himself from his own menu: say how to get him back, and keep keyboard paging working. */
  private deweyHidden(): void {
    this.toasts.show({
      id: 'dewey',
      message: 'Dewey is taking a break. You can bring him back in Settings.',
      actions: [{ label: 'Undo', primary: true, run: () => this.store.update({ buddyEnabled: true }) }],
    });
    // His menu had focus, and it's going away (the browser only drops focus to <body> on the next frame).
    const active = document.activeElement;
    const stranded = !active || active === document.body || active.closest(`.${BUDDY_CLASS}`) !== null;
    if (this.session && this.screen === 'reader' && stranded) this.focusReader();
  }

  private showError(code: string, message: string): void {
    const key = `${code}:${message}`;
    const now = Date.now();
    if (key === this.lastError.key && now - this.lastError.at < 10_000) return;
    this.lastError = { key, at: now };
    this.toasts.show({
      id: `error:${code}`,
      tone: 'error',
      title: 'Something went wrong',
      message: message || 'An unexpected error occurred. Your books and progress are safe.',
    });
  }

  // ─────────────────────────────── DOM events ───────────────────────────────

  private bindDom(): void {
    const signal = this.ac.signal;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('resize', this.onWindowResize, { signal, passive: true });
    document.addEventListener('visibilitychange', this.onVisibility, { signal });
    window.addEventListener('pagehide', () => this.savePositionNow(), { signal });
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) {
      window.addEventListener(type, this.noteInput, { signal, passive: true });
    }
    window.addEventListener('dragenter', this.onDragEnter, { signal });
    window.addEventListener('dragover', this.onDragOver, { signal });
    window.addEventListener('dragleave', this.onDragLeave, { signal });
    window.addEventListener('drop', this.onDrop, { signal });
    this.darkQuery?.addEventListener(
      'change',
      () => {
        if (this.store.get().theme === 'auto') this.applyTheme();
      },
      { signal },
    );
    this.unsubs.push(this.reader.onScroll(this.onReaderScroll));
  }

  private readonly noteInput = (): void => {
    this.lastInputAt = performance.now();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.noteInput();
    if (e.defaultPrevented || this.destroyed) return;
    const action = shortcutFor(e);
    if (!action) return;
    const origin = e.composedPath()[0];
    if (shouldIgnoreShortcut(e, origin instanceof Element ? origin : null)) return;
    if (action === 'escape') {
      if (this.closePanels()) e.preventDefault();
      return;
    }
    // Calibration and dialogs own the keyboard while they are open.
    if (this.calibration || this.modalOpen()) return;
    const def = SHORTCUTS.find((d) => d.action === action);
    if (def?.readerOnly && !this.session) return;
    e.preventDefault();
    if (this.turning && (action === 'page-forward' || action === 'page-back')) {
      // ScrollController cancels its animation on any navigation key, which would leave
      // the page stranded halfway. This listener was registered first (constructor vs.
      // per book), so it can keep the key to itself: forward lands the turn at once,
      // back lets it finish.
      e.stopImmediatePropagation();
    }
    this.bus.emit('command', { name: action });
  };

  private readonly onWindowResize = (): void => {
    this.scheduleMeasure('resize');
    this.timers.set('resize-hint', () => this.maybeSuggestRefresh(), 800);
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.savePositionNow();
      // Don't keep the camera on for a tab nobody is looking at.
      this.timers.set(
        'hidden-stop',
        () => {
          this.hiddenLong = true;
          this.syncSource();
        },
        HIDDEN_STOP_MS,
      );
      return;
    }
    this.timers.clear('hidden-stop');
    this.dragDepth = 0;
    if (this.hiddenLong) {
      this.hiddenLong = false;
      this.syncSource();
    } else if (this.phase === 'running') {
      // Frames were throttled while hidden: start the no-face clock afresh.
      const now = performance.now();
      this.tracking.reset(now);
      this.refreshTracking(now);
    }
  };

  private readonly onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth++;
    this.library.setDragActive(true);
  };

  private readonly onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    // Without this the browser would navigate away to the dropped file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.calibration ? 'none' : 'copy';
  };

  private readonly onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.library.setDragActive(false);
  };

  private readonly onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.library.setDragActive(false);
    const file = e.dataTransfer?.files[0];
    if (!file || this.calibration || this.onboarding.isOpen) return;
    this.closePanels();
    void this.openFromFile(file);
  };
}
