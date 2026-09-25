import type {
  AppEvents,
  AppSettings,
  EventBus,
  Fixation,
  GazeSample,
  LineEstimate,
  LineLayout,
  Mountable,
  PageEndDecision,
  SaccadeKind,
  Unsubscribe,
} from '../types';
import { CSS_PREFIX, IGNORE_ATTR, Z } from '../core/constants';
import { FixationDetector, classifySaccade } from '../signal/fixations';
import { isTrackedLineEstimate } from '../reading/lineTracker';
import { pageEndZones } from '../reading/pageEndDetector';

/**
 * Full-viewport diagnostic overlay for the reading pipeline: raw and smoothed
 * gaze trails, the fixation in progress, the last fixations colored by saccade
 * kind, measured line boxes tinted by the tracker's posterior, the
 * drift-corrected gaze, the page-end zones, and a small legend panel.
 *
 * Everything it shows arrives on the bus (`gaze`, `fixation`, `line-estimate`,
 * `layout`, `page-end`, `settings-changed`, `lighting-state`,
 * `appearance-changed`, `accuracy-check`). The page-end detector's verdict on
 * every sample isn't a bus event, so the host may also pass decisions to
 * `showDecision` to see what the detector is waiting for, and the eyelid
 * monitor's state to `showAppearance`.
 *
 * With a tracked estimate (TrackedLineEstimate) it also shows the drift belief:
 * the 2–98 % range of vertical offsets the line tracker still allows, as a
 * bracket around the drift-corrected gaze and in the panel.
 *
 * Draws only while visible, at most once per animation frame, on a canvas
 * backed at devicePixelRatio. Never intercepts the pointer.
 */

export interface DebugOverlayOptions {
  bus: EventBus;
  getSettings: () => AppSettings;
}

/** The eyelid-appearance monitor as the panel shows it (src/gaze/appearance.ts). */
export interface AppearanceDebugInfo {
  /** Monitor state: off, learning, unknown, watching, shifting, settling. */
  state: string;
  /** Openness shift in robust SDs (negative = narrower), or null without data. */
  residualZ: number | null;
  /** eyeSquint shift in robust SDs, or null. */
  squintZ: number | null;
  /** Slow openness level relative to calibration (openness units). */
  levelVsCalibration: number;
}

const P = CSS_PREFIX;
/** Gaze trail length (samples) and how long a trail point stays visible. */
const TRAIL_MAX = 120;
const TRAIL_FADE_MS = 1500;
/** Consecutive valid samples further apart than this straddle a blink or dropout: the trail breaks. */
const TRAIL_GAP_MS = 250;
const HISTORY = 8;

export const SACCADE_COLORS: Readonly<Record<SaccadeKind | 'none', string>> = Object.freeze({
  forward: '#3b82f6',
  regression: '#f59e0b',
  'return-sweep': '#10b981',
  jump: '#ef4444',
  none: '#94a3b8',
});

/** Legend for the non-saccade marks; colors match what `frame()` draws. */
const MARK_KEYS: ReadonlyArray<readonly [label: string, color: string, shape: string]> = [
  ['gaze', '#ec4899', 'line'],
  ['raw', '#64748b', 'dot'],
  ['drift-corrected', '#10b981', 'cross'],
  ['fixation', '#0ea5e9', 'ring'],
  ['bottom-dwell zone', '#f59e0b', 'box'],
  ['glance zone', '#a855f7', 'box'],
];

