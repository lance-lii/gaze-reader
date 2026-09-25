/**
 * Camera setup page. Offscreen documents can't show permission prompts, so the
 * extension's camera permission is granted here, in a normal tab: explain
 * why, check the current state, call getUserMedia once, stop the stream
 * straight away, and tell the rest of the extension it may retry.
 */
import './pages.css';
import './setup.css';
import type { BuddyMood } from '../../src/types';
import { createEventBus } from '../../src/core/events';
import { KEYS, chromeLocalStorage, loadSettings } from './extStorage';
import { errorMessage, type RuntimeRequest } from './messages';

type View = 'checking' | 'prompt' | 'requesting' | 'granted' | 'denied' | 'no-camera' | 'error';

/**
 * A one-time grant ("Allow this time") ends when this tab closes, before the
 * offscreen document ever opens the camera, so steer readers to the lasting one.
 */
const ALLOW_HINT =
  'Pick “Allow while visiting the site” (just “Allow” in some versions of Chrome). “Allow this time” would run out as soon as this tab closes.';

interface Dewey {
  say(text: string, opts?: { mood?: BuddyMood; priority?: 'low' | 'normal' | 'high' }): void;
  setMood(mood: BuddyMood): void;
}

const storage = chromeLocalStorage();
const returnTabId = parseTabId(new URLSearchParams(location.search).get('return'));

const ui = {
  panel: byId('panel'),
  text: byId('panel-text'),
  allow: byId<HTMLButtonElement>('allow'),
  back: byId<HTMLButtonElement>('back'),
  settings: byId<HTMLButtonElement>('settings'),
  retry: byId<HTMLButtonElement>('retry'),
};

let dewey: Dewey | null = null;
let watching: PermissionStatus | null = null;
let announcedGrant = false;

