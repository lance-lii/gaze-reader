/** Prefix for every localStorage / IndexedDB key this app writes. */
export const STORAGE_PREFIX = 'gazeReader.';

/** Class-name prefix for every element we create (avoids clashes inside host pages in the extension). */
export const CSS_PREFIX = 'gr-';

/** Stacking order. Extension overlays must beat host-page UI, hence the huge values. */
export const Z = {
  reader: 1,
  chrome: 100,
  debugOverlay: 2147483000,
  gazeDot: 2147483100,
  buddy: 2147483200,
  toast: 2147483300,
  panel: 2147483400,
  calibration: 2147483600,
} as const;

/**
 * MediaPipe Face Landmarker model (float16), on Google's model storage. It is data, not code. The
 * app ships its own copy (FACE_LANDMARKER_MODEL_PATH) and uses this address only when that copy is
 * missing (a dev server started offline before the model was ever fetched).
 */
export const FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Relative path (resolved against document.baseURI) of the app's own copy of that model:
 * scripts/fetch-face-model.mjs downloads it at build time and checks it against a pinned hash.
 */
export const FACE_LANDMARKER_MODEL_PATH = 'mediapipe/models/face_landmarker.task';

/** Relative path (resolved against document.baseURI) where the MediaPipe WASM runtime is served. */
export const MEDIAPIPE_WASM_DIR = 'mediapipe/wasm';

/** Attribute that excludes an element (and its subtree) from line measurement — put it on all UI chrome. */
export const IGNORE_ATTR = 'data-gr-ignore';

/** Buddy's name. */
export const BUDDY_NAME = 'Dewey';

/**
 * The page is pinch-zoomed (a trackpad or touch-screen pinch, not the browser's own zoom). The
 * screen then shows a magnified part of the layout, panned to wherever the fingers left it, while
 * every measured line and every gaze point is still in the unmagnified layout's coordinates: what
 * the reader looks at and what the reading model thinks is there no longer match, and nothing else
 * (no resize, no change of pixel ratio) says so.
 */
export function pinchZoomed(win: Pick<Window, 'visualViewport'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  const scale = win?.visualViewport?.scale;
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 1.01;
}
