/**
 * The Artifact frame stamps `data-theme="dark" | "light"` on the root element
 * when the viewer picked a theme explicitly (and nothing for "system"). The app
 * writes the same attribute on the same element, so this watcher tells the two
 * apart: the app writes through write(), which drains the observer's queue
 * right away, so any record the observer delivers later came from the host.
 *
 * Only the Artifact build creates one (see AppController); the web app owns
 * data-theme alone.
 */

export type HostTheme = 'light' | 'dark';

const ATTR = 'data-theme';

/** The host's explicit theme, or null when there is no stamp (or one we don't know). */
export function parseHostTheme(value: string | null | undefined): HostTheme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

export class HostThemeWatcher {
  private readonly root: Element;
  private readonly observer: MutationObserver | null;
  private host: HostTheme | null;

  /**
   * Create it before the app first writes data-theme: whatever is on the root
   * at that point is the host's stamp.
   * @param onHostChange called after the host changes (or removes) its stamp.
   */
  constructor(root: Element, onHostChange: (theme: HostTheme | null) => void) {
    this.root = root;
    this.host = parseHostTheme(root.getAttribute(ATTR));
    this.observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver((records) => {
            if (records.length === 0) return;
            this.host = parseHostTheme(root.getAttribute(ATTR));
            onHostChange(this.host);
          })
        : null;
    this.observer?.observe(root, { attributes: true, attributeFilter: [ATTR] });
  }

  /** The host's current stamp (including a change still waiting for the observer). */
  get theme(): HostTheme | null {
    this.absorbPending();
    return this.host;
  }

  /** Writes the app's theme without mistaking the write for the host's. */
  write(theme: string): void {
    this.absorbPending();
    if (this.root.getAttribute(ATTR) !== theme) this.root.setAttribute(ATTR, theme);
    this.observer?.takeRecords();
  }

  destroy(): void {
    this.observer?.disconnect();
  }

  /** Records queued before one of our writes can only be the host's. */
  private absorbPending(): void {
    if (this.observer && this.observer.takeRecords().length > 0) this.host = parseHostTheme(this.root.getAttribute(ATTR));
  }
}
