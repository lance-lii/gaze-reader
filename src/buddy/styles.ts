import { CSS_PREFIX, Z } from '../core/constants';

/** Root class; every other class Dewey uses is `${BUDDY_CLASS}-…` or `${BUDDY_CLASS}--…`. */
export const BUDDY_CLASS = `${CSS_PREFIX}buddy`;

const B = BUDDY_CLASS;

const FONT_UI =
  'var(--gr-font-ui, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)';

/** mood → which mouth is showing. */
const MOUTH_FOR_MOOD: ReadonlyArray<readonly [string, string]> = [
  ['idle', 'smile'],
  ['reading', 'soft'],
  ['happy', 'grin'],
  ['excited', 'big'],
  ['thinking', 'hmm'],
  ['worried', 'wavy'],
  ['sleepy', 'o'],
  ['celebrating', 'big'],
];

const CORNERS: ReadonlyArray<readonly [string, 'top' | 'bottom', 'left' | 'right']> = [
  ['bottom-right', 'bottom', 'right'],
  ['bottom-left', 'bottom', 'left'],
  ['top-right', 'top', 'right'],
  ['top-left', 'top', 'left'],
];

const cornerRules = CORNERS.map(
  ([name, v, h]) => `
.${B}--${name} {
  ${v}: max(var(--${B}-edge), env(safe-area-inset-${v}, 0px));
  ${h}: max(var(--${B}-edge), env(safe-area-inset-${h}, 0px));
}
.${B}--${name} .${B}-bubble, .${B}--${name} .${B}-pop {
  ${v === 'bottom' ? 'bottom' : 'top'}: calc(100% + 12px);
  ${h}: 0;
  transform-origin: ${h === 'right' ? `calc(100% - var(--${B}-w) / 2)` : `calc(var(--${B}-w) / 2)`} ${v === 'bottom' ? '100%' : '0%'};
}
.${B}--${name} .${B}-bubble::after, .${B}--${name} .${B}-pop::after {
  ${v === 'bottom' ? 'bottom' : 'top'}: -7px;
  ${h}: min(calc(var(--${B}-w) / 2 - 7px), calc(100% - 26px));
  border-${v === 'bottom' ? 'top' : 'bottom'}-color: transparent;
  border-${v === 'bottom' ? 'left' : 'right'}-color: transparent;
}`,
).join('');

const mouthRules = MOUTH_FOR_MOOD.map(([mood, mouth]) => `.${B}--mood-${mood} .${B}-mouth--${mouth}`).join(',\n');