const STYLE = `
.${P}debug-overlay {
  position: fixed; inset: 0; z-index: ${Z.debugOverlay};
  pointer-events: none; contain: strict;
}
.${P}debug-overlay[hidden] { display: none; }
.${P}debug-canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
.${P}debug-panel {
  position: absolute; bottom: 12px; left: 12px; max-width: min(420px, calc(100vw - 24px));
  padding: 8px 10px; border-radius: 8px;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--gr-fg, #1f2328);
  background: rgba(255, 255, 255, 0.86);
  background: color-mix(in srgb, var(--gr-surface, #ffffff) 86%, transparent);
  border: 1px solid var(--gr-border, rgba(0, 0, 0, 0.12));
  box-shadow: 0 4px 18px var(--gr-shadow, rgba(0, 0, 0, 0.12));
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.${P}debug-panel.${P}is-right { left: auto; right: 12px; }
.${P}debug-title { font-weight: 700; letter-spacing: 0.02em; margin-bottom: 2px; }
.${P}debug-keys { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; opacity: 0.85; }
.${P}debug-key::before {
  content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 4px;
  border-radius: 50%; background: var(--${P}key-color, #999); vertical-align: -1px;
}
.${P}debug-key[data-shape="line"]::before { width: 12px; height: 2px; border-radius: 1px; vertical-align: 2px; }
.${P}debug-key[data-shape="ring"]::before { background: none; border: 1.5px dashed var(--${P}key-color, #999); width: 6px; height: 6px; }
.${P}debug-key[data-shape="cross"]::before {
  content: '+'; background: none; width: auto; height: auto; border-radius: 0;
  color: var(--${P}key-color, #999); font-weight: 700; vertical-align: 0;
}
.${P}debug-key[data-shape="box"]::before { width: 10px; border-radius: 2px; opacity: 0.55; }
@media (prefers-color-scheme: dark) {
  .${P}debug-panel { color: var(--gr-fg, #e6e6e6); background: rgba(24, 26, 31, 0.86);
    background: color-mix(in srgb, var(--gr-surface, #181a1f) 86%, transparent); }
}
`;

interface TrailPoint {
  t: number;
  x: number;
  y: number;
  rawX: number;
  rawY: number;
}

interface HistoryEntry {
  fix: Fixation;
  kind: SaccadeKind | null;
}

export class DebugOverlay implements Mountable {
  private readonly bus: EventBus;
  private readonly getSettings: () => AppSettings;
  private root: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private panel: HTMLDivElement | null = null;
  private lines: { title: HTMLDivElement; body: HTMLDivElement } | null = null;
  private offs: Unsubscribe[] = [];
  private detachWindow: (() => void) | null = null;

  private hostVisible = true;
  private settingVisible: boolean;
  private raf: number | null = null;
  private destroyed = false;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private lastPanelText = '';

  private readonly trail: TrailPoint[] = [];
  private readonly history: HistoryEntry[] = [];
  private readonly detector = new FixationDetector();
  private current: Fixation | null = null;
  private lastGaze: GazeSample | null = null;
  private layout: LineLayout | null = null;
  private estimate: LineEstimate | null = null;
  private decision: PageEndDecision | null = null;
  private fired: { at: number; decision: PageEndDecision } | null = null;
  private lighting: AppEvents['lighting-state'] | null = null;
  private appearance: AppearanceDebugInfo | null = null;
  private lastChange: AppEvents['appearance-changed'] | null = null;
  private lastCheck: AppEvents['accuracy-check'] | null = null;

  constructor(opts: DebugOverlayOptions) {
    this.bus = opts.bus;
    this.getSettings = opts.getSettings;
    this.settingVisible = readSettings(opts.getSettings)?.showDebugOverlay === true;
  }

  get visible(): boolean {
    return this.hostVisible && this.settingVisible;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    if (this.destroyed) return;
    if (!this.root) this.build(parent.ownerDocument ?? document);
    parent.appendChild(this.root!);
    this.settingVisible = readSettings(this.getSettings)?.showDebugOverlay === true;
    this.placePanel();
    this.applyVisibility();
  }

  setVisible(v: boolean): void {
    this.hostVisible = v;
    this.applyVisibility();
  }

  /** Feed the page-end detector's decision for the latest sample (optional; shown in the panel). */
  showDecision(decision: PageEndDecision): void {
    this.decision = decision;
    this.schedule();
  }

  /** Feed the eyelid-appearance monitor's state (optional; shown in the panel). Null hides the row. */
  showAppearance(info: AppearanceDebugInfo | null): void {
    this.appearance = info;
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.detachWindow?.();
    this.detachWindow = null;
    this.cancelFrame();
    this.root?.remove();
    this.root = null;
    this.canvas = null;
    this.ctx = null;
    this.panel = null;
    this.lines = null;
    this.trail.length = 0;
    this.history.length = 0;
  }

  // ── setup ──

