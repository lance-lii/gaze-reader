import { IGNORE_ATTR, Z } from '../core/constants';
import type { Mountable } from '../types';
import { icon, type IconName } from './topbar';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

/** A real link (opens in a new tab), for destinations outside the app. */
export interface ToastLink {
  label: string;
  href: string;
}

export interface ToastOptions {
  /** A toast with the same id replaces the existing one instead of stacking. */
  id?: string;
  title?: string;
  message: string;
  tone?: ToastTone;
  actions?: readonly ToastAction[];
  /** Shown after the actions, as links that open in a new tab. */
  links?: readonly ToastLink[];
  /** Milliseconds; 0 keeps it until dismissed. Defaults: 5 s, 9 s with actions, 8 s for errors. */
  durationMs?: number;
}

interface Entry {
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  sticky: boolean;
  remaining: number;
  startedAt: number;
  holds: number;
}

const MAX_VISIBLE = 3;
const LEAVE_MS = 180;
const TONE_ICON: Record<ToastTone, IconName> = { info: 'glasses', success: 'check', warn: 'eye', error: 'camera' };

let toastSeq = 0;

/**
 * Small, calm notifications at the top of the screen, away from the bottom
 * lines where the reader's eyes are when a page is about to turn.
 */
export class Toaster implements Mountable {
  private readonly el: HTMLElement;
  private readonly entries = new Map<string, Entry>();
  private readonly leaving = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    const el = document.createElement('div');
    el.className = 'gr-toasts';
    el.setAttribute(IGNORE_ATTR, '');
    el.style.zIndex = String(Z.toast);
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Notifications');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-relevant', 'additions');
    this.el = el;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    parent.appendChild(this.el);
  }

  /** Shows a toast and returns its id. */
  show(opts: ToastOptions): string {
    const id = opts.id ?? `gr-toast-${++toastSeq}`;
    const tone = opts.tone ?? 'info';
    const actions = opts.actions ?? [];
    const links = opts.links ?? [];
    const duration = opts.durationMs ?? (actions.length + links.length > 0 ? 9000 : tone === 'error' ? 8000 : 5000);

    const existing = this.entries.get(id);
    if (existing) this.removeNow(id, existing);

    const el = document.createElement('div');
    el.className = 'gr-toast';
    el.dataset.tone = tone;
    if (tone === 'error') el.setAttribute('role', 'alert');

    const glyph = document.createElement('span');
    glyph.className = 'gr-toast__icon';
    glyph.innerHTML = icon(TONE_ICON[tone]);

    const text = document.createElement('div');
    text.className = 'gr-toast__text';
    if (opts.title) {
      const t = document.createElement('strong');
      t.className = 'gr-toast__title';
      t.textContent = opts.title;
      text.appendChild(t);
    }
    const msg = document.createElement('span');
    msg.className = 'gr-toast__message';
    msg.textContent = opts.message;
    text.appendChild(msg);

    if (actions.length + links.length > 0) {
      const row = document.createElement('div');
      row.className = 'gr-toast__actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = a.primary ? 'gr-btn gr-btn--primary gr-btn--sm' : 'gr-btn gr-btn--soft gr-btn--sm';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          this.dismiss(id);
          a.run();
        });
        row.appendChild(b);
      }
      for (const l of links) {
        const a = document.createElement('a');
        a.className = 'gr-btn gr-btn--soft gr-btn--sm';
        a.href = l.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = l.label;
        row.appendChild(a);
      }
      text.appendChild(row);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gr-btn gr-btn--ghost gr-btn--icon gr-toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.innerHTML = icon('close');
    close.addEventListener('click', () => this.dismiss(id));

    el.append(glyph, text, close);

    const entry: Entry = { el, timer: null, sticky: !(duration > 0), remaining: duration, startedAt: 0, holds: 0 };
    // Don't let a toast vanish while it is being read or its buttons are focused.
    const hold = () => {
      entry.holds++;
      this.pause(entry);
    };
    const release = () => {
      entry.holds = Math.max(0, entry.holds - 1);
      if (entry.holds === 0) this.resume(id, entry);
    };
    el.addEventListener('pointerenter', hold);
    el.addEventListener('pointerleave', release);
    el.addEventListener('focusin', hold);
    el.addEventListener('focusout', release);

    this.entries.set(id, entry);
    this.el.appendChild(el);
    this.resume(id, entry);

    while (this.entries.size > MAX_VISIBLE) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.dismiss(oldest);
    }
    return id;
  }

  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.pause(entry);
    entry.el.dataset.leaving = 'true';
    const t = setTimeout(() => {
      this.leaving.delete(t);
      entry.el.remove();
    }, LEAVE_MS);
    this.leaving.add(t);
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.dismiss(id);
  }

  destroy(): void {
    for (const [id, entry] of this.entries) this.removeNow(id, entry);
    for (const t of this.leaving) clearTimeout(t);
    this.leaving.clear();
    this.el.remove();
  }

  private removeNow(id: string, entry: Entry): void {
    this.pause(entry);
    entry.el.remove();
    this.entries.delete(id);
  }

  private pause(entry: Entry): void {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
  }

  private resume(id: string, entry: Entry): void {
    if (entry.sticky || entry.timer !== null || !this.entries.has(id)) return;
    entry.startedAt = performance.now();
    // After a hover/focus hold, leave a moment to finish reading.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.dismiss(id);
    }, Math.max(1200, entry.remaining));
  }
}
