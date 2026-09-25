import './pages.css';
import './popup.css';
import type { AppSettings, Sensitivity } from '../../src/types';
import { createEventBus } from '../../src/core/events';
import { createSettingsStore } from '../../src/core/settings';
import {
  KEYS,
  chromeLocalStorage,
  clearCalibrationJSON,
  loadCalibrationJSON,
  loadSettings,
  makeOrigin,
  syncSettings,
  watchKey,
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

const SENSITIVITY_HINT: Record<Sensitivity, string> = {
  relaxed: 'Waits until you have clearly finished',
  balanced: 'Turns soon after your last line',
  eager: 'Turns the moment you reach the end',
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
  let page: PageState = PAGE_OFF;
  let busy = false;
  let notice: { text: string; tone: 'info' | 'error' } | null = restricted ? { text: restricted, tone: 'info' } : null;

  const patch = (p: Partial<AppSettings>) => bus.emit('settings-patch', p);

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
    ui.buddy.checked = s.buddyEnabled;
    ui.gazeDot.checked = s.showGazeDot;

    ui.calibration.hidden = !webcam;
    ui.calibration.replaceChildren();
    if (calibrated) {
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'link';
      forget.textContent = 'Forget it';
      forget.addEventListener('click', () => {
        void clearCalibrationJSON(storage.area).then(() => {
          calibrated = false;
          render();
        });
      });
      ui.calibration.append('Calibrated on this computer. ', forget);
    } else {
      ui.calibration.append("You'll do a 30-second calibration the first time.");
    }

    ui.recalibrate.disabled = busy || !webcam || restricted !== null || tabId === undefined;
    ui.main?.setAttribute('aria-busy', String(busy));
  }

  async function refreshPage(): Promise<void> {
    if (tabId === undefined || restricted || busy) return;
    const request: PageRequest = { type: 'page-query' };
    try {
      const state: unknown = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
      page = isPageState(state) ? state : PAGE_OFF;
    } catch {
      page = PAGE_OFF; // no content script: Gaze Reader is off here
    }
    render();
  }

  async function setEnabled(enabled: boolean): Promise<boolean> {
    if (tabId === undefined) return false;
    busy = true;
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
