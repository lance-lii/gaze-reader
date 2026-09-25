/**
 * Service worker. Owns three jobs:
 *  1. Turning Gaze Reader on/off in a tab (inject the content script on demand).
 *  2. The camera: create the offscreen document when a tab needs frames, relay
 *     frames to it, close it when nobody does (see CameraHub).
 *  3. Opening the camera setup page when permission is missing.
 *
 * Every listener is registered synchronously at top level so Chrome can wake
 * the worker for them. No state here needs to survive a restart: ports
 * reconnect and rebuild it.
 */
import { CameraHub } from './cameraHub';
import { KEYS } from './extStorage';
import {
  PAGE_OFF,
  PORT_OFFSCREEN,
  PORT_TAB,
  errorMessage,
  isPageState,
  isRuntimeRequest,
  type PageRequest,
  type PageState,
  type RuntimeRequest,
  type RuntimeResponse,
} from './messages';

const OFFSCREEN_PAGE = 'offscreen.html';
const SETUP_PAGE = 'setup.html';
const CONTENT_SCRIPT = 'content.js';
const TOGGLE_COMMAND = 'toggle-gaze-reader';
const EXTENSION_ORIGIN = chrome.runtime.getURL('');
const START_FAILED = "Gaze Reader couldn't start on this page. Reloading the page may help.";

// ───────────────────────────── Offscreen document ────────────────────────────

/** Create/close operations run one at a time so they can't interleave. */
let docQueue: Promise<unknown> = Promise.resolve();
function serial<T>(op: () => Promise<T>): Promise<T> {
  const next = docQueue.then(op, op);
  docQueue = next.catch(() => undefined);
  return next;
}

async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PAGE)],
  });
  return contexts.length > 0;
}

const ensureOffscreen = () =>
  serial(async () => {
    if (await offscreenExists()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PAGE,
        reasons: ['USER_MEDIA'],
        justification: 'Runs on-device face tracking from the webcam so the page can scroll when your eyes reach the bottom.',
      });
    } catch (err) {
      // Lost a race with another creator: the document exists, which is what we wanted.
      if (!/single offscreen/i.test(errorMessage(err))) throw err;
    }
  });

const closeOffscreen = () =>
  serial(async () => {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  });

// ─────────────────────────────── Setup page ──────────────────────────────────

async function openSetup(returnTabId: number | null): Promise<void> {
  const url = returnTabId === null ? SETUP_PAGE : `${SETUP_PAGE}?return=${returnTabId}`;
  const base = chrome.runtime.getURL(SETUP_PAGE);
  const open = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find(
    (c) => c.tabId >= 0 && (c.documentUrl ?? '').startsWith(base),
  );
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true, url: chrome.runtime.getURL(url) });
    if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  // Right next to the page it is for. An opener must be in the same window as
  // the new tab (tabs.create fails otherwise), and the focused window may be another one.
  const opener = returnTabId === null ? null : await chrome.tabs.get(returnTabId).catch(() => null);
  await chrome.tabs.create(
    opener?.id === undefined ? { url } : { url, openerTabId: opener.id, windowId: opener.windowId, index: opener.index + 1 },
  );
}

// ──────────────────────────────── The hub ────────────────────────────────────

const hub = new CameraHub({
  ensureOffscreen,
  closeOffscreen,
  openSetup: (tabId) => {
    openSetup(tabId).catch((err: unknown) => console.warn('[gaze-reader] could not open setup page', err));
  },
  log: (...args) => console.info(...args),
});
hub.init();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_OFFSCREEN && port.sender?.url?.startsWith(chrome.runtime.getURL(OFFSCREEN_PAGE))) {
    hub.attachOffscreen(port);
  } else if (port.name === PORT_TAB && port.sender?.tab?.id !== undefined && port.sender.frameId === 0) {
    hub.attachTab(port, port.sender.tab.id);
  } else {
    port.disconnect();
  }
});

// ─────────────────────────────── Tab control ─────────────────────────────────

async function sendToPage(tabId: number, request: PageRequest): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
}

