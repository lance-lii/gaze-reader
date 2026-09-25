// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryScreen, type LibraryEntry, type LibraryScreenOptions } from './libraryScreen';

function options(): LibraryScreenOptions {
  return {
    onOpenFile: vi.fn(),
    onOpenText: vi.fn(),
    onOpenUrl: vi.fn(),
    onOpenSample: vi.fn(),
    onOpenBook: vi.fn(),
    onDeleteBook: vi.fn(),
    onRetrySamples: vi.fn(),
    onCommand: vi.fn(),
  };
}

const entry = (id: string, lastReadAt: number): LibraryEntry => ({
  id,
  title: `Book ${id}`,
  author: null,
  wordCount: 1000,
  format: 'txt',
  addedAt: 0,
  fraction: 0.2,
  lastReadAt,
});

describe('LibraryScreen', () => {
  let screen: LibraryScreen;

  afterEach(() => {
    screen?.el.remove();
  });

  function mount(): LibraryScreen {
    screen = new LibraryScreen(options());
    screen.mount(document.body);
    return screen;
  }

  it('explains a failed URL open next to the form, marks the field invalid, and clears it on edit', () => {
    const s = mount();
    const form = s.el.querySelector<HTMLFormElement>('.gr-inline-form:last-of-type')!;
    const input = form.querySelector('input')!;
    const error = form.querySelector<HTMLElement>('.gr-field__error')!;
    s.showOpenError('url', 'Blocked by CORS.');
    expect(error.textContent).toBe('Blocked by CORS.');
    expect(error.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(error.id).not.toBe('');
    input.value = 'https://example.org/b.epub';
    input.dispatchEvent(new Event('input'));
    expect(error.textContent).toBe('');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows a failed file open in the drop zone until the next open starts', () => {
    const s = mount();
    s.showOpenError('file', 'This file isn’t a readable EPUB.');
    const error = s.el.querySelector<HTMLElement>('.gr-drop .gr-field__error')!;
    expect(error.textContent).toMatch(/readable EPUB/);
    s.setBusy('Opening…');
    expect(error.textContent).toBe('');
  });

  it('marks the paste box invalid and resetForms clears every error', () => {
    const s = mount();
    s.showOpenError('paste', 'Nothing readable in there.');
    s.showOpenError('file', 'Damaged.');
    const area = s.el.querySelector('textarea')!;
    expect(area.getAttribute('aria-invalid')).toBe('true');
    s.resetForms();
    expect(area.hasAttribute('aria-invalid')).toBe(false);
    for (const e of s.el.querySelectorAll('.gr-field__error')) expect(e.textContent).toBe('');
  });

  it('focusRecent keeps focus in the list (clamped) and falls back to the primary action', () => {
    const s = mount();
    s.setRecent([entry('a', 3), entry('b', 2), entry('c', 1)]);
    const cards = () => [...s.el.querySelectorAll<HTMLElement>('.gr-cards--recent .gr-card__main')];
    s.focusRecent(1);
    expect(document.activeElement).toBe(cards()[1]);
    s.focusRecent(7);
    expect(document.activeElement).toBe(cards()[2]);
    s.setRecent([]);
    s.focusRecent(0);
    expect(document.activeElement).toBe(s.el.querySelector('.gr-lib-choose'));
  });
});
