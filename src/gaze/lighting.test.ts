import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EyeFeatures, FeatureFrame, LightingSignature, LightingStats } from '../types';
import {
  ATLAS_H,
  ATLAS_W,
  LIGHTING_COMPONENTS,
  LIGHTING_STAT_KEYS,
  LIGHTING_TOLERANCE,
  LightingMonitor,
  LightingProbe,
  LightingWatch,
  MIN_SIGNATURE_SAMPLES,
  WATCH_MIN_SAMPLES,
  MeasureScratch,
  PROBE_SAFETY_CLOSE_MS,
  RegionAcc,
  SRGB_TO_LINEAR,
  Y_FULL_RANGE,
  Y_LIMITED_RANGE,
  accPolygon,
  accRect,
  atlasLayout,
  buildLightingSignature,
  compareLightingSignatures,
  lightingGeometry,
  lightingSignatureVector,
  measureAtlas,
  measureViews,
  parseLightingSignature,
  relativeLuminance,
  screenExplainsChange,
  screenStops,
  chromaTableFor,
  pixelKindOf,
  planCopyRects,
  yTableFor,
  type LightingGeometry,
  type ChromaView,
  type LightingComparison,
  type LightingSample,
  type PixelKind,
  type PixelView,
} from './lighting';
import {
  FakeCanvas,
  FakeVideoFrame,
  fakeVideo,
  lin,
  renderScene,
  type CanvasLog,
  type FakeFormat,
  type FrameRegistry,
  type Scene,
  type SceneSpec,
} from './lightingTestScene';

// ─────────────────────────────── helpers ───────────────────────────────

const EPS = 1 / 1024;
const log2r = (a: number, b: number): number => Math.log2((a + EPS) / (b + EPS));

function uniform(w: number, h: number, v: number): PixelView {
  const data = new Uint8ClampedArray(w * h * 4).fill(v);
  return { data, offset: 0, stride: w * 4, w, h, x0: 0, y0: 0, kind: 'rgba' };
}

/** Views as copyTo would return them for a frame of the given kind (tightly packed plane 0). */
/**
 * Views as copyTo would return them for a frame of the given kind (tightly packed).
 * 'y' views are NV12: the luma plane, then interleaved Cb/Cr (unless `chroma` is false).
 */
function viewsFor(scene: Scene, g: LightingGeometry, kind: PixelKind, fullRange: boolean, chroma = true) {
  const plan = planCopyRects(g);
  const cut = (r: { x: number; y: number; w: number; h: number }): PixelView => {
    const bpp = kind === 'y' ? 1 : 4;
    const data = new Uint8Array(r.w * r.h * bpp + (kind === 'y' ? r.w * (r.h / 2) : 0));
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const si = ((r.y + y) * scene.W + r.x + x) * 4;
        if (kind === 'y') {
          const Y = 0.299 * scene.rgba[si] + 0.587 * scene.rgba[si + 1] + 0.114 * scene.rgba[si + 2];
          data[y * r.w + x] = Math.round(fullRange ? Y : 16 + (Y * 219) / 255);
        } else {
          const di = (y * r.w + x) * 4;
          data[di] = kind === 'rgba' ? scene.rgba[si] : scene.rgba[si + 2];
          data[di + 1] = scene.rgba[si + 1];
          data[di + 2] = kind === 'rgba' ? scene.rgba[si + 2] : scene.rgba[si];
          data[di + 3] = 255;
        }
      }
    }
    if (kind !== 'y' || !chroma) return { data, offset: 0, stride: r.w * bpp, w: r.w, h: r.h, x0: r.x, y0: r.y, kind };
    const k = fullRange ? 1 : 224 / 255;
    const uv = r.w * r.h;
    for (let cy = 0; cy < r.h / 2; cy++) {
      for (let cx = 0; cx < r.w / 2; cx++) {
        const si = ((r.y + 2 * cy) * scene.W + r.x + 2 * cx) * 4;
        const [R, G, B] = [scene.rgba[si], scene.rgba[si + 1], scene.rgba[si + 2]];
        data[uv + cy * r.w + 2 * cx] = Math.round(128 + k * (-0.168736 * R - 0.331264 * G + 0.5 * B));
        data[uv + cy * r.w + 2 * cx + 1] = Math.round(128 + k * (0.5 * R - 0.418688 * G - 0.081312 * B));
      }
    }
    const c: ChromaView = { offset: uv, stride: r.w, step: 2, cb: 0, cr: 1, lut: chromaTableFor(fullRange) };
    return { data, offset: 0, stride: r.w, w: r.w, h: r.h, x0: r.x, y0: r.y, kind, chroma: c };
  };
  return { face: cut(plan.face), eyes: [cut(plan.eyes[0]), cut(plan.eyes[1])] as const, bg: plan.bg.map(cut) };
}

function measureScene(scene: Scene, kind: PixelKind = 'rgba', fullRange = true, chroma = true): LightingStats | null {
  const g = lightingGeometry(scene.landmarks, scene.W, scene.H);
  if (!g) return null;
  return measureViews(g, viewsFor(scene, g, kind, fullRange, chroma), fullRange ? Y_FULL_RANGE : Y_LIMITED_RANGE);
}

function measureSceneAtlas(scene: Scene): LightingStats | null {
  const g = lightingGeometry(scene.landmarks, scene.W, scene.H);
  if (!g) return null;
  const log: CanvasLog = { created: [], draws: 0, reads: 0 };
  const atlas = new FakeCanvas(ATLAS_W, ATLAS_H, log);
  const layout = atlasLayout(g);
  const video = fakeVideo(scene);
  for (const c of [layout.face, layout.thumb, layout.eyes[0], layout.eyes[1]]) {
    atlas.drawImage(video, c.src.x, c.src.y, c.src.w, c.src.h, c.dst.x, c.dst.y, c.dst.w, c.dst.h);
  }
  return measureAtlas(atlas.getImageData(0, 0, ATLAS_W, ATLAS_H).data, g, layout);
}

function features(overrides: Partial<EyeFeatures> = {}): EyeFeatures {
  return {
    vector: [0],
    headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 },
    blink: 0.1,
    openness: 0.3,
    faceScale: 0.11,
    faceCenter: { x: 0.5, y: 0.5 },
    ...overrides,
  };
}

