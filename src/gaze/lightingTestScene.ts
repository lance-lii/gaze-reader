/**
 * Test support for lighting.ts (not part of the app): a flat-shaded synthetic
 * face with the MediaPipe landmark indices the lighting regions use, and fake
 * VideoFrame / video / canvas objects that serve its pixels.
 *
 * Every surface is one grey level, so each statistic has an exact expected
 * value (grey → the same luma through the RGB formula and through Y).
 */
import {
  FACE_OVAL,
  LEFT_EYE_CONTOUR,
  LEFT_IRIS,
  RIGHT_EYE_CONTOUR,
  RIGHT_IRIS,
  type Canvas2DLike,
  type RectInit,
  type VideoFrameLike,
} from './lighting';

export interface SceneSpec {
  W: number;
  H: number;
  /** Eye midpoint, px. */
  cx: number;
  cy: number;
  /** Distance between the eye centres, px. */
  D: number;
  /** Grey codes. `skinR` paints the subject's right half of the face (image left, unmirrored). */
  skinR: number;
  skinL: number;
  /** Colour for the whole face instead of the grey levels (e.g. red-clipped skin). */
  skinRgb: readonly [number, number, number] | null;
  sclera: number;
  iris: number;
  bg: number;
  /** Lid aperture / eye width. */
  openness: number;
  /** A saturated disc (a glasses reflection) near each listed eye: centre offset and radius in eye widths. */
  glare: { eyes: ('R' | 'L')[]; dx: number; dy: number; r: number } | null;
  /** Radius (fraction of the iris radius) of a saturated glint at the iris centre, both eyes. */
  irisGlint: number;
  /** A background patch (a window or lamp), px, with its grey code. */
  patch: { x: number; y: number; w: number; h: number; value: number } | null;
}

export const DEFAULT_SCENE: Readonly<SceneSpec> = Object.freeze({
  W: 640,
  H: 480,
  cx: 320,
  cy: 200,
  D: 70,
  skinR: 150,
  skinL: 150,
  skinRgb: null,
  sclera: 200,
  iris: 60,
  bg: 110,
  openness: 0.3,
  glare: null,
  irisGlint: 0,
  patch: null,
});

export interface Scene {
  spec: SceneSpec;
  W: number;
  H: number;
  rgba: Uint8ClampedArray;
  landmarks: { x: number; y: number; z: number }[];
}

interface P {
  x: number;
  y: number;
}

