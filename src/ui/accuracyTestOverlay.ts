/**
 * The live accuracy test's screen: rounds of dots at known places, one round per way of sitting,
 * then the scores.
 *
 * It runs right after a full calibration and takes that calibration's frames, so the recording
 * holds everything needed to fit any calibration again: the calibration dots, the head-movement
 * step, and the test dots. It keeps eye features only (numbers, never video), scores them with
 * src/gaze/accuracyTest.ts, and offers the recording as a file. Nothing leaves the browser unless
 * the reader saves that file and sends it somewhere.
 *
 * Self-contained like the calibration overlay: its own <style>, `gr-acc-*` classes.
 */
import { CSS_PREFIX, IGNORE_ATTR, Z } from '../core/constants';
import {
  ACCURACY_TEST_KIND,
  ACCURACY_TEST_VERSION,
  DEFAULT_VARIANT,
  FALLBACK_LINE_PITCH_PX,
  MIN_FRAMES_PER_DOT,
  POSTURES,
  TEST_TARGETS,
  formatScores,
  recordFrame,
  scoreRecording,
  type AccuracyRecording,
  type AccuracyScores,
  type GroupScore,
  type Posture,
  type RecordedBlock,
  type RecordedFrame,
  type RecordedTrial,
} from '../gaze/accuracyTest';
import { assumedCameraInViewport, currentScreenOrigin } from '../gaze/calibrationModel';
import { FEATURE_NAMES } from '../gaze/features';
import type { GazePriorWeights } from '../gaze/gazePrior';
import { BlinkGate } from '../gaze/webcamGazeSource';
import type { CalibrationSample, FeatureFrame, FeatureSource, Point, Unsubscribe } from '../types';
import type { CalibrationFrames } from './calibrationOverlay';

export interface AccuracyTestTiming {
  /** The dot travels to its next place, then the eyes get time to land on it. */
  glideMs: number;
  settleMs: number;
  /** Frames are kept for this long at each dot. */
  dotMs: number;
  /** A dot that got too few frames is shown again, up to this many times in all. */
  maxAttempts: number;
}

export const DEFAULT_ACCURACY_TEST_TIMING: Readonly<AccuracyTestTiming> = Object.freeze({
  glideMs: 380,
  settleMs: 500,
  dotMs: 1300,
  maxAttempts: 2,
});

export interface AccuracyTestOverlayOptions {
  features: FeatureSource;
  /** The frames of the calibration that has just finished. */
  calibration: CalibrationFrames;
  /** Line pitch of the open text, CSS px. */
  linePitchPx?: number | null;
  /** Gaze Reader's version, for the recording. */
  appVersion?: string;
  /** The real-face weights: with them that calibration is scored too. */
  prior?: GazePriorWeights | null;
  /** The id of the eye-picture network that is running: its answers are kept and its calibration scored too. */
  eyeNet?: string | null;
  /** Saves the recording as a file; false when it could not. Without it there is no Save button. */
  save?: (recording: AccuracyRecording) => boolean;
  /** Copies text; without it the browser's clipboard is used. */
  copy?: (text: string) => Promise<void>;
  timing?: Partial<AccuracyTestTiming>;
  random?: () => number;
  isTrustedKey?: (e: KeyboardEvent) => boolean;
}

export interface AccuracyTestResult {
  recording: AccuracyRecording;
  scores: AccuracyScores;
}

const P = `${CSS_PREFIX}acc`;

