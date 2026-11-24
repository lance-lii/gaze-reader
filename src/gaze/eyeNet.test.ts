import { describe, expect, it } from 'vitest';
import { cropEye, cropEyes, EYE_CORNERS, eyeNetExtras, resolveEyeNet, runEyeNet, toGray, type EyeNetWeights } from './eyeNet';
import { noise, weights } from './eyeNet.fixture';

/** The same network written the slow, obvious way. */
function reference(w: EyeNetWeights, eyes: ArrayLike<number>, extra: number[]): { x: number; y: number } {
  const { height: H, width: W, contrastFloor } = w.eye;
  const feats: number[] = [];
  for (let e = 0; e < 2; e++) {
    const px = Array.from({ length: H * W }, (_, i) => eyes[e * H * W + i]);
    const mean = px.reduce((a, b) => a + b, 0) / px.length;
    const sd = Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / (px.length - 1));
    let maps: number[][][] = [Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (px[y * W + x] - mean) / (sd + contrastFloor)))];
    for (const layer of w.convs) {
      const h = maps[0].length;
      const wd = maps[0][0].length;
      let next: number[][][] = [];
      for (let o = 0; o < layer.out; o++) {
        const map = Array.from({ length: h }, () => new Array<number>(wd).fill(0));
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < wd; x++) {
            let sum = layer.b[o];
            for (let c = 0; c < layer.in; c++) {
              for (let ky = 0; ky < 3; ky++) {
                for (let kx = 0; kx < 3; kx++) {
                  const v = maps[c][y + ky - 1]?.[x + kx - 1] ?? 0;
                  sum += v * layer.w[((o * layer.in + c) * 3 + ky) * 3 + kx];
                }
              }
            }
            map[y][x] = Math.max(0, sum);
          }
        }
        next.push(map);
      }
      if (layer.pool) {
        next = next.map((m) =>
          Array.from({ length: Math.floor(h / 2) }, (_, y) =>
            Array.from({ length: Math.floor(wd / 2) }, (_, x) => Math.max(m[2 * y][2 * x], m[2 * y][2 * x + 1], m[2 * y + 1][2 * x], m[2 * y + 1][2 * x + 1])),
          ),
        );
      }
      maps = next;
    }
    for (const m of maps) feats.push(m.flat().reduce((a, b) => a + b, 0) / (m.length * m[0].length));
  }
  let x = [...feats, ...extra.map((v, i) => (v - w.extraMean[i]) / w.extraSd[i])];
  w.dense.forEach((layer, l) => {
    x = Array.from({ length: layer.out }, (_, o) => {
      const sum = layer.b[o] + x.reduce((a, v, i) => a + v * layer.w[o * layer.in + i], 0);
      return l === w.dense.length - 1 ? sum : Math.max(0, sum);
    });
  });
  return { x: x[0] * w.labelSd[0] + w.labelMean[0], y: x[1] * w.labelSd[1] + w.labelMean[1] };
}

function pictures(w: EyeNetWeights, seed: number): Uint8Array {
  const r = noise(seed);
  return Uint8Array.from({ length: 2 * w.eye.height * w.eye.width }, () => Math.round(128 + 100 * r()));
}

