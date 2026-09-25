import { IGNORE_ATTR, Z } from '../core/constants';
import { IS_ARTIFACT } from '../core/target';
import type { AppSettings, CommandName, EventBus, GazeSourceKind, Mountable, TrackingState } from '../types';
import { pillAlwaysVisible, statusPill } from '../app/logic';
import { WEBCAM_UNAVAILABLE_SHORT } from './fullApp';

// ─────────────────────────────── Icon set ───────────────────────────────
// Shared by the shell UI (top bar, library, panels, toasts). Stroke icons on a
// 24-unit grid that inherit `currentColor`.

const ICON_PATHS = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h4M12 17h8"/><circle cx="15" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17.2h.01"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  mouse: '<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 7v3"/>',
  sparkle: '<path d="M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  camera: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  paste: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5v-.7c0-.7.5-1.3 1.2-1.3h2.6c.7 0 1.2.6 1.2 1.3v.7M9 11h6M9 15h4"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  trash: '<path d="M4 7h16M9.5 7V4.8c0-.5.4-.8.8-.8h3.4c.5 0 .8.4.8.8V7M6.5 7l.8 12.2c.1 1 .9 1.8 1.9 1.8h5.6c1 0 1.8-.8 1.9-1.8L17.5 7"/>',
  book: '<path d="M12 6.5C10.3 5.2 7.8 4.5 4 4.5v13c3.8 0 6.3.7 8 2 1.7-1.3 4.2-2 8-2v-13c-3.8 0-6.3.7-8 2zM12 6.5v13"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  glasses: '<circle cx="6.8" cy="13" r="4"/><circle cx="17.2" cy="13" r="4"/><path d="M10.8 12.4c.8-.7 1.6-.7 2.4 0M2.8 13 1.8 9.8M21.2 13l1-3.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.3 2.3 4.2-4.6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** Inline SVG markup for an icon (decorative: hidden from assistive tech). */
export function icon(name: IconName, extraClass = ''): string {
  return (
    `<svg class="gr-icon ${extraClass}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`
  );
}

// ──────────────────────────────── Top bar ────────────────────────────────

export interface TopbarOptions {
  bus: EventBus;
  getSettings: () => AppSettings;
  /** The source switch goes through the controller (it also clears "don't retry the camera" latches). */
  onSelectSource: (kind: GazeSourceKind) => void;
}

export interface TopbarStatus {
  state: TrackingState;
  detail?: string;
  /** The source that is actually running (null when none). */
  kind: GazeSourceKind | null;
  cameraOn: boolean;
}

const HIDE_AFTER_MS = 2600;
/** Extra reveal margin below the bar, px. Small enough not to catch the first line of text in mouse mode. */
const REVEAL_MARGIN_PX = 6;

const SOURCES: readonly { kind: GazeSourceKind; label: string; icon: IconName; title: string; unavailable?: boolean }[] = [
  // The Artifact build keeps the option visible (it's the point of the app), but it only explains where to find it.
  IS_ARTIFACT
    ? { kind: 'webcam', label: 'Eyes', icon: 'eye', title: `Follow my eyes (webcam). ${WEBCAM_UNAVAILABLE_SHORT}`, unavailable: true }
    : { kind: 'webcam', label: 'Eyes', icon: 'eye', title: 'Follow my eyes (webcam)' },
  { kind: 'mouse', label: 'Mouse', icon: 'mouse', title: 'Follow my mouse pointer' },
  { kind: 'simulated', label: 'Demo', icon: 'sparkle', title: 'Watch a simulated reader' },
];

let topbarSeq = 0;

/**
 * Reader chrome: title and progress, the tracking status pill, the source
 * switch and the main commands. Auto-hides while reading; comes back when the
 * pointer nears the top or anything inside receives keyboard focus. The status
 * pill stays visible whenever the camera is on (or the demo is running).
 */
export class Topbar implements Mountable {
  readonly el: HTMLElement;
  private readonly opts: TopbarOptions;
  private readonly ac = new AbortController();
  private readonly ui: {
    book: HTMLElement;
    meta: HTMLElement;
    pill: HTMLElement;
    pillLabel: HTMLElement;
    demoChip: HTMLElement;
    recChip: HTMLElement;
    progress: HTMLElement;
    progressFill: HTMLElement;
    pause: HTMLButtonElement;
    recalibrate: HTMLButtonElement;
    radios: HTMLInputElement[];
  };
  /** What the owner asked for; effective only on devices that can hover. */
  private wantAutoHide = false;
  private autoHide = false;
  private concealed = false;
  /** Pointer y (viewport px) at or above which a hidden bar comes back. */
  private revealBelowY = 0;
  private pointerInside = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hoverQuery: MediaQueryList | null;
  private author = '';
  private progressText = '';
  private recording = false;
  /** Whether the status alone keeps the bar's status area on screen (see pillAlwaysVisible). */
  private persistBase = false;
  private offSettings: (() => void) | null = null;