const BASE_STATS: LightingStats = {
  faceLuma: 0.5,
  faceLin: 0.2,
  faceRange: 1.5,
  faceClip: 0,
  frameLin: 0.18,
  bgLin: 0.18,
  bgClip: 0,
  scleraR: 0.3,
  scleraL: 0.3,
  backlight: 1.2,
  side: 0.1,
  shade: -0.8,
  glareR: 0.001,
  glareL: 0.001,
  irisGlintR: 0,
  irisGlintL: 0,
  facePx: 5000,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────── pure parts ───────────────────────────────

describe('lookup tables and formats', () => {
  it('decodes sRGB exactly at known points', () => {
    expect(SRGB_TO_LINEAR[0]).toBe(0);
    expect(SRGB_TO_LINEAR[255]).toBeCloseTo(1, 6);
    expect(SRGB_TO_LINEAR[188]).toBeCloseTo(0.5029, 3);
    expect(SRGB_TO_LINEAR[10]).toBeCloseTo(10 / 255 / 12.92, 6);
  });

  it('expands limited-range luma, and assumes limited range when the frame does not say', () => {
    expect([Y_LIMITED_RANGE[16], Y_LIMITED_RANGE[235], Y_LIMITED_RANGE[0], Y_LIMITED_RANGE[255]]).toEqual([0, 255, 0, 255]);
    expect(Y_LIMITED_RANGE[126]).toBe(128);
    expect(yTableFor(true)).toBe(Y_FULL_RANGE);
    expect(yTableFor(false)).toBe(Y_LIMITED_RANGE);
    expect(yTableFor(null)).toBe(Y_LIMITED_RANGE);
  });

  it('reads 8-bit YUV planes as luma and RGB(X)/BGR(X) as colour; rejects everything else', () => {
    for (const f of ['NV12', 'I420', 'I420A', 'I422', 'I444']) expect(pixelKindOf(f)).toBe('y');
    expect(pixelKindOf('RGBX')).toBe('rgba');
    expect(pixelKindOf('BGRA')).toBe('bgra');
    for (const f of ['I420P10', 'NV12A', null, undefined, '']) expect(pixelKindOf(f)).toBeNull();
  });
});

describe('rasterization', () => {
  const v = uniform(64, 64, 100);
  const lut = Y_FULL_RANGE;
  it('counts pixel centres inside an axis-aligned square exactly', () => {
    const acc = new RegionAcc();
    const sq = [
      { x: 10.2, y: 10.2 },
      { x: 30.7, y: 10.2 },
      { x: 30.7, y: 30.7 },
      { x: 10.2, y: 30.7 },
    ];
    accPolygon(v, sq, acc, lut);
    expect(acc.n).toBe(21 * 21);
    const every2 = new RegionAcc();
    accPolygon(v, sq, every2, lut, 2);
    expect(every2.n).toBe(11 * 11); // even rows/columns 10…30
  });

  it('approximates the area of a rotated square and a 16-gon', () => {
    const c = { x: 32, y: 32 };
    const r = 20;
    const sq = [0, 1, 2, 3].map((k) => ({ x: c.x + r * Math.cos(Math.PI / 4 + (k * Math.PI) / 2), y: c.y + r * Math.sin(Math.PI / 4 + (k * Math.PI) / 2) }));
    const a1 = new RegionAcc();
    accPolygon(v, sq, a1, lut);
    expect(Math.abs(a1.n - 2 * r * r) / (2 * r * r)).toBeLessThan(0.03);
    const g16 = Array.from({ length: 16 }, (_, k) => ({ x: c.x + r * Math.cos((2 * Math.PI * k) / 16), y: c.y + r * Math.sin((2 * Math.PI * k) / 16) }));
    const a2 = new RegionAcc();
    accPolygon(v, g16, a2, lut);
    const exact = 8 * r * r * Math.sin((2 * Math.PI) / 16);
    expect(Math.abs(a2.n - exact) / exact).toBeLessThan(0.02);
  });

  it('clips to a cell and honours a view offset', () => {
    const acc = new RegionAcc();
    const big = [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ];
    accPolygon(v, big, acc, lut, 1, { x0: 0, y0: 0, x1: 5, y1: 5 });
    expect(acc.n).toBe(25);
    // A view whose pixel (0, 0) sits at region (100, 50): a square at region 100…110 × 50…60 is 10×10 pixels.
    const shifted: PixelView = { ...uniform(20, 20, 100), x0: 100, y0: 50 };
    const s = new RegionAcc();
    accPolygon(
      shifted,
      [
        { x: 100, y: 50 },
        { x: 110, y: 50 },
        { x: 110, y: 60 },
        { x: 100, y: 60 },
      ],
      s,
      lut,
    );
    expect(s.n).toBe(100);
  });

  it('accumulates a rectangle minus a rectangle', () => {
    const acc = new RegionAcc();
    accRect(v, { x0: 0, y0: 0, x1: 40, y1: 30 }, { x0: 10, y0: 5, x1: 30, y1: 100 }, acc, lut);
    expect(acc.n).toBe(40 * 30 - 20 * 25);
    const sparse = new RegionAcc();
    accRect(v, { x0: 0, y0: 0, x1: 40, y1: 40 }, null, sparse, lut, 4);
    expect(sparse.n).toBe(100);
  });
});

describe('region statistics', () => {
  const lut = Y_FULL_RANGE;
  it('uniform patch: luma, linear mean, nothing saturated', () => {
    const W = 16;
    const data = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < W * W; i++) data.set([200, 150, 100, 255], i * 4);
    const acc = new RegionAcc(true);
    accRect({ data, offset: 0, stride: W * 4, w: W, h: W, x0: 0, y0: 0, kind: 'rgba' }, { x0: 0, y0: 0, x1: W, y1: W }, null, acc, lut);
    const l8 = (54 * 200 + 183 * 150 + 19 * 100 + 128) >> 8;
    expect(l8).toBe(157);
    expect(acc.meanLin).toBeCloseTo(SRGB_TO_LINEAR[157], 6);
    expect(acc.meanLuma).toBeCloseTo(157 / 255, 6);
    expect(acc.satFrac).toBe(0);
    expect(acc.clipFrac).toBe(0);
  });

  it('counts saturated and clipped pixels exactly, and reads BGRA with the channels swapped', () => {
    const W = 10;
    const data = new Uint8ClampedArray(W * W * 4).fill(120);
    for (let i = 0; i < 7; i++) data.set([255, 255, 255, 255], i * 4); // saturated and clipped
    for (let i = 7; i < 10; i++) data.set([252, 180, 150, 255], i * 4); // red-clipped skin: clipped only
    const view = (kind: PixelKind): PixelView => ({ data, offset: 0, stride: W * 4, w: W, h: W, x0: 0, y0: 0, kind });
    const a = new RegionAcc();
    accRect(view('rgba'), { x0: 0, y0: 0, x1: W, y1: W }, null, a, lut);
    expect(a.satFrac).toBeCloseTo(0.07, 9);
    expect(a.clipFrac).toBeCloseTo(0.1, 9);
    const b = new RegionAcc();
    accRect(view('bgra'), { x0: 0, y0: 0, x1: W, y1: W }, null, b, lut);
    expect(b.clipFrac).toBeCloseTo(0.1, 9); // B=252 still clips
    expect(b.meanLin).not.toBeCloseTo(a.meanLin, 4); // but luma differs: R and B weights differ
  });

  it('takes exact quantiles and ignores saturated pixels for the sclera', () => {
    const W = 10;
    const data = new Uint8ClampedArray(W * W * 4).fill(150);
    for (let i = 0; i < 40; i++) data.set([255, 255, 255, 255], i * 4);
    const acc = new RegionAcc(true);
    accRect({ data, offset: 0, stride: W * 4, w: W, h: W, x0: 0, y0: 0, kind: 'rgba' }, { x0: 0, y0: 0, x1: W, y1: W }, null, acc, lut);
    expect(acc.quantileLin(0.85)).toBeCloseTo(SRGB_TO_LINEAR[255], 6);
    expect(acc.quantileLin(0.85, 245)).toBeCloseTo(SRGB_TO_LINEAR[150], 6);
    expect(acc.meanLinUnsat).toBeCloseTo(SRGB_TO_LINEAR[150], 6);
    const dark = new RegionAcc(true);
    const d2 = new Uint8ClampedArray(W * W * 4).fill(9);
    for (let i = 50; i < 100; i++) d2.set([13, 13, 13, 255], i * 4);
    accRect({ data: d2, offset: 0, stride: W * 4, w: W, h: W, x0: 0, y0: 0, kind: 'rgba' }, { x0: 0, y0: 0, x1: W, y1: W }, null, dark, lut);
    expect(Math.log2(dark.quantileLin(0.9) / dark.quantileLin(0.1))).toBeCloseTo(Math.log2(lin(13) / lin(9)), 6); // no bin coarsening
  });
});

describe('lightingGeometry', () => {
  const scene = renderScene();
  it('builds the regions of a frontal face', () => {
    const g = lightingGeometry(scene.landmarks, scene.W, scene.H)!;
    expect(g).not.toBeNull();
    expect(g.D).toBeCloseTo(0.45 * 70 + (70 - 0.45 * 70), 6); // corner midpoints are the eye centres
    expect(g.faceOval).toHaveLength(36);
    expect(g.eyes[0].aperture).toHaveLength(16);
    expect(g.eyes[0].iris).toHaveLength(16);
    // The right cheek is on the subject's right (image left), below the eyes.
    const cR = g.cheeks[0].reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
    expect(cR.x).toBeLessThan(320);
    expect(cR.y).toBeGreaterThan(200);
    expect(g.bgExclude.y + g.bgExclude.h).toBeCloseTo(480, 6);
  });

  it('rejects short or broken landmark arrays and tiny faces', () => {
    expect(lightingGeometry([], 640, 480)).toBeNull();
    expect(lightingGeometry(null, 640, 480)).toBeNull();
    expect(lightingGeometry(scene.landmarks, 0, 480)).toBeNull();
    const broken = scene.landmarks.map((p, i) => (i === 159 ? { x: Number.NaN, y: p.y, z: 0 } : p));
    expect(lightingGeometry(broken, 640, 480)).toBeNull();
    const tiny = renderScene({ D: 20 });
    expect(lightingGeometry(tiny.landmarks, tiny.W, tiny.H)).toBeNull();
  });

  it('plans even-aligned copy rectangles inside the frame', () => {
    const g = lightingGeometry(scene.landmarks, scene.W, scene.H)!;
    const plan = planCopyRects(g);
    for (const r of [plan.face, ...plan.eyes, ...plan.bg]) {
      expect(r.x % 2 + r.y % 2 + r.w % 2 + r.h % 2).toBe(0);
      expect(r.x + r.w).toBeLessThanOrEqual(640);
      expect(r.y + r.h).toBeLessThanOrEqual(480);
      expect(r.w).toBeGreaterThan(0);
    }
    expect(plan.bg.length).toBe(3);
  });
});

