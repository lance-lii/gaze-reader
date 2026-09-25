// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PagePill, type PillStatus } from './pagePill';

function setup() {
  const calls = { pause: 0, recalibrate: 0, close: 0 };
  const pill = new PagePill({
    onTogglePause: () => calls.pause++,
    onRecalibrate: () => calls.recalibrate++,
    onClose: () => calls.close++,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  pill.mount(root);
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const byLabel = (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`);
  return { pill, root, calls, q, byLabel };
}

const status = (s: Partial<PillStatus>): PillStatus => ({ state: 'tracking', source: 'webcam', paused: false, detail: null, ...s });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('PagePill', () => {
  it('never assigns HTML strings, so it works on pages that enforce Trusted Types', () => {
    const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...innerHTML,
      set() {
        throw new TypeError("Failed to set 'innerHTML': This document requires 'TrustedHTML' assignment.");
      },
    });
    try {
      const { pill, root } = setup();
      pill.setStatus(status({ source: 'webcam' }));
      pill.setStatus(status({ source: 'mouse', paused: true, state: 'paused' }));
      pill.notify({ text: 'Camera problem', tone: 'error', actions: [{ label: 'Try again', run: () => undefined }] });
      pill.toggleHelp(true);
      // Every button carries a real SVG icon.
      for (const b of Array.from(root.querySelectorAll('.gr-pill-btn'))) {
        expect(b.querySelector('svg')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
      }
      pill.destroy();
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', innerHTML);
    }
  });

  it('shows what the tracker is doing, with a camera-on indicator and the right controls', () => {
    const { pill, q, byLabel } = setup();
    pill.setStatus(status({ state: 'starting' }));
    expect(q('.gr-pill-label')!.textContent).toBe('Waking up the camera…');
    expect(byLabel('Pause auto-scroll')!.hidden).toBe(true); // nothing to pause yet

    pill.setStatus(status({ state: 'tracking' }));
    expect(q('.gr-pill-label')!.textContent).toBe('Reading along');
    expect(q('.gr-pill-src')!.hasAttribute('data-live')).toBe(true);
    expect(byLabel('Recalibrate')!.hidden).toBe(false);

    pill.setStatus(status({ state: 'paused', paused: true }));
    expect(q('.gr-pill-label')!.textContent).toBe('Auto-scroll paused');
    expect(byLabel('Resume auto-scroll')).not.toBeNull();

    pill.setStatus(status({ state: 'error', detail: 'Camera permission needed' }));
    expect(q('.gr-pill-label')!.textContent).toBe('Camera permission needed');
    expect(q('.gr-pill-src')!.hasAttribute('data-live')).toBe(false);
    expect(q('.gr-pill')!.dataset.tone).toBe('err');

    pill.setStatus(status({ source: 'mouse' }));
    expect(byLabel('Recalibrate')!.hidden).toBe(true); // no calibration in mouse mode
    pill.destroy();
  });

  it('runs notice actions, dismisses them, and expires timed notices', () => {
    const { pill, q, calls, byLabel } = setup();
    let ran = 0;
    pill.notify({ text: 'Needs calibration', actions: [{ label: 'Calibrate', run: () => ran++ }] });
    const notice = q('.gr-pill-notice')!;
    expect(notice.hidden).toBe(false);
    q<HTMLButtonElement>('.gr-pill-action')!.click();
    expect(ran).toBe(1);
    expect(notice.hidden).toBe(true);

    pill.notify({ text: 'Window size changed', timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(notice.hidden).toBe(true);

    byLabel('Turn Gaze Reader off on this page')!.click();
    byLabel('Pause auto-scroll')!.click();
    expect(calls).toMatchObject({ close: 1, pause: 1 });
    pill.destroy();
  });

  it('fades while all is well, wakes for problems, and leaves no timers behind', () => {
    const before = vi.getTimerCount();
    const { pill, q, byLabel } = setup();
    pill.setStatus(status({ state: 'tracking' }));
    vi.advanceTimersByTime(4_000);
    expect(q('.gr-pill')!.classList.contains('gr-pill--quiet')).toBe(true);
    pill.setStatus(status({ state: 'no-face' }));
    expect(q('.gr-pill')!.classList.contains('gr-pill--quiet')).toBe(false);

    const help = byLabel('Keyboard shortcuts')!;
    help.click();
    expect(help.getAttribute('aria-expanded')).toBe('true');
    expect(q('.gr-pill-help')!.textContent).toContain('Alt+Shift+P');

    pill.notify({ text: 'x', timeoutMs: 60_000 });
    pill.destroy();
    expect(q('.gr-pill')).toBeNull();
    expect(vi.getTimerCount()).toBe(before);
  });
});
