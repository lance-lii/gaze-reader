import './pages.css';
import './popup.css';
import type { AppSettings, Sensitivity } from '../../src/types';
import { createEventBus } from '../../src/core/events';
import { createSettingsStore } from '../../src/core/settings';
import {
  KEYS,
  chromeLocalStorage,
  clearCalibrationJSON,
  isPageTurnMethod,
  loadCalibrationJSON,
  loadExtSettings,
  loadSettings,
  makeOrigin,
  parseExtSettings,
  saveExtSettings,
  syncSettings,
  watchKey,
  type ExtSettings,
  type PageTurnMethod,
} from './extStorage';
import {
  PAGE_OFF,
  errorMessage,
  isPageState,
  isRuntimeResponse,
  type PageRequest,
  type PageState,
  type RuntimeRequest,
} from './messages';

const POLL_MS = 1_000;
/** How long "Click again to forget" waits for the second click. */
const FORGET_CONFIRM_MS = 4_000;

const SENSITIVITY_HINT: Record<Sensitivity, string> = {
  relaxed: 'Waits until you have clearly finished',
  balanced: 'Turns soon after your last line',
  eager: 'Turns the moment you reach the end',
};

const PAGE_TURN_HINT: Record<PageTurnMethod, string> = {
  auto: "Scrolls, or presses the next-page key on book readers that don't scroll",
  scroll: 'Always scrolls the page',
  keys: 'Presses → and Page Down for the page (some sites ignore it)',
};

/** Pages Chrome never lets extensions script. */
function restrictedReason(url: string): string | null {
  if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|chrome-search|chrome-untrusted|devtools|view-source):/i.test(url)) {
    return "Chrome doesn't let extensions read along on its own pages.";
  }
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) {
    return "Chrome doesn't let extensions run on the Web Store.";
  }
  return null;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup.html is missing #${id}`);
  return found as T;
}

