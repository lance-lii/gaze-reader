import type { Corner, Mountable, TrackingState } from '../../src/types';
import { CSS_PREFIX, IGNORE_ATTR, Z } from '../../src/core/constants';
import { SHORTCUTS, TOGGLE_SHORTCUT } from './shortcuts';

/**
 * The small floating status pill Gaze Reader shows on web pages: what the
 * tracker is doing, a camera-on indicator, pause / recalibrate / help / off
 * buttons, and actionable notices ("Camera permission needed — Open setup").
 * It fades to a whisper while you read and wakes up on hover or when
 * something needs your attention.
 */

export interface PillStatus {
  state: TrackingState;
  source: 'webcam' | 'mouse' | null;
  paused: boolean;
  /** Extra detail shown instead of the default label (errors, "Reconnecting…"). */
  detail: string | null;
}

export interface PillAction {
  label: string;
  run: () => void;
}

export interface PillNotice {
  text: string;
  tone?: 'info' | 'warn' | 'error';
  actions?: PillAction[];
  /** Auto-dismiss after this long. Default: stays until dismissed or replaced. */
  timeoutMs?: number;
}

export interface PillHandlers {
  onTogglePause(): void;
  onRecalibrate(): void;
  onClose(): void;
}

const P = CSS_PREFIX;
const QUIET_AFTER_MS = 4_000;

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
  target:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1.1-1.5 2.1v.4"/><path d="M12 17.5v.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3z"/></svg>',
  mouse: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v3"/></svg>',
} as const;

const CSS = `
.${P}pill {
  position: fixed; top: 12px; right: 12px; z-index: ${Z.toast};
  display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  max-width: min(360px, calc(100vw - 24px));
  font: 500 12.5px/1.35 var(--gr-font-ui, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  color: var(--gr-fg, #2b1d14);
  pointer-events: auto; user-select: none; -webkit-user-select: none;
  transition: opacity .35s ease, transform .35s ease;
}
.${P}pill[data-side="left"] { right: auto; left: 12px; }
.${P}pill[hidden] { display: none; }
.${P}pill--quiet { opacity: .38; }
.${P}pill--quiet:hover, .${P}pill--quiet:focus-within { opacity: 1; }
.${P}pill-bar, .${P}pill-card {
  background: var(--gr-surface, #fffaf3);
  border: 1px solid var(--gr-border, rgba(43, 29, 20, .14));
  box-shadow: var(--gr-shadow, 0 6px 24px rgba(43, 29, 20, .16));
}
.${P}pill-bar {
  display: flex; align-items: center; gap: 2px;
  padding: 3px 3px 3px 10px; border-radius: 999px; align-self: flex-end;
}
.${P}pill[data-side="left"] .${P}pill-bar { align-self: flex-start; }
.${P}pill-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none; margin-right: 6px;
  background: var(--${P}tone, #9a8878);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--${P}tone, #9a8878) 22%, transparent);
}
.${P}pill[data-tone="ok"] { --${P}tone: #16a34a; }
.${P}pill[data-tone="warn"] { --${P}tone: #d97706; }
.${P}pill[data-tone="err"] { --${P}tone: #dc2626; }
.${P}pill[data-tone="off"] { --${P}tone: #9a8878; }
.${P}pill[data-busy] .${P}pill-dot { animation: ${P}pulse 1.2s ease-in-out infinite; }
@keyframes ${P}pulse { 50% { opacity: .35; } }
.${P}pill-src { display: inline-flex; color: var(--gr-muted, #7a6656); margin-right: 5px; }
.${P}pill-src svg, .${P}pill-btn svg {
  width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}
.${P}pill-src[data-live] { color: #dc2626; }
.${P}pill-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; margin-right: 4px; }
.${P}pill-btn {
  all: unset; box-sizing: border-box; display: inline-grid; place-items: center;
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
  color: var(--gr-muted, #7a6656);
}
.${P}pill-btn:hover { background: color-mix(in srgb, var(--gr-fg, #2b1d14) 8%, transparent); color: var(--gr-fg, #2b1d14); }
.${P}pill-btn:focus-visible, .${P}pill-card button:focus-visible { outline: 2px solid var(--gr-accent, #c2410c); outline-offset: 1px; }
.${P}pill-btn[hidden] { display: none; }
.${P}pill-btn[aria-expanded="true"] { color: var(--gr-accent, #c2410c); }
.${P}pill-card { border-radius: 14px; padding: 10px 12px; }
.${P}pill-card[hidden] { display: none; }
.${P}pill-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${P}pill-notice[data-tone="warn"] { border-color: color-mix(in srgb, #d97706 45%, transparent); }
.${P}pill-notice[data-tone="error"] { border-color: color-mix(in srgb, #dc2626 45%, transparent); }
.${P}pill-notice-text { flex: 1 1 180px; font-weight: 450; user-select: text; -webkit-user-select: text; }
.${P}pill-notice-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.${P}pill-card button.${P}pill-action {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 4px 10px; border-radius: 999px;
  font-weight: 600; background: var(--gr-accent, #c2410c); color: var(--gr-accent-fg, #fff);
}
.${P}pill-card button.${P}pill-action + button.${P}pill-action {
  background: transparent; color: var(--gr-fg, #2b1d14);
  box-shadow: inset 0 0 0 1px var(--gr-border, rgba(43, 29, 20, .2));
}
.${P}pill-help h2 { all: unset; display: block; font-weight: 650; margin-bottom: 6px; }
.${P}pill-help dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; }
.${P}pill-help dt { white-space: nowrap; }
.${P}pill-help dd { margin: 0; color: var(--gr-muted, #7a6656); }
.${P}pill-help kbd {
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 2px 5px; border-radius: 5px;
  background: color-mix(in srgb, var(--gr-fg, #2b1d14) 7%, transparent);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--gr-fg, #2b1d14) 18%, transparent);
}
.${P}pill-help p { margin: 8px 0 0; color: var(--gr-muted, #7a6656); }
@media (prefers-reduced-motion: reduce) {
  .${P}pill { transition: none; }
  .${P}pill[data-busy] .${P}pill-dot { animation: none; }
}
`;

