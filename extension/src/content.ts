/**
 * Content script entry, injected on demand by the service worker (never
 * declared in the manifest, so it only ever runs where the reader asked).
 *
 * Injection is idempotent: the first run registers a message listener and
 * leaves a marker on `window`; later injections into the same page are
 * no-ops. After the extension is reloaded the old copy is orphaned (it can
 * no longer reach the extension), so a fresh injection replaces it.
 */
import { chromeLocalStorage } from './extStorage';
import { PAGE_OFF, PORT_TAB, isPageRequest, type PageRequest, type PageState, type RuntimeRequest } from './messages';
import { PageSession } from './pageSession';
import { extensionContextValid } from './ports';

interface ContentHandle {
  /** False once this copy's extension context is gone. */
  isAlive(): boolean;
  /** Tear this copy down so a newer one can take over. */
  shutdown(): void;
}

declare global {
  interface Window {
    __gazeReaderExt?: ContentHandle;
  }
}

function install(): ContentHandle {
  let session: PageSession | null = null;
  let wanted = false;
  let queue: Promise<void> = Promise.resolve();
  let shutDown = false;

  const storage = chromeLocalStorage();

  const notifyServiceWorker = (enabled: boolean) => {
    if (!extensionContextValid()) return;
    const msg: RuntimeRequest = { type: 'page-status', enabled };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  };

  /** Brings the session in line with `wanted`. Serialized, so rapid on/off/on can't interleave. */
  const reconcile = (): Promise<void> => {
    queue = queue.then(async () => {
      if (wanted && !session && !shutDown) {
        try {
          session = await PageSession.start({
            storage,
            connectPort: () => chrome.runtime.connect({ name: PORT_TAB }),
            isContextValid: extensionContextValid,
            openSetup: () => {
              const msg: RuntimeRequest = { type: 'open-setup' };
              chrome.runtime.sendMessage(msg).catch(() => undefined);
            },
            onEnded: (reason) => {
              wanted = false;
              void reconcile();
              if (reason === 'orphaned') shutdown();
            },
          });
          notifyServiceWorker(true);
        } catch (err) {
          console.error('[gaze-reader] could not start on this page', err);
          wanted = false;
          notifyServiceWorker(false);
        }
      } else if ((!wanted || shutDown) && session) {
        session.destroy();
        session = null;
        notifyServiceWorker(false);
      }
    });
    return queue;
  };

  const stateNow = (): PageState => session?.state() ?? PAGE_OFF;

  const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (sender.id !== chrome.runtime.id || !isPageRequest(msg)) return false;
    const request: PageRequest = msg;
    switch (request.type) {
      case 'page-ping':
        sendResponse(true);
        return false;
      case 'page-query':
        sendResponse(stateNow());
        return false;
      case 'page-set-enabled':
        wanted = request.enabled;
        reconcile().then(
          () => sendResponse(stateNow()),
          () => sendResponse(stateNow()),
        );
        return true; // async response
      case 'page-command':
        session?.command(request.command);
        sendResponse(stateNow());
        return false;
    }
  };

  function shutdown(): void {
    if (shutDown) return;
    shutDown = true;
    wanted = false;
    void reconcile();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* context already gone */
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  // Check the runtime object *this* copy was born with: once its extension
  // context is invalidated, its id disappears, whatever `chrome` means later.
  const runtime = chrome.runtime;
  const isAlive = () => {
    try {
      return !shutDown && typeof runtime.id === 'string';
    } catch {
      return false;
    }
  };
  return { isAlive, shutdown };
}

const existing = window.__gazeReaderExt;
if (!existing || !existing.isAlive()) {
  existing?.shutdown();
  window.__gazeReaderExt = install();
}
