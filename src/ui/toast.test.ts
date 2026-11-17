// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from './toast';

const shown = (): string[] => [...document.querySelectorAll('.gr-toast:not([data-leaving])')].map((t) => t.querySelector('.gr-toast__message')!.textContent ?? '');

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('Toaster', () => {
  it('shows at most three; a fourth pushes out the oldest that isn’t waiting for the reader (regression: it pushed out the question)', () => {
    vi.useFakeTimers();
    const toasts = new Toaster();
    toasts.mount(document.body);
    toasts.show({ id: 'question', message: 'Couldn’t open that book', tone: 'error', durationMs: 0 }); // stays until dismissed
    toasts.show({ message: 'first passing note' });
    toasts.show({ message: 'second passing note' });
    toasts.show({ message: 'third passing note' });
    expect(shown()).toEqual(['Couldn’t open that book', 'second passing note', 'third passing note']);
    // When all that are left wait for the reader, the oldest of those goes after all.
    toasts.show({ id: 'q2', message: 'Another question', durationMs: 0 });
    toasts.show({ id: 'q3', message: 'A third question', durationMs: 0 });
    toasts.show({ id: 'q4', message: 'A fourth question', durationMs: 0 });
    expect(shown()).toEqual(['Another question', 'A third question', 'A fourth question']);
    toasts.destroy();
  });

  it('a new toast never pushes itself out, and one shown again under its id replaces the first', () => {
    vi.useFakeTimers();
    const toasts = new Toaster();
    toasts.mount(document.body);
    for (const m of ['a', 'b', 'c']) toasts.show({ id: m, message: m, durationMs: 0 });
    toasts.show({ message: 'passing' });
    expect(shown()).toContain('passing');
    expect(shown()).toHaveLength(3);
    toasts.show({ id: 'c', message: 'c again', durationMs: 0 });
    expect(shown().filter((m) => m.startsWith('c'))).toEqual(['c again']);
    toasts.destroy();
  });
});
