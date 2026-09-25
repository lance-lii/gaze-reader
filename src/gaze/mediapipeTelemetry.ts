/**
 * MediaPipe Tasks (1.0.x) attaches a usage logger to every task it builds. Every
 * 60 s, and again on close(), it POSTs task type, running mode, library version
 * and inference timing to Google's ODML logging endpoint, and it has no opt-out.
 * Gaze Reader promises that only the model download leaves the device, so this
 * guard wraps `fetch` and refuses any request to that endpoint before it is sent.
 *
 * The library looks up the global `fetch` when it flushes, so installing the guard
 * before the first landmarker is built is enough. A refused send makes the logger
 * set its error flag, clear its interval and drop its queue; it does not retry.
 */

export const MEDIAPIPE_LOG_URL_PREFIX = 'https://odml.pa.googleapis.com/';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const GUARDED = Symbol.for('gazeReader.mediapipeTelemetryBlocked');

type Guarded = FetchFn & { [GUARDED]?: true };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Wraps `target.fetch` (once) so requests to MediaPipe's usage-logging endpoint are refused. */
export function blockMediapipeTelemetry(target: { fetch: typeof fetch } = globalThis): void {
  const current = target.fetch as Guarded | undefined;
  if (typeof current !== 'function' || current[GUARDED]) return;
  const real: FetchFn = current.bind(target);
  const guarded: Guarded = (input, init) => {
    let url: string;
    try {
      url = requestUrl(input);
    } catch {
      return real(input, init);
    }
    if (typeof url === 'string' && url.startsWith(MEDIAPIPE_LOG_URL_PREFIX)) {
      return Promise.reject(new TypeError('MediaPipe usage logging is disabled'));
    }
    return real(input, init);
  };
  guarded[GUARDED] = true;
  target.fetch = guarded as typeof fetch;
}
