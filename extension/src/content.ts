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
import { PAGE_EXTRA_NONE, isPageExtraRequest, type PageExtraState } from './pageExtras';
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

  // The runtime *this* copy was born with. After an extension reload its id
  // disappears, whatever the global `chrome` refers to by then.
  const runtime = chrome.runtime;
  const storage = chromeLocalStorage();

  /** Fire-and-forget. sendMessage throws synchronously once the extension context is gone. */
  const tell = (msg: RuntimeRequest) => {
    if (!extensionContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch {
      /* extension reloaded mid-call */
    }
  };
  const notifyServiceWorker = (enabled: boolean) => tell({ type: 'page-status', enabled });

  /** Brings the session in line with `wanted`. Serialized, so rapid on/off/on can't interleave. */
  const reconcile = (): Promise<void> => {
    queue = queue.then(async () => {
      if (wanted && !session && !shutDown) {
        try {
          session = await PageSession.start({
            storage,
            connectPort: () => chrome.runtime.connect({ name: PORT_TAB }),
            isContextValid: extensionContextValid,
            openSetup: () => tell({ type: 'open-setup' }),
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
  const extraNow = (): PageExtraState => session?.extraState() ?? PAGE_EXTRA_NONE;

  const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (isPageExtraRequest(msg)) {
      // The accuracy check and the quick refresh (popup), and what the page knows about the light.
      if (msg.type === 'page-extra-command') session?.command(msg.command);
      sendResponse(extraNow());
      return false;
    }
    if (!isPageRequest(msg)) return false;
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

  // Coming back from the back/forward cache counts as a navigation, which
  // clears the toolbar badge, but this page's session is still running.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted && session) notifyServiceWorker(true);
  };

  function shutdown(): void {
    if (shutDown) return;
    shutDown = true;
    wanted = false;
    void reconcile();
    window.removeEventListener('pageshow', onPageShow);
    try {
      runtime.onMessage.removeListener(onMessage);
    } catch {
      /* context already gone */
    }
  }

  runtime.onMessage.addListener(onMessage);
  window.addEventListener('pageshow', onPageShow);
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
