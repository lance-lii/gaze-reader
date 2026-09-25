import { IGNORE_ATTR, Z } from '../core/constants';
import type { BookFormat, CommandName, Mountable } from '../types';
import { formatMinutes, formatPercent, minutesLeft, normalizeUrl, relativeTime, TYPICAL_WPM } from '../app/logic';
import { icon } from './topbar';

/** A saved book as listed by `listBooks()` in src/reader/library.ts. */
export interface LibraryEntry {
  id: string;
  title: string;
  author: string | null;
  wordCount: number;
  format: BookFormat;
  addedAt: number;
  fraction: number;
  lastReadAt: number | null;
}

/** A bundled sample book (SampleBookInfo from src/reader/bookLoader.ts). */
export interface SampleEntry {
  id: string;
  title: string;
  author: string;
  blurb: string;
}

export type SamplesState =
  | { status: 'loading' }
  | { status: 'ready'; samples: readonly SampleEntry[] }
  | { status: 'error'; message: string };

export interface LibraryScreenOptions {
  onOpenFile(file: File): void;
  onOpenText(text: string, title: string | null): void;
  onOpenUrl(url: string): void;
  onOpenSample(id: string): void;
  onOpenBook(id: string): void;
  onDeleteBook(id: string, title: string): void;
  onRetrySamples(): void;
  onCommand(name: CommandName): void;
}

const ACCEPT = '.txt,.md,.markdown,.html,.htm,.xhtml,.epub,.pdf,text/plain,text/markdown,text/html,application/epub+zip,application/pdf';

const FORMAT_LABEL: Record<BookFormat, string> = {
  txt: 'Text',
  md: 'Markdown',
  html: 'HTML',
  epub: 'EPUB',
  pdf: 'PDF',
  sample: 'Sample',
};