/** Renders the scene and its landmarks (normalized coordinates, not mirrored). */
export function renderScene(partial: Partial<SceneSpec> = {}): Scene {
  const s: SceneSpec = { ...DEFAULT_SCENE, ...partial };
  const { W, H, cx, cy, D } = s;
  const We = 0.45 * D; // eye width
  const a = We / 2;
  const b = (s.openness * We) / 2;
  const ri = 0.2 * We;
  const eyeR: P = { x: cx - D / 2, y: cy }; // subject's right eye is on the image left
  const eyeL: P = { x: cx + D / 2, y: cy };
  const oval = { x: cx, y: cy + 0.45 * D, A: 1.05 * D, B: 1.45 * D };

  const lm: P[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy + 0.4 * D }));
  FACE_OVAL.forEach((idx, k) => {
    const phi = -Math.PI / 2 + (2 * Math.PI * k) / FACE_OVAL.length;
    lm[idx] = { x: oval.x + oval.A * Math.cos(phi), y: oval.y + oval.B * Math.sin(phi) };
  });
  // Contours: outer corner, 7 upper-lid points, inner corner, 7 lower-lid points.
  const contour = (ids: readonly number[], c: P, outerOnLeft: boolean): void => {
    ids.forEach((idx, k) => {
      const theta = outerOnLeft ? Math.PI - (k * Math.PI) / 8 : (k * Math.PI) / 8;
      lm[idx] = { x: c.x + a * Math.cos(theta), y: c.y - b * Math.sin(theta) };
    });
  };
  contour(RIGHT_EYE_CONTOUR, eyeR, true);
  contour(LEFT_EYE_CONTOUR, eyeL, false);
  const iris = (ids: { center: number; ring: readonly number[] }, c: P): void => {
    lm[ids.center] = { ...c };
    const offs: P[] = [
      { x: ri, y: 0 },
      { x: 0, y: -ri },
      { x: -ri, y: 0 },
      { x: 0, y: ri },
    ];
    ids.ring.forEach((idx, k) => {
      lm[idx] = { x: c.x + offs[k].x, y: c.y + offs[k].y };
    });
  };
  iris(RIGHT_IRIS, eyeR);
  iris(LEFT_IRIS, eyeL);

  const rgba = new Uint8ClampedArray(W * H * 4);
  const inEllipse = (x: number, y: number, c: P, rx: number, ry: number): boolean => ((x - c.x) / rx) ** 2 + ((y - c.y) / ry) ** 2 <= 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let v = s.bg;
      let rgb: readonly [number, number, number] | null = null;
      if (s.patch && px >= s.patch.x && px < s.patch.x + s.patch.w && py >= s.patch.y && py < s.patch.y + s.patch.h) v = s.patch.value;
      if (inEllipse(px, py, oval, oval.A, oval.B)) {
        v = px < cx ? s.skinR : s.skinL;
        rgb = s.skinRgb;
      }
      for (const [c, side] of [
        [eyeR, 'R'],
        [eyeL, 'L'],
      ] as const) {
        if (inEllipse(px, py, c, a, b)) {
          v = inEllipse(px, py, c, ri, ri) ? s.iris : s.sclera;
          rgb = null;
        }
        if (s.irisGlint > 0 && inEllipse(px, py, c, ri * s.irisGlint, ri * s.irisGlint)) v = 255;
        const g = s.glare;
        if (g && g.eyes.includes(side)) {
          const lateral = side === 'R' ? -1 : 1; // + dx = toward the ear
          if (inEllipse(px, py, { x: c.x + lateral * g.dx * We, y: c.y + g.dy * We }, g.r * We, g.r * We)) {
            v = 255;
            rgb = null;
          }
        }
      }
      const i = (y * W + x) * 4;
      rgba[i] = rgb ? rgb[0] : v;
      rgba[i + 1] = rgb ? rgb[1] : v;
      rgba[i + 2] = rgb ? rgb[2] : v;
      rgba[i + 3] = 255;
    }
  }
  return { spec: s, W, H, rgba, landmarks: lm.map((p) => ({ x: p.x / W, y: p.y / H, z: 0 })) };
}

// ─────────────────────────────── fake media ───────────────────────────────

export type FakeFormat = 'RGBA' | 'BGRA' | 'NV12' | 'I420' | 'I420P10';

/** Pixel sources known to the fake canvas (a fake video, frame or canvas → its RGBA). */
const SOURCES = new WeakMap<object, { rgba: Uint8ClampedArray; W: number; H: number }>();

export interface FrameRegistry {
  clones: number;
  closes: number;
  copies: number;
  /** Frames (original + clones) not yet closed. */
  open: Set<FakeVideoFrame>;
}

export interface FakeFrameOptions {
  format: FakeFormat;
  fullRange: boolean | null;
  /** 'resolve' (default), 'never' (the promise hangs), 'reject', or 'throw' (copyTo throws synchronously). */
  copy: 'resolve' | 'never' | 'reject' | 'throw';
  /** Extra bytes per row in the returned layout (checks that the probe uses PlaneLayout). */
  rowPadding: number;
}