describe('statistics on a synthetic face', () => {
  const variants: [string, Partial<SceneSpec>][] = [
    ['baseline', {}],
    ['side-lit', { skinR: 90, skinL: 190 }],
    ['dark', { skinR: 25, skinL: 25, sclera: 30, iris: 8, bg: 20 }],
    ['window behind', { patch: { x: 0, y: 0, w: 640, h: 120, value: 252 } }],
    ['glasses glare', { glare: { eyes: ['R'], dx: 0.45, dy: -0.35, r: 0.2 } }],
  ];

  it('gives the exact expected values (RGBA copy path)', () => {
    const s = measureScene(renderScene())!;
    expect(s).not.toBeNull();
    expect(s.scleraR).toBeCloseTo(lin(200), 4);
    expect(s.scleraL).toBeCloseTo(lin(200), 4);
    expect(s.backlight).toBeCloseTo(log2r(lin(200), lin(110)), 3);
    expect(s.bgLin).toBeCloseTo(lin(110), 4);
    expect(s.side).toBeCloseTo(0, 6);
    expect(s.faceRange).toBeCloseTo(0, 6);
    expect(s.faceClip).toBe(0);
    expect(s.glareR + s.glareL + s.irisGlintR + s.irisGlintL).toBe(0);
    const ovalArea = Math.PI * 1.05 * 1.45 * 70 * 70;
    expect(Math.abs(s.facePx - ovalArea) / ovalArea).toBeLessThan(0.02);
    expect(s.faceLuma).toBeGreaterThan(0.55); // mostly skin (150/255 = 0.59), a little eye
    expect(s.faceLuma).toBeLessThan(0.62);
  });

  it('measures side light, glare, iris glints, back-light and clipping', () => {
    const side = measureScene(renderScene({ skinR: 90, skinL: 190 }))!;
    expect(side.side).toBeCloseTo(log2r(lin(190), lin(90)), 3);
    expect(side.faceRange).toBeCloseTo(log2r(lin(190), lin(90)), 3);

    const glare = measureScene(renderScene({ glare: { eyes: ['R'], dx: 0.45, dy: -0.35, r: 0.2 } }))!;
    expect(glare.glareR).toBeCloseTo((Math.PI * 0.2 * 0.2) / (1.8 * 1.1), 2); // disc / box area
    expect(glare.glareL).toBe(0);
    expect(glare.scleraR).toBeCloseTo(lin(200), 4); // saturated pixels never count as sclera

    const glint = measureScene(renderScene({ irisGlint: 0.5 }))!;
    expect(glint.irisGlintR).toBeCloseTo((0.5 * 0.5) / (0.9 * 0.9), 1);

    const back = measureScene(renderScene({ patch: { x: 0, y: 0, w: 640, h: 300, value: 252 } }))!; // a bright window behind
    expect(back.bgClip).toBeGreaterThan(0.15);
    expect(back.backlight).toBeLessThan(0);

    const hot = measureScene(renderScene({ skinR: 253, skinL: 253 }))!;
    expect(hot.faceClip).toBeGreaterThan(0.9);
  });

  it('sees red-clipped skin in 4:2:0 frames through their chroma, where luma alone cannot', () => {
    const scene = renderScene({ skinRgb: [255, 196, 160] }); // over-exposed skin: red clips at a luma of ≈ 212
    const rgb = measureScene(scene, 'rgba')!;
    expect(rgb.faceClip).toBeGreaterThan(0.9);
    for (const full of [true, false]) {
      expect(measureScene(scene, 'y', full)!.faceClip, full ? 'full range' : 'limited range').toBeGreaterThan(0.9);
      expect(measureScene(scene, 'y', full, false)!.faceClip).toBeLessThan(0.05); // the luma-only proxy misses it
    }
    const warm = renderScene({ skinRgb: [230, 180, 150] }); // bright but not clipped
    expect(measureScene(warm, 'y', false)!.faceClip).toBe(0);
    expect(measureScene(renderScene(), 'y', false)!.faceClip).toBe(0); // grey: neutral chroma
  });

  it('reads the same numbers from RGBA, BGRA and full- or limited-range luma', () => {
    for (const [, spec] of variants) {
      const scene = renderScene(spec);
      const ref = measureScene(scene, 'rgba')!;
      for (const [kind, full] of [
        ['bgra', true],
        ['y', true],
        ['y', false],
      ] as [PixelKind, boolean][]) {
        const s = measureScene(scene, kind, full)!;
        const a = lightingSignatureVector(ref);
        const b = lightingSignatureVector(s);
        for (const k of LIGHTING_COMPONENTS) expect(Math.abs(a[k] - b[k]) / LIGHTING_TOLERANCE[k]).toBeLessThan(0.05);
      }
    }
  });

  it('agrees with the atlas (canvas) path within a fraction of each tolerance', () => {
    let worst = 0;
    for (const [, spec] of variants) {
      const scene = renderScene(spec);
      const a = lightingSignatureVector(measureScene(scene)!);
      const b = lightingSignatureVector(measureSceneAtlas(scene)!);
      for (const k of LIGHTING_COMPONENTS) worst = Math.max(worst, Math.abs(a[k] - b[k]) / LIGHTING_TOLERANCE[k]);
    }
    expect(worst).toBeLessThan(0.25);
  });

  it('refuses faces whose regions are too small, and never returns non-finite numbers', () => {
    expect(measureScene(renderScene({ openness: 0.02 }))).toBeNull(); // eyes shut: no sclera
    const s = measureScene(renderScene({ skinR: 0, skinL: 0, sclera: 0, iris: 0, bg: 0 }))!;
    for (const k of LIGHTING_STAT_KEYS) expect(Number.isFinite(s[k])).toBe(true);
  });

  it('rounds to four decimals (≈ 350 bytes as JSON) and holds no pixels', () => {
    const s = measureScene(renderScene({ skinR: 90, skinL: 190 }))!;
    expect(Object.keys(s).sort()).toEqual([...LIGHTING_STAT_KEYS].sort());
    for (const k of LIGHTING_STAT_KEYS) {
      expect(typeof s[k]).toBe('number');
      expect(Math.round(s[k] * 1e4) / 1e4).toBe(s[k]);
    }
    expect(Number.isInteger(s.facePx)).toBe(true);
    expect(JSON.stringify(s).length).toBeLessThan(400);
  });

  it('reuses its accumulators', () => {
    const scene = renderScene();
    const g = lightingGeometry(scene.landmarks, scene.W, scene.H)!;
    const views = viewsFor(scene, g, 'rgba', true);
    const scratch = new MeasureScratch();
    const a = measureViews(g, views, Y_FULL_RANGE, scratch);
    const b = measureViews(g, views, Y_FULL_RANGE, scratch);
    expect(b).toEqual(a);
  });
});

// ─────────────────────────────── LightingProbe ───────────────────────────────

interface ProbeRig {
  probe: LightingProbe;
  registry: FrameRegistry;
  canvasLog: CanvasLog;
  frame(): FakeVideoFrame;
}

