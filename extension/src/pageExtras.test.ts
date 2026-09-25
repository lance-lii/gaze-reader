import { describe, expect, it } from 'vitest';
import { PAGE_EXTRA_NONE, isPageExtraCommand, isPageExtraRequest, isPageExtraState } from './pageExtras';

describe('page extra messages', () => {
  it('accepts the requests the popup sends and nothing else', () => {
    expect(isPageExtraRequest({ type: 'page-extra-query' })).toBe(true);
    expect(isPageExtraRequest({ type: 'page-extra-command', command: 'check-accuracy' })).toBe(true);
    expect(isPageExtraRequest({ type: 'page-extra-command', command: 'touch-up' })).toBe(true);
    for (const bad of [null, 'page-extra-query', [], {}, { type: 'page-query' }, { type: 'page-extra-command' }, { type: 'page-extra-command', command: 'turn-off' }]) {
      expect(isPageExtraRequest(bad)).toBe(false);
    }
    expect(isPageExtraCommand('check-accuracy')).toBe(true);
    expect(isPageExtraCommand('recalibrate')).toBe(false);
  });

  it("validates the page's answer", () => {
    expect(isPageExtraState(PAGE_EXTRA_NONE)).toBe(true);
    const lit = { lighting: { flags: ['backlit', 'glare'], changedSinceCalibration: true, dominant: 'backlight' }, canCheck: true };
    expect(isPageExtraState(JSON.parse(JSON.stringify(lit)))).toBe(true);
    expect(isPageExtraState({ ...lit, lighting: { ...lit.lighting, dominant: null } })).toBe(true);
    expect(isPageExtraState({ ...lit, canCheck: 'yes' })).toBe(false);
    expect(isPageExtraState({ ...lit, lighting: { ...lit.lighting, flags: ['sunburn'] } })).toBe(false);
    expect(isPageExtraState({ ...lit, lighting: { ...lit.lighting, dominant: 'moon' } })).toBe(false);
    expect(isPageExtraState({ ...lit, lighting: { ...lit.lighting, changedSinceCalibration: 1 } })).toBe(false);
    expect(isPageExtraState({ canCheck: false })).toBe(false);
    expect(isPageExtraState(undefined)).toBe(false);
  });
});
