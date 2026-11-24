import { extractEyeFeatures } from '../../src/gaze/features';
import type { CalibrationSample, EyeFeatures, Point } from '../../src/types';

/**
 * Real faces: the MPIIFaceGaze dataset (15 people on their own laptops, over weeks, looking at
 * known points on the screen), after scripts/research/extract_mpiifacegaze.py has run the app's
 * face model over it. Each record is what the app's tracker would have been handed for one
 * picture, turned here into the app's features by the app's own code (extractEyeFeatures).
 *
 * The data is not in the repository (CC BY-NC-SA 4.0, and 190 MB): see docs/REAL_DATA.md.
 */
// The repository has no Node type definitions (it is a browser app), so Node's file API is typed here.
interface FsLike {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: string | Uint8Array): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
}
interface ProcessLike {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}
const proc = (globalThis as { process?: ProcessLike }).process;
export const fs = proc?.getBuiltinModule?.('node:fs') as FsLike | undefined;
const join = (...parts: string[]): string => parts.join('/');

export const REAL_DATA_DIR = proc?.env?.GR_REAL_DATA ?? join(proc?.cwd?.() ?? '.', '.data', 'mpiifacegaze', 'features');

export interface RealSample extends CalibrationSample {
  /** The day's number, and the picture's number within it (its order in time). */
  day: number;
  number: number;
  /** Eye-to-target distance, mm, from the dataset's own 3D estimate. */
  distanceMm: number;
  /** The dataset's face centre in the camera's frame, mm (x right, y down, z away from the camera). */
  faceMm: [number, number, number];
}

export interface Participant {
  id: string;
  screen: { widthPx: number; heightPx: number; widthMm: number; heightMm: number };
  /** Where the camera is, in screen px (from the dataset's measured screen pose). */
  cameraPx: Point;
  /** Screen millimetres per pixel. */
  mmPerPx: number;
  samples: RealSample[];
  /** Pictures in which the face model found no face, and pictures in all. */
  noFace: number;
  annotated: number;
  /** Pictures with a face whose features the app's extractor refused. */
  unusable: number;
}

interface Meta {
  participant: string;
  records: number;
  recordLength: number;
  header: number;
  landmarks: number;
  blendshapeNames: string[];
  screen: Participant['screen'];
  cameraPx: [number, number];
  noFace: number;
  annotated: number;
}

export function realDataAvailable(dir = REAL_DATA_DIR): boolean {
  return !!fs && fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^p\d+\.json$/.test(f));
}

let cached: Participant[] | null = null;

export function loadParticipants(dir = REAL_DATA_DIR): Participant[] {
  if (cached) return cached;
  const out: Participant[] = [];
  if (!fs) throw new Error('The real-face scoreboards need Node 22.3+ (process.getBuiltinModule).');
  for (const file of fs.readdirSync(dir).filter((f) => /^p\d+\.json$/.test(f)).sort()) {
    const meta = JSON.parse(new TextDecoder().decode(fs.readFileSync(join(dir, file)))) as Meta;
    const bytes = fs.readFileSync(join(dir, file.replace(/\.json$/, '.f32')));
    const data = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    const L = meta.recordLength;
    const nBlend = L - meta.header - 2 * meta.landmarks - 16;
    const samples: RealSample[] = [];
    let unusable = 0;
    for (let r = 0; r + L <= data.length; r += L) {
      const h = data.subarray(r, r + meta.header);
      let o = r + meta.header;
      const landmarks: { x: number; y: number; z: number }[] = new Array(meta.landmarks);
      for (let i = 0; i < meta.landmarks; i++) landmarks[i] = { x: data[o + 2 * i], y: data[o + 2 * i + 1], z: 0 };
      o += 2 * meta.landmarks;
      const blend = meta.blendshapeNames.slice(0, nBlend).map((categoryName, i) => ({ categoryName, score: data[o + i] }));
      o += nBlend;
      const matrix = Array.from(data.subarray(o, o + 16));
      const features: EyeFeatures | null = extractEyeFeatures(landmarks, blend, matrix, { aspectRatio: h[4] / h[5] });
      if (!features) {
        unusable++;
        continue;
      }
      const fc: [number, number, number] = [h[6], h[7], h[8]];
      samples.push({
        day: h[0],
        number: h[1],
        target: { x: h[2], y: h[3] },
        features,
        t: samples.length * 100,
        distanceMm: Math.hypot(h[9] - fc[0], h[10] - fc[1], h[11] - fc[2]),
        faceMm: fc,
      });
    }
    samples.sort((a, b) => a.day - b.day || a.number - b.number);
    out.push({
      id: meta.participant,
      screen: meta.screen,
      cameraPx: { x: meta.cameraPx[0], y: meta.cameraPx[1] },
      mmPerPx: meta.screen.widthMm / meta.screen.widthPx,
      samples,
      noFace: meta.noFace,
      annotated: meta.annotated,
      unusable,
    });
  }
  cached = out;
  return out;
}

/** Deterministic PRNG (mulberry32), so a scoreboard repeats exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = q * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
