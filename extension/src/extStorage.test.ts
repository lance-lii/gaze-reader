import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../src/types';
import { createEventBus } from '../../src/core/events';
import { DEFAULT_SETTINGS, createSettingsStore } from '../../src/core/settings';
import {
  KEYS,
  clearCalibrationJSON,
  loadCalibrationJSON,
  loadSettings,
  saveCalibrationJSON,
  syncSettings,
  watchKey,
} from './extStorage';
import { FakeStorage, flush } from './testing/fakes';

async function context(storage: FakeStorage, origin: string) {
  const bus = createEventBus();
  const store = createSettingsStore(bus, { persist: false, initial: await loadSettings(storage.area) });
  const changes: (keyof AppSettings)[][] = [];
  bus.on('settings-changed', (e) => changes.push(e.changed));
  const stop = syncSettings({ bus, store, storage, origin });
  return { bus, store, changes, stop };
}

const stored = (s: FakeStorage) => (s.data.get(KEYS.settings) as { settings: AppSettings } | undefined)?.settings;

describe('settings in chrome.storage.local', () => {
  it('loads defaults when nothing is stored, and sanitizes garbage', async () => {
    const storage = new FakeStorage();
    expect(await loadSettings(storage.area)).toEqual(DEFAULT_SETTINGS);
    storage.data.set(KEYS.settings, { settings: { sensitivity: 'eager', overlapLines: 99, gazeSource: 'telepathy' } });
    const s = await loadSettings(storage.area);
    expect(s.sensitivity).toBe('eager');
    expect(s.overlapLines).toBe(DEFAULT_SETTINGS.overlapLines);
    expect(s.gazeSource).toBe(DEFAULT_SETTINGS.gazeSource);
    storage.data.set(KEYS.settings, 'not an object');
    expect(await loadSettings(storage.area)).toEqual(DEFAULT_SETTINGS);
  });

  it('persists local changes and never writes back a change it received', async () => {
    const storage = new FakeStorage();
    const writes: unknown[] = [];
    const set = storage.area.set;
    storage.area.set = async (items) => {
      writes.push(items);
      return set(items);
    };
    const tab = await context(storage, 'tab');
    tab.bus.emit('settings-patch', { buddyCorner: 'top-left' });
    await flush();
    expect(stored(storage)?.buddyCorner).toBe('top-left');
    expect(writes).toHaveLength(1);

    // Another context (the popup) writes: we apply it, and do not echo it.
    await storage.area.set({ [KEYS.settings]: { v: 1, settings: { ...stored(storage)!, sensitivity: 'relaxed' }, origin: 'popup', seq: 1 } });
    await flush();
    expect(tab.store.get().sensitivity).toBe('relaxed');
    expect(tab.changes.at(-1)).toEqual(['sensitivity']);
    expect(writes).toHaveLength(2); // only the popup's write
  });

  it('does not ping-pong on rapid local changes', async () => {
    const storage = new FakeStorage();
    const tab = await context(storage, 'tab');
    tab.bus.emit('settings-patch', { sensitivity: 'eager' });
    tab.bus.emit('settings-patch', { sensitivity: 'relaxed' });
    tab.bus.emit('settings-patch', { showGazeDot: true });
    await flush(20);
    expect(tab.store.get().sensitivity).toBe('relaxed');
    expect(tab.store.get().showGazeDot).toBe(true);
    expect(stored(storage)).toEqual(tab.store.get());
    // Each local change was broadcast exactly once; no stale echo re-applied an old value.
    expect(tab.changes).toEqual([['sensitivity'], ['sensitivity'], ['showGazeDot']]);
  });

  it('two contexts editing at once converge on the last write', async () => {
    const storage = new FakeStorage();
    const tab = await context(storage, 'tab');
    const popup = await context(storage, 'popup');
    tab.bus.emit('settings-patch', { buddyCorner: 'bottom-left' });
    popup.bus.emit('settings-patch', { sensitivity: 'eager' });
    await flush(20);
    const final = stored(storage)!;
    expect(tab.store.get()).toEqual(final);
    expect(popup.store.get()).toEqual(final);
  });

  it('falls back to defaults when the key is removed, and stops syncing after unsubscribe', async () => {
    const storage = new FakeStorage();
    const tab = await context(storage, 'tab');
    tab.bus.emit('settings-patch', { buddyEnabled: false });
    await flush();
    await storage.area.remove([KEYS.settings]);
    await flush();
    expect(tab.store.get().buddyEnabled).toBe(true);
    tab.stop();
    await storage.area.set({ [KEYS.settings]: { v: 1, settings: { ...DEFAULT_SETTINGS, buddyEnabled: false }, origin: 'x', seq: 1 } });
    await flush();
    expect(tab.store.get().buddyEnabled).toBe(true);
  });

  it('survives a failing storage write', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const bus = createEventBus();
    const store = createSettingsStore(bus, { persist: false });
    const errors: unknown[] = [];
    syncSettings({ bus, store, storage, origin: 'tab', onWriteError: (e) => errors.push(e) });
    bus.emit('settings-patch', { showDebugOverlay: true });
    await flush();
    expect(store.get().showDebugOverlay).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('calibration in chrome.storage.local', () => {
  it('round-trips a model snapshot and rejects junk', async () => {
    const storage = new FakeStorage();
    expect(await loadCalibrationJSON(storage.area)).toBeNull();
    const model = { version: 1, weightsX: [1, 2], viewport: { width: 1280, height: 800 } };
    expect(await saveCalibrationJSON(storage.area, model)).toBe(true);
    expect(await loadCalibrationJSON(storage.area)).toEqual(model);
    storage.data.set(KEYS.calibration, { weights: [1] });
    expect(await loadCalibrationJSON(storage.area)).toBeNull();
    storage.data.set(KEYS.calibration, [1, 2, 3]);
    expect(await loadCalibrationJSON(storage.area)).toBeNull();
    await clearCalibrationJSON(storage.area);
    expect(storage.data.has(KEYS.calibration)).toBe(false);
  });

  it('watchKey reports changes to one key only', async () => {
    const storage = new FakeStorage();
    const seen: unknown[] = [];
    const off = watchKey(storage, KEYS.cameraGrantedAt, (v) => seen.push(v));
    await storage.area.set({ other: 1 });
    await storage.area.set({ [KEYS.cameraGrantedAt]: 123 });
    await flush();
    expect(seen).toEqual([123]);
    off();
    await storage.area.set({ [KEYS.cameraGrantedAt]: 456 });
    await flush();
    expect(seen).toEqual([123]);
  });
});
