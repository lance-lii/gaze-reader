// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { weights } from './eyeNet.fixture';
import { checkEyeNet, EYE_NET_KEY, EYE_NET_MAX_BYTES, forgetStoredEyeNet, loadStoredEyeNet, storeEyeNet } from './eyeNetStore';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the eye-picture network kept in this browser', () => {
  it('starts with none', () => {
    expect(loadStoredEyeNet()).toBeNull();
  });

  it('keeps a network file and reads it back with its shape', () => {
    const result = storeEyeNet(JSON.stringify(weights()));
    expect(result.ok).toBe(true);
    const back = loadStoredEyeNet();
    expect(back?.shape).toEqual({ id: 'test-net', width: 12, height: 8, span: 1.7, extras: 5 });
    expect(back?.weights).toEqual(weights());
    forgetStoredEyeNet();
    expect(loadStoredEyeNet()).toBeNull();
  });

  it('keeps nothing, and leaves the network it had, when the file is not one', () => {
    expect(storeEyeNet(JSON.stringify(weights())).ok).toBe(true);
    for (const text of ['not json', '{}', JSON.stringify({ ...weights(), convs: [] }), JSON.stringify({ ...weights(), labelSd: [0.2] })]) {
      const result = storeEyeNet(text);
      expect(result.ok, text.slice(0, 30)).toBe(false);
      if (!result.ok) expect(result.problem.length).toBeGreaterThan(10);
    }
    expect(loadStoredEyeNet()?.shape.id).toBe('test-net');
  });

  it('does not read a file far larger than a network', () => {
    const result = storeEyeNet(' '.repeat(EYE_NET_MAX_BYTES + 1));
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('too large') });
  });

  it('says so when the browser has no room for it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const result = storeEyeNet(JSON.stringify(weights()));
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('no room') });
  });

  it('treats a stored network it can no longer read as none', () => {
    expect(storeEyeNet(JSON.stringify(weights())).ok).toBe(true);
    const key = Object.keys(localStorage).find((k) => k.includes(EYE_NET_KEY))!;
    localStorage.setItem(key, JSON.stringify({ id: 'old' }));
    expect(loadStoredEyeNet()).toBeNull();
  });

  it('describes a network without keeping it', () => {
    expect(checkEyeNet(weights({ id: 'other' }))?.shape.id).toBe('other');
    expect(checkEyeNet(null)).toBeNull();
    expect(loadStoredEyeNet()).toBeNull();
  });
});
