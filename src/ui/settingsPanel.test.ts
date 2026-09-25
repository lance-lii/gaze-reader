// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../core/events';
import { DEFAULT_SETTINGS } from '../core/settings';
import type { AppSettings } from '../types';
import { SettingsPanel } from './settingsPanel';

function setup(saved = true) {
  const bus = createEventBus();
  let settings: AppSettings = { ...DEFAULT_SETTINGS };
  const patches: Partial<AppSettings>[] = [];
  bus.on('settings-patch', (p) => {
    patches.push(p);
    settings = { ...settings, ...p };
    bus.emit('settings-changed', { settings, changed: Object.keys(p) as (keyof AppSettings)[] });
  });
  const state = { saved, forgot: 0, recalibrated: 0 };
  const panel = new SettingsPanel({
    bus,
    getSettings: () => settings,
    hasSavedCalibration: () => state.saved,
    onForgetCalibration: () => {
      state.saved = false;
      state.forgot++;
    },
    onRecalibrate: () => state.recalibrated++,
    onShowHelp: () => undefined,
    onReplayIntro: () => undefined,
  });
  panel.mount(document.body);
  return { bus, panel, patches, state };
}

const buttonByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.gr-settings button')].find((b) => b.textContent?.includes(text))!;

describe('SettingsPanel', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('keeps focus inside the drawer when "Forget calibration" disables itself', () => {
    const { panel, state } = setup(true);
    panel.open();
    const forget = document.querySelector<HTMLButtonElement>('.gr-settings__forget')!;
    expect(forget.disabled).toBe(false);
    forget.focus();
    forget.click(); // arms ("Click again to forget")
    expect(state.forgot).toBe(0);
    forget.click(); // confirms
    expect(state.forgot).toBe(1);
    expect(forget.disabled).toBe(true);
    expect(document.activeElement).toBe(buttonByText('Calibrate eye tracking'));
    panel.destroy();
  });

  it('writes every kind of control through settings-patch and re-syncs from settings-changed', () => {
    const { bus, panel, patches } = setup();
    panel.open();
    const dot = document.querySelector<HTMLInputElement>('input[id$="-showGazeDot"]')!;
    dot.click();
    expect(patches.at(-1)).toEqual({ showGazeDot: true });

    const size = document.querySelector<HTMLInputElement>('input[id$="-fontSizePx"]')!;
    size.value = '28';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    expect(patches.at(-1)).toEqual({ fontSizePx: 28 });
    expect(size.closest('.gr-set-row')!.querySelector('output')!.textContent).toBe('28 px');

    const sepia = document.querySelector<HTMLInputElement>('input[type="radio"][value="sepia"]')!;
    sepia.click();
    expect(patches.at(-1)).toEqual({ theme: 'sepia' });

    // A change made elsewhere (e.g. the P shortcut) shows up live.
    bus.emit('settings-changed', { settings: { ...DEFAULT_SETTINGS, autoScroll: false }, changed: ['autoScroll'] });
    expect(document.querySelector<HTMLInputElement>('input[id$="-autoScroll"]')!.checked).toBe(false);
    panel.destroy();
  });

  it('asks for confirmation before resetting, keeps the gaze source, and leaves no timers behind', () => {
    vi.useFakeTimers();
    const { panel, patches } = setup();
    // Not opened: jsdom's focus() schedules timers of its own, which would blur the count.
    const reset = buttonByText('Reset to defaults');
    reset.click();
    expect(patches).toHaveLength(0);
    reset.click();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.gazeSource).toBe(DEFAULT_SETTINGS.gazeSource);
    panel.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
