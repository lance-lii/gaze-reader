/**
 * Small dense ridge regression: normal equations + Cholesky.
 *
 * Calibration problems are tiny (tens of columns, a few hundred rows), so
 * forming XᵀX explicitly is both the fastest and the simplest option, and
 * standardized inputs keep it well conditioned. The intercept is never
 * penalized: we solve for the slopes on centered data and recover the bias
 * from the means, which is exactly the minimizer of
 *
 *     Σᵢ (yᵢ − b − xᵢ·w)² + λ‖w‖²
 *
 * Matrices are row-major `Float64Array`s of size n×n.
 */

export interface RidgeSolution {
  weights: number[];
  bias: number;
}

export interface RidgeMultiSolution {
  /** One weight vector per target. */
  weights: number[][];
  bias: number[];
}

/**
 * In-place Cholesky factorization A = L·Lᵀ of a symmetric positive-definite
 * matrix. Reads the lower triangle (diagonal included) and overwrites it with
 * L; the strict upper triangle is left untouched. Returns false when A is not
 * numerically positive definite (the lower triangle is then garbage).
 */
export function cholesky(a: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    const rowJ = j * n;
    const original = a[rowJ + j];
    let d = original;
    for (let k = 0; k < j; k++) d -= a[rowJ + k] * a[rowJ + k];
    // Relative pivot test: a pivot that has cancelled down to rounding noise
    // would blow the solution up even though it is technically positive.
    if (!(d > 1e-13 * Math.abs(original)) || !Number.isFinite(d)) return false;
    const ljj = Math.sqrt(d);
    a[rowJ + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      const rowI = i * n;
      let s = a[rowI + j];
      for (let k = 0; k < j; k++) s -= a[rowI + k] * a[rowJ + k];
      a[rowI + j] = s / ljj;
    }
  }
  return true;
}

/** Solves L·Lᵀ·x = b in place (b becomes x), with L from {@link cholesky}. */
export function choleskySolve(l: Float64Array, n: number, b: Float64Array): Float64Array {
  for (let i = 0; i < n; i++) {
    const row = i * n;
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l[row + k] * b[k];
    b[i] = s / l[row + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= l[k * n + i] * b[k];
    b[i] = s / l[i * n + i];
  }
  return b;
}

/**
 * Solves (S + λI)·w = r for each right-hand side, where S is a symmetric
 * scatter matrix whose lower triangle is filled. S is not modified.
 *
 * With λ = 0 and a rank-deficient S the system is singular; we then retry
 * with a tiny, growing diagonal jitter, which converges to the minimum-norm
 * least-squares solution rather than failing outright.
 */
function solveRegularized(s: Float64Array, p: number, rhs: readonly Float64Array[], lambda: number): Float64Array[] {
  if (p === 0) return rhs.map(() => new Float64Array(0));
  let trace = 0;
  for (let i = 0; i < p; i++) trace += Math.abs(s[i * p + i]);
  const scale = trace / p > 0 ? trace / p : 1;

  const a = new Float64Array(p * p);
  for (let attempt = 0; attempt <= 12; attempt++) {
    const jitter = attempt === 0 ? 0 : scale * 1e-12 * 10 ** (attempt - 1);
    a.set(s);
    for (let i = 0; i < p; i++) a[i * p + i] += lambda + jitter;
    if (cholesky(a, p)) return rhs.map((r) => choleskySolve(a, p, Float64Array.from(r)));
  }
  throw new RangeError('ridge: normal equations are not positive definite (non-finite inputs?)');
}

function assertLambda(lambda: number): void {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new RangeError(`ridge: lambda must be a finite number ≥ 0 (got ${lambda})`);
  }
}

/**
 * Fits several targets that share one design matrix with a single
 * factorization. `Y[k]` is the k-th target vector (length n).
 */
export function ridgeFitMulti(
  X: readonly (readonly number[])[],
  Y: readonly (readonly number[])[],
  lambda: number,
): RidgeMultiSolution {
  assertLambda(lambda);
  const n = X.length;
  if (n === 0) throw new RangeError('ridge: X has no rows');
  const p = X[0].length;
  for (let i = 0; i < n; i++) {
    const row = X[i];
    if (row.length !== p) throw new RangeError(`ridge: row ${i} has ${row.length} columns, expected ${p}`);
    for (let j = 0; j < p; j++) {
      if (!Number.isFinite(row[j])) throw new RangeError(`ridge: X[${i}][${j}] is not finite`);
    }
  }
  if (Y.length === 0) throw new RangeError('ridge: no targets');
  for (const y of Y) {
    if (y.length !== n) throw new RangeError(`ridge: target has ${y.length} values, expected ${n}`);
    for (let i = 0; i < n; i++) if (!Number.isFinite(y[i])) throw new RangeError(`ridge: y[${i}] is not finite`);
  }

  // Two-pass centering (means first) keeps the scatter matrix accurate even
  // for raw, uncentered inputs with large offsets.
  const mu = new Float64Array(p);
  for (const row of X) for (let j = 0; j < p; j++) mu[j] += row[j];
  for (let j = 0; j < p; j++) mu[j] /= n;
  const yMean = Y.map((y) => y.reduce((acc, v) => acc + v, 0) / n);

  const scatter = new Float64Array(p * p);
  const rhs = Y.map(() => new Float64Array(p));
  const c = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const row = X[i];
    for (let j = 0; j < p; j++) c[j] = row[j] - mu[j];
    for (let a = 0; a < p; a++) {
      const ca = c[a];
      if (ca === 0) continue;
      const base = a * p;
      for (let b = 0; b <= a; b++) scatter[base + b] += ca * c[b];
    }
    for (let k = 0; k < Y.length; k++) {
      const yc = Y[k][i] - yMean[k];
      const r = rhs[k];
      for (let j = 0; j < p; j++) r[j] += c[j] * yc;
    }
  }

  const solved = solveRegularized(scatter, p, rhs, lambda);
  const weights = solved.map((w) => Array.from(w));
  const bias = weights.map((w, k) => {
    let b = yMean[k];
    for (let j = 0; j < p; j++) b -= mu[j] * w[j];
    return b;
  });
  return { weights, bias };
}

