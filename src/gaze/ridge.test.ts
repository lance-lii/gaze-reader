import { describe, expect, it } from 'vitest';
import { RidgeNormalEquations, cholesky, choleskySolve, ridgeFit, ridgeFitMulti } from './ridge';

/** mulberry32 — deterministic test data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function makeProblem(seed: number, n: number, w: number[], bias: number, noise: number, offset = 0) {
  const r = rng(seed);
  const X = Array.from({ length: n }, () => w.map(() => offset + gaussian(r) * 2));
  const y = X.map((row) => bias + row.reduce((s, v, j) => s + v * w[j], 0) + noise * gaussian(r));
  return { X, y };
}

describe('cholesky', () => {
  it('factorizes and solves a known SPD system', () => {
    // A = [[4, 2, 0.4], [2, 5, 1], [0.4, 1, 3]], x = [1, -2, 3]
    const A = [4, 2, 0.4, 2, 5, 1, 0.4, 1, 3];
    const x = [1, -2, 3];
    const b = new Float64Array([0, 1, 2].map((i) => A[i * 3] * x[0] + A[i * 3 + 1] * x[1] + A[i * 3 + 2] * x[2]));
    const L = Float64Array.from(A);
    expect(cholesky(L, 3)).toBe(true);
    const sol = choleskySolve(L, 3, b);
    for (let i = 0; i < 3; i++) expect(sol[i]).toBeCloseTo(x[i], 12);
  });

  it('reports non positive-definite matrices', () => {
    expect(cholesky(Float64Array.from([1, 2, 2, 1]), 2)).toBe(false);
    expect(cholesky(Float64Array.from([1, 1, 1, 1]), 2)).toBe(false); // singular
  });
});

describe('ridgeFit', () => {
  it('recovers known weights and bias', () => {
    const w = [3, -1.5, 0.25, 7, 0];
    const { X, y } = makeProblem(1, 400, w, 42, 0.05);
    const fit = ridgeFit(X, y, 1e-6);
    fit.weights.forEach((v, j) => expect(v).toBeCloseTo(w[j], 2));
    expect(fit.bias).toBeCloseTo(42, 2);
  });

  it('never penalizes the intercept, even for inputs with a large offset', () => {
    const w = [2, -1];
    const { X, y } = makeProblem(2, 300, w, -500, 0.01, 1000);
    const exact = ridgeFit(X, y, 1e-9);
    expect(exact.weights[0]).toBeCloseTo(2, 3);
    expect(exact.bias).toBeCloseTo(-500, 0);

    // Huge λ: slopes vanish, the bias becomes the mean of y (not 0).
    const flat = ridgeFit(X, y, 1e12);
    const yMean = y.reduce((a, b) => a + b, 0) / y.length;
    flat.weights.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-6));
    expect(flat.bias).toBeCloseTo(yMean, 3);
  });

  it('shrinks weights monotonically as λ grows', () => {
    const { X, y } = makeProblem(3, 60, [1, 2, 3], 0, 1);
    const norms = [0, 1, 10, 100, 1000].map((l) => Math.hypot(...ridgeFit(X, y, l).weights));
    for (let i = 1; i < norms.length; i++) expect(norms[i]).toBeLessThan(norms[i - 1]);
  });

  it('survives λ = 0 with perfectly collinear columns', () => {
    const r = rng(4);
    const X = Array.from({ length: 50 }, () => {
      const a = gaussian(r);
      return [a, 2 * a, gaussian(r)];
    });
    const y = X.map((row) => 1 + 3 * row[0] - row[2]);
    const fit = ridgeFit(X, y, 0);
    const pred = X.map((row) => fit.bias + row[0] * fit.weights[0] + row[1] * fit.weights[1] + row[2] * fit.weights[2]);
    pred.forEach((p, i) => expect(p).toBeCloseTo(y[i], 4));
  });

  it('handles an empty feature set (bias only)', () => {
    const fit = ridgeFit([[], [], []], [1, 2, 6], 1);
    expect(fit.weights).toEqual([]);
    expect(fit.bias).toBeCloseTo(3, 12);
  });

  it('rejects malformed input', () => {
    expect(() => ridgeFit([], [], 1)).toThrow(RangeError);
    expect(() => ridgeFit([[1, 2], [3]], [1, 2], 1)).toThrow(RangeError);
    expect(() => ridgeFit([[1], [2]], [1], 1)).toThrow(RangeError);
    expect(() => ridgeFit([[1], [Number.NaN]], [1, 2], 1)).toThrow(RangeError);
    expect(() => ridgeFit([[1], [2]], [1, Infinity], 1)).toThrow(RangeError);
    expect(() => ridgeFit([[1], [2]], [1, 2], -1)).toThrow(RangeError);
    expect(() => ridgeFit([[1], [2]], [1, 2], Number.NaN)).toThrow(RangeError);
  });

  it('fits several targets with one factorization', () => {
    const { X } = makeProblem(5, 200, [1, 1, 1], 0, 0);
    const y1 = X.map((r) => 1 + r[0] - r[1]);
    const y2 = X.map((r) => -2 + 0.5 * r[2]);
    const multi = ridgeFitMulti(X, [y1, y2], 0.1);
    const a = ridgeFit(X, y1, 0.1);
    const b = ridgeFit(X, y2, 0.1);
    expect(multi.weights[0]).toEqual(a.weights);
    expect(multi.weights[1]).toEqual(b.weights);
    expect(multi.bias).toEqual([a.bias, b.bias]);
  });
});

describe('RidgeNormalEquations', () => {
  it('matches ridgeFit on standardized data', () => {
    const { X, y } = makeProblem(6, 150, [0.5, -2, 1.25, 0], 3, 0.3);
    const eq = new RidgeNormalEquations(4, 1);
    X.forEach((row, i) => eq.add(row, [y[i]]));
    for (const lambda of [0, 0.01, 1, 100]) {
      const a = eq.solve(lambda);
      const b = ridgeFit(X, y, lambda);
      Array.from(a.weights[0]).forEach((v, j) => expect(v).toBeCloseTo(b.weights[j], 8));
      expect(a.bias[0]).toBeCloseTo(b.bias, 8);
    }
  });

  it('subtracting a subset equals never having added it (leave-one-group-out)', () => {
    const { X, y } = makeProblem(7, 90, [1, -1, 2], 0, 0.5);
    const total = new RidgeNormalEquations(3, 1);
    const held = new RidgeNormalEquations(3, 1);
    const rest = new RidgeNormalEquations(3, 1);
    X.forEach((row, i) => {
      total.add(row, [y[i]]);
      (i % 3 === 0 ? held : rest).add(row, [y[i]]);
    });
    const fold = total.clone().merge(held, -1);
    expect(fold.count).toBe(rest.count);
    const a = fold.solve(0.3);
    const b = rest.solve(0.3);
    Array.from(a.weights[0]).forEach((v, j) => expect(v).toBeCloseTo(b.weights[0][j], 9));
    expect(a.bias[0]).toBeCloseTo(b.bias[0], 9);
  });

  it('refuses to solve without observations and to merge mismatched shapes', () => {
    expect(() => new RidgeNormalEquations(2, 1).solve(1)).toThrow(RangeError);
    expect(() => new RidgeNormalEquations(2, 1).merge(new RidgeNormalEquations(3, 1))).toThrow(RangeError);
    expect(() => new RidgeNormalEquations(-1, 1)).toThrow(RangeError);
  });
});
