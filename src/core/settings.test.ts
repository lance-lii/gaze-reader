// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from './events';
import { DEFAULT_SETTINGS, createSettingsStore, sanitizeSettings } from './settings';
import type { AppSettings } from '../types';

const KEY = 'gazeReader.settings.v1';

/** What another tab of the app does: write the whole settings object, then the browser tells this tab. */
function otherTabWrites(settings: Partial<AppSettings>): void {
  const value = JSON.stringify({ ...DEFAULT_SETTINGS, ...settings });
  localStorage.setItem(KEY, value);
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: value }));
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('sanitizeSettings', () => {
  it('fills what is missing or invalid from the defaults, or from the settings a patch is applied to', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ fontSizePx: 99, theme: 'neon', headGestures: 'yes' })).toEqual(DEFAULT_SETTINGS);
    const mine: AppSettings = { ...DEFAULT_SETTINGS, fontSizePx: 30, theme: 'dark', headGestures: true };
    expect(sanitizeSettings({ ...mine, fontSizePx: 99 }, mine).fontSizePx).toBe(30);
    expect(sanitizeSettings({ ...mine, fontSizePx: 18 }, mine)).toEqual({ ...mine, fontSizePx: 18 });
  });
});

describe('settings store', () => {
  it('an invalid value in a patch leaves that setting as it is (regression: reset to the default)', () => {
    const bus = createEventBus();
    const store = createSettingsStore(bus);
    store.update({ fontSizePx: 30 });
    store.update({ fontSizePx: 99 } as Partial<AppSettings>);
    expect(store.get().fontSizePx).toBe(30);
    store.dispose?.();
  });

  it('takes over what another tab changed, and then writes its own change on top of it (regression: clobbered)', () => {
    const bus = createEventBus();
    const store = createSettingsStore(bus);
    const changes: (keyof AppSettings)[][] = [];
    bus.on('settings-changed', (e) => changes.push(e.changed));

    otherTabWrites({ theme: 'dark', fontSizePx: 30 });
    expect(store.get().theme).toBe('dark');
    expect(store.get().fontSizePx).toBe(30);
    expect(changes).toEqual([['fontSizePx', 'theme']]);

    store.update({ showGazeDot: true }); // this tab's own change
    const stored = JSON.parse(localStorage.getItem(KEY)!) as AppSettings;
    expect(stored).toMatchObject({ theme: 'dark', fontSizePx: 30, showGazeDot: true });

    // Other keys in storage, and removals, are not settings changes.
    window.dispatchEvent(new StorageEvent('storage', { key: 'gazeReader.calibration.v1', newValue: '{}' }));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    expect(changes).toHaveLength(2);

    store.dispose?.();
    otherTabWrites({ theme: 'sepia' });
    expect(store.get().theme).toBe('dark'); // no longer listening
  });

  it('a store that doesn’t persist (the extension’s) listens to nobody', () => {
    const store = createSettingsStore(createEventBus(), { persist: false });
    expect(store.dispose).toBeUndefined();
    otherTabWrites({ theme: 'dark' });
    expect(store.get().theme).toBe(DEFAULT_SETTINGS.theme);
  });
});