/** A VideoFrame stand-in over a rendered scene. copyTo validates like the real one and copies on a microtask. */
export class FakeVideoFrame implements VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: { x: number; y: number; width: number; height: number };
  private readonly fmt: string;
  readonly colorSpace: { fullRange: boolean | null };
  closed = false;

  constructor(
    readonly scene: Scene,
    readonly opts: FakeFrameOptions,
    readonly registry: FrameRegistry = { clones: 0, closes: 0, copies: 0, open: new Set() },
  ) {
    this.displayWidth = scene.W;
    this.displayHeight = scene.H;
    this.codedWidth = scene.W;
    this.codedHeight = scene.H;
    this.visibleRect = { x: 0, y: 0, width: scene.W, height: scene.H };
    this.fmt = opts.format;
    this.colorSpace = { fullRange: opts.fullRange };
    registry.open.add(this);
    SOURCES.set(this, { rgba: scene.rgba, W: scene.W, H: scene.H });
  }

  /** Like WebCodecs: a closed frame reports no format. */
  get format(): string | null {
    return this.closed ? null : this.fmt;
  }

  clone(): FakeVideoFrame {
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    this.registry.clones++;
    return new FakeVideoFrame(this.scene, this.opts, this.registry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.registry.closes++;
    this.registry.open.delete(this);
  }

  private planes(rect: RectInit): { rowBytes: number; rows: number }[] {
    const yuv = this.fmt !== 'RGBA' && this.fmt !== 'BGRA';
    if (yuv && (rect.x % 2 || rect.y % 2 || rect.width % 2 || rect.height % 2)) throw new TypeError('rect not aligned to 4:2:0');
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > this.codedWidth || rect.y + rect.height > this.codedHeight) {
      throw new TypeError('rect out of bounds');
    }
    const pad = this.opts.rowPadding;
    if (!yuv) return [{ rowBytes: rect.width * 4 + pad, rows: rect.height }];
    const cw = rect.width / 2;
    const ch = rect.height / 2;
    return this.fmt === 'NV12'
      ? [
          { rowBytes: rect.width + pad, rows: rect.height },
          { rowBytes: 2 * cw, rows: ch },
        ]
      : [
          { rowBytes: rect.width + pad, rows: rect.height },
          { rowBytes: cw, rows: ch },
          { rowBytes: cw, rows: ch },
        ];
  }

  allocationSize(options: { rect: RectInit }): number {
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    return this.planes(options.rect).reduce((n, p) => n + p.rowBytes * p.rows, 0);
  }

  copyTo(destination: Uint8Array, options: { rect: RectInit }): Promise<{ offset: number; stride: number }[]> {
    if (this.opts.copy === 'throw') throw new TypeError('copyTo unsupported');
    if (this.closed) return Promise.reject(new DOMException('closed', 'InvalidStateError'));
    const rect = options.rect;
    const planes = this.planes(rect);
    const size = planes.reduce((n, p) => n + p.rowBytes * p.rows, 0);
    if (destination.length < size) return Promise.reject(new TypeError('destination too small'));
    if (this.opts.copy === 'never') return new Promise(() => undefined);
    if (this.opts.copy === 'reject') return Promise.reject(new DOMException('not supported', 'NotSupportedError'));
    this.registry.copies++;
    const { rgba, W } = this.scene;
    const kind = this.fmt;
    const full = this.opts.fullRange === true;
    return Promise.resolve().then(() => {
      if (this.closed) throw new DOMException('closed', 'InvalidStateError');
      const stride = planes[0].rowBytes;
      if (kind === 'NV12' || kind === 'I420') writeChroma(destination, planes, rect, rgba, W, kind, full);
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const si = ((rect.y + y) * W + rect.x + x) * 4;
          if (kind === 'RGBA' || kind === 'BGRA') {
            const di = y * stride + x * 4;
            destination[di] = kind === 'RGBA' ? rgba[si] : rgba[si + 2];
            destination[di + 1] = rgba[si + 1];
            destination[di + 2] = kind === 'RGBA' ? rgba[si + 2] : rgba[si];
            destination[di + 3] = 255;
          } else {
            const Y = 0.299 * rgba[si] + 0.587 * rgba[si + 1] + 0.114 * rgba[si + 2]; // BT.601, as a camera's YUV carries it
            destination[y * stride + x] = Math.round(full ? Y : 16 + (Y * 219) / 255);
          }
        }
      }
      let offset = 0;
      return planes.map((p) => {
        const layout = { offset, stride: p.rowBytes };
        offset += p.rowBytes * p.rows;
        return layout;
      });
    });
  }
}