type Tone = 'ok' | 'warn' | 'err' | 'off';

export class PagePill implements Mountable {
  private readonly handlers: PillHandlers;
  private readonly el: HTMLDivElement;
  private readonly style: HTMLStyleElement;
  private readonly label: HTMLSpanElement;
  private readonly src: HTMLSpanElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly calBtn: HTMLButtonElement;
  private readonly helpBtn: HTMLButtonElement;
  private readonly notice: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private status: PillStatus = { state: 'starting', source: null, paused: false, detail: null };
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: PillHandlers) {
    this.handlers = handlers;
    this.style = document.createElement('style');
    this.style.textContent = CSS;

    this.el = document.createElement('div');
    this.el.className = `${P}pill`;
    this.el.setAttribute(IGNORE_ATTR, '');
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Gaze Reader');

    const bar = div(`${P}pill-bar`);
    const dot = span(`${P}pill-dot`);
    this.src = span(`${P}pill-src`);
    this.label = span(`${P}pill-label`);
    this.label.setAttribute('role', 'status');
    this.label.setAttribute('aria-live', 'polite');
    this.pauseBtn = button(ICONS.pause, 'Pause auto-scroll', () => this.handlers.onTogglePause());
    this.calBtn = button(ICONS.target, 'Recalibrate', () => this.handlers.onRecalibrate());
    this.helpBtn = button(ICONS.help, 'Keyboard shortcuts', () => this.toggleHelp());
    this.helpBtn.setAttribute('aria-expanded', 'false');
    const closeBtn = button(ICONS.close, 'Turn Gaze Reader off on this page', () => this.handlers.onClose());
    bar.append(dot, this.src, this.label, this.pauseBtn, this.calBtn, this.helpBtn, closeBtn);

    this.notice = div(`${P}pill-card ${P}pill-notice`);
    this.notice.hidden = true;
    this.help = div(`${P}pill-card ${P}pill-help`);
    this.help.id = `${P}pill-help`;
    this.help.hidden = true;
    this.helpBtn.setAttribute('aria-controls', this.help.id);
    this.help.append(helpContent());

    this.el.append(bar, this.notice, this.help);
    this.el.addEventListener('pointerenter', this.wake);
    this.el.addEventListener('focusin', this.wake);
    this.render();
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    parent.append(this.style, this.el);
  }

  setStatus(status: PillStatus): void {
    this.status = status;
    this.render();
  }

  /** Stay on the opposite side from Dewey when he sits in a top corner. */
  setCorner(buddyCorner: Corner): void {
    this.el.dataset.side = buddyCorner === 'top-right' ? 'left' : 'right';
  }

  notify(notice: PillNotice | null): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice.replaceChildren();
    if (!notice) {
      this.notice.hidden = true;
      this.scheduleQuiet();
      return;
    }
    this.notice.dataset.tone = notice.tone ?? 'info';
    this.notice.setAttribute('role', notice.tone === 'error' ? 'alert' : 'status');
    const text = span(`${P}pill-notice-text`);
    text.textContent = notice.text;
    const actions = span(`${P}pill-notice-actions`);
    for (const a of notice.actions ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `${P}pill-action`;
      b.textContent = a.label;
      b.addEventListener('click', () => {
        this.notify(null);
        a.run();
      });
      actions.append(b);
    }
    const dismiss = button(ICONS.close, 'Dismiss', () => this.notify(null));
    this.notice.append(text, actions, dismiss);
    this.notice.hidden = false;
    this.wake();
    if (notice.timeoutMs !== undefined) this.noticeTimer = setTimeout(() => this.notify(null), notice.timeoutMs);
  }

  toggleHelp(force?: boolean): void {
    const open = force ?? this.help.hidden;
    this.help.hidden = !open;
    this.helpBtn.setAttribute('aria-expanded', String(open));
    if (open) this.wake();
    else this.scheduleQuiet();
  }

  setHidden(hidden: boolean): void {
    this.el.hidden = hidden;
  }

  destroy(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.el.removeEventListener('pointerenter', this.wake);
    this.el.removeEventListener('focusin', this.wake);
    this.el.remove();
    this.style.remove();
  }

  // ──────────────────────────────── internals ───────────────────────────────

  private render(): void {
    const { state, source, paused, detail } = this.status;
    const [tone, text] = describe(this.status);
    this.el.dataset.tone = tone;
    this.el.toggleAttribute('data-busy', state === 'starting' || state === 'calibrating');
    this.label.textContent = detail ?? text;

    this.src.innerHTML = source === 'mouse' ? ICONS.mouse : source === 'webcam' ? ICONS.camera : '';
    const cameraLive = source === 'webcam' && state !== 'error' && state !== 'off';
    this.src.toggleAttribute('data-live', cameraLive);
    this.src.title = source === 'webcam' ? (cameraLive ? 'Camera on (processed on this device)' : 'Camera off') : 'Mouse mode';

    const resumeLabel = paused ? 'Resume auto-scroll' : 'Pause auto-scroll';
    this.pauseBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    this.pauseBtn.setAttribute('aria-label', resumeLabel);
    this.pauseBtn.title = `${resumeLabel} (Alt+Shift+P)`;
    this.pauseBtn.hidden = state === 'error' || state === 'starting';
    this.calBtn.hidden = source !== 'webcam' || state === 'error' || state === 'starting';
    this.scheduleQuiet();
  }

  private readonly wake = (): void => {
    this.el.classList.remove(`${P}pill--quiet`);
    this.scheduleQuiet();
  };

  /** Fade out only while everything is fine and nothing is open. */
  private scheduleQuiet(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    const calm = (this.status.state === 'tracking' || this.status.state === 'paused') && this.notice.hidden && this.help.hidden;
    if (!calm) {
      this.el.classList.remove(`${P}pill--quiet`);
      return;
    }
    this.quietTimer = setTimeout(() => this.el.classList.add(`${P}pill--quiet`), QUIET_AFTER_MS);
  }
}

