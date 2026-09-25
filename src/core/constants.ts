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

/** MediaPipe Face Landmarker model (float16). Fetched at runtime; it is data, not code. */
export const FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** Relative path (resolved against document.baseURI) where the MediaPipe WASM runtime is served. */
export const MEDIAPIPE_WASM_DIR = 'mediapipe/wasm';

/** Attribute that excludes an element (and its subtree) from line measurement — put it on all UI chrome. */
export const IGNORE_ATTR = 'data-gr-ignore';

/** Buddy's name. */
export const BUDDY_NAME = 'Dewey';
