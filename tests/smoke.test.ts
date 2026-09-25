import { describe, expect, it } from 'vitest';
import { createEventBus } from '../src/core/events';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/core/settings';
import { OneEuroFilter } from '../src/signal/oneEuro';

describe('core foundation', () => {
  it('bus delivers typed events and isolates throwing listeners', () => {
    const bus = createEventBus();
    const got: string[] = [];
    bus.on('command', () => { throw new Error('boom'); });
    bus.on('command', (c) => got.push(c.name));
    bus.emit('command', { name: 'pause' });
    expect(got).toEqual(['pause']);
  });

  it('settings store validates patches and reports changed keys', () => {
    const bus = createEventBus();
    const store = createSettingsStore(bus, { persist: false });
    let changed: string[] = [];
    bus.on('settings-changed', (e) => { changed = e.changed; });
    bus.emit('settings-patch', { overlapLines: 2, fontSizePx: 9999 });
    expect(store.get().overlapLines).toBe(2);
    expect(store.get().fontSizePx).toBe(DEFAULT_SETTINGS.fontSizePx);
    expect(changed).toEqual(['overlapLines']);
  });

  it('one euro filter smooths jitter but follows a step', () => {
    const f = new OneEuroFilter();
    let t = 0, out = 0;
    for (let i = 0; i < 60; i++) { t += 33; out = f.filter(100 + (i % 2 ? 10 : -10), t); }
    expect(Math.abs(out - 100)).toBeLessThan(6);
    for (let i = 0; i < 30; i++) { t += 33; out = f.filter(800, t); }
    expect(out).toBeGreaterThan(780);
  });
});