function probeRig(opts: {
  format?: FakeFormat;
  fullRange?: boolean | null;
  copy?: 'resolve' | 'never' | 'reject' | 'throw';
  backend?: 'auto' | 'copy' | 'canvas' | 'off';
  canvas?: boolean;
  scene?: Scene;
  clock?: () => number;
  rowPadding?: number;
} = {}): ProbeRig {
  const scene = opts.scene ?? renderScene();
  const registry: FrameRegistry = { clones: 0, closes: 0, copies: 0, open: new Set() };
  const canvasLog: CanvasLog = { created: [], draws: 0, reads: 0 };
  const probe = new LightingProbe({
    backend: opts.backend ?? 'copy',
    clock: opts.clock ?? (() => 0), // cost-neutral unless a test measures cost
    frameFromVideo: () => new FakeVideoFrame(scene, { format: opts.format ?? 'NV12', fullRange: opts.fullRange ?? false, copy: opts.copy ?? 'resolve', rowPadding: opts.rowPadding ?? 0 }, registry),
    createCanvas: opts.canvas === false ? null : (w, h) => new FakeCanvas(w, h, canvasLog),
  });
  const frame = (): FakeVideoFrame =>
    new FakeVideoFrame(scene, { format: opts.format ?? 'NV12', fullRange: opts.fullRange ?? false, copy: opts.copy ?? 'resolve', rowPadding: opts.rowPadding ?? 0 }, registry);
  return { probe, registry, canvasLog, frame };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Feeds `n` camera frames 33 ms apart like the track-processor driver: each original frame is closed right after the call. */
async function runFrames(rig: ProbeRig, n: number, t0 = 0, f: EyeFeatures = features(), quality = 0.9, scene = renderScene()): Promise<{ stats: LightingStats[]; times: number[] }> {
  const stats: LightingStats[] = [];
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * (1000 / 30);
    const fr = rig.frame();
    rig.probe.maybeMeasure(fr, scene.landmarks, f, quality, t);
    fr.close();
    const s = rig.probe.take();
    if (s) {
      stats.push(s);
      times.push(t);
    }
    await settle();
  }
  return { stats, times };
}

describe('LightingProbe (copyTo fast path)', () => {
  it('measures about 6.7 times a second and closes every clone', async () => {
    const rig = probeRig();
    const { stats } = await runFrames(rig, 90); // 3 s at 30 fps
    expect(rig.probe.backend).toBe('copy');
    expect(stats.length).toBeGreaterThanOrEqual(17);
    expect(stats.length).toBeLessThanOrEqual(21);
    expect(rig.registry.clones).toBe(stats.length);
    expect(rig.registry.open.size).toBe(0);
    expect(stats[0].scleraR).toBeCloseTo(lin(200), 2);
  });

  it('handles every supported format and the returned plane layout', async () => {
    for (const [format, fullRange] of [
      ['NV12', false],
      ['I420', true],
      ['RGBA', null],
      ['BGRA', null],
    ] as [FakeFormat, boolean | null][]) {
      const rig = probeRig({ format, fullRange, rowPadding: 12 });
      const { stats } = await runFrames(rig, 10);
      expect(stats.length, format).toBeGreaterThan(0);
      expect(stats[0].scleraR, format).toBeCloseTo(lin(200), 2);
      expect(stats[0].backlight, format).toBeCloseTo(log2r(lin(200), lin(110)), 1);
      expect(rig.registry.open.size).toBe(0);
    }
  });

  it('measures clipping through NV12 and I420 chroma end to end', async () => {
    const scene = renderScene({ skinRgb: [255, 196, 160] });
    for (const [format, fullRange] of [
      ['NV12', false],
      ['I420', true],
    ] as [FakeFormat, boolean][]) {
      const rig = probeRig({ format, fullRange, scene, rowPadding: 6 });
      const { stats } = await runFrames(rig, 10, 0, features(), 0.9, scene);
      expect(stats[0].faceClip, format).toBeGreaterThan(0.9);
    }
  });

  it('skips blinks, poor frames and missing features', async () => {
    const rig = probeRig();
    expect((await runFrames(rig, 30, 0, features({ blink: 0.6 }))).stats).toHaveLength(0);
    expect((await runFrames(rig, 30, 2000, features(), 0.2)).stats).toHaveLength(0);
    const scene = renderScene();
    rig.probe.maybeMeasure(rig.frame(), scene.landmarks, null, 0.9, 5000);
    expect(rig.registry.clones).toBe(0);
  });

  it('keeps at most one copy in flight and closes a stuck clone after 100 ms', async () => {
    vi.useFakeTimers();
    const rig = probeRig({ copy: 'never' });
    const scene = renderScene();
    const f = features();
    const fr = rig.frame();
    rig.probe.maybeMeasure(fr, scene.landmarks, f, 0.9, 0);
    expect(rig.registry.clones).toBe(1);
    for (let t = 33; t < 99; t += 33) rig.probe.maybeMeasure(fr, scene.landmarks, f, 0.9, t);
    expect(rig.registry.clones).toBe(1); // still one in flight
    vi.advanceTimersByTime(PROBE_SAFETY_CLOSE_MS);
    expect(rig.registry.open.size).toBe(1); // only the original frame is open now
    expect(vi.getTimerCount()).toBe(0);
    fr.close();
  });

  it('closes a stuck clone on the next frame even if timers are throttled, and gives up on copyTo after 3 timeouts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rig = probeRig({ copy: 'never' });
    const scene = renderScene();
    const f = features();
    let t = 0;
    for (let i = 0; i < 3; i++) {
      const fr = rig.frame();
      rig.probe.maybeMeasure(fr, scene.landmarks, f, 0.9, t);
      fr.close();
      t += 150;
      const next = rig.frame();
      rig.probe.maybeMeasure(next, scene.landmarks, f, 0.9, t); // ≥ 100 ms later: the frame-driven safety close
      next.close();
    }
    expect(rig.registry.open.size).toBe(0);
    expect(rig.probe.backend).toBe('canvas');
    const fr = rig.frame();
    rig.probe.maybeMeasure(fr, scene.landmarks, f, 0.9, t + 200);
    expect(rig.probe.take()).toBeDefined(); // the canvas measures synchronously
    fr.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('switches to the canvas for good when copyTo rejects, throws, or the format is unsupported', async () => {
    for (const setup of [{ copy: 'reject' as const }, { copy: 'throw' as const }, { format: 'I420P10' as const }]) {
      const rig = probeRig(setup);
      const { stats } = await runFrames(rig, 30);
      expect(rig.probe.backend, JSON.stringify(setup)).toBe('canvas');
      expect(stats.length).toBeGreaterThan(0);
      expect(stats.at(-1)!.scleraR).toBeCloseTo(lin(200), 1);
      expect(rig.registry.open.size).toBe(0);
      // VideoFrame source: drawn once 1:1 into a full-size canvas, then the atlas from that: 5 draws, 1 read.
      expect(rig.canvasLog.created).toEqual([
        { w: ATLAS_W, h: ATLAS_H },
        { w: 640, h: 480 },
      ]);
      expect(rig.canvasLog.draws).toBe(5 * stats.length);
      expect(rig.canvasLog.reads).toBe(stats.length);
    }
  });

  it('turns off (without throwing) when there is no canvas to fall back to or the canvas breaks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noCanvas = probeRig({ copy: 'reject', canvas: false });
    await runFrames(noCanvas, 10);
    expect(noCanvas.probe.backend).toBe('off');

    const scene = renderScene();
    const broken = new LightingProbe({
      backend: 'canvas',
      createCanvas: () => {
        throw new Error('no 2D context');
      },
    });
    expect(() => broken.maybeMeasure(fakeVideo(scene), scene.landmarks, features(), 0.9, 0)).not.toThrow();
    expect(broken.backend).toBe('off');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads a <video> through a VideoFrame wrapper, or draws it straight into the atlas', async () => {
    const scene = renderScene();
    const rig = probeRig({ format: 'RGBA', fullRange: null });
    const video = fakeVideo(scene);
    rig.probe.maybeMeasure(video, scene.landmarks, features(), 0.9, 0);
    await settle();
    expect(rig.probe.take()?.scleraR).toBeCloseTo(lin(200), 2);
    expect(rig.registry.clones).toBe(0);
    expect(rig.registry.open.size).toBe(0); // the wrapper frame was closed

    const log: CanvasLog = { created: [], draws: 0, reads: 0 };
    const canvasOnly = new LightingProbe({ frameFromVideo: null, createCanvas: (w, h) => new FakeCanvas(w, h, log), backend: 'copy' });
    canvasOnly.maybeMeasure(video, scene.landmarks, features(), 0.9, 0);
    expect(canvasOnly.backend).toBe('canvas');
    expect(canvasOnly.take()?.scleraR).toBeCloseTo(lin(200), 1);
    expect(log.created).toEqual([{ w: ATLAS_W, h: ATLAS_H }]); // no full-size canvas for a <video>
    expect(log.draws).toBe(4);
  });

  it('measures less often when measuring is slow (cost governor)', async () => {
    let now = 0;
    const rig = probeRig({ backend: 'canvas', clock: () => (now += 1.8) }); // two clock reads per measurement, 1.8 ms apart
    const { times } = await runFrames(rig, 150);
    expect(rig.probe.costMs).toBeGreaterThan(1.5);
    expect(rig.probe.intervalMs).toBe(500);
    const gaps = times.slice(-4).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(500);
  });

  it('chooses its backend once per device: keeps a cheap copyTo, trials the canvas when copyTo is slow', async () => {
    // Each clock read advances by `step` ms: a copy measurement reads it 4 times (2 steps), a canvas one twice (1 step).
    const withCost = (step: (backend: string) => number) => {
      let now = 0;
      let probe: LightingProbe | null = null;
      const rig = probeRig({ clock: () => (now += probe ? step(probe.backend) : 0) });
      probe = rig.probe;
      return rig;
    };
    const cheap = withCost(() => 0.2); // copy ≈ 0.4 ms
    await runFrames(cheap, 60);
    expect(cheap.probe.backend).toBe('copy');
    expect(cheap.probe.backendSettled).toBe(true);

    const gpuBacked = withCost(() => 2); // copy ≈ 4 ms (a synchronous readback), canvas ≈ 2 ms
    await runFrames(gpuBacked, 450); // the governor slows measuring to 2 Hz meanwhile
    expect(gpuBacked.probe.backend).toBe('canvas');
    expect(gpuBacked.probe.backendSettled).toBe(true);
    expect(gpuBacked.registry.open.size).toBe(0);

    const canvasWorse = withCost((b) => (b === 'canvas' ? 6 : 0.8)); // copy ≈ 1.6 ms, canvas ≈ 6 ms
    await runFrames(canvasWorse, 600);
    expect(canvasWorse.probe.backend).toBe('copy');
    expect(canvasWorse.probe.backendSettled).toBe(true);
  });

  it('reset() drops pending work and closes the clone', async () => {
    const rig = probeRig({ copy: 'never' });
    const scene = renderScene();
    const fr = rig.frame();
    rig.probe.maybeMeasure(fr, scene.landmarks, features(), 0.9, 0);
    fr.close();
    expect(rig.registry.open.size).toBe(1);
    rig.probe.reset();
    expect(rig.registry.open.size).toBe(0);
    expect(rig.probe.take()).toBeUndefined();
    rig.probe.dispose();
    expect(rig.probe.backend).toBe('off');
  });

  it('costs little on the main thread (measured with fakes)', async () => {
    const scene = renderScene();
    const rig = probeRig({ scene });
    const f = features();
    // 1. Frames it skips (interval not elapsed): the common case, 4 of 5 frames.
    const fr = rig.frame();
    rig.probe.maybeMeasure(fr, scene.landmarks, f, 0.9, 0);
    const N = 200_000;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) rig.probe.maybeMeasure(fr, scene.landmarks, f, 0.9, 1 + (i % 100));
    const skipNs = ((performance.now() - t0) / N) * 1e6;
    fr.close();
    await settle();
    rig.probe.take();

    // 2. The synchronous part of a measuring frame (clone, regions, plan, copyTo kick-off).
    const M = 300;
    let sync = 0;
    for (let i = 0; i < M; i++) {
      const frame = rig.frame();
      const s0 = performance.now();
      rig.probe.maybeMeasure(frame, scene.landmarks, f, 0.9, 1000 + i * 200);
      sync += performance.now() - s0;
      frame.close();
      await settle();
      rig.probe.take();
    }
    const syncMs = sync / M;

    // 3. The statistics pass that runs when the copy resolves (640×480, D = 70 px, NV12-like luma).
    const g = lightingGeometry(scene.landmarks, scene.W, scene.H)!;
    const views = viewsFor(scene, g, 'y', false);
    const scratch = new MeasureScratch();
    t0 = performance.now();
    for (let i = 0; i < M; i++) measureViews(g, views, Y_LIMITED_RANGE, scratch);
    const statsMs = (performance.now() - t0) / M;

    console.info(`[lighting cost] skipped frame ${skipNs.toFixed(0)} ns; measuring frame sync ${(syncMs * 1000).toFixed(0)} µs; stats pass ${(statsMs * 1000).toFixed(0)} µs`);
    expect(skipNs).toBeLessThan(2000);
    expect(syncMs).toBeLessThan(1);
    expect(statsMs).toBeLessThan(3);
    expect(rig.registry.open.size).toBe(0);
  });
});