/** Ridge regression with an unpenalized intercept. */
export function ridgeFit(X: readonly (readonly number[])[], y: readonly number[], lambda: number): RidgeSolution {
  const { weights, bias } = ridgeFitMulti(X, [y], lambda);
  return { weights: weights[0], bias: bias[0] };
}

/**
 * Sufficient statistics (count, Σx, Σxxᵀ, Σy, Σxy) for ridge problems that
 * are solved many times over different subsets — e.g. leave-one-group-out
 * cross-validation, where every fold is "total minus one group" and costs one
 * matrix subtraction instead of a pass over the data.
 *
 * Uses the one-pass centered scatter Σxxᵀ − n·x̄x̄ᵀ, which is accurate only
 * when the columns are roughly centered; feed it standardized features.
 */
export class RidgeNormalEquations {
  readonly dim: number;
  readonly targets: number;
  private n = 0;
  private readonly sx: Float64Array;
  /** Lower triangle of Σxxᵀ (row-major dim×dim). */
  private readonly sxx: Float64Array;
  private readonly sy: Float64Array;
  /** targets × dim */
  private readonly sxy: Float64Array;

  constructor(dim: number, targets: number) {
    if (!Number.isInteger(dim) || dim < 0 || !Number.isInteger(targets) || targets < 1) {
      throw new RangeError('RidgeNormalEquations: bad dimensions');
    }
    this.dim = dim;
    this.targets = targets;
    this.sx = new Float64Array(dim);
    this.sxx = new Float64Array(dim * dim);
    this.sy = new Float64Array(targets);
    this.sxy = new Float64Array(targets * dim);
  }

  get count(): number {
    return this.n;
  }

  /** Adds one observation. `x` must have `dim` entries and `y` `targets` entries, all finite. */
  add(x: ArrayLike<number>, y: ArrayLike<number>): void {
    const p = this.dim;
    this.n += 1;
    for (let a = 0; a < p; a++) {
      const xa = x[a];
      this.sx[a] += xa;
      if (xa === 0) continue;
      const base = a * p;
      for (let b = 0; b <= a; b++) this.sxx[base + b] += xa * x[b];
    }
    for (let k = 0; k < this.targets; k++) {
      const yk = y[k];
      this.sy[k] += yk;
      const base = k * p;
      for (let a = 0; a < p; a++) this.sxy[base + a] += x[a] * yk;
    }
  }

  /** this += sign · other (sign −1 removes a subset previously added). */
  merge(other: RidgeNormalEquations, sign: 1 | -1 = 1): this {
    if (other.dim !== this.dim || other.targets !== this.targets) {
      throw new RangeError('RidgeNormalEquations: dimension mismatch');
    }
    this.n += sign * other.n;
    addScaled(this.sx, other.sx, sign);
    addScaled(this.sxx, other.sxx, sign);
    addScaled(this.sy, other.sy, sign);
    addScaled(this.sxy, other.sxy, sign);
    return this;
  }

  clone(): RidgeNormalEquations {
    return new RidgeNormalEquations(this.dim, this.targets).merge(this);
  }

  /** Weights per target plus unpenalized biases. Throws when there are no observations. */
  solve(lambda: number): { weights: Float64Array[]; bias: number[] } {
    assertLambda(lambda);
    const n = this.n;
    if (!(n >= 1)) throw new RangeError('RidgeNormalEquations: no observations');
    const p = this.dim;
    const mu = new Float64Array(p);
    for (let a = 0; a < p; a++) mu[a] = this.sx[a] / n;
    const scatter = new Float64Array(p * p);
    for (let a = 0; a < p; a++) {
      const base = a * p;
      for (let b = 0; b <= a; b++) scatter[base + b] = this.sxx[base + b] - n * mu[a] * mu[b];
    }
    const rhs: Float64Array[] = [];
    const yMean: number[] = [];
    for (let k = 0; k < this.targets; k++) {
      const ym = this.sy[k] / n;
      yMean.push(ym);
      const r = new Float64Array(p);
      const base = k * p;
      for (let a = 0; a < p; a++) r[a] = this.sxy[base + a] - n * mu[a] * ym;
      rhs.push(r);
    }
    const weights = solveRegularized(scatter, p, rhs, lambda);
    const bias = weights.map((w, k) => yMean[k] - dot(mu, w));
    return { weights, bias };
  }
}

function addScaled(dst: Float64Array, src: Float64Array, s: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] += s * src[i];
}

/** Σ a[i]·b[i] over the shorter of the two. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
