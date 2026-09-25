import { IGNORE_ATTR, Z } from '../core/constants';
import type { Mountable } from '../types';
import { icon } from './topbar';

/** What the preview needs from CameraFeatureSource (kept structural so tests/mocks are easy). */
export interface PreviewSource {
  readonly running: boolean;
  readonly video: HTMLVideoElement | null;
  readonly lastLandmarks: readonly { x: number; y: number }[] | null;
}

export type PreviewCorner = 'bottom-left' | 'bottom-right';

// MediaPipe face-mesh indices. A sparse subset reads better at thumbnail size than all 478 points.
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const EYES = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const IRIS_CENTERS = [468, 473];

const ASPECT = 4 / 3;

/**
 * A small mirrored camera thumbnail with the tracked eye points, so the reader
 * can see what the tracker sees. It never leaves the page: it is drawn from the
 * same local video element the face tracker reads.
 */
export class CameraPreview implements Mountable {
  private readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly lost: HTMLElement;
  private source: PreviewSource | null = null;
  private visible = false;
  private raf = 0;
  private lastVideoTime = -1;
  private lastLandmarks: PreviewSource['lastLandmarks'] = null;
  private cssW = 0;
  private cssH = 0;
  /** The canvas box needs measuring (first draw, or it was resized). Avoids a layout read per frame. */
  private sizeDirty = true;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(opts: { onHide: () => void }) {
    const el = document.createElement('figure');
    el.className = 'gr-preview';
    el.setAttribute(IGNORE_ATTR, '');
    // Above the reader chrome, below Dewey and the gaze dot.
    el.style.zIndex = String(Z.chrome + 1);
    el.setAttribute('aria-label', 'Camera preview');
    el.hidden = true;
    el.dataset.corner = 'bottom-left';
    el.innerHTML = `
      <div class="gr-preview__frame">
        <canvas class="gr-preview__canvas" role="img" aria-label="Mirrored camera preview with the tracked eye points"></canvas>
        <span class="gr-preview__lost" hidden>Looking for you…</span>
        <button type="button" class="gr-btn gr-btn--icon gr-preview__close" aria-label="Hide camera preview" title="Hide preview">${icon('close')}</button>
      </div>
      <figcaption class="gr-preview__caption"><span class="gr-preview__rec" aria-hidden="true"></span>Camera on · only you can see this</figcaption>`;
    this.el = el;
    this.canvas = el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.lost = el.querySelector('.gr-preview__lost')!;
    el.querySelector('.gr-preview__close')!.addEventListener('click', () => opts.onHide());
    this.resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            this.sizeDirty = true;
            // Redraw even if the video hasn't advanced, or the resized canvas stays blank.
            this.lastVideoTime = -1;
          })
        : null;
    this.resizeObserver?.observe(this.canvas);
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    parent.appendChild(this.el);
  }

  attach(source: PreviewSource | null): void {
    if (source === this.source) return;
    this.source = source;
    this.lastVideoTime = -1;
    this.lastLandmarks = null;
    this.sync();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.sync();
  }

  setCorner(corner: PreviewCorner): void {
    this.el.dataset.corner = corner;
  }

  destroy(): void {
    this.stopLoop();
    this.resizeObserver?.disconnect();
    this.source = null;
    this.el.remove();
  }

  private sync(): void {
    const show = this.visible && this.source !== null && this.ctx !== null;
    const wasHidden = this.el.hidden;
    this.el.hidden = !show;
    if (show) {
      // Its box may have changed while hidden (corner, viewport width); redraw on the next frame.
      if (wasHidden) {
        this.sizeDirty = true;
        this.lastVideoTime = -1;
      }
      this.startLoop();
    } else {
      this.stopLoop();
    }
  }

  private startLoop(): void {
    if (this.raf !== 0) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const src = this.source;
    const ctx = this.ctx;
    if (!src || !ctx) return;
    const video = src.video;
    const ready = src.running && video !== null && video.readyState >= 2 && video.videoWidth > 0;
    const landmarks = src.lastLandmarks;
    this.lost.hidden = !ready || (landmarks !== null && landmarks.length > 0);
    if (!ready || !video) return;
    if (video.currentTime === this.lastVideoTime && landmarks === this.lastLandmarks) return;
    this.lastVideoTime = video.currentTime;
    this.lastLandmarks = landmarks;

    this.fitCanvas();
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;

    // Cover-crop the video to the thumbnail's aspect ratio.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let sw = vw;
    let sh = vh;
    if (vw / vh > ASPECT) sw = vh * ASPECT;
    else sh = vw / ASPECT;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;

    ctx.save();
    // Mirror, so moving left moves left — what people expect from a selfie view.
    ctx.setTransform(-1, 0, 0, 1, W, 0);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
    if (landmarks && landmarks.length > 0) {
      const scale = W / this.cssW || 1;
      const toCanvas = (i: number): [number, number] | null => {
        const p = landmarks[i];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        return [((p.x * vw - sx) / sw) * W, ((p.y * vh - sy) / sh) * H];
      };
      const dots = (indices: readonly number[], r: number, fill: string) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        for (const i of indices) {
          const c = toCanvas(i);
          if (!c) continue;
          ctx.moveTo(c[0] + r, c[1]);
          ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
        }
        ctx.fill();
      };
      dots(FACE_OVAL, 0.9 * scale, 'rgba(255,255,255,0.55)');
      dots(EYES, 0.9 * scale, 'rgba(125, 242, 200, 0.95)');
      ctx.strokeStyle = 'rgba(255, 214, 102, 0.95)';
      ctx.lineWidth = 1.2 * scale;
      for (const i of IRIS_CENTERS) {
        const c = toCanvas(i);
        if (!c) continue;
        ctx.beginPath();
        ctx.arc(c[0], c[1], 2.4 * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private fitCanvas(): void {
    // Without a ResizeObserver, fall back to measuring every drawn frame.
    if (!this.sizeDirty && this.resizeObserver) return;
    this.sizeDirty = false;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === this.cssW && h === this.cssH) return;
    this.cssW = w;
    this.cssH = h;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(0, Math.round(w * dpr));
    this.canvas.height = Math.max(0, Math.round(h * dpr));
  }
}