// ─────────────────────────────── LightingMonitor ───────────────────────────────

describe('LightingMonitor', () => {
  it('reports the exposure swing over 3 s and flags instability with hysteresis', () => {
    const m = new LightingMonitor();
    let r = m.update(0, BASE_STATS);
    for (let t = 166; t < 2000; t += 166) r = m.update(t, BASE_STATS);
    expect(r.swing).toBeCloseTo(0, 6);
    expect(r.flags).toEqual([]);
    const brighter = { ...BASE_STATS, frameLin: 0.36, faceLin: 0.4 }; // +1 stop
    r = m.update(2166, brighter);
    expect(r.swing).toBeGreaterThan(0.95);
    expect(r.flags).toContain('unstable');
    for (let t = 2332; t < 6000; t += 166) r = m.update(t, brighter);
    expect(r.swing).toBeCloseTo(0, 6);
    expect(r.flags).not.toContain('unstable');
  });

  it('smooths with a time constant, not a sample count, and restarts after a gap', () => {
    const m = new LightingMonitor(1000);
    m.update(0, BASE_STATS);
    const r = m.update(1000, { ...BASE_STATS, side: 1.1 });
    expect(r.smoothed.side).toBeCloseTo(0.1 + (1 - Math.exp(-1)) * 1.0, 3);
    const after = m.update(8000, { ...BASE_STATS, side: -0.5 });
    expect(after.smoothed.side).toBe(-0.5);
  });

  it('flags darkness from the sclera, not from the (skin-dependent) face level', () => {
    const m = new LightingMonitor(1);
    m.update(0, { ...BASE_STATS, faceLuma: 0.15, faceLin: 0.02 }); // dark skin, normal light
    expect(m.update(10, { ...BASE_STATS, faceLuma: 0.15, faceLin: 0.02 }).flags).not.toContain('dark');
    m.update(20, { ...BASE_STATS, scleraR: 0.05, scleraL: 0.06 });
    expect(m.update(30, { ...BASE_STATS, scleraR: 0.05, scleraL: 0.06 }).flags).toContain('dark');
    expect(m.update(40, { ...BASE_STATS, scleraR: 0.09, scleraL: 0.09 }).flags).toContain('dark'); // held until 0.10
    expect(m.update(50, { ...BASE_STATS, scleraR: 0.11, scleraL: 0.11 }).flags).not.toContain('dark');
  });

  it('flags back-light from the sclera/background ratio or a clipped window', () => {
    const m = new LightingMonitor(1);
    m.update(0, { ...BASE_STATS, backlight: -1.3 });
    expect(m.update(10, { ...BASE_STATS, backlight: -1.3 }).flags).toContain('backlit');
    expect(m.update(20, { ...BASE_STATS, backlight: -0.9 }).flags).toContain('backlit'); // held until −0.8
    expect(m.update(30, { ...BASE_STATS, backlight: -0.5 }).flags).not.toContain('backlit');
    const w = new LightingMonitor(1);
    w.update(0, { ...BASE_STATS, backlight: -0.2, bgClip: 0.3 });
    expect(w.update(10, { ...BASE_STATS, backlight: -0.2, bgClip: 0.3 }).flags).toContain('backlit');
    const wall = new LightingMonitor(1); // a white wall: −0.44, correctly not back-lit
    wall.update(0, { ...BASE_STATS, backlight: -0.44 });
    expect(wall.update(10, { ...BASE_STATS, backlight: -0.44 }).flags).toEqual([]);
  });

  it('flags glare with hysteresis, but not on an over-exposed face', () => {
    const m = new LightingMonitor(1);
    m.update(0, { ...BASE_STATS, glareL: 0.03 });
    expect(m.update(10, { ...BASE_STATS, glareL: 0.03 }).flags).toEqual(['glare']);
    expect(m.update(20, { ...BASE_STATS, glareL: 0.018 }).flags).toEqual(['glare']);
    expect(m.update(30, { ...BASE_STATS, glareL: 0.01 }).flags).toEqual([]);
    const hot = new LightingMonitor(1);
    hot.update(0, { ...BASE_STATS, glareL: 0.04, faceClip: 0.12 });
    expect(hot.update(10, { ...BASE_STATS, glareL: 0.04, faceClip: 0.12 }).flags).toEqual(['overexposed']);
  });

  it('flags side light beyond what head pose explains', () => {
    const m = new LightingMonitor(1);
    m.update(0, { ...BASE_STATS, side: 0.29 }); // 20° yaw with a key light
    expect(m.update(10, { ...BASE_STATS, side: 0.29 }).flags).toEqual([]);
    m.update(20, { ...BASE_STATS, side: -0.9 });
    expect(m.update(30, { ...BASE_STATS, side: -0.9 }).flags).toEqual(['side-lit']);
  });

  it('does not allocate its window per update (ring capacity is bounded)', () => {
    const m = new LightingMonitor();
    let r = m.update(0, BASE_STATS);
    for (let i = 1; i < 1000; i++) r = m.update(i * 10, BASE_STATS); // 100 Hz for 10 s: > ring capacity
    expect(r.swing).toBeCloseTo(0, 9);
  });
});

