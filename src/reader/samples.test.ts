// @vitest-environment jsdom
/**
 * The bundled sample books (public/samples) through the real loader: the index
 * parses, every book renders to clean chapters, and no Markdown leaks through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSampleBooks, loadSampleBook } from './bookLoader';
import story from '../../public/samples/dewey-and-the-midnight-library.md?raw';
import index from '../../public/samples/index.json?raw';
import guide from '../../public/samples/secret-life-of-reading-eyes.md?raw';

/** What the static server serves under samples/. */
const FILES: Readonly<Record<string, string>> = {
  'index.json': index,
  'secret-life-of-reading-eyes.md': guide,
  'dewey-and-the-midnight-library.md': story,
};

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = FILES[new URL(href).pathname.split('/samples/')[1] ?? ''];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sample books', () => {
  it('lists both samples with every field filled in', async () => {
    const samples = await listSampleBooks();
    expect(samples.map((s) => s.id)).toEqual(['reading-eyes', 'midnight-library']);
    for (const s of samples) {
      for (const field of [s.title, s.author, s.blurb, s.file]) expect(field.trim().length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['reading-eyes', 7],
    ['midnight-library', 6],
  ])('%s loads as clean, numbered chapters', async (id, chapters) => {
    const book = await loadSampleBook(id);
    expect(book).toMatchObject({ id: `sample-${id}`, format: 'sample', source: 'sample', author: 'Gaze Reader Press' });
    expect(book.chapters).toHaveLength(chapters);
    book.chapters.forEach((c, i) => expect(c.title).toMatch(new RegExp(`^Chapter ${i + 1}: \\S`)));
    expect(book.wordCount).toBeGreaterThan(3500); // enough for many page turns

    const root = document.createElement('div');
    root.innerHTML = book.chapters.map((c) => c.html).join('');
    const tags = new Set([...root.querySelectorAll('*')].map((el) => el.localName));
    for (const tag of tags) expect(['h1', 'h2', 'p', 'em', 'blockquote', 'hr']).toContain(tag);
    expect(root.querySelectorAll('h1')).toHaveLength(chapters);
    // Nothing of the Markdown source survives as text, and the typography is curly.
    const text = root.textContent ?? '';
    expect(text).not.toMatch(/[*#<>_`]/);
    expect(text).not.toMatch(/"/);
  });
});
