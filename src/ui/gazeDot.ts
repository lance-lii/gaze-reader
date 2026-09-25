import type { AppSettings, EventBus, GazeSample, LineEstimate, Mountable, Unsubscribe } from '../types';
import { CSS_PREFIX, IGNORE_ATTR, Z } from '../core/constants';
import { PINNED_MIN_PROBABILITY } from '../app/logic';

/**
 * A small, soft, semi-transparent dot that follows the smoothed gaze.
 * Positioned with a compositor-only transform once per animation frame, so it
 * never triggers layout. Hidden while the gaze is invalid; pinned (dimmed) to
 * the edge while the gaze is off-screen.
 *
 * By default the dot shows the gaze *as the reading layer sees it*: the
 * smoothed sample minus the vertical drift the line tracker has learned
 * (`LineEstimate.driftY`, from 'line-estimate' events). Under a lighting change
 * webcam gaze can sit lines away from the text; the tracker corrects for that,
 * and a dot at the uncorrected position would contradict the page turns the
 * reader sees. The debug overlay still shows the raw signal.
 */

export interface GazeDotOptions {
  bus: EventBus;
  getSettings: () => AppSettings;
  /** Subtract the line tracker's drift (default true). */
  correctDrift?: boolean;
}

/**
 * The reading layer's vertical drift, for showing gaze where the line tracker believes it is.
 *
 * Only a drift the tracker has pinned (a line with posterior ≥ PINNED_MIN_PROBABILITY) is trusted.
 * While the tracker is unsure, its drift is usually the drift of a wrong line, and following it
 * would put the dot 1.5+ lines from where the reader looks (measured: 3.7 % of reading fixations
 * at noise 1.6, 93 % of them on the wrong line, 97 % unpinned). So after a reset the correction
 * follows the tracker until its first pinned estimate, then holds the last pinned drift through
 * unpinned stretches. (Holding 0 until the first pin instead made constant lighting offsets worse:
 * −3 lines went from 1.8 % to 4.7 % of samples ≥ 1.5 lines off.)
 *
 * A drift not confirmed for `staleMs` (no estimate at all: the reader stopped reading) is dropped,
 * and `reset()` forgets it (a new calibration starts the drift over).
 */
export class DriftCorrection {
  private driftY = 0;
  private at = Number.NEGATIVE_INFINITY;
  /** A pinned estimate was seen since the last reset: unpinned drifts are no longer followed. */
  private pinnedSeen = false;

  constructor(private readonly staleMs = 30_000) {}

  noteEstimate(e: Pick<LineEstimate, 't' | 'driftY' | 'probability' | 'lineIndex'> | null | undefined): void {
    if (!e || !Number.isFinite(e.driftY) || !Number.isFinite(e.t)) return;
    const pinned = e.lineIndex >= 0 && e.probability >= PINNED_MIN_PROBABILITY;
    // Any estimate means the reader is still reading: staleness stays "stopped reading".
    this.at = e.t;
    if (pinned || !this.pinnedSeen) this.driftY = e.driftY;
    this.pinnedSeen ||= pinned;
  }

  reset(): void {
    this.driftY = 0;
    this.at = Number.NEGATIVE_INFINITY;
    this.pinnedSeen = false;
  }

  /** Drift (px, measured − true) to subtract from a sample taken at `t`; 0 when unknown or stale. */
  offsetAt(t: number): number {
    return Number.isFinite(t) && Math.abs(t - this.at) <= this.staleMs ? this.driftY : 0;
  }

  /** The sample with its vertical positions drift-corrected (the same object when there is nothing to correct). */
  correct(s: GazeSample): GazeSample {
    const d = this.offsetAt(s.t);
    return d === 0 ? s : { ...s, y: s.y - d, rawY: s.rawY - d };
  }
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
  private readonly drift: DriftCorrection | null;
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
    this.drift = opts.correctDrift === false ? null : new DriftCorrection();
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
        this.bus.on('line-estimate', (e) => this.drift?.noteEstimate(e)),
        // A new calibration starts the reading layer's drift over.
        this.bus.on('calibration', ({ phase }) => {
          if (phase === 'start') this.drift?.reset();
        }),
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
    this.latest = this.drift ? this.drift.correct(s) : s;
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
