import type { AppSettings } from '../types';

/** Attribute that marks the injected reader stylesheet (so it is injected once per document / shadow root). */
export const READER_STYLE_ATTR = 'data-gr-reader-style';

export const FONT_STACKS: Readonly<Record<AppSettings['fontFamily'], string>> = Object.freeze({
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052, Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
});

/**
 * Reading typography. Everything is scoped under .gr-reader. Colors come from the
 * app's theme tokens (--gr-bg, --gr-fg, …) with light/sepia/dark fallbacks so the
 * reader also looks right on its own. Size, leading, measure and face are CSS
 * variables set by ReaderView.applySettings — changing them never re-renders.
 */
export const READER_CSS = /* css */ `
.gr-reader {
  --gr-r-bg: var(--gr-bg, #fbf8f2);
  --gr-r-fg: var(--gr-fg, #1f1c18);
  --gr-r-muted: var(--gr-muted, #6f685d);
  --gr-r-accent: var(--gr-accent, #3b6ea5);
  --gr-r-border: var(--gr-border, #e3dccf);
  --gr-r-surface: var(--gr-surface, #f3eee4);
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-behavior: auto;
  scrollbar-gutter: stable;
  scrollbar-color: color-mix(in srgb, var(--gr-r-fg) 22%, transparent) transparent;
  -webkit-overflow-scrolling: touch;
  background: var(--gr-r-bg);
  color: var(--gr-r-fg);
  outline: none;
}
:root[data-theme="sepia"] .gr-reader {
  --gr-r-bg: var(--gr-bg, #f4ecd8);
  --gr-r-fg: var(--gr-fg, #3a2e22);
  --gr-r-muted: var(--gr-muted, #7c6a55);
  --gr-r-accent: var(--gr-accent, #9a5b25);
  --gr-r-border: var(--gr-border, #e0d2b4);
  --gr-r-surface: var(--gr-surface, #ece1c8);
}
:root[data-theme="dark"] .gr-reader {
  --gr-r-bg: var(--gr-bg, #16181d);
  --gr-r-fg: var(--gr-fg, #e4dfd6);
  --gr-r-muted: var(--gr-muted, #9c968c);
  --gr-r-accent: var(--gr-accent, #8fb4e3);
  --gr-r-border: var(--gr-border, #2e323b);
  --gr-r-surface: var(--gr-surface, #1f2229);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .gr-reader {
    --gr-r-bg: var(--gr-bg, #16181d);
    --gr-r-fg: var(--gr-fg, #e4dfd6);
    --gr-r-muted: var(--gr-muted, #9c968c);
    --gr-r-accent: var(--gr-accent, #8fb4e3);
    --gr-r-border: var(--gr-border, #2e323b);
    --gr-r-surface: var(--gr-surface, #1f2229);
  }
}

.gr-reader-content {
  box-sizing: content-box;
  max-width: var(--gr-reader-measure, 62ch);
  margin: 0 auto;
  /* Generous bottom padding lets the last lines of the book scroll up to the top. */
  padding: clamp(2rem, 9vh, 5.5rem) clamp(1.1rem, 5vw, 3rem) 60vh;
  font-family: var(--gr-reader-font, ${FONT_STACKS.serif});
  font-size: var(--gr-reader-font-size, 22px);
  line-height: var(--gr-reader-line-height, 1.9);
  font-kerning: normal;
  font-optical-sizing: auto;
  font-variant-ligatures: common-ligatures;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  text-align: start;
  hyphens: auto;
  -webkit-hyphens: auto;
  hyphenate-limit-chars: 6 3 2;
  hanging-punctuation: first allow-end last;
  overflow-wrap: break-word;
  text-wrap: pretty;
  color: var(--gr-r-fg);
}
.gr-reader[data-font="serif"] .gr-reader-content { font-variant-numeric: oldstyle-nums proportional-nums; }
.gr-reader-content::selection,
.gr-reader-content ::selection { background: color-mix(in srgb, var(--gr-r-accent) 26%, transparent); }

.gr-reader-content p { margin: 0; }
.gr-reader-content p + p { text-indent: 1.5em; }

.gr-reader-content :is(h1, h2, h3, h4, h5, h6) {
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: 0.005em;
  margin: 2.2em 0 0.9em;
  text-wrap: balance;
  hyphens: manual;
  -webkit-hyphens: manual;
  font-variant-numeric: lining-nums;
}
.gr-reader-content h1 { font-size: 1.7em; }
.gr-reader-content h2 { font-size: 1.4em; }
.gr-reader-content h3 { font-size: 1.18em; }
.gr-reader-content :is(h4, h5, h6) { font-size: 1em; }
.gr-reader-content .gr-chapter-start {
  margin: 3.6em 0 1.6em;
  text-align: center;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.gr-reader-content .gr-chapter-start::after {
  content: "";
  display: block;
  width: 2.75rem;
  height: 1px;
  margin: 0.85em auto 0;
  background: var(--gr-r-accent);
  opacity: 0.55;
}
.gr-reader-content .gr-chapter:first-child .gr-chapter-start { margin-top: 0.4em; }

/* A subtle drop cap on the first paragraph of each chapter. */
.gr-reader-content p.gr-dropcap { text-indent: 0; }
.gr-reader-content p.gr-dropcap::first-letter {
  font-size: 1.4em;
  line-height: 1;
  font-weight: 600;
  color: var(--gr-r-accent);
}
@supports (initial-letter: 2) or (-webkit-initial-letter: 2) {
  .gr-reader-content p.gr-dropcap::first-letter {
    -webkit-initial-letter: 2;
    initial-letter: 2;
    font-size: inherit;
    line-height: inherit;
    font-weight: 500;
    margin-inline-end: 0.1em;
  }
}

.gr-reader-content a[href] {
  color: var(--gr-r-accent);
  text-decoration-line: underline;
  text-decoration-thickness: 0.06em;
  text-underline-offset: 0.18em;
  text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
}
.gr-reader-content a[href]:hover { text-decoration-color: currentColor; }
.gr-reader-content a[href]:focus-visible { outline: 2px solid var(--gr-r-accent); outline-offset: 2px; border-radius: 2px; }

/* Keep sub/superscripts from nudging line spacing: the eye tracker relies on an even line pitch. */
.gr-reader-content :is(sup, sub) { font-size: 0.7em; line-height: 0; position: relative; vertical-align: baseline; }
.gr-reader-content sup { top: -0.48em; }
.gr-reader-content sub { top: 0.25em; }
.gr-reader-content small { font-size: 0.85em; }
.gr-reader-content abbr[title] { text-decoration: underline dotted; text-underline-offset: 0.2em; }

.gr-reader-content blockquote {
  margin: 1.3em 0;
  padding: 0 0 0 1.25em;
  border-inline-start: 2px solid var(--gr-r-border);
  color: color-mix(in srgb, var(--gr-r-fg) 88%, var(--gr-r-bg));
}
.gr-reader-content blockquote p + p { text-indent: 0; margin-top: 0.6em; }

.gr-reader-content hr {
  border: 0;
  height: auto;
  margin: 1.7em auto;
  text-align: center;
  overflow: visible;
  color: var(--gr-r-muted);
}
.gr-reader-content hr::before { content: "*\\2002*\\2002*"; letter-spacing: 0.1em; }
.gr-reader-content hr + p { text-indent: 0; }

.gr-reader-content :is(ul, ol) { margin: 0.9em 0; padding-inline-start: 1.6em; }
.gr-reader-content li + li { margin-top: 0.2em; }
.gr-reader-content li p + p { text-indent: 0; margin-top: 0.5em; }
.gr-reader-content dl { margin: 0.9em 0; }
.gr-reader-content dt { font-weight: 600; }
.gr-reader-content dd { margin: 0 0 0.5em 1.5em; }

.gr-reader-content :is(pre, code) { font-family: ${FONT_STACKS.mono}; font-size: 0.84em; font-variant-ligatures: none; }
.gr-reader-content pre {
  margin: 1.2em 0;
  padding: 0.8em 1em;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  hyphens: none;
  background: var(--gr-r-surface);
  border-radius: 6px;
}
.gr-reader-content pre code { font-size: 1em; }

.gr-reader-content table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  margin: 1.2em 0;
  border-collapse: collapse;
  font-size: 0.88em;
  line-height: 1.5;
  hyphens: manual;
}
.gr-reader-content :is(td, th) { padding: 0.35em 0.7em; border-bottom: 1px solid var(--gr-r-border); vertical-align: top; text-align: start; }
.gr-reader-content th { font-weight: 600; }

.gr-reader-content figure { margin: 1.4em 0; }
.gr-reader-content figcaption { font-size: 0.85em; color: var(--gr-r-muted); text-align: center; }

.gr-reader-content .gr-end {
  margin: 5em auto 0;
  text-align: center;
  color: var(--gr-r-muted);
  font-size: 0.78em;
  line-height: 1.6;
}
.gr-reader-content .gr-end svg { display: block; width: 7.5em; height: auto; margin: 0 auto 1.1em; color: var(--gr-r-accent); opacity: 0.8; }
.gr-reader-content .gr-end-label { letter-spacing: 0.18em; text-transform: uppercase; font-variant-numeric: lining-nums; }
.gr-reader-content .gr-end-title { margin-top: 0.4em; font-style: italic; letter-spacing: 0.01em; }

@media (max-width: 480px) {
  .gr-reader-content p + p { text-indent: 1.1em; }
  .gr-reader-content .gr-chapter-start { margin-top: 2.6em; }
}
`;
