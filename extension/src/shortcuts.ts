/**
 * In-page keyboard shortcuts. On arbitrary websites plain letters and Space
 * belong to the site, so every shortcut is Alt+Shift+<key> (matched by
 * physical key, so it works on any keyboard layout), and nothing fires while
 * the reader is typing.
 */

export type ShortcutAction =
  | 'toggle-pause'
  | 'recalibrate'
  | 'page-forward'
  | 'page-back'
  | 'undo-turn'
  | 'toggle-debug'
  | 'toggle-gaze-dot'
  | 'toggle-help'
  | 'turn-off';

export interface ShortcutInfo {
  action: ShortcutAction;
  codes: readonly string[];
  keys: string;
  label: string;
}

export const SHORTCUTS: readonly ShortcutInfo[] = [
  { action: 'toggle-pause', codes: ['KeyP'], keys: 'Alt+Shift+P', label: 'Pause / resume auto-scroll' },
  { action: 'page-forward', codes: ['ArrowDown', 'PageDown'], keys: 'Alt+Shift+↓', label: 'Next page' },
  { action: 'page-back', codes: ['ArrowUp', 'PageUp'], keys: 'Alt+Shift+↑', label: 'Previous page' },
  { action: 'undo-turn', codes: ['KeyU'], keys: 'Alt+Shift+U', label: 'Undo the last page turn' },
  { action: 'recalibrate', codes: ['KeyC'], keys: 'Alt+Shift+C', label: 'Recalibrate' },
  { action: 'toggle-gaze-dot', codes: ['KeyO'], keys: 'Alt+Shift+O', label: 'Show / hide the gaze dot' },
  { action: 'toggle-debug', codes: ['KeyD'], keys: 'Alt+Shift+D', label: 'Debug overlay' },
  { action: 'toggle-help', codes: ['Slash', 'KeyH'], keys: 'Alt+Shift+H', label: 'Show these shortcuts' },
  { action: 'turn-off', codes: ['KeyX'], keys: 'Alt+Shift+X', label: 'Turn Gaze Reader off here' },
];

/** The browser-level toggle declared in manifest.json `commands`. */
export const TOGGLE_SHORTCUT = 'Alt+Shift+G';

export interface KeyLike {
  code: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export function matchShortcut(e: KeyLike): ShortcutAction | null {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return null;
  for (const s of SHORTCUTS) {
    if (!s.codes.includes(e.code)) continue;
    // Holding a key down may repeat page turns but must not flicker toggles.
    if (e.repeat && s.action !== 'page-forward' && s.action !== 'page-back') return null;
    return s.action;
  }
  return null;
}

const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week', '',
]);

/** True when the event comes from somewhere the reader types (inputs, textareas, contenteditable, ARIA textboxes). */
export function isTypingContext(e: Event): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const nodes = path.length > 0 ? path : [e.target];
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || !('nodeType' in n) || (n as Node).nodeType !== 1) continue;
    if (isEditableElement(n as Element)) return true;
  }
  return false;
}

export function isEditableElement(el: Element): boolean {
  const tag = el.localName;
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return TEXT_INPUT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase());
  const role = el.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // jsdom doesn't implement isContentEditable; the attribute check covers it.
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.toLowerCase() !== 'false';
}