// ─────────────────────────────── signature ───────────────────────────────

describe('lighting signature', () => {
  const zero = Object.fromEntries(LIGHTING_COMPONENTS.map((k) => [k, 0])) as LightingSignature['c'];
  const sig = (c: Partial<LightingSignature['c']>, yaw = 0, sd: Partial<LightingSignature['sd']> = {}): LightingSignature => ({
    v: 1,
    n: 30,
    yaw,
    pitch: 0,
    c: { ...zero, ...c },
    sd: { ...zero, ...sd },
  });

  it('is 0 for identical signatures and 1 for one component moved by its tolerance', () => {
    expect(compareLightingSignatures(sig({}), sig({})).distance).toBe(0);
    for (const k of LIGHTING_COMPONENTS) {
      const r = compareLightingSignatures(sig({}), sig({ [k]: LIGHTING_TOLERANCE[k] }));
      expect(r.distance).toBeCloseTo(1, 9);
      expect(r.dominant).toBe(k);
      expect(r.z[k]).toBeCloseTo(1, 9);
    }
  });

  it('widens side tolerance with yaw difference and noisy components with their spread', () => {
    const a = compareLightingSignatures(sig({}), sig({ side: 0.5 }, 0));
    const b = compareLightingSignatures(sig({}), sig({ side: 0.5 }, (10 * Math.PI) / 180));
    expect(b.distance).toBeCloseTo(0.5 / (0.5 + 0.3), 6);
    expect(b.distance).toBeLessThan(a.distance);
    const noisy = compareLightingSignatures(sig({}, 0, { range: 0.5 }), sig({ range: 0.75 }));
    expect(noisy.distance).toBeCloseTo(0.75 / 1.5, 6);
  });

  it('builds from medians (robust to a glint outlier) and needs enough samples', () => {
    const samples: LightingSample[] = Array.from({ length: 21 }, (_, i) => ({ stats: { ...BASE_STATS, glareR: i === 5 ? 0.2 : 0.001 }, yaw: 0.01 * i, pitch: -0.1 }));
    const s = buildLightingSignature(samples)!;
    expect(s.c.glare).toBeCloseTo(Math.log2(1 + 0.001 / 0.005), 9);
    expect(s.c.side).toBeCloseTo(0.1, 9);
    expect(s.sd.side).toBe(0);
    expect(s.yaw).toBeCloseTo(0.1, 9);
    expect(s.pitch).toBeCloseTo(-0.1, 9);
    expect(s.n).toBe(21);
    expect(buildLightingSignature(samples.slice(0, 19))).toBeNull();
    // Signatures hold no absolute face level (skin tone): only the six ratio components.
    expect(Object.keys(s.c).sort()).toEqual([...LIGHTING_COMPONENTS].sort());
  });

  it('parses stored signatures and rejects malformed ones', () => {
    const good = sig({ sclera: -1.2, side: 0.2 });
    expect(parseLightingSignature(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseLightingSignature(null)).toBeNull();
    expect(parseLightingSignature({ ...good, v: 2 })).toBeNull();
    expect(parseLightingSignature({ ...good, c: { ...good.c, side: null } })).toBeNull();
    expect(parseLightingSignature({ ...good, sd: { ...good.sd, glare: -1 } })).toBeNull();
    expect(parseLightingSignature({ ...good, c: { sclera: 0 } })).toBeNull();
  });

  it('separates posture from lighting changes on the synthetic face', () => {
    const samples = (spec: Partial<SceneSpec>, yaw = 0): LightingSample[] =>
      Array.from({ length: 20 }, () => ({ stats: measureScene(renderScene(spec))!, yaw, pitch: 0 }));
    const ref = buildLightingSignature(samples({}))!;
    const shifted = buildLightingSignature(samples({ cx: 280, cy: 230, D: 80 }))!; // moved and closer
    expect(compareLightingSignatures(ref, shifted).distance).toBeLessThan(0.3);
    const side = compareLightingSignatures(ref, buildLightingSignature(samples({ skinR: 100, skinL: 190 }))!);
    expect(side.distance).toBeGreaterThan(1);
    expect(side.dominant).toBe('side');
    const window = compareLightingSignatures(ref, buildLightingSignature(samples({ bg: 245 }))!);
    expect(window.dominant).toBe('backlight');
    const glare = compareLightingSignatures(ref, buildLightingSignature(samples({ glare: { eyes: ['R', 'L'], dx: 0.45, dy: -0.35, r: 0.15 } }))!);
    expect(glare.distance).toBeGreaterThan(1);
    expect(glare.dominant).toBe('glare');
  });
});

// ─────────────────────────────── LightingWatch ───────────────────────────────

describe('LightingWatch', () => {
  const frameAt = (t: number, stats: LightingStats | undefined, yaw = 0): FeatureFrame => ({
    t,
    faceFound: true,
    quality: 0.9,
    features: features({ headPose: { yaw, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -50 } }),
    lighting: stats,
  });
  const office = measureScene(renderScene())!;
  const lamp = measureScene(renderScene({ skinR: 100, skinL: 190 }))!;
  const refSig = buildLightingSignature(Array.from({ length: 30 }, () => ({ stats: office, yaw: 0, pitch: 0 })))!;

  /** 6.7 Hz lighting frames between t0 and t1, ticking every 250 ms; returns the updates with a transition. */
  function drive(w: LightingWatch, t0: number, t1: number, stats: LightingStats) {
    const out: { t: number; transition: string; changedAt: number | null; distance: number | null }[] = [];
    for (let t = t0; t < t1; t += 150) {
      w.onFrame(frameAt(t, stats));
      const u = w.tick(t);
      if (u?.transition) out.push({ t, transition: u.transition, changedAt: u.changedAt, distance: u.state.distance });
    }
    return out;
  }

  it('says nothing without a reference, but still reports flags', () => {
    const w = new LightingWatch(null);
    const flagged = { ...office, glareR: 0.05 };
    drive(w, 0, 3000, flagged);
    expect(w.state.distance).toBeNull();
    expect(w.state.changedSinceCalibration).toBe(false);
    expect(w.state.flags).toEqual(['glare']);
  });

  it('holds "changed" until the distance stays ≥ 1 for 5 s, and dates the change', () => {
    const w = new LightingWatch(refSig);
    expect(drive(w, 0, 20_000, office)).toEqual([]);
    expect(w.state.distance).toBeCloseTo(0, 6);
    const changes = drive(w, 20_000, 40_000, lamp);
    expect(changes).toHaveLength(1);
    expect(changes[0].transition).toBe('changed');
    const lag = changes[0].t - 20_000;
    expect(lag).toBeGreaterThanOrEqual(5000);
    expect(lag).toBeLessThanOrEqual(11_000);
    expect(Math.abs(changes[0].changedAt! - 20_000)).toBeLessThanOrEqual(300);
    expect(w.state).toMatchObject({ changedSinceCalibration: true, dominant: 'side' });
    const back = drive(w, 40_000, 60_000, office);
    expect(back.map((c) => c.transition)).toEqual(['restored']);
    expect(w.state.dominant).toBeNull();
  });

  it('ignores a brief change (under the hold time)', () => {
    const w = new LightingWatch(refSig);
    drive(w, 0, 12_000, office);
    const events = [...drive(w, 12_000, 16_000, lamp), ...drive(w, 16_000, 40_000, office)];
    expect(events).toEqual([]);
  });

  it('forgets stale flags and restarts on a new reference', () => {
    const w = new LightingWatch(refSig);
    drive(w, 0, 20_000, lamp);
    expect(w.state.changedSinceCalibration).toBe(true);
    w.setReference(buildLightingSignature(Array.from({ length: 30 }, () => ({ stats: lamp, yaw: 0, pitch: 0 }))));
    expect(w.state.changedSinceCalibration).toBe(false);
    drive(w, 20_000, 30_000, lamp);
    expect(w.state.changedSinceCalibration).toBe(false);
    expect(w.state.distance).toBeCloseTo(0, 6);
    w.onFrame(frameAt(30_000, { ...lamp, glareL: 0.05 }));
    w.tick(31_000);
    expect(w.tick(40_000)?.state.flags).toEqual([]); // no measurement for 10 s
  });

  it('recomputes at most once per second', () => {
    const w = new LightingWatch(refSig);
    w.onFrame(frameAt(0, office));
    expect(w.tick(0)).not.toBeNull();
    expect(w.tick(500)).toBeNull();
    expect(w.tick(1000)).not.toBeNull();
  });

  /** Deterministic noise (LCG), so signatures have a realistic spread. */
  function noiseSource(seed: number): (sd: number) => number {
    let s = seed >>> 0 || 1;
    return (sd) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return sd * 2 * (s / 4294967296 - 0.5) * Math.sqrt(3); // uniform with this SD
    };
  }
  /** One measurement: `base` with ≈ 0.04-stop noise on every signature component. */
  function jittered(base: LightingStats, noise: (sd: number) => number): LightingStats {
    const k = 2 ** noise(0.04);
    return {
      ...base,
      scleraR: base.scleraR * k,
      scleraL: base.scleraL * k,
      backlight: base.backlight + noise(0.04),
      side: base.side + noise(0.03),
      shade: base.shade + noise(0.03),
      faceRange: base.faceRange + noise(0.04),
    };
  }
  /** Like `drive`, with noise, every `stepMs`; returns every update with a transition. */
  function driveNoisy(w: LightingWatch, t0: number, t1: number, base: LightingStats, noise: (sd: number) => number, stepMs = 150) {
    const out: { t: number; transition: string; changedAt: number | null }[] = [];
    for (let t = t0; t < t1; t += stepMs) {
      w.onFrame(frameAt(t, jittered(base, noise)));
      const u = w.tick(t);
      if (u?.transition) out.push({ t, transition: u.transition, changedAt: u.changedAt });
    }
    return out;
  }
  const scaled = (s: LightingStats, scleraStops: number, backlightDelta: number): LightingStats => ({
    ...s,
    scleraR: s.scleraR * 2 ** scleraStops,
    scleraL: s.scleraL * 2 ** scleraStops,
    backlight: s.backlight + backlightDelta,
  });

  it('still compares when the cost governor measures only every 533 ms (fewer samples per window)', () => {
    const w = new LightingWatch(refSig);
    let t = 0;
    let compared = 0;
    let ticks = 0;
    let changed: { t: number; changedAt: number | null } | null = null;
    for (; t < 40_000; t += 533) {
      w.onFrame(frameAt(t, t < 15_000 ? office : lamp));
      const u = w.tick(t);
      if (u && t >= 8000) {
        ticks++;
        if (u.comparison) compared++;
      }
      if (u?.transition === 'changed') changed ??= { t, changedAt: u.changedAt };
    }
    expect(compared).toBe(ticks); // 18–19 samples per 10-s window: enough (the calibration minimum of 20 is not)
    expect(changed).not.toBeNull();
    expect(changed!.t - 15_000).toBeLessThanOrEqual(12_000);
    expect(Math.abs(changed!.changedAt! - 15_000)).toBeLessThanOrEqual(600);
    expect(WATCH_MIN_SAMPLES).toBeLessThan(MIN_SIGNATURE_SAMPLES);
    // At the usual 6.7 Hz the rolling signature still needs the full 20 samples (≈ 3 s).
    const fast = new LightingWatch(refSig);
    for (let k = 0; k < 19; k++) fast.onFrame(frameAt(k * 150, office));
    expect(fast.currentSignature()).toBeNull();
    fast.onFrame(frameAt(19 * 150, office));
    expect(fast.currentSignature()?.n).toBe(20);
  });

  it('keeps a pending change through ticks without a comparison (a window a few samples short)', () => {
    // Needs 19 of the 21 samples a 10-s window holds at 2 Hz; three lost measurements leave it short for 10 s.
    const w = new LightingWatch(refSig, { minSamples: 19, minSamplesFloor: 19 });
    let blind = 0;
    let changedAt: number | null = null;
    for (let t = 0; t < 50_000; t += 500) {
      if (!(t >= 26_000 && t <= 27_000)) w.onFrame(frameAt(t, t < 20_000 ? office : lamp));
      const u = w.tick(t);
      if (u && !u.comparison && t >= 20_000 && changedAt === null) blind++;
      if (u?.transition === 'changed') changedAt ??= t;
    }
    expect(blind).toBeGreaterThanOrEqual(8); // the hold started at ≈ 25 s, then 10 s without a comparison
    // Confirmed on the first comparison after the gap (≈ 37 s), not 5 s later on a restarted hold.
    expect(changedAt).not.toBeNull();
    expect(changedAt! - 20_000).toBeLessThanOrEqual(17_500);
  });

  it('drops a pending change whose evidence is long gone (the reader was away)', () => {
    const w = new LightingWatch(refSig, { windowMs: 3000, minSamples: 5, minSamplesFloor: 5 });
    const events: { t: number; transition: string }[] = [];
    const feed = (t0: number, t1: number, stats: LightingStats | null): void => {
      for (let t = t0; t < t1; t += 250) {
        if (stats) w.onFrame(frameAt(t, stats));
        const u = w.tick(t);
        if (u?.transition) events.push({ t, transition: u.transition });
      }
    };
    feed(0, 6000, office);
    feed(6000, 8000, lamp); // a hold starts at ≈ 7.5 s
    feed(8000, 20_000, null); // away: no measurements for 12 s (> 3 windows)
    feed(20_000, 30_000, lamp);
    expect(events.map((e) => e.transition)).toEqual(['changed']);
    expect(events[0].t).toBeGreaterThanOrEqual(25_500); // a fresh 5-s hold after returning, not the old one
  });

  it('reports a second and a third change while already changed ("changed-again"), each dated to its onset', () => {
    const noise = noiseSource(7);
    const w = new LightingWatch(buildLightingSignature(Array.from({ length: 40 }, () => ({ stats: jittered(office, noise), yaw: 0, pitch: 0 }))));
    const overheadOff = scaled(lamp, -1.5, 1); // the room light goes: the eyes darker, the background darker still
    const blinds = scaled(overheadOff, 0, -2); // daylight behind the reader
    const events = [
      ...driveNoisy(w, 0, 20_000, office, noise),
      ...driveNoisy(w, 20_000, 50_000, lamp, noise),
      ...driveNoisy(w, 50_000, 80_000, overheadOff, noise),
      ...driveNoisy(w, 80_000, 110_000, blinds, noise),
    ];
    expect(events.map((e) => e.transition)).toEqual(['changed', 'changed-again', 'changed-again']);
    [20_000, 50_000, 80_000].forEach((at, i) => {
      expect(Math.abs(events[i].changedAt! - at), `change ${i}`).toBeLessThanOrEqual(2000);
      expect(events[i].t - at, `change ${i}`).toBeLessThanOrEqual(12_000);
    });
    expect(w.state.changedSinceCalibration).toBe(true);
    expect(w.lastComparisonSinceChange!.distance).toBeLessThan(0.5); // compared with the blinds-open light now
    // Back to the calibration's light: 'restored', and the trail is gone.
    const back = driveNoisy(w, 110_000, 140_000, office, noise);
    expect(back.map((e) => e.transition)).toEqual(['restored']);
    expect(w.lastComparisonSinceChange).toBeNull();
  });

  it('stays silent through 10 minutes of a steady (changed) light', () => {
    const noise = noiseSource(11);
    const w = new LightingWatch(buildLightingSignature(Array.from({ length: 40 }, () => ({ stats: jittered(office, noise), yaw: 0, pitch: 0 }))));
    driveNoisy(w, 0, 10_000, office, noise);
    const events = driveNoisy(w, 10_000, 610_000, lamp, noise);
    expect(events.map((e) => e.transition)).toEqual(['changed']);
  });

  it('forgets the last report\'s light on a new reference', () => {
    const w = new LightingWatch(refSig);
    drive(w, 0, 10_000, office);
    expect(drive(w, 10_000, 30_000, lamp).map((e) => e.transition)).toEqual(['changed']);
    expect(w.tick(31_000)?.sinceLastChange?.distance).toBeCloseTo(0, 6);
    w.setReference(buildLightingSignature(Array.from({ length: 30 }, () => ({ stats: lamp, yaw: 0, pitch: 0 }))));
    expect(w.lastComparisonSinceChange).toBeNull();
    const next = drive(w, 31_000, 60_000, scaled(lamp, -1.5, 1));
    expect(next.map((e) => e.transition)).toEqual(['changed']); // a first change against the new calibration, not 'changed-again'
    w.reset();
    expect(w.lastComparisonSinceChange).toBeNull();
    expect(w.state.changedSinceCalibration).toBe(false);
  });
});

