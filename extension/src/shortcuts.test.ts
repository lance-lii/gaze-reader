// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SHORTCUTS, isTypingContext, matchShortcut, type KeyLike } from './shortcuts';

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  altKey: true,
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe('matchShortcut', () => {
  it('maps Alt+Shift+<physical key> to actions', () => {
    expect(matchShortcut(key('KeyP'))).toBe('toggle-pause');
    expect(matchShortcut(key('ArrowDown'))).toBe('page-forward');
    expect(matchShortcut(key('PageUp'))).toBe('page-back');
    expect(matchShortcut(key('Slash'))).toBe('toggle-help');
  });

  it('ignores keys without exactly Alt+Shift, while composing, or unknown', () => {
    expect(matchShortcut(key('KeyP', { altKey: false }))).toBeNull();
    expect(matchShortcut(key('KeyP', { shiftKey: false }))).toBeNull();
    expect(matchShortcut(key('KeyP', { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key('KeyP', { metaKey: true }))).toBeNull();
    expect(matchShortcut(key('KeyP', { isComposing: true }))).toBeNull();
    expect(matchShortcut(key('KeyQ'))).toBeNull();
  });

  it('lets page turns auto-repeat but not toggles', () => {
    expect(matchShortcut(key('ArrowDown', { repeat: true }))).toBe('page-forward');
    expect(matchShortcut(key('KeyD', { repeat: true }))).toBeNull();
  });

  it('never binds the same key twice', () => {
    const codes = SHORTCUTS.flatMap((s) => s.codes);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('isTypingContext', () => {
  const fire = (target: EventTarget): boolean => {
    let typing = false;
    const listener = (e: Event) => {
      typing = isTypingContext(e);
    };
    window.addEventListener('keydown', listener, { capture: true });
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true }));
    window.removeEventListener('keydown', listener, { capture: true });
    return typing;
  };

  it('detects text fields, textareas, selects, contenteditable and ARIA textboxes', () => {
    document.body.innerHTML = `
      <input id="text"><input id="email" type="email"><input id="check" type="checkbox"><input id="btn" type="button">
      <textarea id="ta"></textarea><select id="sel"></select>
      <div contenteditable="true"><p id="inside-ce">hello</p></div>
      <div contenteditable="false" id="not-ce"></div>
      <div role="textbox" id="aria"></div>
      <p id="plain">text</p>`;
    const $ = (id: string) => document.getElementById(id)!;
    expect(fire($('text'))).toBe(true);
    expect(fire($('email'))).toBe(true);
    expect(fire($('ta'))).toBe(true);
    expect(fire($('sel'))).toBe(true);
    expect(fire($('inside-ce'))).toBe(true);
    expect(fire($('aria'))).toBe(true);
    expect(fire($('check'))).toBe(false);
    expect(fire($('btn'))).toBe(false);
    expect(fire($('not-ce'))).toBe(false);
    expect(fire($('plain'))).toBe(false);
    expect(fire(document.body)).toBe(false);
  });

  it('sees through open shadow roots (web-component editors)', () => {
    document.body.innerHTML = '<x-editor id="host"></x-editor>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<textarea id="inner"></textarea>';
    expect(fire(root.getElementById('inner')!)).toBe(true);
  });
});
