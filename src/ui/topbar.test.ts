// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../core/events';
import { DEFAULT_SETTINGS } from '../core/settings';
import type { AppSettings, GazeSourceKind } from '../types';
import { Topbar } from './topbar';

function setup(overrides: Partial<AppSettings> = {}) {
  const bus = createEventBus();
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const picked: GazeSourceKind[] = [];
  const bar = new Topbar({ bus, getSettings: () => settings, onSelectSource: (k) => picked.push(k) });
  bar.mount(document.body);
  return { bus, bar, picked };
}

const radio = (bar: Topbar, kind: GazeSourceKind) => bar.el.querySelector<HTMLInputElement>(`input[value="${kind}"]`)!;

describe('Topbar', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-picking the selected source still reaches the controller, so a failed webcam can be retried', () => {
    const { bar, picked } = setup({ gazeSource: 'webcam' });
    expect(radio(bar, 'webcam').checked).toBe(true);
    // An already-checked radio fires `click` but not `change`.
    radio(bar, 'webcam').click();
    expect(picked).toEqual(['webcam']);
    radio(bar, 'mouse').click();
    expect(picked).toEqual(['webcam', 'mouse']);
    bar.destroy();
  });

  it('gives controls accessible names that survive the compact layout (visible text is hidden there)', () => {
    const { bar } = setup();
    for (const r of bar.el.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(r.getAttribute('aria-label')?.length).toBeGreaterThan(0);
    }
    expect(bar.el.querySelector('[data-cmd="open-library"]')!.getAttribute('aria-label')).toBe('Back to the library');
    for (const b of bar.el.querySelectorAll('button')) {
      expect(b.getAttribute('aria-label') ?? b.textContent?.trim()).toBeTruthy();
    }
    bar.destroy();
  });

  it('keeps the pill visible while the camera is on, in the demo, and when paused', () => {
    const { bar } = setup();
    const persist = () => bar.el.dataset.persist;
    bar.setStatus({ state: 'tracking', kind: 'webcam', cameraOn: true });
    expect(persist()).toBe('true');
    expect(bar.el.querySelector('.gr-pill')!.getAttribute('aria-label')).toMatch(/Camera on/);
    bar.setStatus({ state: 'tracking', kind: 'mouse', cameraOn: false });
    expect(persist()).toBe('false');
    bar.setStatus({ state: 'paused', kind: 'mouse', cameraOn: false });
    expect(persist()).toBe('true');
    bar.setStatus({ state: 'tracking', kind: 'simulated', cameraOn: false });
    expect(persist()).toBe('true');
    expect(bar.el.querySelector<HTMLElement>('.gr-demo-chip')!.hidden).toBe(false);
    bar.destroy();
  });

  it('shows a recording chip, and keeps the status area up, while diagnostics are recorded', () => {
    const { bar } = setup();
    const chip = bar.el.querySelector<HTMLElement>('.gr-rec-chip')!;
    const demo = bar.el.querySelector<HTMLElement>('.gr-demo-chip:not(.gr-rec-chip)')!;
    expect(chip.hidden).toBe(true);
    bar.setStatus({ state: 'tracking', kind: 'mouse', cameraOn: false });
    expect(bar.el.dataset.persist).toBe('false');
    bar.setRecording(true);
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toMatch(/Recording diagnostics/);
    expect(chip.title).toMatch(/no video/);
    expect(demo.hidden).toBe(true);
    expect(bar.el.dataset.persist).toBe('true');
    bar.setStatus({ state: 'tracking', kind: 'mouse', cameraOn: false }); // a status update doesn't hide it
    expect(bar.el.dataset.persist).toBe('true');
    bar.setRecording(false);
    expect(chip.hidden).toBe(true);
    expect(bar.el.dataset.persist).toBe('false');
    bar.destroy();
  });

  it('explains why the camera is off', () => {
    const { bar } = setup();
    const pill = bar.el.querySelector<HTMLElement>('.gr-pill')!;
    bar.setStatus({ state: 'off', detail: 'Not calibrated', kind: null, cameraOn: false });
    expect(pill.title).toMatch(/Not calibrated/);
    bar.setStatus({ state: 'error', detail: 'Camera access is blocked', kind: null, cameraOn: false });
    expect(pill.title).toMatch(/blocked/);
    expect(pill.dataset.tone).toBe('bad');
    bar.destroy();
  });

  describe('auto-hide', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // A device that can hover: auto-hide is only enabled there.
      vi.stubGlobal('matchMedia', (media: string) => ({
        matches: true,
        media,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    });

    it('hides after a quiet moment, comes back near the top, without a layout read per pointer move', () => {
      const { bar } = setup();
      let heightReads = 0;
      Object.defineProperty(bar.el, 'offsetHeight', {
        configurable: true,
        get: () => {
          heightReads++;
          return 52;
        },
      });
      bar.setAutoHide(true);
      vi.advanceTimersByTime(3000);
      expect(bar.el.dataset.concealed).toBe('true');
      const readsWhenHidden = heightReads;

      for (let y = 600; y > 100; y -= 10) window.dispatchEvent(new MouseEvent('pointermove', { clientY: y }));
      expect(bar.el.dataset.concealed).toBe('true');
      expect(heightReads).toBe(readsWhenHidden);

      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 40 }));
      expect(bar.el.dataset.concealed).toBe('false');
      bar.destroy();
    });

    it('stops listening after destroy', () => {
      const { bar } = setup();
      bar.setAutoHide(true);
      vi.advanceTimersByTime(3000);
      bar.destroy();
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 10 }));
      expect(bar.el.dataset.concealed).toBe('true');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
