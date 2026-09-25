import { IGNORE_ATTR, Z } from '../core/constants';
import type { Mountable } from '../types';
import { SHORTCUTS, statusPill, type PillTone } from '../app/logic';
import { icon } from './topbar';

// ───────────────────────────── Modal infrastructure ─────────────────────────────
// Shared by the help dialog, the settings drawer and onboarding. We don't use
// <dialog>.showModal(): the top layer would bury toasts and Dewey, and the
// onboarding deliberately keeps Dewey visible above its scrim.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export interface FocusTrap {
  release(restoreFocus?: boolean): void;
}

function focusablesIn(container: HTMLElement): HTMLElement[] {
  const all = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
  const rendered = all.filter((el) => el.getClientRects().length > 0);
  // Without layout (tests, or before first paint) fall back to the DOM order.
  return rendered.length > 0 ? rendered : all;
}

/**
 * Keeps Tab / Shift+Tab inside `container`, routes Escape to `onEscape`, and
 * returns focus to wherever it was when released.
 */
export function trapFocus(
  container: HTMLElement,
  opts: { onEscape?: () => void; initialFocus?: HTMLElement | null } = {},
): FocusTrap {
  const root = container.getRootNode() as Document | ShadowRoot;
  const previous = root.activeElement instanceof HTMLElement ? root.activeElement : null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.onEscape) {
      e.preventDefault();
      e.stopPropagation();
      opts.onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusablesIn(container);
    if (items.length === 0) {
      e.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = root.activeElement;
    const outside = !(active instanceof Node) || !container.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKey);

  const target = opts.initialFocus ?? focusablesIn(container)[0] ?? container;
  if (target === container && !container.hasAttribute('tabindex')) container.tabIndex = -1;
  target.focus({ preventScroll: true });

  let released = false;
  return {
    release(restoreFocus = true) {
      if (released) return;
      released = true;
      container.removeEventListener('keydown', onKey);
      if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
    },
  };
}

export interface ModalLayerOptions {
  /** Variant class on the layer root, e.g. `gr-modal--drawer`. */
  variant: string;
  /** id of the element that names the dialog. */
  labelledBy: string;
  /** Called after the layer closes, whatever the reason. */
  onClose?: () => void;
  /** Stacking order; defaults to `Z.panel`. */
  zIndex?: number;
}

/** A scrim + dialog surface with focus trapping, Esc / scrim-click to close, and focus restore. */
export class ModalLayer {
  readonly root: HTMLElement;
  readonly surface: HTMLElement;
  private trap: FocusTrap | null = null;
  private readonly opts: ModalLayerOptions;

  constructor(opts: ModalLayerOptions) {
    this.opts = opts;
    const root = document.createElement('div');
    root.className = `gr-modal ${opts.variant}`;
    root.setAttribute(IGNORE_ATTR, '');
    root.style.zIndex = String(opts.zIndex ?? Z.panel);
    root.hidden = true;
    const scrim = document.createElement('div');
    scrim.className = 'gr-modal__scrim';
    scrim.addEventListener('click', () => this.close());
    const surface = document.createElement('section');
    surface.className = 'gr-modal__surface';
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-modal', 'true');
    surface.setAttribute('aria-labelledby', opts.labelledBy);
    surface.tabIndex = -1;
    root.append(scrim, surface);
    this.root = root;
    this.surface = surface;
  }

  get isOpen(): boolean {
    return this.trap !== null;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    parent.appendChild(this.root);
  }

  open(initialFocus?: HTMLElement | null): void {
    if (this.isOpen) return;
    // Leaving display:none restarts the CSS entrance animation.
    this.root.hidden = false;
    this.trap = trapFocus(this.surface, { onEscape: () => this.close(), initialFocus });
  }

  close(): void {
    if (!this.isOpen) return;
    const trap = this.trap;
    this.trap = null;
    this.root.hidden = true;
    // The owner may have made the page inert while we were open; let it undo that
    // first, or handing focus back to an element in the page would silently fail.
    this.opts.onClose?.();
    trap?.release();
  }

  destroy(): void {
    this.trap?.release(false);
    this.trap = null;
    this.root.remove();
  }
}

let dialogSeq = 0;

/** Standard dialog header (title + close button); returns the close button. */
export function dialogHeader(surface: HTMLElement, titleId: string, title: string, onClose: () => void): HTMLButtonElement {
  const header = document.createElement('header');
  header.className = 'gr-modal__header';
  const h = document.createElement('h2');
  h.id = titleId;
  h.className = 'gr-modal__title';
  h.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'gr-btn gr-btn--ghost gr-btn--icon';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = icon('close');
  close.addEventListener('click', onClose);
  header.append(h, close);
  surface.appendChild(header);
  return close;
}