describe('LightingWatch and the screen', () => {
  const frameAt = (t: number, stats: LightingStats): FeatureFrame => ({ t, faceFound: true, quality: 0.9, features: features(), lighting: stats });
  const office = measureScene(renderScene())!;
  const lamp = measureScene(renderScene({ skinR: 100, skinL: 190 }))!;
  const refSig = buildLightingSignature(Array.from({ length: 30 }, () => ({ stats: office, yaw: 0, pitch: 0 })))!;
  // A dark site after calibrating on a white page, in a room lit mostly by the screen:
  // face-metered auto-exposure turns it into a back-light change (and a little sclera).
  const darkPage: LightingStats = { ...office, backlight: office.backlight - 1.2, scleraR: office.scleraR * 2 ** -0.1, scleraL: office.scleraL * 2 ** -0.1, faceRange: office.faceRange + 0.1 };

  function run(w: LightingWatch, t0: number, t1: number, stats: LightingStats) {
    const transitions: string[] = [];
    let explained = false;
    for (let t = t0; t < t1; t += 150) {
      w.onFrame(frameAt(t, stats));
      const u = w.tick(t);
      if (u?.transition) transitions.push(u.transition);
      if (u) explained = u.screenExplained ?? false;
    }
    return { transitions, explained };
  }

  it('computes screen luminance and its change in stops', () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(18, 18, 18)).toBeCloseTo(SRGB_TO_LINEAR[18], 9);
    expect(screenStops(0.125, 1)).toBeCloseTo(-3, 9);
    expect(screenStops(0, 1)).toBeCloseTo(Math.log2(0.005), 9); // floored: even a black page lights the face a little
    expect(screenStops(null, 1)).toBe(0);
    expect(screenStops(0.5, undefined)).toBe(0);
  });

  it('lets a screen change explain only back-light, sclera or glare changes that move with it, without geometry', () => {
    const cmp = (dominant: LightingComparison['dominant'], zd: number, side = 0, shade = 0): LightingComparison => {
      const z = { sclera: 0.1, backlight: 0.1, side, shade, glare: 0, range: 0.1 };
      z[dominant] = zd;
      return { distance: Math.abs(zd), dominant, z };
    };
    expect(screenExplainsChange(cmp('backlight', -1.6), -3)).toBe(true);
    expect(screenExplainsChange(cmp('sclera', 1.4), 2)).toBe(true);
    expect(screenExplainsChange(cmp('glare', -1.2), -1)).toBe(true);
    expect(screenExplainsChange(cmp('backlight', -1.6), -0.5)).toBe(false); // the page barely changed
    expect(screenExplainsChange(cmp('backlight', 1.6), -3)).toBe(false); // brighter eyes on a darker page: not the screen
    expect(screenExplainsChange(cmp('backlight', -1.6, 0.6), -3)).toBe(false); // the light moved sideways too
    expect(screenExplainsChange(cmp('side', 1.6), -3)).toBe(false);
    expect(screenExplainsChange(cmp('backlight', -1.6), 0)).toBe(false);
  });

  it('does not report a dark page as a lighting change, but still reports the same change with the screen unchanged or unknown', () => {
    const dark = new LightingWatch(refSig);
    dark.setReference(refSig, 1); // calibrated on a white page
    dark.setScreenLuminance(0.125); // now on a dark one: −3 stops
    run(dark, 0, 5000, office);
    const r = run(dark, 5000, 45_000, darkPage);
    expect(r.transitions).toEqual([]);
    expect(r.explained).toBe(true);
    expect(dark.state.changedSinceCalibration).toBe(false);
    expect(dark.state.distance).toBeGreaterThanOrEqual(1); // still shown for diagnostics

    for (const screen of [1, null]) {
      const w = new LightingWatch(refSig);
      w.setReference(refSig, 1);
      w.setScreenLuminance(screen);
      run(w, 0, 5000, office);
      const u = run(w, 5000, 45_000, darkPage);
      expect(u.transitions, `screen ${screen}`).toEqual(['changed']);
      expect(u.explained).toBe(false);
    }
  });

  it('still reports a real change on a dark page, and a dark page after a real change is not a second change', () => {
    const w = new LightingWatch(refSig);
    w.setReference(refSig, 1);
    w.setScreenLuminance(0.125);
    run(w, 0, 5000, darkPage);
    const sideLamp: LightingStats = { ...darkPage, side: lamp.side, shade: lamp.shade };
    expect(run(w, 5000, 30_000, sideLamp).transitions).toEqual(['changed']);

    const v = new LightingWatch(refSig);
    v.setReference(refSig, 1);
    v.setScreenLuminance(1);
    run(v, 0, 5000, office);
    expect(run(v, 5000, 30_000, lamp).transitions).toEqual(['changed']); // on the white page
    v.setScreenLuminance(0.125); // then a dark site, same lamp
    expect(run(v, 30_000, 70_000, { ...lamp, backlight: lamp.backlight - 1.2 }).transitions).toEqual([]);
    expect(v.state.changedSinceCalibration).toBe(true);
  });
});

