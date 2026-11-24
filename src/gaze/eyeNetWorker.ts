/**
 * The eye-picture network's background thread: every camera frame's eye region comes in, the
 * network's answer goes back. Everything it computes is in eyeNet.ts; this file only moves
 * messages, so reading does not wait on the arithmetic.
 *
 * The region arrives as an ImageBitmap (a copy the main thread no longer holds), is read through
 * a canvas here, and is closed at once: no pixels are kept, and none leave this thread.
 */
import { answerForRegion, resolveEyeNet, type EyeNet } from './eyeNet';

export type EyeNetRequest =
  | { type: 'load'; weights: unknown }
  | { type: 'frame'; seq: number; bitmap: ImageBitmap; corners: number[]; extra: number[] | null };

export type EyeNetReply =
  | { type: 'ready'; id: string }
  | { type: 'failed'; message: string }
  /** `x` and `y` are NaN when the network had nothing to say about the frame. */
  | { type: 'answer'; seq: number; x: number; y: number };

interface Scope {
  onmessage: ((event: { data: EyeNetRequest }) => void) | null;
  postMessage(reply: EyeNetReply): void;
}

interface Context2D {
  drawImage(image: ImageBitmap, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { readonly data: Uint8ClampedArray };
}

const scope = self as unknown as Scope;

let net: EyeNet | null = null;
let canvas: OffscreenCanvas | null = null;
let context: Context2D | null = null;
const scratch = { gray: new Uint8Array(0), eyes: new Uint8Array(0) };

function pixels(bitmap: ImageBitmap): Uint8ClampedArray | null {
  const { width, height } = bitmap;
  if (!canvas || !context || canvas.width < width || canvas.height < height) {
    canvas = new OffscreenCanvas(Math.max(width, canvas?.width ?? 0), Math.max(height, canvas?.height ?? 0));
    context = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as Context2D | null;
  }
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, width, height).data;
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'load') {
    net = resolveEyeNet(message.weights);
    scope.postMessage(net ? { type: 'ready', id: net.id } : { type: 'failed', message: 'That file is not an eye-picture network this version can read.' });
    return;
  }
  const { seq, bitmap, corners, extra } = message;
  let x = NaN;
  let y = NaN;
  try {
    if (net) {
      const { width, height } = bitmap;
      const rgba = pixels(bitmap);
      if (scratch.gray.length < width * height) scratch.gray = new Uint8Array(width * height);
      if (scratch.eyes.length < 2 * net.width * net.height) scratch.eyes = new Uint8Array(2 * net.width * net.height);
      const answer = rgba ? answerForRegion(net, rgba, width, height, corners, extra, scratch) : null;
      if (answer) ({ x, y } = answer);
    }
  } catch {
    // One bad frame gets no answer; the next one starts clean.
  } finally {
    bitmap.close();
  }
  scope.postMessage({ type: 'answer', seq, x, y });
};
