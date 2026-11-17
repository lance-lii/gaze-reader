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

  it('offers Cancel beside the busy note for work that can be stopped, and only then', () => {
    let cancelled = 0;
    // As the app does: cancelling gives the library back (the buttons it had disabled) at once.
    screen = new LibraryScreen({
      ...options(),
      onCancelOpen: () => {
        cancelled++;
        screen.setBusy(null);
      },
    });
    screen.mount(document.body);
    const cancel = screen.el.querySelector<HTMLButtonElement>('.gr-drop__busy-cancel')!;
    const label = screen.el.querySelector<HTMLElement>('.gr-drop__busy-label')!;
    screen.setBusy('Preparing your text…');
    expect(cancel.hidden).toBe(true);
    screen.setBusy('This PDF is scanned pages: reading their text, page 3 of 40…', true);
    expect(cancel.hidden).toBe(false);
    expect(cancel.disabled).toBe(false); // the other buttons are; this one is how to get out
    expect(label.textContent).toMatch(/page 3 of 40/);
    cancel.click();
    expect(cancelled).toBe(1);
    expect(cancel.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.el.querySelector('.gr-lib-choose')); // not dropped with the hidden button
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