// ──────────────────────────────── Help dialog ────────────────────────────────

const PILL_LEGEND: readonly { label: string; tone: PillTone; text: string }[] = [
  { ...pick('tracking', 'webcam'), text: 'Your eyes are being followed; pages turn when you reach the bottom.' },
  { ...pick('no-face', 'webcam'), text: "The camera can't see your face right now." },
  { ...pick('poor', 'webcam'), text: 'Tracking is unsure. More light on your face, at about an arm’s length, helps.' },
  { ...pick('paused', 'webcam'), text: 'Auto-scroll is paused (P). Tracking continues.' },
  { ...pick('off', null), text: 'The camera is off. It only runs while a book is open.' },
  { ...pick('tracking', 'mouse'), text: 'Following your mouse pointer instead of your eyes.' },
  { ...pick('tracking', 'simulated'), text: 'A simulated reader is reading, to show how page turns work.' },
];

function pick(state: Parameters<typeof statusPill>[0], kind: Parameters<typeof statusPill>[1]): { label: string; tone: PillTone } {
  const v = statusPill(state, kind, false);
  return { label: v.label, tone: v.tone };
}

const TIPS: readonly string[] = [
  'Sit about an arm’s length from the screen, facing the camera.',
  'Light your face from the front; a bright window behind you makes tracking harder.',
  'Calibrate in the light you read in. When the light changes (a lamp on, the sun going down), the reader adjusts by itself, and offers a quick 5-dot refresh if it needs one.',
  'Press A for an accuracy check: a few dots show how far off the tracking is, and you can correct it on the spot.',
  'Keep your head fairly still and let your eyes do the moving.',
  'Page turned too soon? Press U to undo it, or try the Relaxed sensitivity.',
  'If Dewey seems to look in the wrong place, recalibrate with C.',
];

export class HelpDialog implements Mountable {
  private readonly layer: ModalLayer;

  constructor(opts: { onClose?: () => void } = {}) {
    const titleId = `gr-help-title-${++dialogSeq}`;
    this.layer = new ModalLayer({ variant: 'gr-modal--center gr-help', labelledBy: titleId, onClose: opts.onClose });
    const surface = this.layer.surface;
    dialogHeader(surface, titleId, 'Help & shortcuts', () => this.close());

    const body = document.createElement('div');
    body.className = 'gr-modal__body';
    body.innerHTML = `
      <section class="gr-help__section">
        <h3 class="gr-help__heading">${icon('keyboard')} Keyboard shortcuts</h3>
        <table class="gr-help__keys">
          <tbody>
            ${SHORTCUTS.map(
              (s) => `<tr><td>${s.keys.map((k) => keycap(k)).join('<span class="gr-help__or">or</span>')}</td><td>${s.label}</td></tr>`,
            ).join('')}
          </tbody>
        </table>
        <p class="gr-help__note">Shortcuts pause while you type in a text field.</p>
      </section>
      <section class="gr-help__section">
        <h3 class="gr-help__heading">${icon('camera')} The status pill</h3>
        <ul class="gr-help__legend">
          ${PILL_LEGEND.map(
            (p) => `<li><span class="gr-pill gr-pill--static" data-tone="${p.tone}"><span class="gr-pill__dot" aria-hidden="true"></span><span class="gr-pill__label">${p.label}</span></span><span>${p.text}</span></li>`,
          ).join('')}
        </ul>
      </section>
      <section class="gr-help__section">
        <h3 class="gr-help__heading">${icon('eye')} Tips for good tracking</h3>
        <ul class="gr-help__tips">${TIPS.map((t) => `<li>${t}</li>`).join('')}</ul>
      </section>
      <p class="gr-privacy-note">${icon('shield')}<span>Everything runs on this device. Video never leaves your browser.</span></p>`;
    surface.appendChild(body);
  }

  get isOpen(): boolean {
    return this.layer.isOpen;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    this.layer.mount(parent);
  }

  open(): void {
    this.layer.open();
  }

  close(): void {
    this.layer.close();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  destroy(): void {
    this.layer.destroy();
  }
}

function keycap(label: string): string {
  return label
    .split(' + ')
    .map((k) => `<kbd>${k}</kbd>`)
    .join('<span class="gr-help__plus">+</span>');
}