  private build(doc: Document): void {
    const root = doc.createElement('div');
    root.className = `${P}debug-overlay`;
    root.setAttribute(IGNORE_ATTR, '');
    root.setAttribute('aria-hidden', 'true');
    root.style.pointerEvents = 'none';
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const canvas = doc.createElement('canvas');
    canvas.className = `${P}debug-canvas`;
    const panel = doc.createElement('div');
    panel.className = `${P}debug-panel`;
    const title = doc.createElement('div');
    title.className = `${P}debug-title`;
    title.textContent = 'Gaze Reader · debug';
    const body = doc.createElement('div');
    const legendRow = (entries: ReadonlyArray<readonly [label: string, color: string, shape: string]>): HTMLDivElement => {
      const row = doc.createElement('div');
      row.className = `${P}debug-keys`;
      for (const [label, color, shape] of entries) {
        const k = doc.createElement('span');
        k.className = `${P}debug-key`;
        k.dataset['shape'] = shape;
        k.style.setProperty(`--${P}key-color`, color);
        k.textContent = label;
        row.appendChild(k);
      }
      return row;
    };
    const saccades = (['forward', 'regression', 'return-sweep', 'jump'] as const).map((k) => [k, SACCADE_COLORS[k], 'dot'] as const);
    panel.append(title, body, legendRow(saccades), legendRow(MARK_KEYS));
    root.append(style, canvas, panel);
    this.root = root;
    this.canvas = canvas;
    this.panel = panel;
    this.lines = { title, body };
    try {
      this.ctx = canvas.getContext('2d');
    } catch {
      this.ctx = null;
    }

    this.offs.push(
      this.bus.on('gaze', (s) => this.onGaze(s)),
      this.bus.on('fixation', (f) => this.onFixation(f)),
      this.bus.on('line-estimate', (e) => this.onEstimate(e)),
      this.bus.on('layout', (l) => {
        this.layout = l;
        this.schedule();
      }),
      this.bus.on('page-end', (d) => {
        this.fired = { at: this.lastGaze?.t ?? NaN, decision: d };
        this.schedule();
      }),
      this.bus.on('lighting-state', (s) => {
        this.lighting = s;
        this.schedule();
      }),
      this.bus.on('appearance-changed', (c) => {
        this.lastChange = c;
        this.schedule();
      }),
      this.bus.on('accuracy-check', (r) => {
        this.lastCheck = r;
        this.schedule();
      }),
      this.bus.on('settings-changed', ({ settings, changed }) => {
        if (changed.includes('showDebugOverlay')) {
          this.settingVisible = settings.showDebugOverlay;
          this.applyVisibility();
        }
        if (changed.includes('buddyCorner')) this.placePanel();
        this.schedule();
      }),
    );

    const win = doc.defaultView;
    if (win) {
      const onResize = (): void => {
        this.resize();
        this.schedule();
      };
      win.addEventListener('resize', onResize);
      // devicePixelRatio changes (zoom, moving to another monitor) don't always fire `resize`.
      let mql: MediaQueryList | null = null;
      const watchDpr = (): void => {
        mql?.removeEventListener('change', onDpr);
        mql = typeof win.matchMedia === 'function' ? win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`) : null;
        mql?.addEventListener('change', onDpr);
      };
      const onDpr = (): void => {
        watchDpr();
        onResize();
      };
      watchDpr();
      this.detachWindow = () => {
        win.removeEventListener('resize', onResize);
        mql?.removeEventListener('change', onDpr);
      };
    }
  }

  private placePanel(): void {
    const corner = readSettings(this.getSettings)?.buddyCorner ?? 'bottom-right';
    // Keep the panel clear of Dewey: the other bottom corner.
    this.panel?.classList.toggle(`${P}is-right`, corner.endsWith('left'));
  }

  private applyVisibility(): void {
    if (!this.root) return;
    const show = this.visible;
    this.root.hidden = !show;
    if (show) {
      this.resize();
      this.schedule();
    } else {
      this.cancelFrame();
    }
  }

  private resize(): void {
    const canvas = this.canvas;
    const win = canvas?.ownerDocument.defaultView;
    if (!canvas || !win) return;
    const dpr = Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
    const w = Math.max(0, Math.floor(win.innerWidth || 0));
    const h = Math.max(0, Math.floor(win.innerHeight || 0));
    if (w === this.width && h === this.height && dpr === this.dpr && canvas.width === Math.round(w * dpr)) return;
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  // ── inputs ──

  private onGaze(s: GazeSample): void {
    this.lastGaze = s;
    if (s.valid && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      this.trail.push({ t: s.t, x: s.x, y: s.y, rawX: s.rawX, rawY: s.rawY });
      if (this.trail.length > TRAIL_MAX) this.trail.splice(0, this.trail.length - TRAIL_MAX);
    }
    this.current = this.detector.push(s).current;
    this.schedule();
  }

  private onFixation(f: Fixation): void {
    const prev = this.history[this.history.length - 1];
    const kind = prev ? classifySaccade(prev.fix, f, this.layout) : null;
    this.history.push({ fix: f, kind });
    if (this.history.length > HISTORY) this.history.shift();
    this.schedule();
  }

  private onEstimate(e: LineEstimate): void {
    const changed = e.posterior !== this.estimate?.posterior;
    this.estimate = e;
    // The tracker's saccade kind (it knows the current line) supersedes our layout-only guess.
    const last = this.history[this.history.length - 1];
    if (changed && last && e.lastSaccade) last.kind = e.lastSaccade;
    this.schedule();
  }

  // ── drawing ──

  private schedule(): void {
    if (this.raf !== null || !this.root || !this.visible) return;
    const win = this.root.ownerDocument.defaultView ?? globalThis;
    this.raf = win.requestAnimationFrame(this.frame);
  }

  private cancelFrame(): void {
    if (this.raf === null) return;
    const win = this.root?.ownerDocument.defaultView ?? globalThis;
    win.cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private readonly frame = (): void => {
    this.raf = null;
    if (!this.visible) return;
    const ctx = this.ctx;
    if (ctx && this.width > 0 && this.height > 0) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      this.drawLines(ctx);
      this.drawZones(ctx);
      this.drawTrail(ctx);
      this.drawFixations(ctx);
      this.drawGaze(ctx);
    }
    this.updatePanel();
  };

  private drawLines(ctx: CanvasRenderingContext2D): void {
    const layout = this.layout;
    if (!layout) return;
    const est = this.estimate;
    const post = est && est.posterior.length === layout.lines.length ? est.posterior : null;
    const zones = pageEndZones(layout);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (const l of layout.lines) {
      const p = post?.[l.index] ?? 0;
      const w = l.right - l.left;
      const h = l.bottom - l.top;
      if (!(w > 0) || !(h > 0)) continue;
      ctx.fillStyle = `rgba(59, 130, 246, ${(0.04 + 0.4 * p).toFixed(3)})`;
      ctx.fillRect(l.left, l.top, w, h);
      ctx.setLineDash(l.fullyVisible ? [] : [3, 3]);
      ctx.strokeStyle = l.index === est?.lineIndex ? 'rgba(37, 99, 235, 0.9)' : 'rgba(100, 116, 139, 0.45)';
      ctx.strokeRect(l.left + 0.5, l.top + 0.5, w - 1, h - 1);
      ctx.fillStyle = 'rgba(100, 116, 139, 0.9)';
      const label = zones && l.index === zones.lastIndex ? `L ${l.index}` : `${l.index}`;
      ctx.fillText(label, Math.max(2, l.left - 34), l.centerY);
      if (p >= 0.05) ctx.fillText(p.toFixed(2), l.right + 6, l.centerY);
    }
    ctx.restore();
  }

  private drawZones(ctx: CanvasRenderingContext2D): void {
    const layout = this.layout;
    const zones = pageEndZones(layout);
    if (!layout || !zones) return;
    const drift = this.estimate?.driftY ?? 0;
    const bottom = layout.viewport.bottom;
    ctx.save();
    // Zones live in text coordinates; draw them where the (drifted) gaze has to be.
    const zoneTop = zones.zoneTop + drift;
    if (zoneTop < bottom) {
      ctx.fillStyle = 'rgba(245, 158, 11, 0.10)';
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
      ctx.setLineDash([6, 4]);
      const right = Math.min(zones.zoneRight, this.width);
      ctx.fillRect(zones.zoneLeft, zoneTop, right - zones.zoneLeft, bottom - zoneTop);
      ctx.strokeRect(zones.zoneLeft + 0.5, zoneTop + 0.5, right - zones.zoneLeft - 1, bottom - zoneTop - 1);
    }
    if (readSettings(this.getSettings)?.glanceDownToTurn !== false) {
      const glanceTop = Math.min(zones.glanceTop + drift, this.height - 4);
      ctx.fillStyle = 'rgba(168, 85, 247, 0.12)';
      ctx.fillRect(0, glanceTop, this.width, Math.max(4, this.height - glanceTop));
    }
    ctx.restore();
  }

  private drawTrail(ctx: CanvasRenderingContext2D): void {
    const trail = this.trail;
    if (trail.length === 0) return;
    const now = trail[trail.length - 1]!.t;
    ctx.save();
    for (const p of trail) {
      const a = 1 - (now - p.t) / TRAIL_FADE_MS;
      if (a <= 0 || !Number.isFinite(p.rawX) || !Number.isFinite(p.rawY)) continue;
      ctx.fillStyle = `rgba(100, 116, 139, ${(0.35 * a).toFixed(3)})`;
      ctx.fillRect(p.rawX - 1.5, p.rawY - 1.5, 3, 3);
    }
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = 1 - (now - trail[i]!.t) / TRAIL_FADE_MS;
      if (a <= 0 || trail[i]!.t - trail[i - 1]!.t > TRAIL_GAP_MS) continue;
      ctx.strokeStyle = `rgba(236, 72, 153, ${(0.7 * a).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1]!.x, trail[i - 1]!.y);
      ctx.lineTo(trail[i]!.x, trail[i]!.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFixations(ctx: CanvasRenderingContext2D): void {
    const h = this.history;
    ctx.save();
    ctx.lineWidth = 1.5;
    for (let i = 0; i < h.length; i++) {
      const { fix, kind } = h[i]!;
      const color = SACCADE_COLORS[kind ?? 'none'];
      const age = h.length - 1 - i;
      const alpha = 1 - age / (HISTORY + 1);
      if (i > 0) {
        const prev = h[i - 1]!.fix;
        ctx.globalAlpha = 0.5 * alpha;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(fix.x, fix.y);
        ctx.stroke();
      }
      const r = 4 + Math.sqrt(Math.max(0, fix.end - fix.start)) * 0.6;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color + '33';
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(fix.x, fix.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const cur = this.current;
    if (cur) {
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#0ea5e9';
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, 6 + Math.sqrt(Math.max(0, cur.end - cur.start)) * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawGaze(ctx: CanvasRenderingContext2D): void {
    const g = this.lastGaze;
    if (!g || !g.valid || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return;
    const drift = this.estimate?.driftY ?? 0;
    ctx.save();
    ctx.fillStyle = 'rgba(236, 72, 153, 0.9)';
    ctx.beginPath();
    ctx.arc(g.x, g.y, 4, 0, Math.PI * 2);
    ctx.fill();
    // Drift-corrected gaze: where the tracker thinks the eyes really are.
    const cy = g.y - drift;
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.95)';
    ctx.lineWidth = 1.5;
    if (Math.abs(drift) >= 1) {
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.moveTo(g.x - 7, cy);
    ctx.lineTo(g.x + 7, cy);
    ctx.moveTo(g.x, cy - 7);
    ctx.lineTo(g.x, cy + 7);
    ctx.stroke();
    // Drift belief: where the eyes may really be, for every offset the tracker still allows
    // (2–98 %). Wide after a page turn or an appearance change; narrow once the offset is learned.
    const range = driftRange(this.estimate);
    if (range) {
      const top = g.y - range.high;
      const bottom = g.y - range.low;
      if (bottom - top >= 2) {
        const x = g.x + 12;
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x - 4, top);
        ctx.lineTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.lineTo(x - 4, bottom);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private updatePanel(): void {
    const body = this.lines?.body;
    if (!body) return;
    const e = this.estimate;
    const layout = this.layout;
    const pitch = layout?.linePitch ?? 0;
    const zones = pageEndZones(layout);
    const out: string[] = [];
    if (e && e.lineIndex >= 0) {
      const of = zones ? ` (L=${zones.lastIndex})` : '';
      out.push(`line ${e.lineIndex}${of}  p ${e.probability.toFixed(2)}  x ${e.progressX.toFixed(2)}  ${e.lastSaccade ?? '–'}`);
      const sigma = isTrackedLineEstimate(e) ? e.sigmaYPx : NaN;
      const sigmaLines = pitch > 0 && Number.isFinite(sigma) ? ` (${(sigma / pitch).toFixed(2)} ln)` : '';
      out.push(
        `driftY ${signed(e.driftY)} px  σy ${Number.isFinite(sigma) ? sigma.toFixed(1) : '–'} px${sigmaLines}`,
      );
      const range = driftRange(e);
      if (range) {
        const inLines = (v: number): string => (pitch > 0 ? signed(v / pitch, 2) : '–');
        const sd = Number.isFinite(range.sd) && pitch > 0 ? `  sd ${(range.sd / pitch).toFixed(2)}` : '';
        out.push(`drift belief ${inLines(range.low)}…${inLines(range.high)} ln${sd}`);
      }
      const away = isTrackedLineEstimate(e) ? `  off-text ${e.excursions}` : '';
      out.push(`fixations on page ${e.fixationsOnPage}${away}`);
    } else {
      out.push(layout ? `${layout.lines.length} lines measured · waiting for fixations` : 'no layout yet');
    }
    const light = this.lighting;
    if (light) {
      const flags = light.flags.length > 0 ? light.flags.join(', ') : 'ok';
      const d = light.distance === null ? '–' : light.distance.toFixed(2);
      const changed = light.changedSinceCalibration ? `  CHANGED${light.dominant ? ` (${light.dominant})` : ''}` : '';
      out.push(`light ${flags}  D ${d}${changed}`);
    }
    const a = this.appearance;
    if (a) {
      const z = (v: number | null): string => (v === null || !Number.isFinite(v) ? '–' : signed(v, 1));
      out.push(`lids ${a.state}  z ${z(a.residualZ)}  squint z ${z(a.squintZ)}  level ${signed(a.levelVsCalibration, 3)}`);
    }
    const g0 = this.lastGaze;
    if (this.lastChange) {
      const ago = g0 ? (g0.t - this.lastChange.t) / 1000 : NaN;
      const when = Number.isFinite(ago) && ago >= 0 ? ` ${ago.toFixed(0)} s ago` : '';
      out.push(`appearance change${when}: ${this.lastChange.reason} · ${this.lastChange.detail}`);
    }
    if (this.lastCheck) {
      const c = this.lastCheck;
      out.push(`accuracy check: ${Number.isFinite(c.meanErrorPx) ? Math.round(c.meanErrorPx) : '–'} px, y ${signed(c.offsetYLines, 2)} ln${c.applied ? ' (applied)' : ''}`);
    }
    const g = this.lastGaze;
    if (g && !g.valid) out.push('gaze: invalid (no face / blink)');
    if (this.decision) out.push(`page-end: ${this.decision.detail}`);
    if (this.fired) {
      const ago = g ? (g.t - this.fired.at) / 1000 : NaN;
      const when = Number.isFinite(ago) && ago >= 0 ? ` ${ago.toFixed(1)} s ago` : '';
      out.push(`last turn${when}: ${this.fired.decision.reason} · ${this.fired.decision.detail}`);
    }
    const text = out.join('\n');
    if (text !== this.lastPanelText) {
      body.textContent = text;
      this.lastPanelText = text;
    }
  }
}

function readSettings(getSettings: () => AppSettings): AppSettings | null {
  try {
    return getSettings();
  } catch {
    return null;
  }
}

function signed(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '–';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

/** The tracker's drift belief (px), when the estimate carries it. */
export function driftRange(e: LineEstimate | null): { low: number; high: number; sd: number } | null {
  if (!isTrackedLineEstimate(e)) return null;
  const low = e.driftLowY;
  const high = e.driftHighY;
  if (low === undefined || high === undefined || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: Math.min(low, high), high: Math.max(low, high), sd: e.driftSdY ?? NaN };
}