  constructor(opts: TopbarOptions) {
    this.opts = opts;
    const id = `gr-topbar-${++topbarSeq}`;
    const el = document.createElement('header');
    el.className = 'gr-topbar';
    el.setAttribute(IGNORE_ATTR, '');
    el.style.zIndex = String(Z.chrome);
    el.setAttribute('aria-label', 'Reader controls');
    el.innerHTML = `
      <div class="gr-topbar__row">
        <div class="gr-topbar__start gr-topbar__fade">
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon-sm" data-cmd="open-library" aria-label="Back to the library" title="Library (L)">
            ${icon('back')}<span class="gr-topbar__label">Library</span>
          </button>
          <div class="gr-topbar__title">
            <span class="gr-topbar__book"></span>
            <span class="gr-topbar__meta"></span>
          </div>
        </div>
        <div class="gr-topbar__status">
          <span class="gr-pill" role="status" aria-live="polite" data-tone="idle">
            <span class="gr-pill__dot" aria-hidden="true"></span>
            <span class="gr-pill__cam">${icon('camera')}</span>
            <span class="gr-pill__label">Camera off</span>
          </span>
          <span class="gr-demo-chip" hidden>${icon('sparkle')}<span class="gr-demo-chip__long">Demo: a simulated reader is reading</span><span class="gr-demo-chip__short" aria-hidden="true">Demo reader</span></span>
          <span class="gr-demo-chip gr-rec-chip" role="status" title="Recording tracking diagnostics: numbers only, no video. Stop it in Settings › Advanced." hidden>${icon('record')}<span class="gr-demo-chip__long">Recording diagnostics</span><span class="gr-demo-chip__short" aria-hidden="true">Rec</span></span>
        </div>
        <div class="gr-topbar__end gr-topbar__fade">
          <fieldset class="gr-seg gr-topbar__source">
            <legend class="gr-sr-only">Follow</legend>
            ${SOURCES.map(
              (s) => `
              <label class="gr-seg__opt" title="${s.title}"${s.unavailable ? ' data-unavailable' : ''}>
                <input type="radio" name="${id}-source" value="${s.kind}" class="gr-sr-only" aria-label="${s.title}"${s.unavailable ? ' aria-disabled="true"' : ''} />
                <span class="gr-seg__face">${icon(s.icon)}<span class="gr-seg__text">${s.label}</span></span>
              </label>`,
            ).join('')}
          </fieldset>
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon" data-cmd="toggle-autoscroll" aria-pressed="false"></button>
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon gr-topbar__recal" data-cmd="recalibrate" aria-label="Recalibrate" title="Recalibrate (C)">${icon('target')}</button>
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon gr-topbar__help" data-cmd="show-help" aria-label="Help and shortcuts" title="Help (?)">${icon('help')}</button>
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon" data-cmd="open-settings" aria-label="Settings" title="Settings (S)">${icon('settings')}</button>
        </div>
      </div>
      <div class="gr-topbar__progress" role="progressbar" aria-label="Reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span class="gr-topbar__progress-fill"></span>
      </div>`;
    this.el = el;
    const q = <T extends Element>(sel: string): T => {
      const found = el.querySelector<T>(sel);
      if (!found) throw new Error(`Topbar: missing ${sel}`);
      return found;
    };
    this.ui = {
      book: q('.gr-topbar__book'),
      meta: q('.gr-topbar__meta'),
      pill: q('.gr-pill'),
      pillLabel: q('.gr-pill__label'),
      demoChip: q('.gr-demo-chip:not(.gr-rec-chip)'),
      recChip: q('.gr-rec-chip'),
      progress: q('.gr-topbar__progress'),
      progressFill: q('.gr-topbar__progress-fill'),
      pause: q('[data-cmd="toggle-autoscroll"]'),
      recalibrate: q('.gr-topbar__recal'),
      radios: [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')],
    };
    // Touch-only devices can't bring a hidden bar back by hovering, so it stays put there.
    this.hoverQuery = typeof matchMedia === 'function' ? matchMedia('(hover: hover)') : null;
    this.bindEvents();
    this.syncSettings(opts.getSettings());
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    parent.appendChild(this.el);
  }

  setBook(book: { title: string; author: string | null } | null): void {
    this.ui.book.textContent = book?.title ?? '';
    this.author = book?.author ?? '';
    this.renderMeta();
  }

  /** @param detail e.g. "12 min left" */
  setProgress(fraction: number, percentText: string, detail: string): void {
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    this.ui.progressFill.style.transform = `scaleX(${f})`;
    this.ui.progress.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    this.ui.progress.setAttribute('aria-valuetext', detail ? `${percentText}, ${detail}` : percentText);
    this.progressText = detail ? `${percentText} · ${detail}` : percentText;
    this.renderMeta();
  }

  setStatus(s: TopbarStatus): void {
    const view = statusPill(s.state, s.kind, s.cameraOn);
    const { pill, pillLabel, demoChip } = this.ui;
    pillLabel.textContent = view.label;
    pill.dataset.tone = view.tone;
    pill.dataset.camera = s.cameraOn ? 'on' : 'off';
    // "Camera off (Not calibrated)" says what to do next; other states' details repeat the label.
    const description = s.detail && (s.state === 'error' || s.state === 'off') ? `${view.description} (${s.detail})` : view.description;
    pill.title = description;
    pill.setAttribute('aria-label', `${view.label}. ${description}`);
    const demo = s.kind === 'simulated';
    demoChip.hidden = !demo;
    this.el.dataset.demo = String(demo);
    // Privacy: whenever the camera is on, its indicator never hides.
    this.persistBase = pillAlwaysVisible(s.state, s.kind, s.cameraOn);
    this.el.dataset.persist = String(this.persistBase || this.recording);
  }

  /** Shows the "Recording diagnostics" chip (kept on screen, like the camera pill, while recording). */
  setRecording(on: boolean): void {
    this.recording = on;
    this.ui.recChip.hidden = !on;
    this.el.dataset.recording = String(on);
    this.el.dataset.persist = String(this.persistBase || on);
  }

  /** Reflect settings the bar displays (source switch, pause state, recalibrate availability). */
  syncSettings(s: AppSettings): void {
    for (const r of this.ui.radios) r.checked = r.value === s.gazeSource;
    const paused = !s.autoScroll;
    const pause = this.ui.pause;
    pause.setAttribute('aria-pressed', String(paused));
    pause.setAttribute('aria-label', paused ? 'Resume auto-scroll' : 'Pause auto-scroll');
    pause.title = paused ? 'Resume auto-scroll (P)' : 'Pause auto-scroll (P)';
    pause.innerHTML = icon(paused ? 'play' : 'pause');
    this.ui.recalibrate.hidden = s.gazeSource !== 'webcam';
  }

  /** Auto-hide is on while reading. Turning it off shows the bar for good. */
  setAutoHide(on: boolean): void {
    this.wantAutoHide = on;
    this.autoHide = on && (this.hoverQuery?.matches ?? false);
    if (this.autoHide) this.reveal();
    else {
      this.clearHideTimer();
      this.setConcealed(false);
    }
  }

  /** Show the bar now; it hides again after a quiet moment. */
  reveal(): void {
    this.setConcealed(false);
    this.scheduleHide();
  }

  destroy(): void {
    this.ac.abort();
    this.offSettings?.();
    this.offSettings = null;
    this.clearHideTimer();
    this.el.remove();
  }

  private renderMeta(): void {
    const parts = [this.author, this.progressText].filter(Boolean);
    this.ui.meta.textContent = parts.join(' · ');
  }

  private bindEvents(): void {
    const signal = this.ac.signal;
    this.el.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as Element | null)?.closest<HTMLElement>('[data-cmd]');
        if (!btn || !this.el.contains(btn)) return;
        this.opts.bus.emit('command', { name: btn.dataset.cmd as CommandName });
      },
      { signal },
    );
    for (const r of this.ui.radios) {
      // `click`, not `change`: re-picking the checked source must reach the controller,
      // because that is how the reader retries a webcam that failed to start.
      // (Arrow-key selection also fires click on the newly checked radio.)
      const unavailable = r.getAttribute('aria-disabled') === 'true';
      r.addEventListener(
        'click',
        (e) => {
          if (unavailable) {
            // Keep the current source checked; the controller explains why this one can't start.
            // (Not every engine re-checks the previous radio of a canceled click, so re-sync after it.)
            e.preventDefault();
            this.opts.onSelectSource(r.value as GazeSourceKind);
            setTimeout(() => this.syncSettings(this.opts.getSettings()), 0);
            return;
          }
          if (r.checked) this.opts.onSelectSource(r.value as GazeSourceKind);
        },
        { signal },
      );
    }
    this.hoverQuery?.addEventListener('change', () => this.setAutoHide(this.wantAutoHide), { signal });
    this.el.addEventListener('focusin', () => this.reveal(), { signal });
    this.el.addEventListener('focusout', () => this.scheduleHide(), { signal });
    this.el.addEventListener('pointerenter', () => {
      this.pointerInside = true;
      this.setConcealed(false);
      this.clearHideTimer();
    }, { signal });
    this.el.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.scheduleHide();
    }, { signal });
    window.addEventListener(
      'pointermove',
      (e) => {
        if (!this.autoHide || !this.concealed || e.pointerType === 'touch') return;
        // revealBelowY is measured once when the bar hides: no layout read per move.
        if (e.clientY <= this.revealBelowY) this.reveal();
      },
      { signal, passive: true },
    );
    this.offSettings = this.opts.bus.on('settings-changed', ({ settings, changed }) => {
      if (changed.some((k) => k === 'gazeSource' || k === 'autoScroll')) this.syncSettings(settings);
    });
  }

  private scheduleHide(): void {
    this.clearHideTimer();
    if (!this.autoHide) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      const root = this.el.getRootNode() as Document | ShadowRoot;
      const focusInside = root.activeElement instanceof Node && this.el.contains(root.activeElement);
      if (this.autoHide && !this.pointerInside && !focusInside) this.setConcealed(true);
    }, HIDE_AFTER_MS);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private setConcealed(v: boolean): void {
    if (this.concealed === v) return;
    if (v) this.revealBelowY = this.el.offsetHeight + REVEAL_MARGIN_PX;
    this.concealed = v;
    this.el.dataset.concealed = String(v);
  }
}