export const BUDDY_CSS = `
.${B} {
  all: initial;
  position: fixed;
  z-index: ${Z.buddy};
  display: block;
  box-sizing: border-box;
  width: var(--${B}-w);
  height: var(--${B}-h);
  --${B}-w: 120px;
  --${B}-h: 150px;
  --${B}-edge: 16px;
  --${B}-accent: var(--gr-accent, #3b6fd8);
  --${B}-surface: var(--gr-surface, #ffffff);
  --${B}-fg: var(--gr-fg, #1f2328);
  --${B}-border: var(--gr-border, rgba(31, 35, 40, 0.14));
  --${B}-shadow: var(--gr-shadow, rgba(20, 24, 40, 0.16));
  font: 500 14px/1.4 ${FONT_UI};
  color: var(--${B}-fg);
  text-align: left;
  -webkit-tap-highlight-color: transparent;
  pointer-events: none;
}
.${B}[hidden] { display: none !important; }
.${B} *, .${B} *::before, .${B} *::after { box-sizing: border-box; }
${cornerRules}
.${B}--above { z-index: ${Z.calibration + 1}; }

/* ── Dewey himself ───────────────────────────────────────────────────────── */
.${B}-btn {
  all: unset;
  position: absolute;
  inset: 0;
  display: block;
  border-radius: 30px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  /* Only painted parts of the drawing take the pointer; transparent corners let clicks through. */
  pointer-events: none;
}
.${B}-btn:focus-visible { outline: 3px solid var(--${B}-accent); outline-offset: 3px; }
.${B}-svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  filter: drop-shadow(0 3px 6px rgba(20, 24, 40, 0.18));
}
.${B}-char { pointer-events: auto; cursor: pointer; }
.${B}--dragging .${B}-char { cursor: grabbing; }
.${B}--dragging .${B}-svg { filter: drop-shadow(0 12px 16px rgba(20, 24, 40, 0.26)); }
:root[data-theme="dark"] .${B}-svg {
  filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.35)) drop-shadow(0 4px 10px rgba(0, 0, 0, 0.5));
}
/* Only parts transformed by CSS get fill-box: it would also re-origin the
   rotate()/scale() transform attributes used elsewhere in the drawing. */
.${B}-char, .${B}-body, .${B}-head, .${B}-glasses, .${B}-cowlick, .${B}-brow, .${B}-lid-up,
.${B}-lid-low, .${B}-mouth--talk, .${B}-flip, .${B}-z, .${B}-star { transform-box: fill-box; }
.${B}-char { transform-origin: 50% 100%; }

/* Moods are class toggles on the root; parts are never re-rendered. */
.${B}-mouth { opacity: 0; transition: opacity 140ms ease; }
${mouthRules} { opacity: 1; }
.${B}-mouth--talk { transform-origin: 50% 0%; }

.${B}-brow { transform-origin: 50% 50%; }
.${B}--mood-reading .${B}-brow--l { transform: translateY(1px) rotate(5deg); }
.${B}--mood-reading .${B}-brow--r { transform: translateY(1px) rotate(-5deg); }
.${B}--mood-happy .${B}-brow { transform: translateY(-1.5px); }
.${B}--mood-excited .${B}-brow { transform: translateY(-3px); }
.${B}--mood-celebrating .${B}-brow { transform: translateY(-3.5px); }
.${B}--mood-thinking .${B}-brow--l { transform: translateY(-2.5px) rotate(-8deg); }
.${B}--mood-thinking .${B}-brow--r { transform: translateY(0.5px) rotate(3deg); }
.${B}--mood-worried .${B}-brow--l { transform: translateY(-1px) rotate(-14deg); }
.${B}--mood-worried .${B}-brow--r { transform: translateY(-1px) rotate(14deg); }
.${B}--mood-sleepy .${B}-brow { transform: translateY(1.5px); }

.${B}-lid-up { transform-origin: 50% 0%; transform: scaleY(0); }
.${B}-lid-low { transform-origin: 50% 100%; transform: scaleY(0); }
.${B}--mood-reading .${B}-lid-up { transform: scaleY(0.22); }
.${B}--mood-thinking .${B}-lid-up { transform: scaleY(0.12); }
.${B}--mood-sleepy .${B}-lid-up { transform: scaleY(0.62); }
.${B}--mood-happy .${B}-lid-low, .${B}--mood-excited .${B}-lid-low { transform: scaleY(0.42); }
.${B}.${B}--blink .${B}-lid-up { transform: scaleY(1); }

.${B}-eye, .${B}-eye-happy { transition: opacity 120ms ease; }
.${B}-eye-happy { opacity: 0; }
.${B}--mood-celebrating .${B}-eye { opacity: 0; }
.${B}--mood-celebrating .${B}-eye-happy { opacity: 1; }

.${B}-blush { opacity: 0.3; transition: opacity 300ms ease; }
.${B}--mood-happy .${B}-blush,
.${B}--mood-excited .${B}-blush,
.${B}--mood-celebrating .${B}-blush { opacity: 0.58; }
.${B}--mood-worried .${B}-blush { opacity: 0.12; }

.${B}-flip { opacity: 0; transform-origin: 0% 50%; }
.${B}-flip-shade { opacity: 0; }

.${B}-zzz, .${B}-sparkles { opacity: 0; transition: opacity 400ms ease; }
.${B}--mood-sleepy .${B}-zzz { opacity: 0.8; }
.${B}--mood-celebrating .${B}-sparkles { opacity: 1; }

/* ── speech bubble & menu ────────────────────────────────────────────────── */
.${B}-bubble, .${B}-pop {
  position: absolute;
  margin: 0;
  background: var(--${B}-surface);
  color: var(--${B}-fg);
  border: 1px solid var(--${B}-border);
  box-shadow: 0 8px 24px var(--${B}-shadow), 0 1px 2px rgba(20, 24, 40, 0.08);
  font: 500 14px/1.38 ${FONT_UI};
  letter-spacing: 0.005em;
  text-align: left;
  text-transform: none;
  white-space: normal;
  overflow-wrap: break-word;
}
.${B}-bubble::after, .${B}-pop::after {
  content: "";
  position: absolute;
  width: 12px;
  height: 12px;
  background: inherit;
  border: inherit;
  transform: rotate(45deg);
}
.${B}-bubble {
  width: max-content;
  min-width: 72px;
  max-width: 260px;
  padding: 9px 13px 10px;
  border-radius: 16px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 180ms ease, visibility 0s linear 180ms;
}
.${B}-bubble--show {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  cursor: default;
  transition: opacity 180ms ease, visibility 0s;
}
/* Never intercept clicks meant for an overlay Dewey is standing in front of. */
.${B}--above .${B}-bubble--show { pointer-events: none; }
.${B}-bubble-text { display: block; margin: 0; padding: 0; font: inherit; color: inherit; }

.${B}-pop {
  width: 228px;
  max-width: calc(100vw - 2 * var(--${B}-edge));
  padding: 8px;
  border-radius: 18px;
  pointer-events: auto;
}
.${B}-pop[hidden] { display: none; }
.${B}-pop-say { display: block; margin: 3px 8px 7px; font-weight: 650; font-size: 13.5px; }
.${B}-menu { display: flex; flex-direction: column; gap: 1px; }
.${B}-item {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 7px 10px;
  border-radius: 11px;
  font: 500 14px/1.3 ${FONT_UI};
  color: var(--${B}-fg);
  cursor: pointer;
}
.${B}-item svg { flex: none; width: 18px; height: 18px; opacity: 0.8; }
.${B}-item:hover, .${B}-item:focus {
  background: rgba(59, 111, 216, 0.12);
  background: color-mix(in srgb, var(--${B}-accent) 14%, transparent);
}
.${B}-item:focus-visible { outline: 2px solid var(--${B}-accent); outline-offset: -2px; }
.${B}-item--muted { color: var(--gr-muted, #5f6773); }
.${B}-sep { height: 1px; margin: 4px 8px; background: var(--${B}-border); }

.${B}-sr {
  position: absolute !important;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.${B}-fx { position: absolute; left: 50%; top: 32%; width: 0; height: 0; pointer-events: none; }
.${B}-confetti {
  position: absolute;
  left: -3px; top: -5px;
  width: 6px; height: 10px;
  border-radius: 1.5px;
  background: var(--${B}-c, #ffcf4d);
  opacity: 0;
}

/* ── motion: only when the reader hasn't asked for less of it ─────────────── */
@media (prefers-reduced-motion: no-preference) {
  .${B}-brow { transition: transform 220ms ease; }
  .${B}-lid-up { transition: transform 150ms ease; }
  .${B}-lid-low { transition: transform 220ms ease; }
  .${B}.${B}--blink .${B}-lid-up { transition-duration: 60ms; }
  .${B}-svg { transition: transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1.3), filter 200ms ease; }
  .${B}--dragging .${B}-svg { transform: scale(1.05) rotate(-3deg); }
  @media (hover: hover) {
    .${B}:not(.${B}--dragging) .${B}-btn:hover .${B}-svg { transform: translateY(-2px); }
  }
  .${B}--snapping { transition: transform 420ms cubic-bezier(0.2, 0.9, 0.3, 1.12); }

  .${B}-body { transform-origin: 50% 100%; animation: ${B}-breathe 4.8s ease-in-out infinite; }
  .${B}-head { animation: ${B}-bob 4.8s ease-in-out infinite; }
  .${B}--mood-sleepy .${B}-head { transform-origin: 50% 90%; animation: ${B}-nod 5.5s ease-in-out infinite; }
  .${B}--mood-sleepy .${B}-lid-up { animation: ${B}-droop 5.5s ease-in-out infinite; }
  .${B}--mood-celebrating .${B}-char { animation: ${B}-hop 0.62s cubic-bezier(0.3, 0.7, 0.4, 1) 4; }
  .${B}--mood-excited .${B}-cowlick { transform-origin: 20% 100%; animation: ${B}-boing 0.55s ease-in-out 2; }
  .${B}--wiggle .${B}-char { transform-origin: 50% 100%; animation: ${B}-wiggle 0.5s ease-in-out; }
  .${B}--push .${B}-glasses { animation: ${B}-push 0.8s ease-in-out; }

  .${B}--talking .${B}-mouth { opacity: 0; }
  .${B}--talking .${B}-mouth--talk { opacity: 1; animation: ${B}-talk 0.24s steps(2, jump-none) infinite alternate; }

  .${B}--flip .${B}-flip { animation: ${B}-flip 0.56s ease-in-out; }
  .${B}--flip .${B}-flip-shade { animation: ${B}-flip-shade 0.56s ease-in-out; }
  .${B}--flip-back .${B}-flip { animation: ${B}-flip 0.56s ease-in-out reverse; }
  .${B}--flip-back .${B}-flip-shade { animation: ${B}-flip-shade 0.56s ease-in-out reverse; }

  .${B}--mood-sleepy .${B}-z { opacity: 0; animation: ${B}-z 3.6s ease-in-out infinite; }
  .${B}--mood-sleepy g:nth-child(2) > .${B}-z { animation-delay: 1.2s; }
  .${B}--mood-sleepy g:nth-child(3) > .${B}-z { animation-delay: 2.4s; }
  .${B}--mood-celebrating .${B}-star { animation: ${B}-twinkle 1.1s ease-in-out infinite; }
  .${B}--mood-celebrating g:nth-child(2n) > .${B}-star { animation-delay: 0.35s; }
  .${B}--mood-celebrating g:nth-child(3n) > .${B}-star { animation-delay: 0.7s; }

  .${B}-bubble, .${B}-pop { transform: translateY(6px) scale(0.94); }
  .${B}-bubble { transition: opacity 180ms ease, transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1.25), visibility 0s linear 240ms; }
  .${B}-bubble--show { transform: none; transition: opacity 180ms ease, transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1.25), visibility 0s; }
  .${B}-pop:not([hidden]) { transform: none; animation: ${B}-pop 200ms cubic-bezier(0.2, 0.9, 0.3, 1.25); }

  .${B}-confetti { animation: ${B}-confetti 1.35s cubic-bezier(0.15, 0.6, 0.35, 1) var(--${B}-delay, 0ms) forwards; }
}

@keyframes ${B}-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.018); } }
@keyframes ${B}-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-0.7px); } }
@keyframes ${B}-nod { 0%, 100% { transform: rotate(0deg); } 50% { transform: translateY(1px) rotate(3deg); } }
@keyframes ${B}-droop { 0%, 100% { transform: scaleY(0.58); } 45% { transform: scaleY(0.8); } 55% { transform: scaleY(0.82); } }
@keyframes ${B}-hop { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-7px); } 70% { transform: translateY(0.5px) scale(1.02, 0.98); } }
@keyframes ${B}-boing { 0%, 100% { transform: rotate(0deg); } 30% { transform: rotate(-10deg); } 70% { transform: rotate(7deg); } }
@keyframes ${B}-wiggle { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-4deg); } 60% { transform: rotate(3deg); } 85% { transform: rotate(-1deg); } }
@keyframes ${B}-push { 0%, 100% { transform: translateY(0); } 35% { transform: translateY(1.3px); } 65% { transform: translateY(-1.1px); } }
@keyframes ${B}-talk { from { transform: scaleY(0.45); } to { transform: scaleY(1); } }
@keyframes ${B}-flip {
  0% { opacity: 1; transform: scaleX(1); }
  46% { opacity: 1; transform: scaleX(0.06) skewY(-9deg); }
  54% { opacity: 1; transform: scaleX(-0.06) skewY(9deg); }
  100% { opacity: 1; transform: scaleX(-1); }
}
@keyframes ${B}-flip-shade { 0%, 50% { opacity: 0; } 51% { opacity: 0.45; } 100% { opacity: 0.18; } }
@keyframes ${B}-z {
  0% { opacity: 0; transform: translate(0, 3px) scale(0.7); }
  25% { opacity: 0.9; }
  100% { opacity: 0; transform: translate(5px, -9px) scale(1.12); }
}
@keyframes ${B}-twinkle { 0%, 100% { transform: scale(0.6) rotate(0deg); opacity: 0.5; } 50% { transform: scale(1.15) rotate(20deg); opacity: 1; } }
@keyframes ${B}-pop { from { opacity: 0; transform: translateY(6px) scale(0.94); } to { opacity: 1; transform: none; } }
@keyframes ${B}-confetti {
  0% { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(0.6); }
  45% { opacity: 1; transform: translate(calc(var(--${B}-dx) * 0.8), var(--${B}-dy)) rotate(calc(var(--${B}-rot) * 0.5)) scale(1); }
  100% { opacity: 0; transform: translate(var(--${B}-dx), calc(var(--${B}-dy) + 70px)) rotate(var(--${B}-rot)) scale(0.9); }
}

@media (max-width: 560px), (max-height: 520px) {
  .${B} { --${B}-w: 88px; --${B}-h: 110px; --${B}-edge: 10px; }
  .${B}-bubble { font-size: 13px; }
}
@media (forced-colors: active) {
  .${B}-svg { forced-color-adjust: none; }
  .${B}-bubble, .${B}-pop { border: 2px solid CanvasText; background: Canvas; color: CanvasText; }
  .${B}-item:focus-visible, .${B}-btn:focus-visible { outline-color: Highlight; }
}
@media print { .${B} { display: none !important; } }
`;

