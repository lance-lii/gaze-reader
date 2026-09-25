// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostThemeWatcher, parseHostTheme } from './hostTheme';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('parseHostTheme', () => {
  it('accepts only the two stamps the host uses', () => {
    expect(parseHostTheme('dark')).toBe('dark');
    expect(parseHostTheme('light')).toBe('light');
    expect(parseHostTheme(null)).toBeNull();
    expect(parseHostTheme(undefined)).toBeNull();
    expect(parseHostTheme('sepia')).toBeNull();
    expect(parseHostTheme('')).toBeNull();
  });
});

describe('HostThemeWatcher', () => {
  let watcher: HostThemeWatcher | null = null;
  afterEach(() => {
    watcher?.destroy();
    watcher = null;
  });

  it('reads the stamp present before the app writes', () => {
    const root = document.createElement('div');
    root.setAttribute('data-theme', 'dark');
    watcher = new HostThemeWatcher(root, () => undefined);
    expect(watcher.theme).toBe('dark');
  });

  it('never reports its own writes as host changes', async () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    watcher = new HostThemeWatcher(root, onChange);
    watcher.write('sepia');
    watcher.write('light');
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(watcher.theme).toBeNull();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('follows the host when it stamps, changes and removes its theme', async () => {
    const root = document.createElement('div');
    const seen: (string | null)[] = [];
    watcher = new HostThemeWatcher(root, (t) => {
      seen.push(t);
      watcher?.write(t ?? 'light'); // what the controller does: repaint with our own value
    });
    watcher.write('light');
    root.setAttribute('data-theme', 'dark');
    await flush();
    expect(watcher.theme).toBe('dark');
    root.setAttribute('data-theme', 'light');
    await flush();
    root.removeAttribute('data-theme');
    await flush();
    expect(seen).toEqual(['dark', 'light', null]);
    expect(watcher.theme).toBeNull();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('picks up a host change that is still queued when the app writes', () => {
    const root = document.createElement('div');
    watcher = new HostThemeWatcher(root, () => undefined);
    root.setAttribute('data-theme', 'dark'); // the observer hasn't delivered this yet
    expect(watcher.theme).toBe('dark');
    watcher.write('sepia');
    expect(watcher.theme).toBe('dark');
  });
});
