import type {
  AppEvents,
  AppSettings,
  BuddyMood,
  CalibrationPhase,
  Chattiness,
  Corner,
  EventBus,
  EventName,
  GazeSample,
  LineEstimate,
  LineLayout,
  Mountable,
  Point,
  Rect,
  SpeechPriority,
  Unsubscribe,
} from '../types';
import { BUDDY_NAME, IGNORE_ATTR } from '../core/constants';
import { DEFAULT_SETTINGS } from '../core/settings';
import { clampOffset, createAvatar, pupilOffset, setPupil, type AvatarParts } from './avatar';
import { QuipPicker, shortTitle, type QuipKey, type QuipVars } from './quips';
import { adoptBuddyStyles, BUDDY_CLASS as B } from './styles';

// ───────────────────────────────── tuning ──────────────────────────────────

export const MAX_SPEECH_CHARS = 90;
/** Identical lines are not repeated within this window. */
export const DEDUPE_WINDOW_MS = 120_000;
/** At most one unprompted remark per this interval (normal & chatty). */
export const REMARK_GAP_MS = 45_000;
/** Continuous `no-face` before Dewey gets worried. */
export const WORRY_AFTER_MS = 3_000;
/** No valid gaze (or other sign of life) for this long → sleepy. */
export const SLEEP_AFTER_MS = 60_000;
/** Pointer travel that turns a press into a drag. */
export const DRAG_THRESHOLD_PX = 5;

/** The face must stay found this long before a worried episode ends (tracking flickers). */
const RECOVER_MS = 1_200;
/** Valid gaze within this window → Dewey is "reading" along. */
const READING_LINGER_MS = 1_500;
/** Pupils follow the gaze only while it is this fresh. */
const GAZE_FRESH_MS = 500;
/** "Mid-line" = valid gaze on the text this recently … */
const BUSY_GAZE_MS = 700;
/** … after at least this long of uninterrupted gaze (someone who just looked back isn't mid-line yet) … */
const SETTLE_MS = 1_200;
/** … and (when the host emits them) a line estimate this recently. */
const BUSY_ESTIMATE_MS = 1_500;
/** After a page turn, held remarks may be spoken for this long … */
const PAGE_TURN_WINDOW_MS = 1_800;
/** … starting once the scroll is under way. */
const PAGE_TURN_SPEAK_DELAY_MS = 450;
const SPEECH_GAP_MS = 350;
const HOLD_RETRY_MS = 800;
const QUEUE_LIMIT = 6;
const TTL_MS: Readonly<Record<SpeechPriority, number>> = { low: 60_000, normal: 120_000, high: 30_000 };
/**
 * Host lines are mostly feedback on something the reader just did ("Paused."),
 * which is stale soon after; one still held back by the mid-line rule is dropped.
 */
const APP_TTL_MS = 20_000;
const MANUAL_MOOD_MS = 5_000;
const CELEBRATE_MS = 5_200;
const PAGE_TURN_REACTION_P = 0.18;
const PAGE_TURN_FUN_FACT_P = 0.22;
const EYE_EASE_MS = 70;
const EYE_REMEASURE_MS = 2_000;
const FLIP_MS = 560;
const SNAP_MS = 420;
const CONFETTI_COUNT = 22;
const MILESTONES = [0.25, 0.5, 0.75] as const;

const PRIORITY_RANK: Readonly<Record<SpeechPriority, number>> = { low: 0, normal: 1, high: 2 };
const MOODS: readonly BuddyMood[] = ['idle', 'reading', 'happy', 'excited', 'thinking', 'worried', 'sleepy', 'celebrating'];
const CORNERS: readonly Corner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const ZERO: Readonly<Point> = Object.freeze({ x: 0, y: 0 });

// ───────────────────────────── pure helpers ────────────────────────────────

/** quiet = high only; normal = + normal; chatty = + low (fun facts). */
export function chattinessAllows(chattiness: Chattiness, priority: SpeechPriority): boolean {
  switch (chattiness) {
    case 'quiet':
      return priority === 'high';
    case 'chatty':
      return true;
    case 'normal':
    default:
      return priority !== 'low';
  }
}

/** How long a line stays up: 1.2 s + 55 ms per character, within 2–9 s. */
export function speechDurationMs(text: string): number {
  return clamp(1_200 + 55 * Array.from(text).length, 2_000, 9_000);
}

/** Normalizes whitespace and trims to `max` characters at a word boundary. */
export function clampSpeech(text: string, max = MAX_SPEECH_CHARS): string {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const base = space >= max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/** The corner whose quadrant contains `p` (equivalently, the nearest corner). */
export function nearestCorner(p: Point, viewport: { width: number; height: number }, fallback: Corner = 'bottom-right'): Corner {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !(viewport.width > 0) || !(viewport.height > 0)) return fallback;
  const v = p.y < viewport.height / 2 ? 'top' : 'bottom';
  const h = p.x < viewport.width / 2 ? 'left' : 'right';
  return `${v}-${h}`;
}

/** Limits a drag offset so the dragged rect stays inside the viewport. */
export function clampDrag(base: Rect, dx: number, dy: number, viewport: { width: number; height: number }, margin = 0): Point {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  if (!(viewport.width > 0) || !(viewport.height > 0) || !isFiniteRect(base)) return { x, y };
  const minX = margin - base.left;
  const maxX = Math.max(minX, viewport.width - margin - base.right);
  const minY = margin - base.top;
  const maxY = Math.max(minY, viewport.height - margin - base.bottom);
  return { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) };
}

export interface BubbleWidthInput {
  corner: Corner;
  /** Dewey's on-screen rect; the bubble is anchored to his outer edge. */
  anchor: Rect;
  viewportWidth: number;
  /** Center x of the reading column, if known. */
  columnCenterX: number | null;
  /** The column's edge on Dewey's side (right edge for right corners), if known. */
  columnEdgeX?: number | null;
  /** A gutter at least this wide is used instead of overlapping the text. */
  comfortable?: number;
  preferred?: number;
  min?: number;
  /** Distance kept from the screen edge. */
  edge?: number;
  /** Distance kept from the column center. */
  gap?: number;
}

/**
 * Widest the bubble may be so that, growing from Dewey's outer edge toward the
 * page, it stops short of the reading column's center — and, when the margin
 * beside the column is roomy enough, stays out of the text altogether.
 */
export function bubbleMaxWidth(o: BubbleWidthInput): number {
  const preferred = o.preferred ?? 260;
  const min = Math.min(o.min ?? 120, preferred);
  const edge = o.edge ?? 8;
  const gap = o.gap ?? 24;
  const right = o.corner.endsWith('right');
  const anchorX = right ? o.anchor.right : o.anchor.left;
  if (!Number.isFinite(anchorX)) return preferred;
  const vw = Number.isFinite(o.viewportWidth) && o.viewportWidth > 0 ? o.viewportWidth : Infinity;
  let limit = right ? anchorX - edge : vw - edge - anchorX;
  const c = o.columnCenterX;
  if (c !== null && Number.isFinite(c)) {
    if (right && c < anchorX) limit = Math.min(limit, anchorX - (c + gap));
    if (!right && c > anchorX) limit = Math.min(limit, c - gap - anchorX);
  }
  const e = o.columnEdgeX;
  if (e !== null && e !== undefined && Number.isFinite(e)) {
    const gutter = right ? anchorX - (e + edge) : e - edge - anchorX;
    if (gutter >= (o.comfortable ?? 180)) limit = Math.min(limit, gutter);
  }
  return Math.round(clamp(limit, min, preferred));
}

// ───────────────────────────────── types ───────────────────────────────────

export interface BuddyOptions {
  bus: EventBus;
  getSettings: () => AppSettings;
  /** Source of randomness (blinks, quip choice, reactions). Injectable for tests. */
  random?: () => number;
}

export interface SayOptions {
  priority?: SpeechPriority;
  durationMs?: number;
  mood?: BuddyMood;
}

interface Utterance {
  text: string;
  priority: SpeechPriority;
  durationMs: number | null;
  mood: BuddyMood | null;
  /** Dewey's own unprompted commentary: rate-limited to one per REMARK_GAP_MS. */
  remark: boolean;
  /** Requested by the host (say() / buddy-say) rather than one of Dewey's quips. */
  fromApp: boolean;
  /** Groups lines that go stale together (e.g. calibration coaching). */
  tag: string | null;
  expiresAt: number;
}