/** BT.601 Cb/Cr of each 2×2 block (its top-left pixel), as a camera's 4:2:0 frame carries them. */
function writeChroma(
  dest: Uint8Array,
  planes: { rowBytes: number; rows: number }[],
  rect: RectInit,
  rgba: Uint8ClampedArray,
  W: number,
  kind: 'NV12' | 'I420',
  full: boolean,
): void {
  const k = full ? 1 : 224 / 255;
  const yBytes = planes[0].rowBytes * planes[0].rows;
  for (let cy = 0; cy < rect.height / 2; cy++) {
    for (let cx = 0; cx < rect.width / 2; cx++) {
      const si = ((rect.y + 2 * cy) * W + rect.x + 2 * cx) * 4;
      const r = rgba[si];
      const g = rgba[si + 1];
      const b = rgba[si + 2];
      const cb = Math.round(128 + k * (-0.168736 * r - 0.331264 * g + 0.5 * b));
      const cr = Math.round(128 + k * (0.5 * r - 0.418688 * g - 0.081312 * b));
      if (kind === 'NV12') {
        const o = yBytes + cy * planes[1].rowBytes + 2 * cx;
        dest[o] = cb;
        dest[o + 1] = cr;
      } else {
        dest[yBytes + cy * planes[1].rowBytes + cx] = cb;
        dest[yBytes + planes[1].rowBytes * planes[1].rows + cy * planes[2].rowBytes + cx] = cr;
      }
    }
  }
}

/** A `<video>` stand-in (videoWidth/videoHeight + pixels for the fake canvas). */
export function fakeVideo(scene: Scene): HTMLVideoElement {
  const v = { videoWidth: scene.W, videoHeight: scene.H };
  SOURCES.set(v, { rgba: scene.rgba, W: scene.W, H: scene.H });
  return v as unknown as HTMLVideoElement;
}

export interface CanvasLog {
  created: { w: number; h: number }[];
  draws: number;
  reads: number;
}

/** A 2D context stand-in: drawImage resamples with a box filter (like a smoothed downscale), getImageData copies out. */
export class FakeCanvas implements Canvas2DLike {
  readonly canvas: CanvasImageSource & { width: number; height: number };
  private data: Uint8ClampedArray;

  constructor(
    w: number,
    h: number,
    private readonly log: CanvasLog,
  ) {
    const surface = { width: w, height: h };
    this.canvas = surface as unknown as CanvasImageSource & { width: number; height: number };
    this.data = new Uint8ClampedArray(w * h * 4);
    SOURCES.set(surface, { rgba: this.data, W: w, H: h });
    log.created.push({ w, h });
  }

  drawImage(image: CanvasImageSource, ...args: number[]): void {
    const src = SOURCES.get(image as object);
    if (!src) throw new TypeError('unknown image source');
    if (src.rgba === this.data) throw new TypeError('drawing a canvas onto itself');
    if (image instanceof FakeVideoFrame && image.closed) throw new DOMException('closed', 'InvalidStateError');
    this.log.draws++;
    let sx = 0;
    let sy = 0;
    let sw = src.W;
    let sh = src.H;
    let dx: number;
    let dy: number;
    let dw = src.W;
    let dh = src.H;
    if (args.length === 2) [dx, dy] = args;
    else [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    const W = this.canvas.width;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const x0 = sx + (x * sw) / dw;
        const x1 = sx + ((x + 1) * sw) / dw;
        const y0 = sy + (y * sh) / dh;
        const y1 = sy + ((y + 1) * sh) / dh;
        let r = 0;
        let g = 0;
        let bl = 0;
        let n = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            if (xx < 0 || yy < 0 || xx >= src.W || yy >= src.H) continue;
            const i = (yy * src.W + xx) * 4;
            r += src.rgba[i];
            g += src.rgba[i + 1];
            bl += src.rgba[i + 2];
            n++;
          }
        }
        const tx = dx + x;
        const ty = dy + y;
        if (n === 0 || tx < 0 || ty < 0 || tx >= W || ty >= this.canvas.height) continue;
        const o = (ty * W + tx) * 4;
        this.data[o] = Math.round(r / n);
        this.data[o + 1] = Math.round(g / n);
        this.data[o + 2] = Math.round(bl / n);
        this.data[o + 3] = 255;
      }
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray } {
    this.log.reads++;
    const out = new Uint8ClampedArray(sw * sh * 4);
    const W = this.canvas.width;
    for (let y = 0; y < sh; y++) out.set(this.data.subarray(((sy + y) * W + sx) * 4, ((sy + y) * W + sx + sw) * 4), y * sw * 4);
    return { data: out };
  }
}

/** sRGB code → linear, for expectations. */
export function lin(code: number): number {
  const c = code / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