function describe({ state, source, paused }: PillStatus): [Tone, string] {
  switch (state) {
    case 'starting':
      return ['warn', source === 'webcam' ? 'Waking up the camera…' : 'Starting…'];
    case 'calibrating':
      return ['warn', 'Calibrating: follow the dots'];
    case 'tracking':
      return paused ? ['off', 'Auto-scroll paused'] : ['ok', source === 'mouse' ? 'Following your mouse' : 'Reading along'];
    case 'no-face':
      return ['warn', source === 'mouse' ? 'Point at the page to read' : "Can't see your eyes"];
    case 'poor':
      return ['warn', 'Tracking is shaky: more light helps'];
    case 'paused':
      return ['off', 'Auto-scroll paused'];
    case 'error':
      return ['err', 'Camera problem'];
    case 'off':
      return ['off', 'Off'];
  }
}

function helpContent(): DocumentFragment {
  const frag = document.createDocumentFragment();
  const h = document.createElement('h2');
  h.textContent = 'Keyboard shortcuts';
  const dl = document.createElement('dl');
  const row = (keys: string, label: string) => {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = keys;
    dt.append(kbd);
    const dd = document.createElement('dd');
    dd.textContent = label;
    dl.append(dt, dd);
  };
  for (const s of SHORTCUTS) row(s.keys, s.label);
  row(TOGGLE_SHORTCUT, 'Turn Gaze Reader on/off (anywhere)');
  const p = document.createElement('p');
  p.textContent = 'Shortcuts are ignored while you type in a text field.';
  frag.append(h, dl, p);
  return frag;
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

function span(className: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  return s;
}

function button(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${P}pill-btn`;
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
