import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_OFF, type PageRequest, type PageState, type RuntimeResponse } from './messages';

type MessageListener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => boolean;
type UpdatedListener = (tabId: number, changeInfo: { status?: string }) => void;

const ON: PageState = { ...PAGE_OFF, enabled: true, tracking: 'starting', source: 'webcam' };
const POPUP = { id: 'ext', url: 'chrome-extension://ext/popup.html' } satisfies chrome.runtime.MessageSender;

/** Just enough of the chrome.* surface for the service worker, with the page side scripted per test. */
function installChrome() {
  const messageListeners: MessageListener[] = [];
  const updatedListeners: UpdatedListener[] = [];
  const badges = new Map<number, string>();
  const page = {
    injected: false,
    /** What the content script answers to page-set-enabled / page-query. */
    state: ON as PageState,
  };
  const listenerSet = <F>(into?: F[]) => ({ addListener: (cb: F) => void into?.push(cb), removeListener: () => undefined });
  const fake = {
    runtime: {
      id: 'ext',
      getURL: (p: string) => `chrome-extension://ext/${p}`,
      getContexts: vi.fn(async (): Promise<unknown[]> => []),
      onConnect: listenerSet(),
      onMessage: listenerSet(messageListeners),
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, req: PageRequest): Promise<unknown> => {
        if (!page.injected) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (req.type === 'page-ping') return true;
        return page.state;
      }),
      get: vi.fn(async (tabId: number): Promise<Partial<chrome.tabs.Tab>> => ({ id: tabId, windowId: 2, index: 4 })),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      onUpdated: listenerSet(updatedListeners),
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: {
      executeScript: vi.fn(async () => {
        page.injected = true;
        return [];
      }),
    },
    action: {
      setBadgeText: vi.fn(async ({ tabId, text }: { tabId: number; text: string }) => void badges.set(tabId, text)),
      getBadgeText: vi.fn(async ({ tabId }: { tabId: number }) => badges.get(tabId) ?? ''),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    commands: { onCommand: listenerSet() },
    storage: { onChanged: listenerSet() },
    offscreen: { createDocument: vi.fn(async () => undefined), closeDocument: vi.fn(async () => undefined) },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;

  const request = (msg: unknown, sender: chrome.runtime.MessageSender = POPUP) =>
    new Promise<RuntimeResponse>((resolve) => {
      for (const l of messageListeners) l(msg, sender, (r) => resolve(r as RuntimeResponse));
    });
  const updated = async (tabId: number, changeInfo: { status?: string }) => {
    for (const l of updatedListeners) l(tabId, changeInfo);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { fake, page, badges, request, updated };
}

async function loadWorker() {
  vi.resetModules();
  await import('./background');
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('service worker', () => {
  it('turning a tab on injects the content script once, then marks the tab ON', async () => {
    const c = installChrome();
    await loadWorker();
    const res = await c.request({ type: 'set-tab-enabled', tabId: 5, enabled: true });
    expect(res).toEqual({ ok: true, state: ON });
    expect(c.fake.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 5 }, files: ['content.js'] });
    expect(c.badges.get(5)).toBe('ON');

    await c.request({ type: 'set-tab-enabled', tabId: 5, enabled: true });
    expect(c.fake.scripting.executeScript).toHaveBeenCalledTimes(1); // already there: not injected twice
  });

  it('reports a page whose session failed to start as an error, not a silent "off"', async () => {
    const c = installChrome();
    c.page.state = PAGE_OFF;
    await loadWorker();
    const res = await c.request({ type: 'set-tab-enabled', tabId: 5, enabled: true });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/couldn't start on this page/);
    expect(c.badges.get(5) ?? '').toBe('');
  });

  it('only lets extension pages turn tabs on', async () => {
    const c = installChrome();
    await loadWorker();
    const fromPage = { id: 'ext', url: 'https://example.com/article', tab: { id: 5 } as chrome.tabs.Tab, frameId: 0 };
    expect(await c.request({ type: 'set-tab-enabled', tabId: 5, enabled: true }, fromPage)).toEqual({ ok: false, error: 'Not allowed.' });
    expect(c.fake.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('keeps the badge through a single-page-app navigation and clears it after a real one', async () => {
    const c = installChrome();
    await loadWorker();
    await c.request({ type: 'set-tab-enabled', tabId: 5, enabled: true });
    expect(c.badges.get(5)).toBe('ON');

    // pushState navigation: Chrome reports loading → complete, the session lives on.
    await c.updated(5, { status: 'loading' });
    await c.updated(5, { status: 'complete' });
    expect(c.badges.get(5)).toBe('ON');

    // A real navigation: the content script is gone with the old document.
    c.page.injected = false;
    await c.updated(5, { status: 'complete' });
    expect(c.badges.get(5)).toBe('');

    // Tabs we never marked aren't even asked.
    c.fake.tabs.sendMessage.mockClear();
    await c.updated(6, { status: 'complete' });
    expect(c.fake.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("opens the camera setup page right next to the page that needs it, in that page's window", async () => {
    const c = installChrome();
    await loadWorker();
    const fromContent = { id: 'ext', url: 'https://example.com/a', tab: { id: 9 } as chrome.tabs.Tab, frameId: 0 };
    expect(await c.request({ type: 'open-setup' }, fromContent)).toEqual({ ok: true });
    expect(c.fake.tabs.create).toHaveBeenLastCalledWith({ url: 'setup.html?return=9', openerTabId: 9, windowId: 2, index: 5 });

    // The page's tab closed in the meantime: still open the setup page, just without an opener.
    c.fake.tabs.get.mockRejectedValueOnce(new Error('No tab with id: 9.'));
    await c.request({ type: 'open-setup' }, fromContent);
    expect(c.fake.tabs.create).toHaveBeenLastCalledWith({ url: 'setup.html?return=9' });
  });
});
