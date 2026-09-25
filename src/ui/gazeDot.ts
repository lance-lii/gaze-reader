import type { AppSettings, EventBus, GazeSample, Mountable, Unsubscribe } from '../types';
import { CSS_PREFIX, IGNORE_ATTR, Z } from '../core/constants';

/**
 * A small, soft, semi-transparent dot that follows the smoothed gaze.
 * Positioned with a compositor-only transform once per animation frame, so it
 * never triggers layout. Hidden while the gaze is invalid; pinned (dimmed) to
 * the edge while the gaze is off-screen.
 */

export interface GazeDotOptions {
  bus: EventBus;
  getSettings: () => AppSettings;
}

const P = CSS_PREFIX;
const SIZE = 18;
const HALF = SIZE / 2;

const STYLE = `
.${P}gaze-dot-layer {
  position: fixed; left: 0; top: 0; width: 0; height: 0;
  z-index: ${Z.gazeDot}; pointer-events: none;
}
.${P}gaze-dot-layer[hidden] { display: none; }
.${P}gaze-dot {
  position: absolute; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px;
  border-radius: 50%; pointer-events: none; contain: strict;
  opacity: 0; will-change: transform, opacity;
  transition: opacity 160ms ease-out;
  background: radial-gradient(circle, rgba(79, 124, 255, 0.55) 0%, rgba(79, 124, 255, 0.28) 50%, rgba(79, 124, 255, 0) 72%);
  background: radial-gradient(circle,
    color-mix(in srgb, var(--gr-accent, #4f7cff) 60%, transparent) 0%,
    color-mix(in srgb, var(--gr-accent, #4f7cff) 28%, transparent) 50%,
    transparent 72%);
  box-shadow: 0 0 0 1.5px rgba(79, 124, 255, 0.4), 0 0 10px rgba(79, 124, 255, 0.25);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--gr-accent, #4f7cff) 42%, transparent),
    0 0 10px color-mix(in srgb, var(--gr-accent, #4f7cff) 25%, transparent);
}
.${P}gaze-dot.${P}is-on { opacity: 0.9; }
.${P}gaze-dot.${P}is-on.${P}is-offscreen { opacity: 0.45; }
@media (prefers-reduced-motion: reduce) {
  .${P}gaze-dot { transition: none; }
}
`;

export class GazeDot implements Mountable {
  private readonly bus: EventBus;
  private readonly getSettings: () => AppSettings;
  private layer: HTMLDivElement | null = null;
  private dot: HTMLDivElement | null = null;
  private offs: Unsubscribe[] = [];
  private hostVisible = true;
  private settingVisible: boolean;
  private latest: GazeSample | null = null;
  private raf: number | null = null;
  private destroyed = false;
  /**
   * Viewport size, refreshed on `resize`. Reading innerWidth/innerHeight inside the frame
   * callback can force a synchronous layout when another rAF consumer (Dewey's eyes) has
   * already written styles in the same frame.
   */
  private viewW = 0;
  private viewH = 0;
  private detachWindow: (() => void) | null = null;

  constructor(opts: GazeDotOptions) {
    this.bus = opts.bus;
    this.getSettings = opts.getSettings;
    this.settingVisible = readFlag(opts.getSettings);
  }

  /** Whether the dot layer is currently shown (setting on and not hidden by the host). */
  get visible(): boolean {
    return this.hostVisible && this.settingVisible;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    if (this.destroyed) return;
    if (!this.layer) {
      const doc = parent.ownerDocument ?? document;
      const layer = doc.createElement('div');
      layer.className = `${P}gaze-dot-layer`;
      layer.setAttribute(IGNORE_ATTR, '');
      layer.setAttribute('aria-hidden', 'true');
      layer.style.pointerEvents = 'none';
      const style = doc.createElement('style');
      style.textContent = STYLE;
      const dot = doc.createElement('div');
      dot.className = `${P}gaze-dot`;
      layer.append(style, dot);
      this.layer = layer;
      this.dot = dot;
      this.offs.push(
        this.bus.on('gaze', (s) => this.onGaze(s)),
        this.bus.on('settings-changed', ({ settings, changed }) => {
          if (changed.includes('showGazeDot')) {
            this.settingVisible = settings.showGazeDot;
            this.applyVisibility();
          }
        }),
      );
      this.settingVisible = readFlag(this.getSettings);
      const win = doc.defaultView;
      if (win) {
        const measure = (): void => {
          this.viewW = win.innerWidth || 0;
          this.viewH = win.innerHeight || 0;
        };
        const onResize = (): void => {
          measure();
          this.schedule();
        };
        measure();
        win.addEventListener('resize', onResize);
        this.detachWindow = () => win.removeEventListener('resize', onResize);
      }
    }
    parent.appendChild(this.layer);
    this.applyVisibility();
  }

  setVisible(v: boolean): void {
    this.hostVisible = v;
    this.applyVisibility();
  }

  destroy(): void {
    this.destroyed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.detachWindow?.();
    this.detachWindow = null;
    this.cancelFrame();
    this.layer?.remove();
    this.layer = null;
    this.dot = null;
    this.latest = null;
  }

  private onGaze(s: GazeSample): void {
    this.latest = s;
    this.schedule();
  }

  private applyVisibility(): void {
    if (!this.layer) return;
    const show = this.visible;
    this.layer.hidden = !show;
    if (!show) {
      this.cancelFrame();
      this.dot?.classList.remove(`${P}is-on`);
    } else {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.raf !== null || !this.layer || !this.visible) return;
    const win = this.layer.ownerDocument.defaultView ?? globalThis;
    this.raf = win.requestAnimationFrame(this.render);
  }

  private cancelFrame(): void {
    if (this.raf === null) return;
    const win = this.layer?.ownerDocument.defaultView ?? globalThis;
    win.cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private readonly render = (): void => {
    this.raf = null;
    const dot = this.dot;
    const s = this.latest;
    if (!dot || !this.visible) return;
    if (!s || !s.valid || !Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      dot.classList.remove(`${P}is-on`);
      return;
    }
    const w = this.viewW;
    const h = this.viewH;
    let x = s.x;
    let y = s.y;
    let off = false;
    if (w > 0 && h > 0) {
      const cx = Math.min(w - HALF, Math.max(HALF, x));
      const cy = Math.min(h - HALF, Math.max(HALF, y));
      off = cx !== x || cy !== y;
      x = cx;
      y = cy;
    }
    dot.style.transform = `translate3d(${(x - HALF).toFixed(1)}px, ${(y - HALF).toFixed(1)}px, 0)${off ? ' scale(0.7)' : ''}`;
    dot.classList.add(`${P}is-on`);
    dot.classList.toggle(`${P}is-offscreen`, off);
  };
}

function readFlag(getSettings: () => AppSettings): boolean {
  try {
    return getSettings().showGazeDot === true;
  } catch {
    return false;
  }
}
