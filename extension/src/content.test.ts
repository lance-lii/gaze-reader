// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageState } from './messages';
import type { PageSessionDeps } from './pageSession';

/** A stand-in session so this test exercises only the entry's injection and messaging logic. */
const sessions: { destroyed: boolean; commands: string[]; deps: PageSessionDeps }[] = [];
vi.mock('./pageSession', () => ({
  PageSession: {
    start: vi.fn(async (deps: PageSessionDeps) => {
      const s = { destroyed: false, commands: [] as string[], deps };
      sessions.push(s);
      return {
        state: (): PageState => ({ enabled: true, tracking: 'tracking', source: 'mouse', calibrated: false, paused: false, fps: null, detail: null }),
        command: (c: string) => s.commands.push(c),
        destroy: () => {
          s.destroyed = true;
        },
      };
    }),
  },
}));

type Listener = (msg: unknown, sender: { id?: string }, sendResponse: (r: unknown) => void) => boolean | undefined;

function installChrome(id = 'ext-id') {
  const listeners = new Set<Listener>();
  const runtime = {
    id: id as string | undefined,
    onMessage: {
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
    },
    sendMessage: vi.fn(async () => ({ ok: true })),
    connect: vi.fn(),
  };
  const storage = { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } };
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime, storage };
  /** Sends a message as the extension would and resolves with the response. */
  const send = (msg: unknown, senderId: string | undefined = runtime.id) =>
    new Promise<unknown>((resolve) => {
      let responded = false;
      const respond = (r: unknown) => {
        responded = true;
        resolve(r);
      };
      for (const l of [...listeners]) l(msg, { id: senderId }, respond);
      setTimeout(() => !responded && resolve('no response'), 50);
    });
  return { runtime, listeners, send };
}

async function inject(): Promise<void> {
  vi.resetModules();
  await import('./content');
}

beforeEach(() => {
  sessions.length = 0;
  delete window.__gazeReaderExt;
});
afterEach(() => {
  window.__gazeReaderExt?.shutdown(); // drop this copy's window listeners before the next test injects again
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('content script entry', () => {
  it('is idempotent: a second injection into the same page is a no-op', async () => {
    const chrome = installChrome();
    await inject();
    await inject();
    expect(chrome.listeners.size).toBe(1);
    expect(await chrome.send({ type: 'page-ping' })).toBe(true);
  });

  it('turns on and off on request and reports its state', async () => {
    const chrome = installChrome();
    await inject();
    expect(await chrome.send({ type: 'page-query' })).toMatchObject({ enabled: false, tracking: 'off' });
    expect(await chrome.send({ type: 'page-set-enabled', enabled: true })).toMatchObject({ enabled: true });
    expect(sessions).toHaveLength(1);
    await chrome.send({ type: 'page-command', command: 'recalibrate' });
    expect(sessions[0]!.commands).toEqual(['recalibrate']);
    expect(await chrome.send({ type: 'page-set-enabled', enabled: false })).toMatchObject({ enabled: false });
    expect(sessions[0]!.destroyed).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'page-status', enabled: false });
  });

  it('serializes rapid on/off/on into a single live session', async () => {
    const chrome = installChrome();
    await inject();
    const a = chrome.send({ type: 'page-set-enabled', enabled: true });
    const b = chrome.send({ type: 'page-set-enabled', enabled: false });
    const c = chrome.send({ type: 'page-set-enabled', enabled: true });
    await Promise.all([a, b, c]);
    expect(sessions.filter((s) => !s.destroyed)).toHaveLength(1);
  });

  it('ignores malformed messages and messages from other extensions', async () => {
    const chrome = installChrome();
    await inject();
    expect(await chrome.send({ type: 'page-set-enabled', enabled: 'yes' })).toBe('no response');
    expect(await chrome.send({ type: 'page-set-enabled', enabled: true }, 'someone-else')).toBe('no response');
    expect(sessions).toHaveLength(0);
  });

  it('re-announces itself for the toolbar badge when the page returns from the back/forward cache', async () => {
    const chrome = installChrome();
    await inject();
    await chrome.send({ type: 'page-set-enabled', enabled: true });
    chrome.runtime.sendMessage.mockClear();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled(); // an ordinary load: nothing to restore
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'page-status', enabled: true });
  });

  it('asking for the setup page never throws, even as the extension goes away', async () => {
    const chrome = installChrome();
    await inject();
    await chrome.send({ type: 'page-set-enabled', enabled: true });
    const { openSetup } = sessions[0]!.deps;
    openSetup();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'open-setup' });
    chrome.runtime.sendMessage.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    expect(() => openSetup()).not.toThrow();
  });

  it('replaces an orphaned copy left behind by an extension reload', async () => {
    const first = installChrome();
    await inject();
    await first.send({ type: 'page-set-enabled', enabled: true });
    expect(sessions).toHaveLength(1);

    first.runtime.id = undefined; // the old extension context is gone
    const second = installChrome('ext-id-2');
    await inject();
    await new Promise((r) => setTimeout(r, 0));
    expect(sessions[0]!.destroyed).toBe(true);
    expect(second.listeners.size).toBe(1);
    expect(await second.send({ type: 'page-ping' })).toBe(true);
  });
});