/** Stable pleasant hue for generated covers. */
function hueFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function initialOf(title: string): string {
  const m = /[\p{L}\p{N}]/u.exec(title);
  return m ? m[0].toUpperCase() : '·';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

let libSeq = 0;

/** The home screen: a friendly hero, ways to open a book, recent books and samples. */
export class LibraryScreen implements Mountable {
  readonly el: HTMLElement;
  private readonly opts: LibraryScreenOptions;
  private readonly ac = new AbortController();
  private readonly ui: {
    drop: HTMLElement;
    fileInput: HTMLInputElement;
    choose: HTMLButtonElement;
    pasteToggle: HTMLButtonElement;
    urlToggle: HTMLButtonElement;
    pasteForm: HTMLFormElement;
    urlForm: HTMLFormElement;
    pasteText: HTMLTextAreaElement;
    pasteTitle: HTMLInputElement;
    urlInput: HTMLInputElement;
    pasteError: HTMLElement;
    urlError: HTMLElement;
    busy: HTMLElement;
    busyLabel: HTMLElement;
    recentSection: HTMLElement;
    recentList: HTMLElement;
    samplesList: HTMLElement;
    samplesStatus: HTMLElement;
  };

  constructor(opts: LibraryScreenOptions) {
    this.opts = opts;
    const uid = `gr-lib-${++libSeq}`;
    const root = el('main', 'gr-library');
    root.setAttribute(IGNORE_ATTR, '');
    root.style.zIndex = String(Z.reader);
    root.innerHTML = `
      <header class="gr-lib-header">
        <span class="gr-brand">${icon('glasses', 'gr-brand__mark')}<span>Gaze Reader</span></span>
        <nav class="gr-lib-header__nav" aria-label="App">
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon" data-cmd="show-help" aria-label="Help and shortcuts" title="Help (?)">${icon('help')}</button>
          <button type="button" class="gr-btn gr-btn--ghost gr-btn--icon" data-cmd="open-settings" aria-label="Settings" title="Settings (S)">${icon('settings')}</button>
        </nav>
      </header>

      <div class="gr-lib-top">
        <section class="gr-hero" aria-labelledby="${uid}-hero">
          <p class="gr-hero__kicker">${icon('eye')}<span>Hands-free reading</span></p>
          <h1 class="gr-hero__title" id="${uid}-hero">Your eyes turn the page.</h1>
          <p class="gr-hero__lead">Gaze Reader follows your eyes with your webcam and turns the page when you reach the bottom. Dewey, the little fellow in the corner, reads along.</p>
          <p class="gr-privacy-note">${icon('shield')}<span>Everything runs on this device. Video never leaves your browser.</span></p>
        </section>

        <section class="gr-open" aria-labelledby="${uid}-open">
          <h2 class="gr-sr-only" id="${uid}-open">Open a book</h2>
          <div class="gr-drop">
            <span class="gr-drop__icon">${icon('upload')}</span>
            <p class="gr-drop__title">Drop a book here</p>
            <p class="gr-drop__formats">EPUB, PDF, plain text, Markdown or HTML</p>
            <div class="gr-drop__actions">
              <button type="button" class="gr-btn gr-btn--primary gr-lib-choose">${icon('book')}<span>Choose a file</span></button>
              <button type="button" class="gr-btn gr-btn--soft gr-lib-paste-toggle" aria-expanded="false" aria-controls="${uid}-paste">${icon('paste')}<span>Paste text</span></button>
              <button type="button" class="gr-btn gr-btn--soft gr-lib-url-toggle" aria-expanded="false" aria-controls="${uid}-url">${icon('link')}<span>Open from URL</span></button>
            </div>
            <input type="file" class="gr-sr-only" tabindex="-1" aria-hidden="true" accept="${ACCEPT}" />
            <div class="gr-drop__busy" hidden><span class="gr-spinner" aria-hidden="true"></span><span class="gr-drop__busy-label" role="status" aria-live="polite"></span></div>
          </div>

          <form class="gr-inline-form" id="${uid}-paste" hidden novalidate>
            <label class="gr-field">
              <span class="gr-field__label">Title <small>(optional)</small></span>
              <input type="text" class="gr-input" name="title" autocomplete="off" maxlength="200" />
            </label>
            <label class="gr-field">
              <span class="gr-field__label">Text</span>
              <textarea class="gr-input gr-input--area" name="text" rows="7" placeholder="Paste an article, a chapter, or your own writing."></textarea>
            </label>
            <p class="gr-field__error" role="alert"></p>
            <div class="gr-inline-form__actions">
              <button type="submit" class="gr-btn gr-btn--primary">Start reading</button>
              <button type="button" class="gr-btn gr-btn--ghost" data-cancel>Cancel</button>
            </div>
          </form>

          <form class="gr-inline-form" id="${uid}-url" hidden novalidate>
            <label class="gr-field">
              <span class="gr-field__label">Web address of a book or article</span>
              <input type="url" class="gr-input" name="url" inputmode="url" autocomplete="url" placeholder="https://example.com/book.epub" />
            </label>
            <p class="gr-field__hint">Works with text, Markdown, HTML, EPUB and PDF files on sites that allow downloads from other pages.</p>
            <p class="gr-field__error" role="alert"></p>
            <div class="gr-inline-form__actions">
              <button type="submit" class="gr-btn gr-btn--primary">Open</button>
              <button type="button" class="gr-btn gr-btn--ghost" data-cancel>Cancel</button>
            </div>
          </form>
        </section>
      </div>

      <section class="gr-shelf" aria-labelledby="${uid}-recent" hidden>
        <h2 class="gr-shelf__title" id="${uid}-recent">Continue reading</h2>
        <ul class="gr-cards gr-cards--recent" role="list"></ul>
      </section>

      <section class="gr-shelf" aria-labelledby="${uid}-samples">
        <h2 class="gr-shelf__title" id="${uid}-samples">Sample books</h2>
        <ul class="gr-cards gr-cards--samples" role="list"></ul>
        <div class="gr-shelf__status" role="status" aria-live="polite"></div>
      </section>

      <footer class="gr-lib-footer">
        <p>Works best in a well-lit room, on a laptop or desktop with a webcam. No account, no uploads, no tracking of the other kind.</p>
      </footer>`;
    this.el = root;

    const q = <T extends Element>(sel: string): T => {
      const found = root.querySelector<T>(sel);
      if (!found) throw new Error(`LibraryScreen: missing ${sel}`);
      return found;
    };
    const pasteForm = q<HTMLFormElement>(`#${uid}-paste`);
    const urlForm = q<HTMLFormElement>(`#${uid}-url`);
    const shelves = root.querySelectorAll<HTMLElement>('.gr-shelf');
    this.ui = {
      drop: q('.gr-drop'),
      fileInput: q('input[type="file"]'),
      choose: q('.gr-lib-choose'),
      pasteToggle: q('.gr-lib-paste-toggle'),
      urlToggle: q('.gr-lib-url-toggle'),
      pasteForm,
      urlForm,
      pasteText: pasteForm.querySelector('textarea')!,
      pasteTitle: pasteForm.querySelector('input')!,
      urlInput: urlForm.querySelector('input')!,
      pasteError: pasteForm.querySelector('.gr-field__error')!,
      urlError: urlForm.querySelector('.gr-field__error')!,
      busy: q('.gr-drop__busy'),
      busyLabel: q('.gr-drop__busy-label'),
      recentSection: shelves[0]!,
      recentList: q('.gr-cards--recent'),
      samplesList: q('.gr-cards--samples'),
      samplesStatus: q('.gr-shelf__status'),
    };
    this.bindEvents();
    this.setSamples({ status: 'loading' });
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    parent.appendChild(this.el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  /** Moves focus to the primary action (after returning from a book). */
  focusPrimary(): void {
    this.ui.choose.focus({ preventScroll: true });
  }

  setBusy(label: string | null): void {
    const busy = label !== null;
    this.ui.busy.hidden = !busy;
    this.ui.busyLabel.textContent = label ?? '';
    this.el.toggleAttribute('aria-busy', busy);
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.gr-drop__actions button, .gr-inline-form button[type="submit"], .gr-card__main')) {
      b.disabled = busy;
    }
  }

  setDragActive(on: boolean): void {
    this.el.dataset.drag = String(on);
  }

  setRecent(entries: readonly LibraryEntry[]): void {
    const list = this.ui.recentList;
    list.replaceChildren();
    const sorted = [...entries].sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt));
    const now = Date.now();
    for (const e of sorted) list.appendChild(this.recentCard(e, now));
    this.ui.recentSection.hidden = sorted.length === 0;
    this.el.dataset.returning = String(sorted.length > 0);
  }

  setSamples(state: SamplesState): void {
    const list = this.ui.samplesList;
    const status = this.ui.samplesStatus;
    list.replaceChildren();
    status.replaceChildren();
    list.setAttribute('aria-busy', String(state.status === 'loading'));
    if (state.status === 'loading') {
      for (let i = 0; i < 2; i++) list.appendChild(el('li', 'gr-card gr-card--skeleton'));
      return;
    }
    if (state.status === 'error') {
      status.append(el('span', '', state.message));
      const retry = el('button', 'gr-btn gr-btn--soft gr-btn--sm', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => this.opts.onRetrySamples());
      status.append(retry);
      return;
    }
    if (state.samples.length === 0) {
      status.textContent = 'No sample books are bundled with this build.';
      return;
    }
    for (const s of state.samples) list.appendChild(this.sampleCard(s));
  }

  destroy(): void {
    this.ac.abort();
    this.el.remove();
  }

  // ─────────────────────────────── cards ───────────────────────────────

  private cover(id: string, title: string, badge: string): HTMLElement {
    const c = el('span', 'gr-cover');
    c.setAttribute('aria-hidden', 'true');
    c.style.setProperty('--gr-hue', String(hueFor(id)));
    c.append(el('span', 'gr-cover__letter', initialOf(title)), el('span', 'gr-cover__badge', badge));
    return c;
  }

  private recentCard(e: LibraryEntry, now: number): HTMLElement {
    const li = el('li', 'gr-card gr-card--book');
    const main = el('button', 'gr-card__main');
    main.type = 'button';
    const fraction = Number.isFinite(e.fraction) ? Math.min(1, Math.max(0, e.fraction)) : 0;
    const pct = formatPercent(fraction);
    const left = formatMinutes(minutesLeft(fraction, e.wordCount, TYPICAL_WPM));
    const done = fraction >= 0.995;
    main.setAttribute('aria-label', `${done ? 'Reread' : 'Continue'} ${e.title}${e.author ? ` by ${e.author}` : ''}, ${pct} read`);
    main.addEventListener('click', () => this.opts.onOpenBook(e.id));

    const body = el('span', 'gr-card__body');
    body.append(el('strong', 'gr-card__title', e.title));
    if (e.author) body.append(el('span', 'gr-card__author', e.author));
    const progress = el('span', 'gr-card__progress');
    const meter = el('span', 'gr-meter');
    const fill = el('span', 'gr-meter__fill');
    fill.style.transform = `scaleX(${fraction})`;
    meter.append(fill);
    progress.append(meter, el('span', 'gr-card__pct', done ? 'Finished' : left ? `${pct} · ${left} left` : pct));
    body.append(progress);
    const when = relativeTime(e.lastReadAt, now);
    if (when) body.append(el('span', 'gr-card__when', `Read ${when}`));
    main.append(this.cover(e.id, e.title, FORMAT_LABEL[e.format] ?? ''), body);

    const del = el('button', 'gr-btn gr-btn--ghost gr-btn--icon gr-card__delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Remove ${e.title} from this device`);
    del.title = 'Remove from library';
    del.innerHTML = icon('trash');
    del.addEventListener('click', () => this.opts.onDeleteBook(e.id, e.title));

    li.append(main, del);
    return li;
  }

  private sampleCard(s: SampleEntry): HTMLElement {
    const li = el('li', 'gr-card gr-card--sample');
    const main = el('button', 'gr-card__main');
    main.type = 'button';
    main.setAttribute('aria-label', `Read ${s.title} by ${s.author}`);
    main.addEventListener('click', () => this.opts.onOpenSample(s.id));
    const body = el('span', 'gr-card__body');
    body.append(
      el('strong', 'gr-card__title', s.title),
      el('span', 'gr-card__author', s.author),
      el('span', 'gr-card__blurb', s.blurb),
    );
    const cta = el('span', 'gr-card__cta');
    cta.innerHTML = `<span>Start reading</span>${icon('chevronRight')}`;
    body.append(cta);
    main.append(this.cover(`sample:${s.id}`, s.title, 'Sample'), body);
    li.append(main);
    return li;
  }

  // ─────────────────────────────── events ───────────────────────────────

  private bindEvents(): void {
    const signal = this.ac.signal;
    const ui = this.ui;

    this.el.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as Element | null)?.closest<HTMLElement>('[data-cmd]');
        if (btn && this.el.contains(btn)) this.opts.onCommand(btn.dataset.cmd as CommandName);
      },
      { signal },
    );

    ui.choose.addEventListener('click', () => ui.fileInput.click(), { signal });
    ui.fileInput.addEventListener(
      'change',
      () => {
        const file = ui.fileInput.files?.[0];
        // Reset so choosing the same file again still fires `change`.
        ui.fileInput.value = '';
        if (file) this.opts.onOpenFile(file);
      },
      { signal },
    );

    const toggle = (btn: HTMLButtonElement, form: HTMLFormElement, other: [HTMLButtonElement, HTMLFormElement], focus: HTMLElement) => {
      btn.addEventListener(
        'click',
        () => {
          const open = form.hidden;
          this.setFormOpen(other[0], other[1], false);
          this.setFormOpen(btn, form, open);
          if (open) focus.focus();
        },
        { signal },
      );
      form.querySelector<HTMLButtonElement>('[data-cancel]')!.addEventListener(
        'click',
        () => {
          this.setFormOpen(btn, form, false);
          btn.focus();
        },
        { signal },
      );
      form.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          this.setFormOpen(btn, form, false);
          btn.focus();
        },
        { signal },
      );
    };
    toggle(ui.pasteToggle, ui.pasteForm, [ui.urlToggle, ui.urlForm], ui.pasteText);
    toggle(ui.urlToggle, ui.urlForm, [ui.pasteToggle, ui.pasteForm], ui.urlInput);

    ui.pasteForm.addEventListener(
      'submit',
      (e) => {
        e.preventDefault();
        const text = ui.pasteText.value;
        if (text.trim().length === 0) {
          ui.pasteError.textContent = 'Paste some text first.';
          ui.pasteText.focus();
          return;
        }
        ui.pasteError.textContent = '';
        const title = ui.pasteTitle.value.trim();
        this.opts.onOpenText(text, title || null);
      },
      { signal },
    );
    ui.pasteText.addEventListener('input', () => (ui.pasteError.textContent = ''), { signal });

    ui.urlForm.addEventListener(
      'submit',
      (e) => {
        e.preventDefault();
        const url = normalizeUrl(ui.urlInput.value);
        if (!url) {
          ui.urlError.textContent = 'That doesn’t look like a web address. Try one starting with https://';
          ui.urlInput.focus();
          return;
        }
        ui.urlError.textContent = '';
        this.opts.onOpenUrl(url);
      },
      { signal },
    );
    ui.urlInput.addEventListener('input', () => (ui.urlError.textContent = ''), { signal });
  }

  /** Clears and collapses the inline forms (after a successful open). */
  resetForms(): void {
    this.ui.pasteForm.reset();
    this.ui.urlForm.reset();
    this.ui.pasteError.textContent = '';
    this.ui.urlError.textContent = '';
    this.setFormOpen(this.ui.pasteToggle, this.ui.pasteForm, false);
    this.setFormOpen(this.ui.urlToggle, this.ui.urlForm, false);
  }

  private setFormOpen(btn: HTMLButtonElement, form: HTMLFormElement, open: boolean): void {
    form.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
}