describe('LightingWatch fed by the probe at its slowest rate', () => {
  it('detects a lamp when measuring costs > 1.5 ms (500-ms interval), with jittered 15-fps frames and blinks', () => {
    const office = renderScene();
    const lamp = renderScene({ skinR: 100, skinL: 190 });
    let clock = 0;
    const log: CanvasLog = { created: [], draws: 0, reads: 0 };
    const probe = new LightingProbe({ backend: 'canvas', clock: () => (clock += 1.8), createCanvas: (w, h) => new FakeCanvas(w, h, log), frameFromVideo: null });
    const registry: FrameRegistry = { clones: 0, closes: 0, copies: 0, open: new Set() };
    const reference = measureScene(office)!;
    const watch = new LightingWatch(buildLightingSignature(Array.from({ length: 30 }, () => ({ stats: reference, yaw: 0, pitch: 0 }))));
    const noise = (() => {
      let s = 12345;
      return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 8 - 4; // ±4 ms
    })();
    const LAMP_AT = 12_000;
    let compared = 0;
    let ticks = 0;
    let changed: { t: number; changedAt: number | null } | null = null;
    for (let k = 0; ; k++) {
      const t = k * (1000 / 15) + noise();
      if (t > 26_000) break;
      const scene = t >= LAMP_AT ? lamp : office;
      const f = features({ blink: t % 4000 < 8 * (1000 / 15) ? 0.8 : 0.1 }); // an 8-frame blink every 4 s: not measured
      const frame = new FakeVideoFrame(scene, { format: 'NV12', fullRange: false, copy: 'resolve', rowPadding: 0 }, registry);
      probe.maybeMeasure(frame, scene.landmarks, f, 0.9, t);
      frame.close();
      const lighting = probe.take();
      watch.onFrame({ t, faceFound: true, quality: 0.9, features: f, ...(lighting ? { lighting } : {}) });
      const u = watch.tick(t);
      if (u && t >= 8000) {
        ticks++;
        if (u.comparison) compared++;
      }
      if (u?.transition === 'changed') changed ??= { t, changedAt: u.changedAt };
    }
    expect(probe.intervalMs).toBe(500);
    expect(ticks).toBeGreaterThan(15);
    expect(compared).toBe(ticks);
    expect(changed).not.toBeNull();
    expect(changed!.t - LAMP_AT).toBeLessThanOrEqual(12_500);
    expect(Math.abs(changed!.changedAt! - LAMP_AT)).toBeLessThanOrEqual(1000);
  });
});
