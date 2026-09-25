import { describe, expect, it, vi } from 'vitest';
import { blockMediapipeTelemetry, MEDIAPIPE_LOG_URL_PREFIX } from './mediapipeTelemetry';

const LOG_URL = 'https://odml.pa.googleapis.com/v1/log';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

function fakeTarget() {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const real = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return Promise.resolve(new Response('ok'));
  });
  const target = { fetch: real as unknown as typeof fetch };
  return { target, real, calls };
}

describe('blockMediapipeTelemetry', () => {
  it('uses the logging endpoint prefix MediaPipe posts to', () => {
    expect(LOG_URL.startsWith(MEDIAPIPE_LOG_URL_PREFIX)).toBe(true);
  });

  it('refuses string, URL and Request inputs to the logging endpoint without calling fetch', async () => {
    const { target, real } = fakeTarget();
    blockMediapipeTelemetry(target);
    const init: RequestInit = { method: 'POST', body: '{}' };
    await expect(target.fetch(LOG_URL, init)).rejects.toBeInstanceOf(TypeError);
    await expect(target.fetch(new URL(LOG_URL), init)).rejects.toBeInstanceOf(TypeError);
    await expect(target.fetch(new Request(LOG_URL, init))).rejects.toBeInstanceOf(TypeError);
    expect(real).not.toHaveBeenCalled();
  });

  it('passes the model URL and other requests through with the same init', async () => {
    const { target, calls } = fakeTarget();
    blockMediapipeTelemetry(target);
    const init: RequestInit = { method: 'GET', cache: 'force-cache' };
    const res = await target.fetch(MODEL_URL, init);
    expect(await res.text()).toBe('ok');
    await target.fetch('./samples/index.json');
    const url = new URL('https://example.com/book.epub');
    await target.fetch(url);
    expect(calls).toEqual([
      [MODEL_URL, init],
      ['./samples/index.json', undefined],
      [url, undefined],
    ]);
  });

  it('wraps only once', async () => {
    const { target, real } = fakeTarget();
    blockMediapipeTelemetry(target);
    const once = target.fetch;
    blockMediapipeTelemetry(target);
    expect(target.fetch).toBe(once);
    await target.fetch(MODEL_URL);
    expect(real).toHaveBeenCalledTimes(1);
  });
});
