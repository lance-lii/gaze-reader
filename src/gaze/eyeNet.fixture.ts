/** A made-up eye-picture network for tests. Not part of the app. */
import type { EyeNetWeights } from './eyeNet';

/** Deterministic numbers in -1..1. */
export function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** A small network with made-up numbers: the right shape, no meaning. */
export function weights(over: Partial<EyeNetWeights> = {}, seed = 7): EyeNetWeights {
  const r = noise(seed);
  const fill = (n: number, scale = 0.5): number[] => Array.from({ length: n }, () => r() * scale);
  return {
    id: 'test-net',
    eye: { height: 8, width: 12, span: 1.7, contrastFloor: 4 },
    inputs: 'eyes+head',
    convs: [
      { in: 1, out: 3, pool: true, w: fill(3 * 1 * 9), b: fill(3) },
      { in: 3, out: 4, pool: false, w: fill(4 * 3 * 9), b: fill(4) },
    ],
    dense: [
      { in: 2 * 4 + 5, out: 6, w: fill(6 * 13), b: fill(6) },
      { in: 6, out: 2, w: fill(12), b: fill(2) },
    ],
    extraMean: [0.1, -0.2, 0, 0.05, 0.3],
    extraSd: [0.5, 0.4, 0.3, 0.2, 0.1],
    labelMean: [0.02, -0.15],
    labelSd: [0.2, 0.1],
    ...over,
  };
}