async function contentScriptPresent(tabId: number): Promise<boolean> {
  try {
    return (await sendToPage(tabId, { type: 'page-ping' })) === true;
  } catch {
    return false; // "Receiving end does not exist"
  }
}

async function queryPage(tabId: number): Promise<PageState> {
  try {
    const state = await sendToPage(tabId, { type: 'page-query' });
    return isPageState(state) ? state : PAGE_OFF;
  } catch {
    return PAGE_OFF;
  }
}

async function setTabEnabled(tabId: number, enabled: boolean): Promise<PageState> {
  if (!(await contentScriptPresent(tabId))) {
    if (!enabled) return PAGE_OFF;
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  }
  const state = await sendToPage(tabId, { type: 'page-set-enabled', enabled });
  const result = isPageState(state) ? state : PAGE_OFF;
  await setBadge(tabId, result.enabled);
  return result;
}

async function setBadge(tabId: number, on: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#C2410C' });
  } catch {
    /* the tab closed meanwhile */
  }
}

/** Turns a Chrome error into something a reader can act on. */
function friendlyInjectionError(err: unknown): string {
  const msg = errorMessage(err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|edge:\/\//i.test(msg)) {
    return "Chrome doesn't let extensions read along on this page.";
  }
  if (/file:\/\//i.test(msg) || /file access/i.test(msg)) {
    return 'To use Gaze Reader on local files, enable "Allow access to file URLs" for it in chrome://extensions.';
  }
  if (/permission|activeTab/i.test(msg)) {
    return 'Click the Gaze Reader button again to give it access to this page.';
  }
  return msg;
}

// ───────────────────────────── One-shot messages ─────────────────────────────

function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return (sender.url ?? '').startsWith(EXTENSION_ORIGIN);
}

async function handleRequest(msg: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  switch (msg.type) {
    case 'set-tab-enabled': {
      if (!fromExtensionPage(sender)) return { ok: false, error: 'Not allowed.' };
      let state: PageState;
      try {
        state = await setTabEnabled(msg.tabId, msg.enabled);
      } catch (err) {
        return { ok: false, error: friendlyInjectionError(err) };
      }
      // The content script ran but its session failed to start (details are in the page's console).
      if (msg.enabled && !state.enabled) return { ok: false, error: START_FAILED };
      return { ok: true, state };
    }
    case 'camera-permission-granted': {
      if (!fromExtensionPage(sender)) return { ok: false, error: 'Not allowed.' };
      hub.permissionGranted();
      return { ok: true };
    }
    case 'open-setup': {
      const returnTabId = fromExtensionPage(sender) ? (msg.returnTabId ?? null) : (sender.tab?.id ?? null);
      await openSetup(returnTabId);
      return { ok: true };
    }
    case 'page-status': {
      if (sender.tab?.id !== undefined && sender.frameId === 0) await setBadge(sender.tab.id, msg.enabled);
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isRuntimeRequest(msg)) return false;
  handleRequest(msg, sender).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: errorMessage(err) }));
  return true; // respond asynchronously
});

// ─────────────────────────── Keyboard command & badge ────────────────────────

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== TOGGLE_COMMAND || tab?.id === undefined) return;
  const tabId = tab.id;
  queryPage(tabId)
    .then((state) => setTabEnabled(tabId, !state.enabled))
    .catch((err: unknown) => console.info('[gaze-reader] toggle failed:', friendlyInjectionError(err)));
});

// Chrome resets a tab's own badge when it loads a new document. Single-page
// apps navigate without one (and report 'loading' anyway) while the content
// script and its session carry on, so never clear blindly: when a load
// finishes, ask the page whether it is still on.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') void refreshBadge(tabId);
});

async function refreshBadge(tabId: number): Promise<void> {
  let text: string;
  try {
    text = await chrome.action.getBadgeText({ tabId });
  } catch {
    return; // the tab is gone
  }
  if (!text) return;
  await setBadge(tabId, (await queryPage(tabId)).enabled);
}

// The setup page records a grant in storage too (content scripts watch it); mirror it here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && KEYS.cameraGrantedAt in changes) hub.permissionGranted();
});