ui.allow.addEventListener('click', () => void requestCamera());
ui.retry.addEventListener('click', () => void check());
ui.back.addEventListener('click', () => void backToPage());
ui.settings.addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}` });
});

void mountDewey();
void check();

// ─────────────────────────────── permission flow ─────────────────────────────

async function check(): Promise<void> {
  show('checking');
  const status = await permissionStatus();
  if (status && status !== watching) {
    watching = status;
    // The reader may flip the permission in Chrome's settings while this page is open.
    status.addEventListener('change', () => void onPermissionState(status.state));
  }
  if (!status) {
    show('prompt'); // can't tell: let the button find out
    return;
  }
  await onPermissionState(status.state);
}

async function onPermissionState(state: PermissionState): Promise<void> {
  if (state === 'granted') await granted();
  else if (state === 'denied') show('denied');
  else show('prompt');
}

async function requestCamera(): Promise<void> {
  show('requesting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    // We only needed the permission; the offscreen document opens the camera when a page asks.
    for (const track of stream.getTracks()) track.stop();
    await granted();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    const state = (await permissionStatus())?.state;
    if (state === 'granted') {
      // Permission is fine; the device itself is busy or missing.
      await granted(name === 'NotReadableError' ? 'Note: another app seems to be using the camera right now.' : undefined);
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      show('no-camera');
    } else if (state === 'denied') {
      show('denied');
    } else if (name === 'NotAllowedError') {
      show('prompt', 'No problem. Click “Allow camera” whenever you’re ready.');
    } else {
      show('error', errorMessage(err));
    }
  }
}

async function granted(note?: string): Promise<void> {
  show('granted', note);
  if (announcedGrant) return;
  announcedGrant = true;
  // Tabs waiting for the camera watch this key; the service worker gets a direct nudge too.
  await storage.area.set({ [KEYS.cameraGrantedAt]: Date.now() }).catch(() => undefined);
  const msg: RuntimeRequest = { type: 'camera-permission-granted' };
  await chrome.runtime.sendMessage(msg).catch(() => undefined);
  dewey?.setMood('celebrating');
  dewey?.say('Wonderful! Now I can see where you’re reading.', { mood: 'celebrating', priority: 'high' });
}

async function permissionStatus(): Promise<PermissionStatus | null> {
  try {
    return await navigator.permissions.query({ name: 'camera' });
  } catch {
    return null;
  }
}

// ────────────────────────────────── view ─────────────────────────────────────

function show(view: View, detail?: string): void {
  ui.panel.dataset.state = view;
  const back = returnTabId !== null ? 'Back to my page' : 'Close this tab';
  const visible = new Set<HTMLButtonElement>();
  let title = '';
  let body = '';
  switch (view) {
    case 'checking':
      body = 'Checking camera permission…';
      break;
    case 'prompt':
      title = 'One click to go.';
      body = detail ?? `Chrome will ask whether Gaze Reader may use your camera. ${ALLOW_HINT}`;
      visible.add(ui.allow);
      break;
    case 'requesting':
      title = 'Look up near the address bar.';
      body = `Chrome is asking for permission. ${ALLOW_HINT}`;
      break;
    case 'granted':
      title = 'All set!';
      body =
        (returnTabId !== null
          ? 'Head back to your page: Gaze Reader starts the camera and a quick calibration.'
          : 'Turn Gaze Reader on from the toolbar button on any page you want to read.') + (detail ? ` ${detail}` : '');
      visible.add(ui.back);
      ui.back.textContent = back;
      break;
    case 'denied':
      title = 'The camera is blocked for Gaze Reader.';
      body =
        'Open Chrome’s camera settings for Gaze Reader and set Camera to “Allow”, then come back here. Or read with the mouse instead: pick “Mouse” in the toolbar popup.';
      visible.add(ui.settings).add(ui.retry);
      break;
    case 'no-camera':
      title = 'No camera found.';
      body = 'Connect a webcam and check again, or read with the mouse instead.';
      visible.add(ui.retry);
      break;
    case 'error':
      title = 'Something went wrong.';
      body = detail ?? 'Please try again.';
      visible.add(ui.allow).add(ui.retry);
      break;
  }
  ui.text.replaceChildren();
  if (title) {
    const strong = document.createElement('strong');
    strong.textContent = title;
    ui.text.append(strong);
  }
  ui.text.append(body);
  for (const b of [ui.allow, ui.back, ui.settings, ui.retry]) b.hidden = !visible.has(b);
  if (view === 'denied') dewey?.setMood('worried');
}

async function backToPage(): Promise<void> {
  try {
    if (returnTabId !== null) {
      const tab = await chrome.tabs.update(returnTabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    }
    const me = await chrome.tabs.getCurrent();
    if (me?.id !== undefined) await chrome.tabs.remove(me.id);
  } catch {
    show('granted', 'That tab seems to be closed. Open any page and turn Gaze Reader on from the toolbar.');
  }
}

// ───────────────────────────────── Dewey ─────────────────────────────────────

/** Dewey is a nice-to-have here: loaded lazily, and the page works fine without him. */
async function mountDewey(): Promise<void> {
  try {
    const settings = await loadSettings(storage.area);
    if (!settings.buddyEnabled) return;
    const { Buddy } = await import('../../src/buddy/buddy');
    const buddy = new Buddy({ bus: createEventBus(), getSettings: () => settings });
    buddy.mount(document.body);
    dewey = buddy;
    if (ui.panel.dataset.state === 'granted') {
      buddy.say('All set! Let’s go read something.', { mood: 'happy', priority: 'high' });
    } else {
      buddy.say('Hi, I’m Dewey! Once the camera is on, I’ll read along with you.', { mood: 'happy', priority: 'high' });
    }
  } catch (err) {
    console.info('[gaze-reader] Dewey is taking a break on this page', err);
  }
}

// ──────────────────────────────── helpers ────────────────────────────────────

function parseTabId(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`setup.html is missing #${id}`);
  return found as T;
}