type StyleRoot = Document | ShadowRoot;

interface StyleEntry {
  count: number;
  remove: () => void;
}

const installed = new WeakMap<StyleRoot, StyleEntry>();

function isDocument(root: StyleRoot): root is Document {
  return root.nodeType === 9; // Node.DOCUMENT_NODE, without relying on a realm-specific global
}

/**
 * Makes Dewey's stylesheet available in `root` (a Document or a ShadowRoot),
 * once per root however many buddies mount there. Returns a release function.
 *
 * Constructable stylesheets are preferred: unlike a `<style>` element they are
 * not subject to the host page's `style-src` CSP when the extension mounts
 * Dewey on arbitrary sites. A `<style>` element is the fallback.
 */
export function adoptBuddyStyles(root: StyleRoot): () => void {
  let entry = installed.get(root);
  if (!entry) {
    entry = { count: 0, remove: install(root) };
    installed.set(root, entry);
  }
  entry.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const e = installed.get(root);
    if (!e) return;
    e.count--;
    if (e.count <= 0) {
      e.remove();
      installed.delete(root);
    }
  };
}

function install(root: StyleRoot): () => void {
  const adopted = tryAdopt(root);
  if (adopted) return adopted;
  const doc = isDocument(root) ? root : root.ownerDocument;
  const style = doc.createElement('style');
  style.setAttribute('data-gr-style', 'buddy');
  style.textContent = BUDDY_CSS;
  const host: Node = isDocument(root) ? (root.head ?? root.documentElement) : root;
  host.appendChild(style);
  return () => style.remove();
}

function tryAdopt(root: StyleRoot): (() => void) | null {
  try {
    const current: unknown = (root as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    const view = (isDocument(root) ? root : root.ownerDocument).defaultView;
    const Sheet = view?.CSSStyleSheet;
    if (!Array.isArray(current) || !Sheet || typeof Sheet.prototype.replaceSync !== 'function') return null;
    const sheet = new Sheet();
    sheet.replaceSync(BUDDY_CSS);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return () => {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  } catch {
    return null;
  }
}
