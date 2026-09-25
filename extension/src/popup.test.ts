// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import popupHtml from '../popup.html?raw';
import type { AppSettings } from '../../src/types';
import { KEYS } from './extStorage';
import { PAGE_OFF, type PageRequest, type PageState, type RuntimeRequest, type RuntimeResponse } from './messages';
import { FakeStorage } from './testing/fakes';

const ON: PageState = { ...PAGE_OFF, enabled: true, tracking: 'tracking', source: 'webcam', calibrated: true, fps: 29.7 };
/** The real popup markup, minus its module script (the test imports popup.ts itself). */
const POPUP_BODY = /<body>([\s\S]*)<\/body>/.exec(popupHtml)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');

function installChrome(opts: { url?: string } = {}) {
  const storage = new FakeStorage();
  /** Answers to page-query, in order; a function gets to decide when to resolve. */
  const pageAnswers: (PageState | (() => Promise<PageState>))[] = [];
  const fake = {
    tabs: {
      query: vi.fn(async () => [{ id: 5, url: opts.url ?? 'https://example.com/article' }]),
      sendMessage: vi.fn(async (_tabId: number, req: PageRequest): Promise<unknown> => {
        if (req.type !== 'page-query') return ON;
        const next = pageAnswers.shift() ?? PAGE_OFF;
        return typeof next === 'function' ? next() : next;
      }),
    },
    runtime: {
      sendMessage: vi.fn(async (req: RuntimeRequest): Promise<RuntimeResponse> => {
        if (req.type === 'set-tab-enabled') return { ok: true, state: req.enabled ? ON : PAGE_OFF };
        return { ok: true };
      }),
    },
    storage: { local: storage.area, onChanged: storage.onChanged },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { fake, storage, pageAnswers };
}

async function openPopup(): Promise<void> {
  document.body.innerHTML = POPUP_BODY;
  vi.resetModules();
  await import('./popup');
  await vi.advanceTimersByTimeAsync(0);
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const toggle = (el: HTMLInputElement, checked: boolean) => {
  el.checked = checked;
  el.dispatchEvent(new Event('change'));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('popup', () => {
  it("shows the page's state, and a poll already in flight can't undo the reader's toggle", async () => {
    const c = installChrome();
    await openPopup();
    const enabled = $<HTMLInputElement>('#enabled');
    expect(enabled.checked).toBe(false);
    expect($('#status').textContent).toBe('Off');

    // The 1 s poll asks the page… and the answer (from before the toggle) arrives late.
    let answer!: (s: PageState) => void;
    c.pageAnswers.push(() => new Promise<PageState>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(1_000);
    toggle(enabled, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.fake.runtime.sendMessage).toHaveBeenCalledWith({ type: 'set-tab-enabled', tabId: 5, enabled: true });
    answer(PAGE_OFF);
    await vi.advanceTimersByTimeAsync(0);

    expect(enabled.checked).toBe(true);
    expect($('#status').textContent).toBe('Reading along · 30 fps');
  });

  it('explains pages Chrome never lets extensions touch, and disables the switch', async () => {
    installChrome({ url: 'chrome://extensions/' });
    await openPopup();
    expect($<HTMLInputElement>('#enabled').disabled).toBe(true);
    expect($('#notice').hidden).toBe(false);
    expect($('#notice').textContent).toMatch(/doesn't let extensions/);
  });

  it('shows why turning on failed', async () => {
    const c = installChrome();
    c.fake.runtime.sendMessage.mockResolvedValueOnce({ ok: false, error: "Gaze Reader couldn't start on this page." });
    await openPopup();
    toggle($<HTMLInputElement>('#enabled'), true);
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLInputElement>('#enabled').checked).toBe(false);
    expect($('#notice').textContent).toBe("Gaze Reader couldn't start on this page.");
    expect($('#notice').dataset.tone).toBe('error');
  });

  it('writes setting changes to chrome.storage.local for every tab to pick up, and can forget the calibration', async () => {
    const c = installChrome();
    c.storage.data.set(KEYS.calibration, { version: 1 });
    await openPopup();

    const mouse = document.querySelector<HTMLInputElement>('input[name="source"][value="mouse"]')!;
    toggle(mouse, true);
    toggle(document.querySelector<HTMLInputElement>('input[name="sensitivity"][value="eager"]')!, true);
    await vi.advanceTimersByTimeAsync(0);
    const stored = c.storage.data.get(KEYS.settings) as { settings: AppSettings };
    expect(stored.settings).toMatchObject({ gazeSource: 'mouse', sensitivity: 'eager' });
    expect($('#calibration').hidden).toBe(true); // nothing to calibrate in mouse mode

    toggle(document.querySelector<HTMLInputElement>('input[name="source"][value="webcam"]')!, true);
    await vi.advanceTimersByTimeAsync(0);
    const forget = $('#calibration').querySelector('button')!;
    expect(forget.textContent).toBe('Forget it');
    forget.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.storage.data.has(KEYS.calibration)).toBe(false);
    expect($('#calibration').textContent).toMatch(/30-second calibration/);
  });
});