function radios(name: string): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`));
}

async function main(): Promise<void> {
  const ui = {
    main: document.querySelector<HTMLElement>('main.popup'),
    enabled: el<HTMLInputElement>('enabled'),
    status: el<HTMLSpanElement>('status'),
    notice: el<HTMLParagraphElement>('notice'),
    calibration: el<HTMLParagraphElement>('calibration'),
    sensitivityHint: el<HTMLSpanElement>('sensitivity-hint'),
    pageTurnHint: el<HTMLSpanElement>('page-turn-hint'),
    buddy: el<HTMLInputElement>('buddy'),
    gazeDot: el<HTMLInputElement>('gaze-dot'),
    recalibrate: el<HTMLButtonElement>('recalibrate'),
    setup: el<HTMLButtonElement>('setup'),
  };

  const storage = chromeLocalStorage();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  const restricted = tab?.url ? restrictedReason(tab.url) : null;

  const bus = createEventBus();
  const store = createSettingsStore(bus, { persist: false, initial: await loadSettings(storage.area) });
  syncSettings({ bus, store, storage, origin: makeOrigin('popup') });

  let calibrated = (await loadCalibrationJSON(storage.area)) !== null;
  let ext: ExtSettings = await loadExtSettings(storage.area);
  let page: PageState = PAGE_OFF;
  let busy = false;
  /** Bumped by every on/off request, so a poll that was already in flight can't overwrite its answer. */
  let pageEpoch = 0;
  let notice: { text: string; tone: 'info' | 'error' } | null = restricted ? { text: restricted, tone: 'info' } : null;

  const patch = (p: Partial<AppSettings>) => bus.emit('settings-patch', p);

  // "Forget calibration" wipes it in every tab, with no undo: the first click only arms it.
  let forgetArmed = false;
  let forgetTimer: ReturnType<typeof setTimeout> | undefined;
  const disarmForget = (): void => {
    clearTimeout(forgetTimer);
    forgetArmed = false;
  };
  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'link';
  forget.addEventListener('click', () => {
    if (forgetArmed) {
      disarmForget();
      const hadFocus = document.activeElement === forget;
      void clearCalibrationJSON(storage.area).then(() => {
        calibrated = false;
        render();
        // The button just left the page; hand focus to the natural next step, not <body>.
        if (hadFocus && !ui.recalibrate.disabled) ui.recalibrate.focus();
      });
      return;
    }
    forgetArmed = true;
    forgetTimer = setTimeout(() => {
      forgetArmed = false;
      render();
    }, FORGET_CONFIRM_MS);
    render();
  });
  forget.addEventListener('blur', () => {
    if (!forgetArmed) return;
    disarmForget();
    render();
  });

  function render(): void {
    const s = store.get();
    const webcam = s.gazeSource === 'webcam';

    ui.enabled.checked = page.enabled;
    ui.enabled.disabled = busy || restricted !== null || tabId === undefined;
    const [tone, text] = describePage(page, restricted !== null);
    ui.status.dataset.tone = tone;
    ui.status.textContent = text;

    ui.notice.hidden = notice === null;
    ui.notice.textContent = notice?.text ?? '';
    ui.notice.dataset.tone = notice?.tone ?? 'info';

    for (const r of radios('source')) r.checked = r.value === (webcam ? 'webcam' : 'mouse');
    for (const r of radios('sensitivity')) r.checked = r.value === s.sensitivity;
    ui.sensitivityHint.textContent = SENSITIVITY_HINT[s.sensitivity];
    for (const r of radios('page-turn')) r.checked = r.value === ext.pageTurn;
    ui.pageTurnHint.textContent = PAGE_TURN_HINT[ext.pageTurn];
    ui.buddy.checked = s.buddyEnabled;
    ui.gazeDot.checked = s.showGazeDot;

    ui.calibration.hidden = !webcam;
    if (!calibrated && forgetArmed) disarmForget(); // cleared elsewhere: don't come back armed
    forget.textContent = forgetArmed ? 'Click again to forget' : 'Forget calibration';
    if (calibrated) {
      // Kept across polls (not rebuilt), so keyboard focus stays on the button.
      if (forget.parentElement !== ui.calibration) ui.calibration.replaceChildren('Calibrated on this computer. ', forget);
    } else {
      ui.calibration.replaceChildren("You'll do a one-minute calibration the first time.");
    }

    ui.recalibrate.disabled = busy || !webcam || restricted !== null || tabId === undefined;
    ui.main?.setAttribute('aria-busy', String(busy));
  }

  async function refreshPage(): Promise<void> {
    if (tabId === undefined || restricted || busy) return;
    const epoch = pageEpoch;
    const request: PageRequest = { type: 'page-query' };
    let next: PageState;
    try {
      const state: unknown = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
      next = isPageState(state) ? state : PAGE_OFF;
    } catch {
      next = PAGE_OFF; // no content script: Gaze Reader is off here
    }
    if (epoch !== pageEpoch || busy) return;
    page = next;
    render();
  }

  async function setEnabled(enabled: boolean): Promise<boolean> {
    if (tabId === undefined) return false;
    busy = true;
    pageEpoch++;
    render();
    let ok = false;
    try {
      const request: RuntimeRequest = { type: 'set-tab-enabled', tabId, enabled };
      const res: unknown = await chrome.runtime.sendMessage(request);
      if (!isRuntimeResponse(res)) throw new Error('Gaze Reader did not answer. Try again.');
      if (res.ok) {
        page = res.state ?? PAGE_OFF;
        notice = null;
        ok = true;
      } else {
        notice = { text: res.error, tone: 'error' };
      }
    } catch (err) {
      notice = { text: errorMessage(err), tone: 'error' };
    }
    busy = false;
    render();
    return ok;
  }

  ui.enabled.addEventListener('change', () => {
    const on = ui.enabled.checked;
    void setEnabled(on).then((ok) => {
      // First webcam run: calibration starts on the page, so get out of the way.
      if (ok && on && store.get().gazeSource === 'webcam' && !calibrated) setTimeout(() => window.close(), 350);
    });
  });
  for (const r of radios('source')) {
    r.addEventListener('change', () => r.checked && patch({ gazeSource: r.value === 'mouse' ? 'mouse' : 'webcam' }));
  }
  for (const r of radios('sensitivity')) {
    r.addEventListener('change', () => {
      if (r.checked && (r.value === 'relaxed' || r.value === 'balanced' || r.value === 'eager')) patch({ sensitivity: r.value });
    });
  }
  for (const r of radios('page-turn')) {
    r.addEventListener('change', () => {
      if (!r.checked || !isPageTurnMethod(r.value)) return;
      ext = { ...ext, pageTurn: r.value };
      render();
      void saveExtSettings(storage.area, ext);
    });
  }
  ui.buddy.addEventListener('change', () => patch({ buddyEnabled: ui.buddy.checked }));
  ui.gazeDot.addEventListener('change', () => patch({ showGazeDot: ui.gazeDot.checked }));

  ui.recalibrate.addEventListener('click', () => {
    void (async () => {
      if (tabId === undefined) return;
      if (!page.enabled && !(await setEnabled(true))) return;
      // A fresh session without a saved model calibrates on its own.
      if (calibrated || page.calibrated) {
        const request: PageRequest = { type: 'page-command', command: 'recalibrate' };
        await chrome.tabs.sendMessage(tabId, request, { frameId: 0 }).catch(() => undefined);
      }
      window.close();
    })();
  });

  ui.setup.addEventListener('click', () => {
    const request: RuntimeRequest = tabId === undefined ? { type: 'open-setup' } : { type: 'open-setup', returnTabId: tabId };
    void chrome.runtime.sendMessage(request).finally(() => window.close());
  });

  bus.on('settings-changed', render);
  watchKey(storage, KEYS.extSettings, (value) => {
    ext = parseExtSettings(value);
    render();
  });
  watchKey(storage, KEYS.calibration, (value) => {
    calibrated = value !== undefined && value !== null;
    render();
  });

  render();
  await refreshPage();
  setInterval(() => void refreshPage(), POLL_MS);
}

function describePage(page: PageState, restricted: boolean): ['ok' | 'warn' | 'err' | 'off', string] {
  if (restricted) return ['off', 'Not available on this page'];
  if (!page.enabled) return ['off', 'Off'];
  const mouse = page.source === 'mouse';
  switch (page.tracking) {
    case 'starting':
      return ['warn', page.detail ?? (mouse ? 'Starting…' : 'Waking up the camera…')];
    case 'calibrating':
      return ['warn', 'Calibrating…'];
    case 'tracking':
      // Page mode: no text lines to follow here, so the bottom edge turns the page.
      if (page.pageMode) return ['ok', mouse ? 'Following your mouse · page mode' : 'Reading along · page mode'];
      if (mouse) return ['ok', 'Following your mouse'];
      return ['ok', page.fps ? `Reading along · ${Math.round(page.fps)} fps` : 'Reading along'];
    case 'no-face':
      return ['warn', mouse ? 'Point at the page' : "Can't see your eyes"];
    case 'poor':
      return ['warn', 'Tracking is shaky: try more light'];
    case 'paused':
      return ['off', page.detail ?? 'Auto-scroll paused'];
    case 'error':
      return ['err', page.detail ?? 'Camera problem'];
    case 'off':
      return ['off', 'Off'];
  }
}

main().catch((err: unknown) => {
  console.error('[gaze-reader] popup failed', err);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Something went wrong. Close and reopen this popup.';
});
