// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraPreview, type PreviewSource } from './cameraPreview';

/** Manually driven rAF, ResizeObserver and 2D context (jsdom has none of them). */
function installFakes() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(nextId, cb);
    return nextId++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flushFrame = () => {
    const due = [...frames.entries()];
    frames.clear();
    for (const [, cb] of due) cb(performance.now());
  };

  const observers: (() => void)[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: () => void) {
        observers.push(() => this.cb());
      }
      observe(): void {}
      disconnect(): void {}
    },
  );

  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { frames, flushFrame, observers, ctx };
}

function fakeSource(): PreviewSource & { video: HTMLVideoElement } {
  const video = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 } as unknown as HTMLVideoElement;
  const landmarks = Array.from({ length: 478 }, (_, i) => ({ x: 0.3 + (i % 20) * 0.02, y: 0.3 + Math.floor(i / 20) * 0.01 }));
  return { running: true, video, lastLandmarks: landmarks };
}

describe('CameraPreview', () => {
  let fakes: ReturnType<typeof installFakes>;
  beforeEach(() => {
    fakes = installFakes();
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws each new video frame but measures its canvas only when it resizes', () => {
    const preview = new CameraPreview({ onHide: () => undefined });
    preview.mount(document.body);
    const canvas = document.querySelector('canvas')!;
    const measure = vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 176, 132));
    const src = fakeSource();
    preview.attach(src);
    preview.setVisible(true);

    for (let i = 0; i < 10; i++) {
      (src.video as { currentTime: number }).currentTime += 1 / 30;
      fakes.flushFrame();
    }
    expect(fakes.ctx.drawImage).toHaveBeenCalledTimes(10);
    expect(measure).toHaveBeenCalledTimes(1);

    // Same video frame, same landmarks: nothing to redraw.
    fakes.flushFrame();
    expect(fakes.ctx.drawImage).toHaveBeenCalledTimes(10);

    // A resize re-measures once, and redraws even though the video hasn't advanced.
    fakes.observers.forEach((notify) => notify());
    fakes.flushFrame();
    fakes.flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(fakes.ctx.drawImage).toHaveBeenCalledTimes(11);
    preview.destroy();
  });

  it('shows only when visible with a source, and stops its frame loop when hidden or destroyed', () => {
    const preview = new CameraPreview({ onHide: () => undefined });
    preview.mount(document.body);
    const figure = document.querySelector<HTMLElement>('.gr-preview')!;
    preview.setVisible(true);
    expect(figure.hidden).toBe(true); // no source yet
    preview.attach(fakeSource());
    expect(figure.hidden).toBe(false);
    expect(fakes.frames.size).toBe(1);
    preview.setVisible(false);
    expect(figure.hidden).toBe(true);
    expect(fakes.frames.size).toBe(0);
    preview.setVisible(true);
    preview.destroy();
    expect(fakes.frames.size).toBe(0);
    expect(document.querySelector('.gr-preview')).toBeNull();
  });

  it('says it is looking for the reader when the tracker has no face', () => {
    const preview = new CameraPreview({ onHide: () => undefined });
    preview.mount(document.body);
    vi.spyOn(document.querySelector('canvas')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 176, 132));
    const src = { ...fakeSource(), lastLandmarks: null };
    preview.attach(src);
    preview.setVisible(true);
    fakes.flushFrame();
    expect(document.querySelector<HTMLElement>('.gr-preview__lost')!.hidden).toBe(false);
    preview.destroy();
  });
});