interface SpeakOptions {
  priority: SpeechPriority;
  durationMs?: number;
  mood?: BuddyMood;
  remark?: boolean;
  fromApp?: boolean;
  tag?: string;
  ttlMs?: number;
}

type MenuAction = 'autoscroll' | 'recalibrate' | 'fact' | 'settings' | 'hide';

interface DragState {
  id: number;
  x0: number;
  y0: number;
  base: Rect;
  dx: number;
  dy: number;
  active: boolean;
  captureTarget: Element | null;
}

let instanceCount = 0;

/**
 * Dewey, the reading buddy: an SVG character in a screen corner who reads
 * along, reacts to the reading session through the event bus, talks in a
 * small speech bubble, and offers a menu when clicked.
 */
export class Buddy implements Mountable {
  private readonly bus: EventBus;
  private readonly getSettings: () => AppSettings;
  private readonly random: () => number;
  private readonly quips: QuipPicker;
  private readonly timers = new Timers();
  private readonly unsubs: Unsubscribe[] = [];

  private readonly root: HTMLDivElement;
  private readonly btn: HTMLButtonElement;
  private readonly avatar: AvatarParts;
  private readonly bubble: HTMLDivElement;
  private readonly bubbleText: HTMLParagraphElement;
  private readonly live: HTMLDivElement;
  private readonly pop: HTMLDivElement;
  private readonly popSay: HTMLParagraphElement;
  private readonly menuItems: HTMLButtonElement[] = [];
  private readonly autoscrollItem: { label: HTMLSpanElement; icon: SVGPathElement };
  private readonly fx: HTMLDivElement;

  private win: Window | null = null;
  private releaseStyles: (() => void) | null = null;
  private motionQuery: MediaQueryList | null = null;
  private mounted = false;
  private destroyed = false;
  private enabled: boolean;
  private corner: Corner = 'bottom-right';
  private reducedMotion = false;

  // speech
  private queue: Utterance[] = [];
  private current: Utterance | null = null;
  private speechEndsAt = 0;
  private speechRemaining: number | null = null;
  private readonly spokenAt = new Map<string, number>();
  private lastRemarkAt = -Infinity;
  private pageTurnAt = -Infinity;

  // what Dewey knows about the reader
  private lastGaze: GazeSample | null = null;
  private lastValidGazeAt = -Infinity;
  /** Start of the current uninterrupted run of valid gaze. */
  private validRunStart = -Infinity;
  private lastActivityAt: number;
  private lastEstimate: LineEstimate | null = null;
  private lastEstimateAt = -Infinity;
  private sawEstimates = false;
  private layout: LineLayout | null = null;

  // mood layers (see resolveMood)
  private mood: BuddyMood = 'idle';
  /** Short reactions to events and to his own speech. */
  private transient: { mood: BuddyMood; until: number; fromSpeech: boolean } | null = null;
  /** A mood the host asked for with setMood(); reactions play over it, then it returns. */
  private held: { mood: BuddyMood; until: number } | null = null;
  private calibrationMood: BuddyMood | null = null;
  private calPhase: CalibrationPhase | null = null;
  private noFace = false;
  private worried = false;
  private worriedSpoken = false;
  private sleepy = false;
  private vitalsDueAt = Infinity;

  // eyes
  private manualLook: Point | null = null;
  private glance: { offset: Point; until: number } | null = null;
  private readonly pupils: [Point, Point] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private readonly appliedPupils: [string, string] = ['', ''];
  private eyeCenters: [Point, Point] | null = null;
  private eyesDirty = true;
  private eyesMeasuredAt = -Infinity;
  private frameHandle: { kind: 'raf' | 'timeout'; id: number } | null = null;
  private lastFrameAt = 0;

  // book progress
  private lastFraction: number | null = null;
  private readonly milestonesSaid = new Set<number>();
  private tensSeen: number | null = null;
  /** The book was finished: progress reports may still trail in, but they're old news. */
  private bookDone = false;

  // interaction
  private menuOpen = false;
  private drag: DragState | null = null;
  private suppressClickUntil = -Infinity;
  private lastInsideEvent: Event | null = null;

  constructor(opts: BuddyOptions) {
    this.bus = opts.bus;
    this.getSettings = opts.getSettings;
    this.random = opts.random ?? Math.random;
    this.quips = new QuipPicker(this.random);
    this.lastActivityAt = now();

    const initial = this.settings();
    this.enabled = initial.buddyEnabled !== false;
    this.corner = isCorner(initial.buddyCorner) ? initial.buddyCorner : 'bottom-right';

    const doc = document;
    const uid = `${B}-${++instanceCount}`;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.className = className;
      return node;
    };

    this.root = el('div', `${B} ${B}--${this.corner} ${B}--mood-idle`);
    this.root.setAttribute(IGNORE_ATTR, '');
    this.root.dataset.mood = 'idle';
    this.root.hidden = !this.enabled;

    this.fx = el('div', `${B}-fx`);
    this.fx.setAttribute('aria-hidden', 'true');

    this.bubble = el('div', `${B}-bubble`);
    this.bubble.setAttribute('aria-hidden', 'true');
    this.bubbleText = el('p', `${B}-bubble-text`);
    this.bubble.appendChild(this.bubbleText);