/** The calibration's kept samples, grouped by dot, as the recording stores them. */
export function trialsFromSamples(samples: readonly CalibrationSample[], sessionStart: number, label?: string): RecordedTrial[] {
  const trials: RecordedTrial[] = [];
  let last: RecordedTrial | null = null;
  for (const s of samples) {
    const f = recordFrame({ t: s.t, faceFound: true, features: s.features, quality: 1 }, sessionStart);
    if (!f) continue;
    if (!last || last.target.x !== s.target.x || last.target.y !== s.target.y) {
      last = { target: { x: s.target.x, y: s.target.y }, frames: [] };
      if (label) last.label = label;
      trials.push(last);
    }
    last.frames.push(f);
  }
  return trials;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const fmt = (n: number, digits = 0): string => (Number.isFinite(n) ? n.toFixed(digits) : '–');

export class AccuracyTestOverlay {
  private readonly timing: AccuracyTestTiming;
  private readonly random: () => number;
  private readonly blinkGate = new BlinkGate();
  private root: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private dot: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private progress: HTMLElement | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private ctl: AbortController | null = null;
  private running: Promise<AccuracyTestResult | null> | null = null;
  private destroyed = false;
  /** The dot frames are being kept for, and the window (frame clock) they are kept in. */
  private collector: { frames: RecordedFrame[]; from: number; until: number } | null = null;
  /** Session start on the frame clock: recorded times count from here. */
  private sessionStart = 0;
  /** Pending card choice. */
  private choose: ((choice: string) => void) | null = null;
  private stopAsked = false;
  private resized = false;
  /** The rounds are over: the recording is complete, and a resize can no longer spoil it. */
  private recorded = false;

  constructor(private readonly opts: AccuracyTestOverlayOptions) {
    this.timing = { ...DEFAULT_ACCURACY_TEST_TIMING, ...opts.timing };
    this.random = opts.random ?? Math.random;
  }

  get active(): boolean {
    return this.running !== null;
  }

  /** Resolves with the recording and its scores, or null when the reader left before any round was complete. */
  run(parent?: HTMLElement | ShadowRoot): Promise<AccuracyTestResult | null> {
    if (this.destroyed) return Promise.resolve(null);
    if (this.running) return this.running;
    const host = parent ?? (typeof document === 'undefined' ? null : document.body);
    if (!host) return Promise.resolve(null);
    this.build(host);
    const p = this.execute().finally(() => {
      this.teardown();
      this.running = null;
    });
    this.running = p;
    return p;
  }

  cancel(): void {
    if (this.ctl && !this.ctl.signal.aborted) this.ctl.abort();
    this.choose?.('cancel');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.teardown();
  }

  // ───────────────────────────────── flow ────────────────────────────────────

  private async execute(): Promise<AccuracyTestResult | null> {
    const ctl = new AbortController();
    this.ctl = ctl;
    const signal = ctl.signal;
    const cal = this.opts.calibration;
    const win = this.root?.ownerDocument.defaultView ?? window;
    const originStart = currentScreenOrigin();
    const firstT = cal.targets[0]?.t ?? cal.head[0]?.t ?? performance.now();
    this.sessionStart = firstT;
    const recordedAt = new Date(Date.now() - Math.max(0, performance.now() - firstT)).toISOString();

    const blocks: RecordedBlock[] = [{ kind: 'calibrate', trials: trialsFromSamples(cal.targets, firstT) }];
    if (cal.head.length > 0) blocks.push({ kind: 'head', trials: trialsFromSamples(cal.head, firstT, 'all') });

    this.unsubscribe = this.opts.features.onFrame(this.handleFrame);
    win.addEventListener('keydown', this.handleKeydown, true);
    win.addEventListener('resize', this.handleResize);

    const first = await this.showCard({
      title: 'Accuracy test',
      body: [
        `Your calibration is done. Now ${POSTURES.length} short rounds of ${TEST_TARGETS.length} dots show how well it holds: sitting still, with your head turned, leaning back, sitting lower, and sitting up again.`,
        'Each round takes about 20 seconds. Look at the middle of each dot until it moves on.',
        'Only numbers about your eyes and head are kept, never video, and nothing leaves this browser unless you save the recording yourself.',
      ],
      actions: [
        { id: 'go', label: 'Start', primary: true },
        { id: 'cancel', label: 'Not now' },
      ],
    });
    if (first !== 'go' || signal.aborted) return null;

    let done = 0;
    for (const posture of POSTURES) {
      const choice = await this.showCard({
        title: `Round ${done + 1} of ${POSTURES.length}: ${posture.title}`,
        body: [posture.instruction],
        actions: [
          { id: 'go', label: 'Ready', primary: true },
          { id: 'cancel', label: done > 0 ? 'Stop and score what I have' : 'Stop' },
        ],
      });
      if (choice !== 'go' || signal.aborted || this.resized) break;
      const trials = await this.round(posture, done, signal);
      if (!trials) break;
      blocks.push({ kind: 'test', posture: posture.id, trials });
      done += 1;
    }
    this.collector = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.recorded = true;

    if (this.resized) {
      await this.showCard({
        title: 'The window changed size',
        body: ['The dots and your calibration no longer line up, so this recording can’t be scored. Keep the window as it is and run the test again.'],
        actions: [{ id: 'cancel', label: 'Close', primary: true }],
      });
      return null;
    }
    if (done === 0 || this.destroyed) return null;

    const pitch = this.opts.linePitchPx;
    const recording: AccuracyRecording = {
      kind: ACCURACY_TEST_KIND,
      version: ACCURACY_TEST_VERSION,
      app: this.opts.appVersion ?? 'unknown',
      recordedAt,
      featureNames: [...FEATURE_NAMES],
      viewport: { width: cal.viewport.width, height: cal.viewport.height },
      camera: assumedCameraInViewport(cal.viewport),
      windowOrigin: { start: originStart, end: currentScreenOrigin() },
      linePitchPx: typeof pitch === 'number' && pitch > 0 ? pitch : FALLBACK_LINE_PITCH_PX,
      maxBlink: cal.maxBlink,
      ...(this.opts.eyeNet ? { eyeNet: this.opts.eyeNet } : {}),
      blocks,
    };
    const scores = scoreRecording(recording, { prior: this.opts.prior ?? null });
    const result: AccuracyTestResult = { recording, scores };
    await this.showResults(result);
    return result;
  }

  /** One round of dots. Null when it was stopped: a round that is not complete is not kept. */
  private async round(posture: Posture, index: number, signal: AbortSignal): Promise<RecordedTrial[] | null> {
    const view = this.opts.calibration.viewport;
    const order = shuffled(TEST_TARGETS, this.random);
    const queue = order.map((frac) => ({ frac, attempts: 0 }));
    const trials = new Map<Point, RecordedTrial>();
    this.setPhase('dots');
    this.stopAsked = false;
    let shown = 0;
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const target = { x: item.frac.x * view.width, y: item.frac.y * view.height };
      this.setProgress(`Round ${index + 1} of ${POSTURES.length} · ${posture.short} · dot ${Math.min(++shown, order.length)} of ${order.length}`);
      this.moveDot(target);
      if (!(await this.wait(this.timing.glideMs + this.timing.settleMs, signal))) return null;
      const frames: RecordedFrame[] = [];
      const now = performance.now();
      this.collector = { frames, from: now, until: now + this.timing.dotMs };
      const ok = await this.wait(this.timing.dotMs, signal);
      this.collector = null;
      if (!ok) return null;
      item.attempts += 1;
      const usable = frames.filter((f) => f.e[0] <= this.opts.calibration.maxBlink).length;
      const kept = trials.get(item.frac);
      if (!kept || frames.length > kept.frames.length) trials.set(item.frac, { target, frames });
      // The face was lost or the eyes were closed: show the dot once more, at the end of the round.
      if (usable < MIN_FRAMES_PER_DOT && item.attempts < this.timing.maxAttempts) queue.push(item);
    }
    // In the order of TEST_TARGETS, whatever order they were shown in.
    return TEST_TARGETS.flatMap((frac) => {
      const t = trials.get(frac);
      return t ? [t] : [];
    });
  }

  /** Resolves true after `ms`, false when the run was stopped (Esc, cancel, a resize). */
  private wait(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted || this.stopAsked || this.resized) return resolve(false);
      const started = performance.now();
      const tick = (): void => {
        if (signal.aborted || this.stopAsked || this.resized || this.destroyed) return resolve(false);
        if (performance.now() - started >= ms) return resolve(true);
        setTimeout(tick, Math.min(40, Math.max(1, ms - (performance.now() - started))));
      };
      setTimeout(tick, Math.min(40, Math.max(1, ms)));
    });
  }

  private readonly handleFrame = (frame: FeatureFrame): void => {
    const c = this.collector;
    const f = frame.faceFound ? frame.features : null;
    if (!f) {
      this.blinkGate.reset();
      return;
    }
    // The gate the live tracker uses: frames inside a blink are never kept.
    if (this.blinkGate.update(frame.t, f.blink, f.openness)) return;
    if (!c) return;
    const now = performance.now();
    if (now < c.from || now > c.until) return;
    const rec = recordFrame(frame, this.sessionStart);
    if (rec) c.frames.push(rec);
  };

  private readonly handleKeydown = (e: KeyboardEvent): void => {
    if (this.opts.isTrustedKey && !this.opts.isTrustedKey(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.choose) this.choose('cancel');
      else this.stopAsked = true;
      return;
    }
    // Keys belong to the test while it is up: the reader underneath must not scroll or turn pages.
    const inCard = e.target instanceof Node && this.card?.contains(e.target);
    if (!inCard || !['Tab', 'Enter', ' '].includes(e.key)) {
      if (!(e.metaKey || e.ctrlKey || e.altKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  private readonly handleResize = (): void => {
    const win = this.root?.ownerDocument.defaultView;
    const v = this.opts.calibration.viewport;
    if (!win || this.recorded) return;
    if (Math.abs(win.innerWidth - v.width) > 2 || Math.abs(win.innerHeight - v.height) > 2) {
      this.resized = true;
      this.choose?.('cancel');
    }
  };

  // ───────────────────────────────── screen ──────────────────────────────────

  private build(parent: HTMLElement | ShadowRoot): void {
    const doc = parent.ownerDocument ?? document;
    const root = doc.createElement('div');
    root.className = P;
    root.setAttribute(IGNORE_ATTR, '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Accuracy test');
    root.tabIndex = -1;
    const dark = doc.documentElement.getAttribute('data-theme') === 'dark' || doc.documentElement.classList.contains('dark');
    if (dark) root.setAttribute('data-tone', 'dark');
    const style = doc.createElement('style');
    style.textContent = css();
    const stage = doc.createElement('div');
    stage.className = `${P}-stage`;
    const dot = doc.createElement('div');
    dot.className = `${P}-dot`;
    dot.setAttribute('aria-hidden', 'true');
    stage.appendChild(dot);
    const progress = doc.createElement('div');
    progress.className = `${P}-progress`;
    progress.setAttribute('aria-live', 'polite');
    const card = doc.createElement('div');
    card.className = `${P}-card`;
    root.append(style, stage, progress, card);
    parent.appendChild(root);
    this.root = root;
    this.stage = stage;
    this.dot = dot;
    this.card = card;
    this.progress = progress;
    this.setPhase('card');
  }

  private teardown(): void {
    const win = this.root?.ownerDocument.defaultView;
    win?.removeEventListener('keydown', this.handleKeydown, true);
    win?.removeEventListener('resize', this.handleResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.collector = null;
    this.choose = null;
    this.root?.remove();
    this.root = null;
    this.stage = null;
    this.dot = null;
    this.card = null;
    this.progress = null;
  }

  private setPhase(phase: 'card' | 'dots' | 'results'): void {
    this.root?.setAttribute('data-phase', phase);
    if (this.card) this.card.hidden = phase === 'dots';
    if (this.stage) this.stage.hidden = phase !== 'dots';
    if (this.progress) this.progress.hidden = phase !== 'dots';
  }

  private setProgress(text: string): void {
    if (this.progress) this.progress.textContent = `${text} · Esc stops`;
  }

  private moveDot(p: Point): void {
    if (!this.dot) return;
    this.dot.style.setProperty('--x', `${p.x}px`);
    this.dot.style.setProperty('--y', `${p.y}px`);
    this.dot.style.transitionDuration = `${this.timing.glideMs}ms`;
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const doc = this.root?.ownerDocument ?? document;
    const node = doc.createElement(tag);
    if (cls) node.className = `${P}-${cls}`;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = this.el('button', 'btn', label);
    if (primary) b.classList.add(`${P}-btn--primary`);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /** A card with buttons. Resolves with the chosen action's id; 'cancel' on Esc or cancel(). */
  private showCard(view: { title: string; body: string[]; actions: { id: string; label: string; primary?: boolean }[] }): Promise<string> {
    const card = this.card;
    if (!card || this.destroyed) return Promise.resolve('cancel');
    this.setPhase('card');
    card.replaceChildren();
    card.appendChild(this.el('h2', 'title', view.title));
    for (const line of view.body) card.appendChild(this.el('p', 'text', line));
    const actions = this.el('div', 'actions');
    card.appendChild(actions);
    return new Promise((resolve) => {
      const settle = (choice: string): void => {
        if (this.choose !== settle) return;
        this.choose = null;
        resolve(choice);
      };
      this.choose = settle;
      let focus: HTMLButtonElement | null = null;
      for (const a of view.actions) {
        const b = this.button(a.label, a.primary === true, () => settle(a.id));
        actions.appendChild(b);
        if (a.primary) focus = b;
      }
      focus?.focus();
    });
  }

  private async showResults(result: AccuracyTestResult): Promise<void> {
    const card = this.card;
    if (!card || this.destroyed) return;
    const { scores, recording } = result;
    this.setPhase('results');
    card.replaceChildren();
    card.classList.add(`${P}-card--wide`);
    card.appendChild(this.el('h2', 'title', 'Accuracy test: results'));
    card.appendChild(this.el('p', 'verdict', scores.verdict));

    const postures = POSTURES.filter((p) => scores.variants.some((v) => v.postures.some((q) => q.posture === p.id)));
    const wrap = this.el('div', 'tablewrap');
    const table = this.el('table', 'table');
    // Not a <caption>: that is as wide as the table, which scrolls sideways in a small window.
    const caption = this.el('p', 'caption', 'How far off each calibration was, in lines of text up or down (median). In brackets: the share of dots read on the right line.');
    caption.id = `${P}-caption`;
    table.setAttribute('aria-describedby', caption.id);
    card.appendChild(caption);
    const head = this.el('tr', '');
    head.appendChild(this.el('th', '', 'Calibration'));
    for (const p of postures) head.appendChild(this.el('th', '', p.short));
    head.appendChild(this.el('th', '', 'All'));
    head.appendChild(this.el('th', '', 'After moving'));
    const thead = this.el('thead', '');
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = this.el('tbody', '');
    const cell = (g: GroupScore | undefined): string => (g && g.scored > 0 ? `${fmt(g.medianVerticalLines, 1)} (${fmt(g.onLine * 100)}%)` : '–');
    for (const v of scores.variants) {
      const row = this.el('tr', v.id === DEFAULT_VARIANT ? 'row-default' : '');
      const name = this.el('th', '', v.label);
      name.scope = 'row';
      name.title = v.note;
      row.appendChild(name);
      if (!v.ok) {
        const td = this.el('td', '', `Could not be fitted: ${v.problem ?? 'unknown reason'}`);
        td.colSpan = postures.length + 2;
        row.appendChild(td);
      } else {
        for (const p of postures) row.appendChild(this.el('td', '', cell(v.postures.find((q) => q.posture === p.id)?.score)));
        row.appendChild(this.el('td', '', cell(v.overall)));
        row.appendChild(this.el('td', '', cell(v.moved)));
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);

    for (const w of scores.warnings) card.appendChild(this.el('p', 'warn', `Note: ${w}`));
    card.appendChild(
      this.el(
        'p',
        'text',
        'This is one session of one person, so treat small differences as noise. The recording holds numbers about your eyes and head, no video. Saving it keeps it on this computer; it is sent nowhere.',
      ),
    );

    const status = this.el('p', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = this.el('div', 'actions');
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        if (this.choose !== close) return;
        this.choose = null;
        resolve();
      };
      const close = (_choice: string): void => settle();
      this.choose = close;
      const done = this.button('Done', true, settle);
      actions.appendChild(done);
      const save = this.opts.save;
      if (save) {
        actions.appendChild(
          this.button('Save recording', false, () => {
            status.textContent = save(recording) ? 'Recording saved to your downloads.' : 'The recording could not be saved here.';
          }),
        );
      }
      actions.appendChild(
        this.button('Copy results', false, () => {
          const text = formatScores(scores);
          const copy = this.opts.copy ?? ((t: string) => navigator.clipboard.writeText(t));
          let pending: Promise<void>;
          try {
            pending = copy(text);
          } catch (err) {
            pending = Promise.reject(err instanceof Error ? err : new Error('copy failed'));
          }
          pending.then(
            () => {
              status.textContent = 'Results copied.';
            },
            () => {
              status.textContent = 'The results could not be copied here.';
            },
          );
        }),
      );
      card.append(actions, status);
      done.focus();
    });
  }
}

function css(): string {
  const p = P;
  return `
.${p} {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: ${Z.calibration};
  display: block;
  overflow: auto;
  outline: none;
  --c-bg: var(--gr-bg, #f7f5f0);
  --c-fg: var(--gr-fg, #1a1d23);
  --c-muted: var(--gr-muted, #575d68);
  --c-accent: var(--gr-accent, #2a64d6);
  --c-accent-fg: var(--gr-accent-fg, #ffffff);
  --c-surface: var(--gr-surface, #ffffff);
  --c-border: var(--gr-border, rgba(26, 29, 35, 0.14));
  --c-shadow: var(--gr-shadow, 0 24px 60px rgba(15, 18, 25, 0.16));
  --c-font: var(--gr-font-ui, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  --c-warn: #9a5700;
  --c-tint: rgba(26, 29, 35, 0.05);
  background: var(--c-bg);
  color: var(--c-fg);
  font: 16px/1.5 var(--c-font);
  -webkit-font-smoothing: antialiased;
}
.${p}[data-tone="dark"] {
  --c-bg: var(--gr-bg, #14161b);
  --c-fg: var(--gr-fg, #eceef2);
  --c-muted: var(--gr-muted, #a5abb6);
  --c-accent: var(--gr-accent, #7ea8ff);
  --c-accent-fg: var(--gr-accent-fg, #0c1220);
  --c-surface: var(--gr-surface, #1e2128);
  --c-border: var(--gr-border, rgba(236, 238, 242, 0.16));
  --c-shadow: var(--gr-shadow, 0 24px 60px rgba(0, 0, 0, 0.5));
  --c-warn: #f2b53c;
  --c-tint: rgba(236, 238, 242, 0.06);
}
.${p} [hidden] { display: none !important; }
.${p} *, .${p} *::before, .${p} *::after { box-sizing: border-box; }
.${p}[data-phase="dots"] { cursor: none; overflow: hidden; user-select: none; -webkit-user-select: none; }
.${p}-stage { position: absolute; inset: 0; }
.${p}-dot {
  position: absolute; left: 0; top: 0; width: 0; height: 0;
  transform: translate3d(var(--x, 50vw), var(--y, 50vh), 0);
  transition: transform 380ms cubic-bezier(0.3, 0, 0.2, 1);
}
.${p}-dot::before {
  content: ""; position: absolute; left: -14px; top: -14px; width: 28px; height: 28px;
  border-radius: 50%; background: var(--c-accent); opacity: 0.28;
}
.${p}-dot::after {
  content: ""; position: absolute; left: -4px; top: -4px; width: 8px; height: 8px;
  border-radius: 50%; background: var(--c-accent);
}
.${p}-progress {
  position: absolute; left: 0; right: 0; bottom: 14px; text-align: center;
  color: var(--c-muted); font-size: 13px; pointer-events: none;
}
.${p}-card {
  position: relative; margin: 10vh auto 32px; width: min(560px, calc(100% - 32px));
  padding: 26px 28px; border-radius: 14px; background: var(--c-surface);
  border: 1px solid var(--c-border); box-shadow: var(--c-shadow);
}
.${p}-card--wide { width: min(1060px, calc(100% - 32px)); margin-top: 5vh; }
.${p}-title { margin: 0 0 12px; font-size: 21px; line-height: 1.25; font-weight: 650; }
.${p}-text { margin: 0 0 10px; color: var(--c-muted); }
.${p}-verdict { margin: 0 0 16px; font-size: 17px; }
.${p}-warn { margin: 0 0 8px; color: var(--c-warn); font-size: 14px; }
.${p}-status { margin: 10px 0 0; min-height: 1.5em; color: var(--c-muted); font-size: 14px; }
.${p}-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.${p}-btn {
  font: inherit; font-weight: 550; color: var(--c-fg); background: transparent; cursor: pointer;
  border: 1px solid var(--c-border); border-radius: 9px; padding: 9px 16px;
}
.${p}-btn:hover { background: var(--c-tint); }
.${p}-btn:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
.${p}-btn--primary { background: var(--c-accent); color: var(--c-accent-fg); border-color: transparent; }
.${p}-btn--primary:hover { background: var(--c-accent); filter: brightness(1.06); }
.${p}-tablewrap { overflow-x: auto; margin: 0 0 14px; }
.${p}-table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
.${p}-caption { margin: 0 0 8px; color: var(--c-muted); font-size: 14px; }
.${p}-table th, .${p}-table td { padding: 7px 8px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--c-border); }
.${p}-table th:first-child { text-align: left; font-weight: 550; white-space: normal; min-width: 150px; }
.${p}-table thead th { color: var(--c-muted); font-weight: 550; }
.${p}-row-default { background: var(--c-tint); }
@media (prefers-reduced-motion: reduce) { .${p}-dot { transition: none !important; } }
`;
}
