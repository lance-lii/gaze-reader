// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import setupHtml from '../setup.html?raw';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { KEYS } from './extStorage';
import type { RuntimeRequest } from './messages';
import { FakeStorage, flush } from './testing/fakes';

/** The real setup markup, minus its module script (the test imports setup.ts itself). */
const SETUP_BODY = /<body>([\s\S]*)<\/body>/.exec(setupHtml)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');

/** A camera PermissionStatus whose state the test flips, as Chrome's settings page would. */
class FakePermission extends EventTarget {
  constructor(public state: PermissionState) {
    super();
  }
  set(state: PermissionState): void {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }
}

function install(initial: PermissionState) {
  const storage = new FakeStorage();
  storage.data.set(KEYS.settings, { v: 1, settings: { ...DEFAULT_SETTINGS, buddyEnabled: false }, origin: 'seed', seq: 1 });
  const permission = new FakePermission(initial);
  const sendMessage = vi.fn(async (_msg: RuntimeRequest) => ({ ok: true }));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: storage.area, onChanged: storage.onChanged },
    runtime: { sendMessage },
    tabs: { create: vi.fn(), update: vi.fn(), getCurrent: vi.fn(async () => undefined), remove: vi.fn() },
    windows: { update: vi.fn() },
  };
  // jsdom has no Permissions API.
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => permission } });
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  const grants = () => sendMessage.mock.calls.filter(([m]) => m.type === 'camera-permission-granted').length;
  return { storage, permission, grants, getUserMedia };
}

async function openSetup(): Promise<void> {
  document.body.innerHTML = SETUP_BODY;
  vi.resetModules();
  await import('./setup');
  await flush(20);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(navigator, 'permissions');
});

describe('camera setup page', () => {
  it('announces a grant again after the permission was revoked while the page was open', async () => {
    const c = install('granted');
    await openSetup();
    expect(document.getElementById('panel')!.dataset.state).toBe('granted');
    expect(c.grants()).toBe(1);
    expect(c.storage.data.has(KEYS.cameraGrantedAt)).toBe(true);

    // The reader resets the camera permission in Chrome's settings: waiting tabs need the next grant.
    c.permission.set('prompt');
    await flush(20);
    expect(document.getElementById('panel')!.dataset.state).toBe('prompt');

    document.getElementById('allow')!.click();
    await flush(20);
    expect(c.getUserMedia).toHaveBeenCalledTimes(1);
    c.permission.state = 'granted';
    await flush(20);
    expect(document.getElementById('panel')!.dataset.state).toBe('granted');
    expect(c.grants()).toBe(2);
  });

  it('shows the blocked state with a way to Chrome settings', async () => {
    install('denied');
    await openSetup();
    expect(document.getElementById('panel')!.dataset.state).toBe('denied');
    expect(document.getElementById('settings')!.hidden).toBe(false);
  });
});