    this.pop = el('div', `${B}-pop`);
    this.pop.hidden = true;
    this.popSay = el('p', `${B}-pop-say`);
    this.popSay.id = `${uid}-say`;
    const menu = el('div', `${B}-menu`);
    menu.id = `${uid}-menu`;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${BUDDY_NAME}’s menu`);
    menu.setAttribute('aria-describedby', this.popSay.id);
    this.autoscrollItem = this.buildMenu(doc, menu);
    this.pop.append(this.popSay, menu);

    this.btn = el('button', `${B}-btn`);
    this.btn.type = 'button';
    this.btn.setAttribute('aria-label', `${BUDDY_NAME}, your reading buddy`);
    this.btn.setAttribute('aria-haspopup', 'menu');
    this.btn.setAttribute('aria-expanded', 'false');
    this.btn.setAttribute('aria-controls', menu.id);
    this.btn.title = `${BUDDY_NAME}: click for options, drag to move`;
    this.avatar = createAvatar(doc, uid);
    this.btn.appendChild(this.avatar.svg);

    this.live = el('div', `${B}-sr`);
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');

    this.root.append(this.fx, this.bubble, this.pop, this.btn, this.live);

    this.btn.addEventListener('click', this.onBtnClick);
    this.btn.addEventListener('keydown', this.onBtnKeyDown);
    this.btn.addEventListener('keyup', stopActivationKeys);
    this.btn.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('pointerdown', this.onInsidePointer);
    menu.addEventListener('keydown', this.onMenuKeyDown);
    menu.addEventListener('keyup', stopActivationKeys);
    menu.addEventListener('focusout', this.onMenuFocusOut);
    this.bubble.addEventListener('pointerenter', this.onBubbleEnter);
    this.bubble.addEventListener('pointerleave', this.onBubbleLeave);
    this.bubble.addEventListener('click', () => this.endSpeech(true));

    this.listen('gaze', this.onGaze);
    this.listen('layout', this.onLayout);
    this.listen('line-estimate', this.onLineEstimate);
    this.listen('page-turn', this.onPageTurn);
    this.listen('page-turn-undone', this.onPageTurnUndone);
    this.listen('tracking-state', this.onTrackingState);
    this.listen('calibration', this.onCalibration);
    this.listen('book-opened', this.onBookOpened);
    this.listen('book-progress', this.onBookProgress);
    this.listen('book-finished', this.onBookFinished);
    this.listen('break-due', this.onBreakDue);
    this.listen('buddy-say', this.onBuddySay);
    this.listen('buddy-poke', this.onPoke);
    this.listen('settings-changed', this.onSettingsChanged);
  }

  // ──────────────────────────────── public API ───────────────────────────────

  mount(parent: HTMLElement | ShadowRoot): void {
    if (this.destroyed) return;
    if (this.mounted) this.unmount();
    const rootNode = parent.getRootNode();
    const styleRoot = isStyleRoot(rootNode) ? rootNode : (parent.ownerDocument ?? document);
    this.releaseStyles = adoptBuddyStyles(styleRoot);
    parent.appendChild(this.root);
    this.mounted = true;
    this.win = this.root.ownerDocument.defaultView;
    this.win?.addEventListener('resize', this.onResize);
    const mm = this.win?.matchMedia;
    this.motionQuery = typeof mm === 'function' ? mm.call(this.win, '(prefers-reduced-motion: reduce)') : null;
    this.reducedMotion = this.motionQuery?.matches === true;
    this.motionQuery?.addEventListener?.('change', this.onMotionChange);

    const s = this.settings();
    this.setCorner(s.buddyCorner, false);
    this.setEnabled(s.buddyEnabled !== false, false);
    this.syncMenuLabels();
    this.lastActivityAt = now();
    this.eyesDirty = true;
    this.startLife();
    this.scheduleVitals();
    this.requestFrame();
    this.pump();
  }

  /**
   * Queues a line. High priority preempts lower-priority speech and is shown
   * even mid-line; normal/low wait for a pause or the next page turn.
   */
  say(text: string, opts: SayOptions = {}): void {
    this.enqueue(text, {
      priority: opts.priority ?? 'normal',
      durationMs: opts.durationMs,
      mood: opts.mood,
      fromApp: true,
    });
  }

  /**
   * Shows `mood` for `holdMs` (default 5 s; `Infinity` holds until the next
   * setMood), after which Dewey returns to his situational mood. Brief
   * reactions (a spoken line's mood, a page-turn grin) may play over a held
   * mood; it comes back when they end. `holdMs` 0 clears a held mood.
   */
  setMood(mood: BuddyMood, holdMs = MANUAL_MOOD_MS): void {
    if (this.destroyed || !isMood(mood)) return;
    const ms = Number.isNaN(holdMs) ? MANUAL_MOOD_MS : Math.max(0, holdMs);
    // The host's latest request wins over whatever reaction is playing now.
    this.transient = null;
    this.held = ms === 0 ? null : { mood, until: now() + ms };
    this.refreshMood();
    this.scheduleVitals();
  }

  /** Viewport px to look at; null returns to following the reader. */
  lookAt(p: Point | null): void {
    if (this.destroyed) return;
    this.manualLook = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    this.requestFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.unsubs.splice(0)) off();
    this.unmount();
    this.timers.clearAll();
    this.queue = [];
    this.current = null;
  }

  // ─────────────────────────────── lifecycle ───────────────────────────────

  private unmount(): void {
    this.closeMenu(false);
    this.cancelDrag();
    this.stopLife();
    this.cancelFrame();
    this.win?.removeEventListener('resize', this.onResize);
    this.win?.removeEventListener('pointerdown', this.onOutsidePointer);
    this.motionQuery?.removeEventListener?.('change', this.onMotionChange);
    this.motionQuery = null;
    this.root.remove();
    this.releaseStyles?.();
    this.releaseStyles = null;
    this.win = null;
    this.mounted = false;
  }

  private listen<K extends EventName>(type: K, cb: (payload: AppEvents[K]) => void): void {
    this.unsubs.push(this.bus.on(type, cb));
  }

  private settings(): AppSettings {
    try {
      return this.getSettings() ?? DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private chattiness(): Chattiness {
    const c = this.settings().buddyChattiness;
    return c === 'quiet' || c === 'chatty' ? c : 'normal';
  }

  private setEnabled(on: boolean, announce: boolean): void {
    if (on === this.enabled) {
      this.root.hidden = !on;
      return;
    }
    this.enabled = on;
    this.root.hidden = !on;
    if (!on) {
      this.closeMenu(false);
      this.endDrag(false); // settles any drag offset so he reappears in his corner
      this.dropSpeech();
      this.stopLife();
      this.cancelFrame();
      return;
    }
    this.eyesDirty = true;
    this.startLife();
    this.requestFrame();
    if (announce) this.sayQuip('unhide', { priority: 'normal', ttlMs: 10_000, mood: 'happy' });
  }

  private readonly onSettingsChanged = (e: AppEvents['settings-changed']): void => {
    const s = e?.settings;
    if (!s) return;
    const changed = Array.isArray(e.changed) ? e.changed : [];
    if (changed.includes('buddyCorner')) this.setCorner(s.buddyCorner, true);
    if (changed.includes('buddyEnabled')) this.setEnabled(s.buddyEnabled !== false, true);
    if (changed.includes('buddyChattiness')) this.purgeQueue();
    if (changed.includes('autoScroll')) this.syncMenuLabels();
  };

  private readonly onMotionChange = (e: MediaQueryListEvent): void => {
    this.reducedMotion = e.matches;
  };

  private readonly onResize = (): void => {
    this.eyesDirty = true;
    if (this.current) this.placeFloating(this.bubble);
    if (this.menuOpen) this.placeFloating(this.pop);
    this.requestFrame();
  };

  // ─────────────────────────────── bus handlers ──────────────────────────────

  private readonly onGaze = (g: GazeSample): void => {
    if (!g || typeof g !== 'object') return;
    if (g.valid === true && Number.isFinite(g.x) && Number.isFinite(g.y)) {
      const t = now();
      const wasReading = t - this.lastValidGazeAt < READING_LINGER_MS;
      if (t - this.lastValidGazeAt > BUSY_GAZE_MS) this.validRunStart = t;
      this.lastGaze = g;
      this.lastValidGazeAt = t;
      this.lastActivityAt = t;
      // If he was also worried, "There you are!" says it all.
      if (this.sleepy) this.wake(!this.worried);
      if (!wasReading) {
        this.refreshMood();
        this.scheduleVitals();
      }
    }
    this.requestFrame();
  };

  private readonly onLayout = (layout: LineLayout): void => {
    this.layout = layout && Array.isArray(layout.lines) && isFiniteRect(layout.column) ? layout : null;
    if (this.current) this.placeFloating(this.bubble);
  };

  private readonly onLineEstimate = (e: LineEstimate): void => {
    if (!e || typeof e !== 'object') return;
    this.lastEstimate = e;
    this.lastEstimateAt = now();
    this.sawEstimates = true;
  };

  private readonly onPageTurn = (e: AppEvents['page-turn']): void => {
    this.markActivity();
    this.flipBook(1);
    this.pageTurnAt = now();
    if (e?.auto === true && this.random() < PAGE_TURN_REACTION_P) {
      this.sayQuip('pageTurn', { priority: 'normal', remark: true, ttlMs: 4_000 });
    } else if (this.chattiness() === 'chatty' && this.random() < PAGE_TURN_FUN_FACT_P) {
      this.sayQuip('funFacts', { priority: 'low', remark: true, ttlMs: 20_000, mood: 'excited' });
    }
    this.timers.set('pump', PAGE_TURN_SPEAK_DELAY_MS, this.pump);
  };

  private readonly onPageTurnUndone = (): void => {
    this.markActivity();
    this.flipBook(-1);
  };

  private readonly onTrackingState = (e: AppEvents['tracking-state']): void => {
    const state = e?.state;
    if (state !== 'calibrating' && state !== 'starting' && this.calibrationMood !== null) {
      // Calibration ended without its closing event: don't stay above panels and toasts.
      this.calibrationMood = null;
      this.calPhase = null;
      this.raise(false);
      this.refreshMood();
    }
    if (state === 'no-face') {
      this.timers.clear('recover');
      if (!this.noFace) {
        this.noFace = true;
        if (!this.worried) this.timers.set('worry', WORRY_AFTER_MS, this.becomeWorried);
      }
      return;
    }
    this.noFace = false;
    this.timers.clear('worry');
    if (!this.worried) {
      this.worriedSpoken = false;
      return;
    }
    if (state === 'tracking' || state === 'poor') {
      if (!this.timers.has('recover')) this.timers.set('recover', RECOVER_MS, () => this.endWorry(true));
    } else {
      // Tracking was stopped on purpose (paused, off, calibrating…): no fuss.
      this.endWorry(false);
    }
  };

  private readonly becomeWorried = (): void => {
    if (!this.noFace || this.calibrationMood !== null) return;
    this.worried = true;
    this.refreshMood();
    if (!this.worriedSpoken) {
      // Only a line that was actually queued earns the "there you are" later.
      this.worriedSpoken = this.sayQuip('trackingLost', { priority: 'high', ttlMs: 15_000, tag: 'worry' });
    }
  };

  private endWorry(greet: boolean): void {
    const spoke = this.worriedSpoken;
    this.worried = false;
    this.worriedSpoken = false;
    this.withdraw('worry');
    if (greet && spoke) {
      this.setTransient('happy', 2_500);
      // Closes the loop on the high-priority "I can't see you", so it may interrupt too.
      this.sayQuip('trackingBack', { priority: 'high', ttlMs: 5_000, durationMs: 2_400 });
    }
    this.refreshMood();
  }

  private readonly onCalibration = (e: AppEvents['calibration']): void => {
    const phase = e?.phase;
    if (!phase) return;
    this.markActivity();
    const repeat = phase === this.calPhase && phase !== 'point';
    this.calPhase = phase;
    switch (phase) {
      case 'start':
        this.raise(true);
        this.calibrationMood = 'excited';
        if (!repeat) this.coach('calibrationStart');
        break;
      case 'positioning':
        this.raise(true);
        this.calibrationMood = 'happy';
        if (!repeat) this.coach('calibrationPositioning');
        break;
      case 'point':
        // Targets can appear anywhere, including under Dewey: step behind the overlay.
        this.raise(false);
        this.calibrationMood = 'reading';
        // Only the first target's first announcement; the overlay re-emits it with a
        // message on retry / pause / resume, which isn't worth a new tip.
        if (e.index === 0 && typeof e.message !== 'string') this.coach('calibrationPoint');
        break;
      case 'training':
        this.raise(true);
        this.calibrationMood = 'thinking';
        if (!repeat) this.coach('calibrationTraining');
        break;
      case 'validating':
        this.raise(false);
        this.calibrationMood = 'reading';
        if (!repeat) this.coach('calibrationValidating');
        break;
      case 'done': {
        this.calibrationMood = null;
        this.calPhase = null;
        this.raise(true, 7_000);
        const q = e.report?.quality;
        if (q === 'excellent' || q === 'good') {
          this.setTransient('excited', 3_500);
          this.coach('calibrationGood');
        } else if (q === 'fair') {
          this.setTransient('happy', 3_500);
          this.coach('calibrationFair');
        } else if (q === 'poor') {
          this.setTransient('thinking', 3_500);
          this.coach('calibrationPoor');
        } else {
          this.setTransient('happy', 2_500);
        }
        break;
      }
      case 'cancelled':
        this.calibrationMood = null;
        this.calPhase = null;
        this.raise(false);
        this.coach('calibrationCancelled');
        break;
      case 'failed':
        this.calibrationMood = null;
        this.calPhase = null;
        this.raise(true, 7_000);
        this.setTransient('worried', 3_000);
        this.coach('calibrationFailed');
        break;
    }
    this.refreshMood();
  };

  private readonly onBookOpened = (e: AppEvents['book-opened']): void => {
    this.markActivity();
    this.lastFraction = null;
    this.milestonesSaid.clear();
    this.tensSeen = null;
    this.bookDone = false;
    const title = typeof e?.title === 'string' && e.title.trim() ? shortTitle(e.title) : undefined;
    this.setTransient('happy', 2_600);
    this.sayQuip(e?.resumed ? 'welcomeBack' : 'greeting', { priority: 'normal', ttlMs: 20_000 }, { title });
  };

  private readonly onBookProgress = (e: AppEvents['book-progress']): void => {
    if (!e || typeof e !== 'object') return;
    // After the finale, keep the baselines current but save the applause.
    let announced = this.bookDone;
    const f = e.fraction;
    if (typeof f === 'number' && Number.isFinite(f)) {
      const frac = clamp(f, 0, 1);
      const prev = this.lastFraction;
      this.lastFraction = frac;
      if (prev === null) {
        // First report (e.g. a resumed book): milestones already behind us don't count.
        for (const m of MILESTONES) if (frac >= m) this.milestonesSaid.add(m);
      } else {
        const crossed = MILESTONES.filter((m) => prev < m && frac >= m && !this.milestonesSaid.has(m));
        for (const m of crossed) this.milestonesSaid.add(m);
        const top = crossed[crossed.length - 1];
        if (top !== undefined && !announced) {
          const key: QuipKey = top === 0.25 ? 'milestone25' : top === 0.5 ? 'milestone50' : 'milestone75';
          announced = this.sayQuip(key, { priority: 'normal', remark: true, mood: 'excited', ttlMs: 120_000 });
        }
      }
    }
    const pages = e.pagesTurned;
    if (typeof pages === 'number' && Number.isFinite(pages) && pages >= 0) {
      const tens = Math.floor(pages / 10);
      if (this.tensSeen === null || tens < this.tensSeen) {
        this.tensSeen = tens;
      } else if (tens > this.tensSeen) {
        this.tensSeen = tens;
        if (!announced && tens > 0) {
          this.sayQuip('tenPages', { priority: 'normal', remark: true, mood: 'happy', ttlMs: 90_000 }, { pages: tens * 10 });
        }
      }
    }
  };

  private readonly onBookFinished = (): void => {
    this.markActivity();
    this.bookDone = true;
    // A milestone still waiting for a pause would be an odd encore.
    this.queue = this.queue.filter((u) => !u.remark);
    this.celebrate();
    this.sayQuip('bookFinished', { priority: 'high', mood: 'celebrating', ttlMs: 60_000 });
  };

  private readonly onBreakDue = (): void => {
    if (this.settings().breakReminders === false) return;
    const said = this.sayQuip('break', { priority: 'high', mood: 'happy', ttlMs: 60_000, durationMs: 9_000 });
    if (said) {
      // Dewey takes the 20-20-20 break with you: he gazes off into the distance.
      this.glance = { offset: { x: 2.2, y: -1.4 }, until: now() + 20_000 };
      this.timers.set('look', 20_010, () => this.requestFrame());
      this.requestFrame();
    }
  };

  private readonly onBuddySay = (e: AppEvents['buddy-say']): void => {
    if (!e || typeof e.text !== 'string') return;
    this.say(e.text, { priority: e.priority, durationMs: e.durationMs, mood: e.mood });
  };

  private readonly onPoke = (): void => {
    this.markActivity();
    this.wiggle();
    // Clicking Dewey opens the menu (whose header greets); only answer pokes from elsewhere.
    if (this.menuOpen) return;
    this.sayQuip('poke', { priority: 'high', mood: 'happy', ttlMs: 5_000 });
  };

  // ───────────────────────────────── speech ──────────────────────────────────

  private sayQuip(key: QuipKey, o: SpeakOptions, vars: QuipVars = {}): boolean {
    if (this.destroyed || !this.enabled || !chattinessAllows(this.chattiness(), o.priority)) return false;
    const t = now();
    const line = this.quips.pick(key, vars, (l) => this.recentlySaid(l, t));
    return line !== null && this.enqueue(line, { ...o, fromApp: false });
  }

  private coach(key: QuipKey): void {
    // Coaching for an earlier phase is stale the moment the phase changes.
    this.withdraw('cal');
    this.sayQuip(key, { priority: 'normal', ttlMs: 8_000, tag: 'cal' });
  }

  private enqueue(raw: string, o: SpeakOptions): boolean {
    if (this.destroyed || !this.enabled || typeof raw !== 'string') return false;
    const text = clampSpeech(raw);
    if (!text) return false;
    const priority: SpeechPriority = isPriority(o.priority) ? o.priority : 'normal';
    if (!chattinessAllows(this.chattiness(), priority)) return false;
    const t = now();
    if (this.current?.text === text || this.queue.some((u) => u.text === text)) return false;
    if (!(o.fromApp === true && priority === 'high') && this.recentlySaid(text, t)) return false;
    const ttl =
      o.ttlMs !== undefined && Number.isFinite(o.ttlMs) && o.ttlMs > 0
        ? o.ttlMs
        : o.fromApp === true
          ? Math.min(APP_TTL_MS, TTL_MS[priority])
          : TTL_MS[priority];
    const u: Utterance = {
      text,
      priority,
      durationMs: validDuration(o.durationMs),
      mood: isMood(o.mood) ? o.mood : null,
      remark: o.remark === true,
      fromApp: o.fromApp === true,
      tag: o.tag ?? null,
      expiresAt: t + ttl,
    };
    const cur = this.current;
    if (cur && PRIORITY_RANK[priority] > PRIORITY_RANK[cur.priority] && !this.blocked() && this.canSpeak(u, t)) {
      this.endSpeech(false);
      this.show(u);
      return true;
    }
    this.insert(u);
    this.pump();
    return true;
  }

  private insert(u: Utterance): void {
    const rank = PRIORITY_RANK[u.priority];
    let i = this.queue.findIndex((q) => PRIORITY_RANK[q.priority] < rank);
    if (i < 0) i = this.queue.length;
    this.queue.splice(i, 0, u);
    while (this.queue.length > QUEUE_LIMIT) {
      // Drop the oldest of the least important lines.
      let victim = 0;
      for (let j = 1; j < this.queue.length; j++) {
        const q = this.queue[j];
        const v = this.queue[victim];
        if (q && v && PRIORITY_RANK[q.priority] < PRIORITY_RANK[v.priority]) victim = j;
      }
      this.queue.splice(victim, 1);
    }
  }

  private readonly pump = (): void => {
    this.timers.clear('pump');
    if (this.current || this.blocked()) return;
    const t = now();
    const sincePageTurn = t - this.pageTurnAt;
    if (sincePageTurn >= 0 && sincePageTurn < PAGE_TURN_SPEAK_DELAY_MS) {
      this.timers.set('pump', PAGE_TURN_SPEAK_DELAY_MS - sincePageTurn, this.pump);
      return;
    }
    const chattiness = this.chattiness();
    this.queue = this.queue.filter((u) => u.expiresAt > t && chattinessAllows(chattiness, u.priority));
    const idx = this.queue.findIndex((u) => this.canSpeak(u, t));
    if (idx >= 0) {
      const [u] = this.queue.splice(idx, 1);
      if (u) this.show(u);
      return;
    }
    if (this.queue.length > 0) this.timers.set('pump', HOLD_RETRY_MS, this.pump);
  };

  private blocked(): boolean {
    return this.destroyed || !this.mounted || !this.enabled || this.menuOpen || this.drag?.active === true;
  }

  private canSpeak(u: Utterance, t: number): boolean {
    if (u.priority === 'high') return true;
    if (this.readerBusy(t)) return false;
    return !u.remark || t - this.lastRemarkAt >= REMARK_GAP_MS;
  }

  /** True while the reader is in the middle of reading a line of text. */
  private readerBusy(t: number): boolean {
    // Calibrating isn't reading, however much valid gaze lands on the column.
    if (this.calPhase !== null) return false;
    if (t - this.pageTurnAt < PAGE_TURN_WINDOW_MS) return false;
    const g = this.lastGaze;
    if (!g || t - this.lastValidGazeAt > BUSY_GAZE_MS || t - this.validRunStart < SETTLE_MS) return false;
    const layout = this.layout;
    if (layout) {
      if (layout.lines.length === 0 || !insideColumn(g, layout)) return false;
    }
    if (this.sawEstimates) {
      return t - this.lastEstimateAt < BUSY_ESTIMATE_MS && (this.lastEstimate?.lineIndex ?? -1) >= 0;
    }
    return true;
  }

  private show(u: Utterance): void {
    // Nobody talks in their sleep here: speaking wakes him (quietly) and resets the nap clock.
    this.markActivity();
    const t = now();
    this.current = u;
    for (const [line, at] of this.spokenAt) if (t - at >= DEDUPE_WINDOW_MS) this.spokenAt.delete(line);
    this.spokenAt.set(u.text, t);
    if (u.remark) this.lastRemarkAt = t;

    this.bubbleText.textContent = u.text;
    this.live.textContent = u.text;
    this.placeFloating(this.bubble);
    this.bubble.classList.add(`${B}-bubble--show`);

    const duration = u.durationMs ?? speechDurationMs(u.text);
    this.speechEndsAt = t + duration;
    this.speechRemaining = null;
    this.timers.set('speech', duration, () => this.endSpeech(true));

    if (u.mood && !(this.transient && this.transient.mood === u.mood && this.transient.until >= t + duration)) {
      this.setTransient(u.mood, duration, true);
    }
    this.root.classList.add(`${B}--talking`);
    this.timers.set('talk', clamp(250 + 30 * u.text.length, 500, 1_800), () =>
      this.root.classList.remove(`${B}--talking`),
    );
    this.requestFrame();
  }

  private endSpeech(thenContinue: boolean): void {
    if (!this.current) return;
    this.timers.clear('speech');
    this.timers.clear('talk');
    this.current = null;
    this.speechRemaining = null;
    this.root.classList.remove(`${B}--talking`);
    this.bubble.classList.remove(`${B}-bubble--show`);
    this.live.textContent = '';
    if (this.transient?.fromSpeech) {
      this.transient = null;
      this.refreshMood();
    }
    this.requestFrame();
    if (thenContinue) this.timers.set('pump', SPEECH_GAP_MS, this.pump);
  }

  /** Removes queued (and showing) lines with this tag. */
  private withdraw(tag: string): void {
    this.queue = this.queue.filter((u) => u.tag !== tag);
    if (this.current?.tag === tag) this.endSpeech(true);
  }

  private dropSpeech(): void {
    this.queue = [];
    this.endSpeech(false);
    this.timers.clear('pump');
  }

  private purgeQueue(): void {
    const chattiness = this.chattiness();
    this.queue = this.queue.filter((u) => chattinessAllows(chattiness, u.priority));
    if (this.current && !chattinessAllows(chattiness, this.current.priority)) this.endSpeech(true);
  }

  private recentlySaid(text: string, t: number): boolean {
    const at = this.spokenAt.get(text);
    return at !== undefined && t - at < DEDUPE_WINDOW_MS;
  }

  private readonly onBubbleEnter = (): void => {
    // Hovering keeps the line up for as long as someone is reading it.
    if (!this.current || !this.timers.has('speech')) return;
    this.speechRemaining = Math.max(0, this.speechEndsAt - now());
    this.timers.clear('speech');
  };

  private readonly onBubbleLeave = (): void => {
    if (!this.current || this.speechRemaining === null) return;
    const ms = Math.max(this.speechRemaining, 1_200);
    this.speechRemaining = null;
    this.speechEndsAt = now() + ms;
    this.timers.set('speech', ms, () => this.endSpeech(true));
  };

  // ────────────────────────────────── mood ───────────────────────────────────

  private resolveMood(t: number): BuddyMood {
    if (this.transient && this.transient.until > t) return this.transient.mood;
    if (this.held && this.held.until > t) return this.held.mood;
    if (this.calibrationMood) return this.calibrationMood;
    if (this.worried) return 'worried';
    if (this.sleepy) return 'sleepy';
    return t - this.lastValidGazeAt < READING_LINGER_MS ? 'reading' : 'idle';
  }

  private refreshMood(): void {
    const t = now();
    if (this.transient && this.transient.until <= t) this.transient = null;
    if (this.held && this.held.until <= t) this.held = null;
    const m = this.resolveMood(t);
    if (m === this.mood) return;
    this.root.classList.remove(`${B}--mood-${this.mood}`);
    this.root.classList.add(`${B}--mood-${m}`);
    this.root.dataset.mood = m;
    this.mood = m;
    this.requestFrame();
  }

  private setTransient(mood: BuddyMood, ms: number, fromSpeech = false): void {
    this.transient = { mood, until: now() + ms, fromSpeech };
    this.refreshMood();
    this.scheduleVitals();
  }

  /**
   * One lazily re-armed timer covers every time-based transition (reading →
   * idle, falling asleep, transient moods ending), so a 60 Hz gaze stream
   * never churns timers.
   */
  private scheduleVitals(): void {
    if (this.destroyed) return;
    const t = now();
    let due = Infinity;
    if (!this.sleepy) due = Math.min(due, this.lastActivityAt + SLEEP_AFTER_MS);
    if (t - this.lastValidGazeAt < READING_LINGER_MS) due = Math.min(due, this.lastValidGazeAt + READING_LINGER_MS);
    if (this.transient && Number.isFinite(this.transient.until)) due = Math.min(due, this.transient.until);
    if (this.held && Number.isFinite(this.held.until)) due = Math.min(due, this.held.until);
    if (!Number.isFinite(due)) {
      this.timers.clear('vitals');
      this.vitalsDueAt = Infinity;
      return;
    }
    if (this.timers.has('vitals') && this.vitalsDueAt <= due) return;
    this.vitalsDueAt = due;
    this.timers.set('vitals', due - t + 1, this.onVitals);
  }

  private readonly onVitals = (): void => {
    this.vitalsDueAt = Infinity;
    if (!this.sleepy && now() - this.lastActivityAt >= SLEEP_AFTER_MS) this.sleepy = true;
    this.refreshMood();
    this.scheduleVitals();
  };

  private markActivity(): void {
    this.lastActivityAt = now();
    if (this.sleepy) this.wake(false);
    this.scheduleVitals();
  }

  private wake(speak: boolean): void {
    if (!this.sleepy) return;
    this.sleepy = false;
    this.refreshMood();
    this.scheduleVitals();
    if (speak) this.sayQuip('wakeUp', { priority: 'normal', ttlMs: 8_000, mood: 'excited' });
  }

  private celebrate(): void {
    this.setTransient('celebrating', CELEBRATE_MS);
    if (!this.mounted || !this.enabled || this.reducedMotion) return;
    const doc = this.root.ownerDocument;
    const colors = ['#ffcf4d', '#f28b82', '#7cc4fa', '#9be08a', '#c69cf4', '#ffffff'];
    this.fx.replaceChildren();
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const piece = doc.createElement('span');
      piece.className = `${B}-confetti`;
      const angle = -Math.PI / 2 + (this.random() - 0.5) * Math.PI * 1.2;
      const dist = 50 + this.random() * 70;
      piece.style.setProperty(`--${B}-dx`, `${(Math.cos(angle) * dist).toFixed(1)}px`);
      piece.style.setProperty(`--${B}-dy`, `${(Math.sin(angle) * dist).toFixed(1)}px`);
      piece.style.setProperty(`--${B}-rot`, `${Math.round((this.random() - 0.5) * 720)}deg`);
      piece.style.setProperty(`--${B}-delay`, `${Math.round(this.random() * 120)}ms`);
      piece.style.setProperty(`--${B}-c`, colors[i % colors.length] ?? '#ffcf4d');
      this.fx.appendChild(piece);
    }
    this.timers.set('confetti', 1_800, () => this.fx.replaceChildren());
  }

  private wiggle(): void {
    this.restartClass(`${B}--wiggle`, 520, 'wiggle');
  }

  private flipBook(dir: 1 | -1): void {
    this.root.classList.remove(`${B}--flip`, `${B}--flip-back`);
    this.restartClass(dir > 0 ? `${B}--flip` : `${B}--flip-back`, FLIP_MS + 40, 'flip');
    // A quick glance down at his own book as the page turns.
    this.glance = { offset: { x: dir > 0 ? -0.8 : 0.8, y: 2.5 }, until: now() + 520 };
    this.timers.set('look', 530, () => this.requestFrame());
    this.requestFrame();
  }

  /** (Re)starts a CSS animation class and removes it after `ms`. */
  private restartClass(cls: string, ms: number, timer: string): void {
    this.root.classList.remove(cls);
    if (this.mounted) void this.root.offsetWidth; // reflow so the animation restarts
    this.root.classList.add(cls);
    this.timers.set(timer, ms, () => this.root.classList.remove(cls));
  }

  private raise(on: boolean, autoLowerMs?: number): void {
    this.root.classList.toggle(`${B}--above`, on);
    if (on && autoLowerMs !== undefined) this.timers.set('lower', autoLowerMs, () => this.raise(false));
    else this.timers.clear('lower');
  }

  // ─────────────────────────────── idle life ───────────────────────────────

  private startLife(): void {
    if (!this.mounted || !this.enabled || this.destroyed) return;
    this.scheduleBlink();
    this.scheduleFidget();
    this.scheduleGlance();
  }

  private stopLife(): void {
    for (const name of ['blink', 'blink-end', 'fidget', 'fidget-end', 'glance', 'look', 'stale']) this.timers.clear(name);
    this.root.classList.remove(`${B}--blink`, `${B}--push`);
  }

  private scheduleBlink(): void {
    this.timers.set('blink', 2_000 + this.random() * 4_000, () => {
      if (this.mood !== 'sleepy' && this.mood !== 'celebrating') this.blink(this.random() < 0.15);
      this.scheduleBlink();
    });
  }

  private blink(double: boolean): void {
    this.root.classList.add(`${B}--blink`);
    this.timers.set('blink-end', 130, () => {
      this.root.classList.remove(`${B}--blink`);
      if (double) this.timers.set('blink-end', 150, () => this.blink(false));
    });
  }

  private scheduleFidget(): void {
    // Now and then he pushes his glasses back up his nose.
    this.timers.set('fidget', 30_000 + this.random() * 45_000, () => {
      if (!this.current && (this.mood === 'idle' || this.mood === 'reading')) {
        this.root.classList.add(`${B}--push`);
        this.timers.set('fidget-end', 850, () => this.root.classList.remove(`${B}--push`));
      }
      this.scheduleFidget();
    });
  }

  private scheduleGlance(): void {
    this.timers.set('glance', 3_500 + this.random() * 5_000, () => {
      const t = now();
      const idle = t - this.lastValidGazeAt > GAZE_FRESH_MS;
      const busy = this.manualLook || this.current || (this.glance && this.glance.until > t);
      if (idle && !busy && this.mood !== 'sleepy' && this.mood !== 'celebrating') {
        const a = this.random() * Math.PI * 2;
        const m = 1.4 + this.random() * 1.2;
        const hold = 600 + this.random() * 700;
        this.glance = { offset: { x: Math.cos(a) * m, y: Math.sin(a) * m * 0.7 }, until: t + hold };
        this.timers.set('look', hold + 10, () => this.requestFrame());
        this.requestFrame();
      }
      this.scheduleGlance();
    });
  }

  // ────────────────────────────────── eyes ───────────────────────────────────

  private requestFrame(): void {
    if (this.frameHandle || !this.mounted || !this.enabled || this.destroyed) return;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.frameHandle = { kind: 'raf', id: globalThis.requestAnimationFrame(this.frame) };
    } else {
      this.frameHandle = { kind: 'timeout', id: Number(setTimeout(this.frame, 16)) };
    }
  }

  private cancelFrame(): void {
    const h = this.frameHandle;
    if (!h) return;
    if (h.kind === 'raf') globalThis.cancelAnimationFrame?.(h.id);
    else clearTimeout(h.id);
    this.frameHandle = null;
    this.lastFrameAt = 0;
  }

  private readonly frame = (): void => {
    this.frameHandle = null;
    if (!this.mounted || !this.enabled || this.destroyed) return;
    const t = now();
    const dt = this.lastFrameAt > 0 ? clamp(t - this.lastFrameAt, 0, 64) : 16;
    this.lastFrameAt = t;
    if (this.eyesDirty || t - this.eyesMeasuredAt > EYE_REMEASURE_MS) this.measureEyes(t);
    const k = 1 - Math.exp(-dt / EYE_EASE_MS);
    let moving = false;
    for (const i of [0, 1] as const) {
      const target = clampOffset(this.pupilTarget(i, t));
      const p = this.pupils[i];
      const nx = p.x + (target.x - p.x) * k;
      const ny = p.y + (target.y - p.y) * k;
      const settled = Math.hypot(target.x - nx, target.y - ny) < 0.02;
      p.x = settled ? target.x : nx;
      p.y = settled ? target.y : ny;
      const key = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      if (key !== this.appliedPupils[i]) {
        this.appliedPupils[i] = key;
        setPupil(this.avatar.eyes[i], p);
      }
      if (!settled) moving = true;
    }
    if (moving) {
      this.requestFrame();
    } else {
      this.lastFrameAt = 0;
      this.armStaleCheck(t);
    }
  };

  /**
   * The eyes rest while following a steady gaze; if the stream simply stops,
   * wake the loop once the gaze goes stale so they drift home. One timer at a
   * time, re-armed lazily — never per sample.
   */
  private armStaleCheck(t: number): void {
    if (this.lastGaze === null || this.timers.has('stale')) return;
    const staleAt = this.lastValidGazeAt + GAZE_FRESH_MS;
    if (staleAt <= t) return;
    this.timers.set('stale', staleAt - t + 5, () => this.requestFrame());
  }

  private measureEyes(t: number): void {
    const center = (i: 0 | 1): Point => {
      const r = this.avatar.eyes[i].sclera.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    this.eyeCenters = [center(0), center(1)];
    this.eyesDirty = false;
    this.eyesMeasuredAt = t;
  }

  /** Where pupil `i` should be, in SVG units from its eye center. */
  private pupilTarget(i: 0 | 1, t: number): Point {
    const eye = this.eyeCenters?.[i] ?? null;
    if (this.manualLook) return eye ? pupilOffset(eye, this.manualLook) : ZERO;
    if (this.glance) {
      if (this.glance.until > t) return this.glance.offset;
      this.glance = null;
    }
    const g = this.lastGaze;
    const fresh = g !== null && t - this.lastValidGazeAt < GAZE_FRESH_MS;
    if (this.mood === 'sleepy') return { x: 0, y: 1.2 };
    if (this.mood === 'celebrating') return ZERO;
    if (this.mood === 'thinking' && !fresh) return { x: -1.8, y: -2.1 };
    if (this.current) return ZERO; // talking: look at the reader
    if (!fresh || !g) return ZERO;
    const layout = this.layout;
    if (this.mood === 'reading' && layout && layout.lines.length > 0 && insideColumn(g, layout)) {
      // Reading along: eyes scan his own little book in step with the reader's line.
      const w = layout.column.right - layout.column.left;
      if (w > 1) return { x: (clamp((g.x - layout.column.left) / w, 0, 1) * 2 - 1) * 2.3, y: 2.1 };
    }
    return eye ? pupilOffset(eye, g) : ZERO;
  }

  // ───────────────────────────────── corner & drag ─────────────────────────────

  private setCorner(corner: Corner, animate: boolean): void {
    const c = isCorner(corner) ? corner : 'bottom-right';
    const offset = this.root.style.transform !== '';
    if (c === this.corner && !offset) return;
    const first = animate && this.mounted && !this.reducedMotion ? this.root.getBoundingClientRect() : null;
    this.root.classList.remove(`${B}--${this.corner}`, `${B}--snapping`);
    this.corner = c;
    this.root.classList.add(`${B}--${c}`);
    this.root.style.transform = '';
    if (first) {
      // FLIP: jump to the new corner, then animate from where we were.
      const last = this.root.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        this.root.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        void this.root.offsetWidth;
        this.root.classList.add(`${B}--snapping`);
        this.root.style.transform = '';
        this.timers.set('snap', SNAP_MS + 60, () => {
          this.root.classList.remove(`${B}--snapping`);
          this.eyesDirty = true;
          this.requestFrame();
        });
      }
    }
    this.eyesDirty = true;
    if (this.current) this.placeFloating(this.bubble);
    if (this.menuOpen) this.placeFloating(this.pop);
    this.requestFrame();
  }

  private viewport(): { width: number; height: number } {
    return { width: this.win?.innerWidth ?? 0, height: this.win?.innerHeight ?? 0 };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.isPrimary === false || !this.win) return;
    // A press that never saw its release (the page swallowed it, the window lost
    // focus mid-drag…) must not leave Dewey glued to the pointer: settle it first.
    if (this.drag) this.endDrag(false);
    if (this.root.classList.contains(`${B}--snapping`)) {
      this.root.classList.remove(`${B}--snapping`);
      this.root.style.transform = '';
    }
    const r = this.root.getBoundingClientRect();
    const target = e.target instanceof Element ? e.target : null;
    this.drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      base: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      dx: 0,
      dy: 0,
      active: false,
      captureTarget: target,
    };
    // Capture phase: a host page that stops propagation can't hide the release from us.
    this.win.addEventListener('pointermove', this.onPointerMove, true);
    this.win.addEventListener('pointerup', this.onPointerUp, true);
    this.win.addEventListener('pointercancel', this.onPointerCancel, true);
    try {
      target?.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is a nicety; window listeners still see the moves */
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
      // The button went up where we couldn't see it (e.g. outside the window).
      this.endDrag(true);
      return;
    }
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (!(Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX)) return;
      d.active = true;
      this.root.classList.add(`${B}--dragging`);
      this.closeMenu(false);
      this.endSpeech(false);
      this.markActivity();
    }
    const c = clampDrag(d.base, dx, dy, this.viewport(), 4);
    d.dx = c.x;
    d.dy = c.y;
    this.root.style.transform = `translate3d(${c.x}px, ${c.y}px, 0)`;
    this.eyesDirty = true;
    this.requestFrame();
    if (e.cancelable) e.preventDefault();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.id) this.endDrag(true);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.id) this.endDrag(false);
  };

  /**
   * Finishes the press. A press that never became a drag is a plain click (the
   * click event opens the menu). A drag either drops — snapping to the nearest
   * corner — or, when cancelled, slides back to where it came from.
   */
  private endDrag(drop: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.cancelDrag();
    if (!d.active) return;
    if (drop) {
      this.suppressClickUntil = now() + 400;
      const center = {
        x: (d.base.left + d.base.right) / 2 + d.dx,
        y: (d.base.top + d.base.bottom) / 2 + d.dy,
      };
      const corner = nearestCorner(center, this.viewport(), this.corner);
      this.setCorner(corner, true);
      if (corner !== this.settings().buddyCorner) this.bus.emit('settings-patch', { buddyCorner: corner });
    } else {
      this.setCorner(this.corner, true);
    }
    this.pump();
  }

  /** Drops any press in progress without side effects: listeners, capture and the dragging class. */
  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.win?.removeEventListener('pointermove', this.onPointerMove, true);
    this.win?.removeEventListener('pointerup', this.onPointerUp, true);
    this.win?.removeEventListener('pointercancel', this.onPointerCancel, true);
    try {
      if (d.captureTarget?.hasPointerCapture?.(d.id)) d.captureTarget.releasePointerCapture(d.id);
    } catch {
      /* already released */
    }
    this.root.classList.remove(`${B}--dragging`);
  }

  // ────────────────────────────────── menu ───────────────────────────────────

  private buildMenu(doc: Document, menu: HTMLElement): { label: HTMLSpanElement; icon: SVGPathElement } {
    const items: ReadonlyArray<{ action: MenuAction; label: string; icon: IconName; muted?: boolean } | 'sep'> = [
      { action: 'autoscroll', label: 'Pause auto-scroll', icon: 'pause' },
      { action: 'recalibrate', label: 'Recalibrate', icon: 'target' },
      { action: 'fact', label: 'Tell me a fun fact', icon: 'bulb' },
      { action: 'settings', label: 'Settings', icon: 'sliders' },
      'sep',
      { action: 'hide', label: `Hide ${BUDDY_NAME}`, icon: 'hide', muted: true },
    ];
    let autoscroll: { label: HTMLSpanElement; icon: SVGPathElement } | null = null;
    for (const item of items) {
      if (item === 'sep') {
        const sep = doc.createElement('div');
        sep.className = `${B}-sep`;
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        continue;
      }
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = item.muted ? `${B}-item ${B}-item--muted` : `${B}-item`;
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.dataset.action = item.action;
      const { svg, path } = icon(doc, item.icon);
      const label = doc.createElement('span');
      label.textContent = item.label;
      b.append(svg, label);
      b.addEventListener('click', () => this.activate(item.action));
      menu.appendChild(b);
      this.menuItems.push(b);
      if (item.action === 'autoscroll') autoscroll = { label, icon: path };
    }
    if (!autoscroll) throw new Error('menu is missing the auto-scroll item');
    return autoscroll;
  }

  private syncMenuLabels(): void {
    const on = this.settings().autoScroll !== false;
    this.autoscrollItem.label.textContent = on ? 'Pause auto-scroll' : 'Resume auto-scroll';
    this.autoscrollItem.icon.setAttribute('d', ICONS[on ? 'pause' : 'play']);
  }

  private readonly onBtnClick = (e: MouseEvent): void => {
    if (now() < this.suppressClickUntil) {
      e.preventDefault();
      return;
    }
    if (this.menuOpen) {
      this.closeMenu(true);
      return;
    }
    this.openMenu('first');
    this.bus.emit('buddy-poke', {});
  };

  private readonly onBtnKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
        break;
      case 'Escape':
        if (this.current) {
          e.stopPropagation();
          this.endSpeech(true);
        }
        break;
      case 'Enter':
      case ' ':
        // Let the button activate natively, but keep the app's Space = "next page" out of it.
        e.stopPropagation();
        break;
    }
  };

  private openMenu(focus: 'first' | 'last'): void {
    if (this.menuOpen || !this.mounted || !this.enabled || this.destroyed) return;
    this.popSay.textContent = this.menuGreeting();
    this.markActivity();
    this.endSpeech(false);
    this.menuOpen = true;
    this.syncMenuLabels();
    this.pop.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    this.root.classList.add(`${B}--menu-open`);
    this.placeFloating(this.pop);
    this.win?.addEventListener('pointerdown', this.onOutsidePointer);
    this.setTransient('happy', 2_500);
    this.focusItem(focus === 'first' ? 0 : this.menuItems.length - 1);
  }

  private menuGreeting(): string {
    const key: QuipKey = this.sleepy ? 'wakeUp' : this.worried ? 'trackingLost' : 'poke';
    return this.quips.pick(key) ?? 'Hi!';
  }

  private closeMenu(restoreFocus: boolean): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.pop.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    this.root.classList.remove(`${B}--menu-open`);
    this.win?.removeEventListener('pointerdown', this.onOutsidePointer);
    if (restoreFocus) this.btn.focus({ preventScroll: true });
    if (!this.destroyed) this.timers.set('pump', SPEECH_GAP_MS, this.pump);
  }

  private focusItem(i: number): void {
    const n = this.menuItems.length;
    if (n === 0) return;
    this.menuItems[((i % n) + n) % n]?.focus({ preventScroll: true });
  }

  private readonly onMenuKeyDown = (e: KeyboardEvent): void => {
    const i = this.menuItems.findIndex((b) => b === e.target);
    const n = this.menuItems.length;
    switch (e.key) {
      case 'ArrowDown':
        this.focusItem(i + 1);
        break;
      case 'ArrowUp':
        this.focusItem(i < 0 ? n - 1 : i - 1);
        break;
      case 'Home':
      case 'PageUp':
        this.focusItem(0);
        break;
      case 'End':
      case 'PageDown':
        this.focusItem(n - 1);
        break;
      case 'Escape':
        this.closeMenu(true);
        break;
      case 'Tab':
        // Menu-button pattern: close, then let Tab carry on from Dewey to the next control.
        this.closeMenu(true);
        return;
      case 'Enter':
      case ' ':
        e.stopPropagation(); // native activation; just keep it from the app's shortcuts
        return;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || !/\S/.test(e.key)) return;
        // Type-ahead: jump to the next item starting with that letter.
        const ch = e.key.toLocaleLowerCase();
        for (let k = 1; k <= n; k++) {
          const j = (Math.max(i, 0) + k) % n;
          if (this.menuItems[j]?.textContent?.trim().toLocaleLowerCase().startsWith(ch)) {
            this.focusItem(j);
            break;
          }
        }
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onMenuFocusOut = (e: FocusEvent): void => {
    const next = e.relatedTarget;
    if (this.menuOpen && next instanceof Node && !this.root.contains(next)) this.closeMenu(false);
  };

  private readonly onInsidePointer = (e: Event): void => {
    this.lastInsideEvent = e;
  };

  private readonly onOutsidePointer = (e: Event): void => {
    // Same Event object as the one our root saw → the press was inside Dewey (works in closed shadow roots too).
    if (e === this.lastInsideEvent) return;
    this.closeMenu(false);
  };

  private activate(action: MenuAction): void {
    switch (action) {
      case 'autoscroll':
        this.closeMenu(true);
        this.bus.emit('command', { name: 'toggle-autoscroll' });
        break;
      case 'recalibrate':
        this.closeMenu(true);
        this.bus.emit('command', { name: 'recalibrate' });
        break;
      case 'settings':
        this.closeMenu(true);
        this.bus.emit('command', { name: 'open-settings' });
        break;
      case 'fact':
        this.closeMenu(true);
        // Asked for explicitly, so it is spoken whatever the chattiness.
        this.sayQuip('funFacts', { priority: 'high', mood: 'excited', ttlMs: 10_000 });
        break;
      case 'hide':
        this.closeMenu(false);
        this.setEnabled(false, false);
        this.bus.emit('settings-patch', { buddyEnabled: false });
        break;
    }
  }

  // ───────────────────────────────── placement ─────────────────────────────────

  private placeFloating(el: HTMLElement): void {
    if (!this.mounted) return;
    const r = this.root.getBoundingClientRect();
    const col = this.layout && this.layout.lines.length > 0 && this.layout.column.right > this.layout.column.left
      ? this.layout.column
      : null;
    const menu = el === this.pop;
    const width = bubbleMaxWidth({
      corner: this.corner,
      anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      viewportWidth: this.viewport().width,
      columnCenterX: col ? (col.left + col.right) / 2 : null,
      columnEdgeX: col ? (this.corner.endsWith('right') ? col.right : col.left) : null,
      preferred: menu ? 228 : 260,
      min: menu ? 200 : 120,
    });
    el.style.maxWidth = `${width}px`;
  }
}

// ───────────────────────────────── internals ─────────────────────────────────

class Timers {
  private readonly ids = new Map<string, ReturnType<typeof setTimeout>>();

  set(name: string, ms: number, fn: () => void): void {
    this.clear(name);
    const id = setTimeout(
      () => {
        this.ids.delete(name);
        fn();
      },
      Number.isFinite(ms) ? Math.max(0, ms) : 0,
    );
    this.ids.set(name, id);
  }

  has(name: string): boolean {
    return this.ids.has(name);
  }

  clear(name: string): void {
    const id = this.ids.get(name);
    if (id === undefined) return;
    clearTimeout(id);
    this.ids.delete(name);
  }

  clearAll(): void {
    for (const id of this.ids.values()) clearTimeout(id);
    this.ids.clear();
  }
}

const ICONS = {
  pause: 'M9 5.5v13M15 5.5v13',
  play: 'M8 5.5v13l10-6.5z',
  target: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3',
  bulb: 'M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  hide: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A9.5 9.5 0 0 1 12 5c5 0 8.6 4.4 9.6 7a12.6 12.6 0 0 1-2.6 3.8M6.4 6.4C4.4 7.7 3 9.7 2.4 12c1 2.6 4.6 7 9.6 7 1.7 0 3.3-.5 4.6-1.3',
} as const;

type IconName = keyof typeof ICONS;

function icon(doc: Document, name: IconName): { svg: SVGSVGElement; path: SVGPathElement } {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return { svg, path };
}

function stopActivationKeys(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isFiniteRect(r: Rect | null | undefined): r is Rect {
  return !!r && Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom);
}

/** Is the gaze on (or right next to) the text column? */
function insideColumn(g: Point, layout: LineLayout): boolean {
  const pitch = Number.isFinite(layout.linePitch) && layout.linePitch > 0 ? layout.linePitch : 32;
  const col = layout.column;
  const vp = isFiniteRect(layout.viewport) ? layout.viewport : col;
  return g.x >= col.left - pitch && g.x <= col.right + pitch && g.y >= vp.top - pitch && g.y <= vp.bottom + pitch;
}

function isStyleRoot(node: Node): node is Document | ShadowRoot {
  return node.nodeType === 9 || (node.nodeType === 11 && 'host' in node);
}

function isMood(v: unknown): v is BuddyMood {
  return typeof v === 'string' && (MOODS as readonly string[]).includes(v);
}

function isPriority(v: unknown): v is SpeechPriority {
  return v === 'low' || v === 'normal' || v === 'high';
}

function isCorner(v: unknown): v is Corner {
  return typeof v === 'string' && (CORNERS as readonly string[]).includes(v);
}

function validDuration(ms: number | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? clamp(ms, 800, 30_000) : null;
}
