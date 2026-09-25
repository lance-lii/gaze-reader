import './styles/app.css';
import { AppController } from './app/controller';
import { errorMessage, isBenignGlobalError } from './app/logic';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) {
    console.error('[gaze-reader] #app element not found');
    return;
  }

  const app = new AppController(root);

  // Last-resort handlers: log, then tell the reader kindly (the controller dedupes).
  const ac = new AbortController();
  window.addEventListener(
    'error',
    (e) => {
      const message = errorMessage(e.error ?? e.message, '');
      if (!message || isBenignGlobalError(message, e.filename)) return;
      app.reportError('uncaught', message);
    },
    { signal: ac.signal },
  );
  window.addEventListener(
    'unhandledrejection',
    (e) => {
      const message = errorMessage(e.reason, '');
      if (!message || isBenignGlobalError(message)) return;
      app.reportError('unhandled-rejection', message);
    },
    { signal: ac.signal },
  );

  app.start().catch((err: unknown) => {
    console.error('[gaze-reader] failed to start', err);
    app.reportError('startup', errorMessage(err));
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      ac.abort();
      app.destroy();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