describe('runEyeNet', () => {
  it('gives the answer of the same network written the obvious way', () => {
    const w = weights();
    const net = resolveEyeNet(w)!;
    for (const seed of [1, 2, 3]) {
      const eyes = pictures(w, seed);
      const extra = [0.2, -0.1, 0.05, 0.1, 0.25];
      const got = runEyeNet(net, eyes, extra)!;
      const want = reference(w, eyes, extra);
      expect(got.x).toBeCloseTo(want.x, 4);
      expect(got.y).toBeCloseTo(want.y, 4);
    }
  });

  it('handles odd picture sizes, where pooling drops the last row and column', () => {
    const w = weights({ eye: { height: 9, width: 13, span: 1.7, contrastFloor: 4 } });
    const net = resolveEyeNet(w)!;
    const eyes = pictures(w, 5);
    const extra = [0, 0, 0, 0, 0];
    const got = runEyeNet(net, eyes, extra)!;
    const want = reference(w, eyes, extra);
    expect(got.x).toBeCloseTo(want.x, 4);
    expect(got.y).toBeCloseTo(want.y, 4);
  });

  it('gives the same answer every time (no state carried between frames)', () => {
    const w = weights();
    const net = resolveEyeNet(w)!;
    const a = pictures(w, 1);
    const b = pictures(w, 2);
    const extra = [0, 0, 0, 0, 0];
    const first = runEyeNet(net, a, extra)!;
    runEyeNet(net, b, extra);
    expect(runEyeNet(net, a, extra)).toEqual(first);
  });

  it('answers the same for a brighter or lower-contrast room, nearly', () => {
    const w = weights();
    const net = resolveEyeNet(w)!;
    const eyes = pictures(w, 4).map((v) => 60 + (v - 28) * 0.5);
    const brighter = eyes.map((v) => v + 40);
    const extra = [0, 0, 0, 0, 0];
    const a = runEyeNet(net, eyes, extra)!;
    const b = runEyeNet(net, brighter, extra)!;
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it('has no answer without the inputs it was trained with', () => {
    const w = weights();
    const net = resolveEyeNet(w)!;
    expect(runEyeNet(net, pictures(w, 1), null)).toBeNull();
    expect(runEyeNet(net, pictures(w, 1), [0, 0, NaN, 0, 0])).toBeNull();
    expect(runEyeNet(net, new Uint8Array(10), [0, 0, 0, 0, 0])).toBeNull();
  });

  it('runs a network that takes the pictures alone', () => {
    const r = noise(3);
    const w = weights({
      inputs: 'eyes',
      extraMean: [],
      extraSd: [],
      dense: [{ in: 8, out: 2, w: Array.from({ length: 16 }, () => r()), b: [0, 0] }],
    });
    const net = resolveEyeNet(w)!;
    const eyes = pictures(w, 9);
    const got = runEyeNet(net, eyes, null)!;
    const want = reference(w, eyes, []);
    expect(got.x).toBeCloseTo(want.x, 4);
    expect(got.y).toBeCloseTo(want.y, 4);
  });
});

describe('resolveEyeNet', () => {
  it('survives a round trip through JSON', () => {
    expect(resolveEyeNet(JSON.parse(JSON.stringify(weights())))?.id).toBe('test-net');
  });

  it('turns down anything malformed', () => {
    const w = weights();
    const bad: unknown[] = [
      null,
      [],
      'weights',
      { ...w, id: '' },
      { ...w, eye: { ...w.eye, width: 0 } },
      { ...w, eye: { ...w.eye, height: 4000 } },
      { ...w, eye: { ...w.eye, span: 0 } },
      { ...w, convs: [] },
      { ...w, convs: [{ ...w.convs[0], in: 2 }, w.convs[1]] },
      { ...w, convs: [{ ...w.convs[0], w: w.convs[0].w.slice(1) }, w.convs[1]] },
      { ...w, convs: [{ ...w.convs[0], b: [1, 2, Number.NaN] }, w.convs[1]] },
      { ...w, convs: [{ ...w.convs[0], w: w.convs[0].w.map(String) }, w.convs[1]] },
      { ...w, dense: [w.dense[0]] },
      { ...w, dense: [{ ...w.dense[0], in: 12 }, w.dense[1]] },
      { ...w, extraSd: [0.5, 0.4, 0, 0.2, 0.1] },
      { ...w, extraSd: [0.5] },
      { ...w, labelSd: [0.2, 0] },
      { ...w, labelMean: [0.2] },
    ];
    for (const b of bad) expect(resolveEyeNet(b)).toBeNull();
  });

  it('turns down a network too large to be one of these', () => {
    const w = weights();
    const huge = { ...w, convs: [{ in: 1, out: 256, pool: false, w: [], b: [] }, { in: 256, out: 256, pool: false, w: [], b: [] }, { in: 256, out: 256, pool: false, w: [], b: [] }, { in: 256, out: 256, pool: false, w: [], b: [] }, { in: 256, out: 256, pool: false, w: [], b: [] }] };
    expect(resolveEyeNet(huge)).toBeNull();
  });
});

describe('cropEye', () => {
  const net = { width: 12, height: 8, span: 1 };
  /** A frame whose brightness says where a pixel is: 2·x + 20·y. */
  const frame = (w: number, h: number): Uint8Array => Uint8Array.from({ length: w * h }, (_, i) => 2 * (i % w) + 20 * Math.floor(i / w));

  it('copies the frame when the eye is level and as wide as the picture', () => {
    const out = new Uint8Array(96);
    // Corners 12 px apart around (10, 5): the picture's top-left pixel is the frame's (4, 1).
    expect(cropEye(frame(20, 10), 20, 10, 4, 5, 16, 5, false, net, out)).toBe(true);
    expect(out[0]).toBe(2 * 4 + 20 * 1);
    expect(out[11]).toBe(2 * 15 + 20 * 1);
    expect(out[7 * 12]).toBe(2 * 4 + 20 * 8);
  });

  it('mirrors left to right, keeping up and down', () => {
    const plain = new Uint8Array(96);
    const flipped = new Uint8Array(96);
    cropEye(frame(20, 10), 20, 10, 4, 5, 16, 5, false, net, plain);
    cropEye(frame(20, 10), 20, 10, 4, 5, 16, 5, true, net, flipped);
    // Row 0 of the mirrored picture is still the frame's top row of the region, read right to left.
    expect(flipped[0]).toBe(plain[11] + 2);
    expect(flipped[0] - flipped[1]).toBe(2);
    expect(flipped[12] - flipped[0]).toBe(20);
    expect(plain[12] - plain[0]).toBe(20);
  });

  it('halves the detail when the eye is twice as large in the frame', () => {
    const out = new Uint8Array(96);
    cropEye(frame(40, 20), 40, 20, 8, 10, 32, 10, false, net, out);
    expect(out[1] - out[0]).toBe(4);
    expect(out[12] - out[0]).toBe(40);
  });

  it('follows a tilted head: the picture’s rows run along the line between the corners', () => {
    const out = new Uint8Array(96);
    const f = Uint8Array.from({ length: 30 * 30 }, (_, i) => 4 * (i % 30));
    // Corners one above the other: along a picture row the frame's x does not change.
    cropEye(f, 30, 30, 15, 9, 15, 21, false, net, out);
    expect(out[5]).toBe(out[0]);
    expect(out[12]).not.toBe(out[0]);
  });

  it('repeats the edge past the frame, and refuses corners that coincide', () => {
    const out = new Uint8Array(96).fill(7);
    expect(cropEye(frame(20, 10), 20, 10, -6, 5, 6, 5, false, net, out)).toBe(true);
    expect(out[0]).toBe(out[5]);
    expect(cropEye(frame(20, 10), 20, 10, 5, 5, 5, 5, false, net, out)).toBe(false);
    expect(cropEye(frame(20, 10), 20, 10, Number.NaN, 5, 5, 5, false, net, out)).toBe(false);
  });
});

describe('cropEyes', () => {
  it('cuts both eyes, the second mirrored, from normalized landmarks', () => {
    const net = { width: 12, height: 8, span: 1 };
    const w = 64;
    const h = 32;
    const f = Uint8Array.from({ length: w * h }, (_, i) => 3 * (i % w));
    const landmarks: { x: number; y: number }[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
    landmarks[EYE_CORNERS[0][0]] = { x: 10 / w, y: 16 / h };
    landmarks[EYE_CORNERS[0][1]] = { x: 22 / w, y: 16 / h };
    landmarks[EYE_CORNERS[1][0]] = { x: 40 / w, y: 16 / h };
    landmarks[EYE_CORNERS[1][1]] = { x: 52 / w, y: 16 / h };
    const out = new Uint8Array(192);
    expect(cropEyes(f, w, h, landmarks, net, out)).toBe(true);
    expect(out[1] - out[0]).toBe(3);
    expect(out[96 + 1] - out[96]).toBe(-3);
    expect(cropEyes(f, w, h, landmarks.slice(0, 100), net, out)).toBe(false);
    expect(cropEyes(f, w, h, landmarks, net, new Uint8Array(100))).toBe(false);
  });
});

describe('toGray and eyeNetExtras', () => {
  it('weighs the colours the way video does', () => {
    const out = toGray([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], new Uint8Array(4));
    expect(Array.from(out)).toEqual([255, 76, 150, 29]);
  });

  it('reads the head’s angles and where the face is in the picture', () => {
    const index = { yaw: 0, pitch: 1, roll: 2, tx: 3, ty: 4, tz: 5 };
    expect(eyeNetExtras([0.1, 0.2, 0.3, 4, -6, 20], index)).toEqual([0.1, 0.2, 0.3, 0.2, -0.3]);
  });
});
