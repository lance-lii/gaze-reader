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

/**
 * The guard matches one URL prefix and wraps one transport (`fetch`). That is right for the
 * MediaPipe version this project ships; whether it is still right after an upgrade is a question
 * for whoever upgrades, and this test is what asks it: it reads the installed library and fails
 * when it could reach the network in any way the guard doesn't cover.
 */
describe('the installed MediaPipe bundle (what the guard has to cover)', () => {
  interface FsLike {
    readFileSync(path: URL, encoding: 'utf8'): string;
    readdirSync(path: URL): string[];
  }
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as FsLike | undefined;
  if (!fs) throw new Error('This test needs Node 22.3+ (process.getBuiltinModule).');
  const root = new URL('../../node_modules/@mediapipe/tasks-vision/', import.meta.url);
  const read = (name: string): string => fs.readFileSync(new URL(name, root), 'utf8');
  const urlsIn = (code: string): string[] => [...new Set(code.match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+/g) ?? [])];

  it('is the version the guard was written for', () => {
    // Upgrading? Read what the new bundle sends and where (the tests below help), update the
    // guard if needed, and then this number and the pinned version in package.json.
    expect((JSON.parse(read('package.json')) as { version: string }).version).toBe('1.0.1');
  });

  it('names no address but the logging endpoint the guard refuses, and uses no transport but fetch', () => {
    for (const bundle of ['vision_bundle.mjs', 'vision_bundle.cjs', 'vision_bundle.js']) {
      const code = read(bundle);
      const urls = urlsIn(code);
      expect(urls.length, bundle).toBeGreaterThan(0); // the logger is still there: the guard is still needed
      for (const url of urls) expect(url.startsWith(MEDIAPIPE_LOG_URL_PREFIX), `${bundle}: ${url}`).toBe(true);
      for (const transport of ['sendBeacon', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection']) {
        expect(code.includes(transport), `${bundle} uses ${transport}`).toBe(false);
      }
    }
  });

  it('the WebAssembly loaders open no connection of their own', () => {
    const loaders = fs.readdirSync(new URL('wasm/', root)).filter((f) => f.endsWith('.js'));
    expect(loaders.length).toBeGreaterThan(0);
    for (const loader of loaders) {
      const code = read(`wasm/${loader}`);
      // (Emscripten's XMLHttpRequest paths load the .wasm file from where the app serves it.)
      for (const transport of ['sendBeacon', 'WebSocket', 'EventSource', 'RTCPeerConnection']) {
        expect(code.includes(transport), `${loader} uses ${transport}`).toBe(false);
      }
      expect(code.includes('googleapis.com'), `${loader} names a Google endpoint`).toBe(false);
    }
  });
});
