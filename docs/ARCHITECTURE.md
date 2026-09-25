# Gaze Reader — Architecture & Module Contracts

Gaze Reader is a browser app (plus a Chrome extension) that watches your eyes through
the webcam while you read and **turns the page — scrolls — when you reach the bottom**.
**Dewey**, a tiny nerd avatar, sits in the corner reading along with you.

Everything runs locally. Video never leaves the device. The only network fetch is the
MediaPipe face-landmarker model file (data, ~3.6 MB, cached by the browser).

```
 camera ─► FaceLandmarker ─► EyeFeatures ─► GazeModel (ridge regression, calibrated)
                                                   │
 mouse ───────────────────────────────┐            ▼
 simulated reader (demo) ─────────────┴──► GazeSample stream (One Euro smoothed)
                                                   │
                         FixationDetector ◄────────┘
                                │ Fixation
                         LineTracker (HMM over the visible text lines, return-sweep aware,
                                │      learns vertical drift)            ▲
                                │ LineEstimate                           │ LineLayout
                         PageEndDetector ──► decision ──► ScrollController ──► ReaderView
                                                                         (measureLines)
            EventBus (typed, src/core/events.ts) connects everything ──► Dewey, HUD, debug overlay
```

## Ground rules for every module

* **Contracts**: `src/types.ts` is the single source of truth for shared types. Do not edit it.
  If a contract is insufficient, add a local helper type in your own file and say so in your
  final report — the integrator reconciles.
* **Only write files you own** (table below). Read anything.
* **Language**: TypeScript, `strict`, no `any` (use `unknown` + narrowing). ES2022, DOM lib.
  `verbatimModuleSyntax` is on → use `import type { … }` for type-only imports.
  Relative imports without extensions (`'../types'`).
* **Time** is `performance.now()` ms. **Positions** are viewport CSS px (clientX/Y space).
* **Styling**: modules that render UI must be *self-contained* — inject their own `<style>`
  (CSS in a TS string) into the mount root (works in `document.head` or a `ShadowRoot`). Never rely
  on `src/styles/app.css`. Prefix every class with `gr-` (`CSS_PREFIX`). Use `Z` from
  `src/core/constants.ts` for z-index. Put `data-gr-ignore` (`IGNORE_ATTR`) on every UI root so
  line measurement skips it. Respect `prefers-reduced-motion`. Support light & dark (read CSS custom
  properties with fallbacks; see "Theme tokens" below).
* **Mountable**: UI components take `mount(parent: HTMLElement | ShadowRoot)` so the extension can
  put them in a shadow root.
* **Storage**: use `readJSON/writeJSON` from `src/core/storage.ts` (never-throwing wrappers). Keys are
  auto-prefixed with `gazeReader.`.
* **Settings**: read via a `getSettings: () => AppSettings` callback; react to the `settings-changed`
  event. Request changes by emitting `settings-patch`. Never write settings storage yourself.
* **No new npm dependencies.** Installed: `@mediapipe/tasks-vision@1.0.1`, `jszip`, `pdfjs-dist@6`,
  `vite@8`, `vitest@5`, `typescript@7`, `jsdom`, `@types/chrome`.
* **Tests**: vitest. Put tests next to code as `*.test.ts`. Pure-logic tests run in node; DOM tests
  start with `// @vitest-environment jsdom`. jsdom has no layout — mock `getClientRects` /
  `getBoundingClientRect` when needed.
* **Checks** (run from `C:\Users\lance\Documents\gaze-reader`):
  `npx tsc --noEmit -p tsconfig.json` (errors in files you don't own are not yours — other agents are
  writing concurrently) and `npx vitest run <your paths>`.
* Privacy: no analytics, no remote logging, no network calls except the model URL constant
  (and user-requested book URLs in the reader).

### Theme tokens (CSS custom properties on `:root`, set by the app shell; always provide fallbacks)

`--gr-bg`, `--gr-fg`, `--gr-muted`, `--gr-accent`, `--gr-accent-fg`, `--gr-surface`, `--gr-border`,
`--gr-shadow`, `--gr-font-reading`, `--gr-font-ui`. `data-theme` on `<html>` is one of
`light | sepia | dark` (the shell resolves `auto`).

## Shared foundation (already written — do not modify)

| File | Exports |
|---|---|
| `src/types.ts` | All shared contracts |
| `src/core/events.ts` | `createEventBus(): EventBus` |
| `src/core/settings.ts` | `DEFAULT_SETTINGS`, `sanitizeSettings(x)`, `createSettingsStore(bus, {persist?, initial?}): SettingsStore` (`get`, `update`, `reset`; listens to `settings-patch`) |
| `src/core/storage.ts` | `readJSON`, `writeJSON`, `removeKey` |
| `src/core/constants.ts` | `STORAGE_PREFIX`, `CSS_PREFIX`, `Z`, `FACE_LANDMARKER_MODEL_URL`, `MEDIAPIPE_WASM_DIR`, `IGNORE_ATTR`, `BUDDY_NAME` |
| `src/signal/oneEuro.ts` | `OneEuroFilter`, `OneEuroFilter2D` (`filter(x, y, tMs): Point`, `reset()`, `setParams()`), `GAZE_ONE_EURO` |

## Module ownership & exact public APIs

### A · Face & gaze sources — `src/gaze/{camera,faceTracker,features,headPose,webcamGazeSource,mouseGazeSource}.ts`

```ts
// features.ts — pure, unit-tested
export const FEATURE_NAMES: readonly string[];
export interface LandmarkLike { x: number; y: number; z: number }
export interface BlendshapeLike { categoryName: string; score: number }
export function extractEyeFeatures(
  landmarks: readonly LandmarkLike[],            // 478 MediaPipe face landmarks (with iris)
  blendshapes: readonly BlendshapeLike[] | null,
  transformMatrix: readonly number[] | null,     // 4x4 column-major facial transformation matrix
): EyeFeatures | null;
export function frameQuality(f: EyeFeatures | null): number; // 0..1

// headPose.ts — pure
export function headPoseFromMatrix(m: readonly number[]): HeadPose;

// faceTracker.ts
export class TrackerError extends Error { readonly code: TrackerErrorCode; constructor(code, message?) }
export interface CameraFeatureSourceOptions {
  wasmBaseUrl?: string;      // default: new URL(MEDIAPIPE_WASM_DIR, document.baseURI).href
  modelAssetPath?: string;   // default: FACE_LANDMARKER_MODEL_URL
  delegate?: 'GPU' | 'CPU';  // default GPU, automatic fallback to CPU on failure
  video?: HTMLVideoElement;  // optional element to render into; otherwise one is created (hidden)
}
export class CameraFeatureSource implements FeatureSource {
  constructor(opts?: CameraFeatureSourceOptions);
  start(): Promise<void>;    // idempotent; rejects with TrackerError
  stop(): void;              // stops tracks, cancels loop; keeps the loaded model for fast restart
  onFrame(cb): Unsubscribe;
  readonly running: boolean;
  readonly video: HTMLVideoElement | null;   // for the camera preview
  readonly fps: number;                      // processed frames per second (EMA)
  readonly lastLandmarks: readonly LandmarkLike[] | null; // for preview overlays
}

// webcamGazeSource.ts — FeatureSource + GazeModel → GazeSample
export class WebcamGazeSource implements GazeSource {
  readonly kind: 'webcam';
  constructor(opts: { features: FeatureSource; getModel: () => GazeModel | null; filter?: Partial<OneEuroParams> });
  start(); stop(); onSample(cb); readonly running: boolean;
}
// Emits one GazeSample per FeatureFrame. valid=false when: no face, blink > 0.5, no model, prediction
// null. Smoothing: OneEuroFilter2D; reset the filter after >300 ms of invalid frames.
// confidence = frame.quality (0 when invalid). Does NOT own the FeatureSource lifecycle
// (start() only subscribes; the controller starts/stops the camera).

// mouseGazeSource.ts
export class MouseGazeSource implements GazeSource {
  readonly kind: 'mouse';
  constructor(opts?: { noisePx?: () => number; target?: Window; hz?: number });
}
// Emits at `hz` (default 30) from the last pointer position + Gaussian noise (Box–Muller),
// valid=false when the pointer has left the window or before the first move.
```

Feature-engineering guidance (from the MediaPipe 478-point mesh; indices refer to the subject's
anatomical sides): iris centers **468** (right eye) and **473** (left eye); right eye corners **33**
(outer) / **133** (inner), lids **159** (upper) / **145** (lower); left eye corners **362** (inner) /
**263** (outer), lids **386** / **374**. For each eye, project the iris onto the corner axis → `u`
(0 = inner … 1 = outer, normalized by eye width) and the perpendicular offset relative to the lid
midpoint → `v` (normalized by eye width); lid aperture → `open`. Add head pose (yaw, pitch, roll,
tx, ty, tz), face scale and blendshapes `eyeLookUp/Down/In/Out_{Left,Right}` and
`eyeBlink_{Left,Right}` when present (fill 0 when blendshapes are missing so the vector length stays
constant). Vertical gaze is the hard axis for webcams: lid aperture, `eyeLookDown/Up` and head
pitch carry most of the vertical signal — keep all of them. Mirror nothing: features are in raw
image space; the model learns the mapping.

MediaPipe 1.0.1 facts (verified in `node_modules/@mediapipe/tasks-vision/vision.d.ts`):
`FilesetResolver.forVisionTasks(basePath)`, `FaceLandmarker.createFromOptions(fileset,
{ baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', numFaces: 1,
outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true })`,
`detectForVideo(video, timestampMs)` → `{ faceLandmarks: NormalizedLandmark[][], faceBlendshapes:
Classifications[] (categories[]: {categoryName, score}), facialTransformationMatrixes: Matrix[]
({rows, columns, data: number[]}) }`. Timestamps passed to `detectForVideo` must strictly increase.
The WASM loader is injected with a `<script>` tag on the main thread (so it cannot run in an
extension content script — the extension uses an offscreen document). Drive the loop with
`video.requestVideoFrameCallback` when available, else `requestAnimationFrame`; skip frames when
the video time hasn't advanced.

### B · Calibration — `src/gaze/{ridge,calibrationModel}.ts`, `src/ui/calibrationOverlay.ts`

```ts
// ridge.ts — pure linear algebra, unit-tested
export function ridgeFit(X: number[][], y: number[], lambda: number): { weights: number[]; bias: number };
// calibrationModel.ts
export interface TrainOptions { viewport?: { width: number; height: number }; lambdas?: number[] }
export function trainGazeModel(samples: CalibrationSample[], opts?: TrainOptions): { model: GazeModel; report: CalibrationReport };
export function evaluateModel(model: GazeModel, samples: CalibrationSample[]): CalibrationReport;
export function deserializeGazeModel(json: SerializedGazeModel): GazeModel | null; // null if invalid/incompatible
export function saveCalibration(model: GazeModel): void;   // writeJSON('calibration.v1', …)
export function loadCalibration(): GazeModel | null;
export function clearCalibration(): void;
export function qualityFromError(errorPx: number, viewportHeight: number): CalibrationQuality;
```
Model: standardize features (z-score from training data), expand with degree-2 terms for the
strongest gaze features (iris u/v, lookUp/Down) plus linear head pose, then two independent ridge
regressions (x, y). Choose λ by **leave-one-target-out** cross-validation over a λ grid. Robustness:
drop samples with blink > 0.5 and per-target outliers (> 2.5 MAD) before fitting. `predict`
returns viewport px compensated for window moves since calibration (store `window.screenX/Y` at
train time; subtract the delta). Serialize everything needed (means, stds, weights, feature-length,
viewport, screen offset, trainedAt). Reject deserialization when the feature length changed.

```ts
// calibrationOverlay.ts
export interface CalibrationOverlayOptions {
  features: FeatureSource;           // already started by the caller
  bus: EventBus;
  video?: HTMLVideoElement | null;   // for the positioning preview
  mode?: 'quick' | 'standard';       // quick = 5 points (bias refresh of a saved model), standard = full grid
  baseModel?: GazeModel | null;      // for quick mode
}
export class CalibrationOverlay implements Mountable {
  constructor(opts: CalibrationOverlayOptions);
  mount(parent: HTMLElement | ShadowRoot): void;
  run(): Promise<{ model: GazeModel; report: CalibrationReport } | null>; // null = cancelled (Esc)
  cancel(): void;
  destroy(): void;
}
```
Flow: (1) positioning — mirrored video preview with a face-oval guide, live feedback (too far / too
close / off-center / too dark / face not found) using `EyeFeatures.faceScale`/`faceCenter`/quality;
"Start" enabled when good. (2) targets — standard mode uses a 3 × 4 grid (x = 10/50/90 %, y =
8/36/64/92 %) plus 1 extra center point, in shuffled order; each target is an animated dot that
shrinks over ~1.6 s; discard the first ~450 ms (saccade latency + settling), collect the rest;
retry a target if < 8 valid samples. (3) train. (4) validate — 4 new points (not grid points),
compute error, show results: mean error in px and as "≈ N lines at your text size" (use 22 px ×
1.9 line-height = 41.8 px if unknown), quality badge, buttons **Use it** / **Redo**. Emit
`calibration` events for every phase so Dewey can coach. Esc cancels. Full-viewport overlay with
z-index `Z.calibration`; hide the cursor during targets; big, high-contrast, accessible.

### C · Reading intelligence — `src/signal/fixations.ts`, `src/reading/{lineTracker,pageEndDetector,simulatedReader}.ts`, `src/ui/{debugOverlay,gazeDot}.ts`

```ts
// fixations.ts — online dispersion (I-DT) detector tuned for noisy webcam gaze
export interface FixationOptions { maxDispersionPx: number; minDurationMs: number; maxGapMs: number }
export class FixationDetector {
  constructor(opts?: Partial<FixationOptions>);
  push(s: GazeSample): { completed: Fixation | null; current: Fixation | null };
  reset(): void;
}
export function classifySaccade(prev: Fixation, next: Fixation, layout: LineLayout | null): SaccadeKind;

// lineTracker.ts — HMM forward filter over the lines of the current layout
export interface LineTrackerOptions { sigmaYLines: number; driftRate: number; maxDriftLines: number }
export class LineTracker {
  constructor(opts?: Partial<LineTrackerOptions>);
  setLayout(layout: LineLayout, reason: LayoutChangeReason): void; // remap posterior by docTop
  onFixation(f: Fixation): LineEstimate;
  onSample(s: GazeSample): LineEstimate | null; // cheap update of progressX from the live gaze
  afterPageTurn(resumeLineIndex: number): void;  // concentrate prior near the line reading resumes at
  reset(): void;
  readonly estimate: LineEstimate | null;
}

// pageEndDetector.ts
export interface PageEndInput { t: number; gaze: GazeSample | null; estimate: LineEstimate | null; layout: LineLayout | null }
export interface PageEndOptions { sensitivity: Sensitivity; glanceDownToTurn: boolean }
export class PageEndDetector {
  constructor(opts?: Partial<PageEndOptions>);
  configure(opts: Partial<PageEndOptions>): void;
  update(input: PageEndInput): PageEndDecision;    // call on every gaze sample
  notifyScrolled(t: number): void;                  // any scroll (auto or manual) starts a cooldown
  reset(): void;
}

// simulatedReader.ts — a synthetic reader for demo mode and tests
export interface SimulatedReaderOptions {
  getLayout: () => LineLayout | null;
  wpm?: () => number; noisePx?: number; driftPx?: number; hz?: number; seed?: number;
}
export class SimulatedReaderSource implements GazeSource { readonly kind: 'simulated'; constructor(opts: SimulatedReaderOptions); }
export function simulateReading(layout: LineLayout, opts: { wpm?: number; noisePx?: number; driftPx?: number; hz?: number; seed?: number; startLine?: number; endLine?: number; lingerMs?: number }):
  { samples: GazeSample[]; truth: { t: number; lineIndex: number }[]; lastLineEndT: number };

// debugOverlay.ts / gazeDot.ts
export class DebugOverlay implements Mountable { constructor(opts: { bus: EventBus; getSettings: () => AppSettings }); setVisible(v: boolean): void; }
export class GazeDot implements Mountable { constructor(opts: { bus: EventBus; getSettings: () => AppSettings }); setVisible(v: boolean): void; }
```

**Reading model (the heart of the app).** Webcam gaze is accurate horizontally (~2–4°) but poor
and drifty vertically, so we don't trust `y` alone. We exploit the structure of reading:
fixations march left→right along a line in small forward saccades (~7–9 characters), with
occasional short regressions, then a **return sweep** — a large leftward saccade landing at the
start of the *next* line. The LineTracker is a hidden Markov model whose hidden state is "which
visible line is being read":

* *Emission*: `N(y − driftY; line.centerY, σ_y²)` with `σ_y = sigmaYLines × linePitch` (default
  0.9, adapted online from residuals when confident, clamped 0.4–3 lines), times a horizontal
  plausibility factor (penalize x far outside the line's [left, right] — matters for short last
  lines of paragraphs).
* *Transition*, chosen by the saccade kind between consecutive fixations: forward → stay 0.85 /
  next 0.07 / prev 0.03; regression → stay 0.85 / prev 0.08 / next 0.03; **return-sweep → next
  0.75 / next+1 0.08 / stay 0.07 / prev 0.03**; jump → broad (mix 60 % uniform + vertical
  likelihood). Remaining mass spread uniformly. Normalize.
* *Drift*: when the posterior max > 0.8, `driftY += driftRate × ((y − centerY) − driftY)`, clamped
  to ±`maxDriftLines × linePitch`. Drift lives only in the reading layer; GazeSample is never
  modified.
* *Layout changes*: on scroll/resize, carry the posterior across by matching `docTop`; on
  `page-turn`, `afterPageTurn(resume)` puts ~70 % on the resume line, decaying over the next lines.
* `progressX` = (x − line.left)/(line.right − line.left) clamped 0..1 using the latest fixation or
  (in `onSample`) the smoothed gaze when valid.

**Page-end detection.** Let `L` = last fully visible line. Fire when any holds (and all guards pass):
1. **line-tracker**: `posterior[L] ≥ θp` and `progressX ≥ θx` held for ≥ `dwell` ms — or the
   tracker was confidently on `L` and then a return-sweep-like leftward saccade happens
   (finished the line, looking for the next one that isn't there) → fire immediately.
2. **bottom-dwell** (fallback when the HMM is unsure): `(gaze.y − driftY) ≥ L.top − 0.25·pitch`
   and `gaze.x` in the right half of the column for ≥ `Tzone` ms.
3. **glance-down** (if enabled): gaze at/below `viewport.bottom − 0.2·pitch` (off-screen below
   counts) for ≥ `Tglance` ms — an intentional "turn the page" gesture.

| preset | θp | θx | dwell | Tzone | Tglance | cooldown |
|---|---|---|---|---|---|---|
| relaxed | 0.70 | 0.85 | 600 | 1800 | 800 | 2200 |
| balanced | 0.55 | 0.70 | 350 | 1200 | 600 | 1800 |
| eager | 0.45 | 0.55 | 200 | 800 | 450 | 1400 |

Guards: cooldown after any scroll; ≥ 60 % valid samples over the last 1000 ms; ≥ 4 fixations
on the page or ≥ 2500 ms since the last turn (glance-down exempt); never fire during a scroll
animation (the controller doesn't call `update` then). `targetLineIndex` = the tracker's line if
it is ≥ L−1, else L.

**Simulator.** Fixations along each line: first landing ~3–5 chars in, saccades ~N(7.5, 2) chars
(char width = line width / charCount), durations ~N(225, 60) ms clamped 100–500 scaled to hit
`wpm` (≈ 6 chars/word), 10 % short regressions, return sweeps with undershoot + small corrective
saccade, 30–40 ms saccade transitions, Gaussian noise `noisePx` on every sample, slow vertical
drift up to `driftPx`, then One Euro smoothing. `SimulatedReaderSource` follows the live layout: it
remembers the `docTop` of the last line it read; when the layout's `scrollTop` changes it resumes
at the first line whose `docTop` is below that; when it reaches the last fully visible line it
lingers near its end (re-fixating, occasionally glancing left/down) until the page turns. Seeded
PRNG (mulberry32) for determinism.

**Required tests** (vitest, node): fixation detection on clean/noisy traces; HMM line accuracy
≥ 80 % of fixations on the true line with noise σ = 0.75 pitch and 0.5-pitch drift; end-to-end
`simulateReading → FixationDetector → LineTracker → PageEndDetector` over ≥ 20 seeds: fires within
1500 ms after the true end of the last line for *balanced*, never fires before the reader reaches
the last two lines, never fires with invalid (face-lost) samples, and relaxed fires no earlier than
eager.

Debug overlay (full-viewport canvas, pointer-events none, `Z.debugOverlay`): raw + smoothed gaze
trail, current fixation circle, last ~8 fixations with saccade-kind colors, measured line boxes
tinted by posterior, drift-corrected gaze marker, bottom-dwell/glance zones, and a small text panel
(line, p, progressX, driftY, σ_y, last decision detail). Throttle drawing to rAF. Gaze dot: small,
soft, semi-transparent circle following the smoothed gaze (hidden when invalid).

### D · Reader — `src/reader/{sanitize,bookLoader,epub,pdf,library,readerView,lineGeometry,scrollController}.ts`

```ts
// sanitize.ts
export function sanitizeHtml(html: string, opts?: { baseUrl?: string }): string;
// allowlist: p, br, hr, h1-h6, em, i, strong, b, u, s, sub, sup, small, blockquote, q, cite,
// ul, ol, li, dl, dt, dd, pre, code, span, div, section, article, figure, figcaption, table, thead,
// tbody, tr, th, td, a (href http/https/# only, rel=noopener, target=_blank), abbr, time.
// Strip everything else (script, style, iframe, img, svg, forms, on* attributes, style attributes,
// javascript:/data: URLs). Keep id attributes only in sanitized form (prefix "gr-src-").

// bookLoader.ts
export async function loadBookFromFile(file: File): Promise<Book>;       // .txt .md .markdown .html .htm .xhtml .epub .pdf
export function loadBookFromText(text: string, opts?: { title?: string; format?: 'txt' | 'md' | 'html'; source?: Book['source'] }): Book;
export async function loadBookFromUrl(url: string): Promise<Book>;       // fetch; clear error if CORS blocks
export interface SampleBookInfo { id: string; title: string; author: string; blurb: string; file: string }
export async function listSampleBooks(): Promise<SampleBookInfo[]>;      // fetch('samples/index.json')
export async function loadSampleBook(id: string): Promise<Book>;         // markdown file → Book
export function markdownToHtml(md: string): string;                     // small, safe subset: headings, paragraphs, emphasis, lists, blockquotes, hr, code
export function countWords(text: string): number;
export function hashId(text: string): string;                           // stable id (FNV-1a 64 → base36)

// epub.ts / pdf.ts
export async function parseEpub(data: ArrayBuffer): Promise<Omit<Book, 'source' | 'addedAt'>>;  // JSZip: container.xml → OPF → spine → XHTML → sanitize
export async function parsePdf(data: ArrayBuffer): Promise<Omit<Book, 'source' | 'addedAt'>>;   // pdfjs-dist text extraction → paragraphs (dynamic import so pdf.js loads only when needed)

// library.ts — IndexedDB (db "gazeReader", stores "books", "progress"); in-memory fallback if IDB unavailable
export async function saveBook(book: Book): Promise<void>;
export async function getBook(id: string): Promise<Book | null>;
export async function listBooks(): Promise<Array<Pick<Book, 'id' | 'title' | 'author' | 'wordCount' | 'format' | 'addedAt'> & { fraction: number; lastReadAt: number | null }>>;
export async function deleteBook(id: string): Promise<void>;
export async function saveProgress(pos: ReadingPosition): Promise<void>;
export async function getProgress(bookId: string): Promise<ReadingPosition | null>;

// lineGeometry.ts — generic; also used by the extension on arbitrary pages
export interface MeasureOptions {
  root: Element;                 // subtree to measure
  viewport: Rect;                // visible reading area (viewport px)
  scrollTop: number;             // scroller.scrollTop (or window.scrollY)
  scrollHeight: number; clientHeight: number;
  marginPx?: number;             // include lines this far outside the viewport (default 0.5 × viewport height)
}
export function measureLines(opts: MeasureOptions): LineLayout;
// TreeWalker over text nodes; prune subtrees whose bounding rect misses viewport±margin and anything
// inside [data-gr-ignore]/hidden elements; Range.getClientRects() per text node; merge rects into
// lines by vertical overlap; charCount ≈ text length distributed by rect width; docTop =
// (top − viewport.top) + scrollTop; fullyVisible = inside viewport. linePitch = median center
// delta. Must run in < 8 ms for a 150k-word book (prune aggressively; measure only near viewport).

// scrollController.ts
export interface ScrollControllerOptions { scroller: HTMLElement | Window; bus: EventBus; getSettings: () => AppSettings }
export class ScrollController {
  constructor(opts: ScrollControllerOptions);
  computeTarget(layout: LineLayout, targetLineIndex: number, overlapLines: number): number;
  turnPage(layout: LineLayout | null, targetLineIndex: number, opts: { auto: boolean; reason: string }): Promise<void>;
  pageBack(layout: LineLayout | null): Promise<void>;
  undo(): Promise<boolean>;                 // return to the position before the last turn
  scrollTo(top: number, durationMs?: number): Promise<void>;
  atEnd(): boolean;
  readonly animating: boolean;
  readonly pagesTurned: number;
  readonly lastTurnAt: number;
  destroy(): void;
}
```
Scroll target: the line placed at the top is `lines[L − overlap + 1]` where L = `targetLineIndex`
(overlap 0 → the first unread line goes to the top); new scrollTop = that line's `docTop −
0.35·pitch`, clamped to [0, max]. If that isn't at least one pitch forward (or the line doesn't
exist), fall back to `scrollTop + clientHeight − (overlap + 1)·pitch`. Animate with rAF and an
ease-in-out curve over `scrollDurationMs` (instant under `prefers-reduced-motion`); a user
wheel/touch/key during the animation cancels it. Emit `page-turn` at start and keep an undo stack
(max 20).

```ts
// readerView.ts
export class ReaderView {
  constructor(opts: { mount: HTMLElement; bus: EventBus });
  open(book: Book, position?: ReadingPosition | null): void;   // renders chapters; restores position
  close(): void;
  applySettings(s: AppSettings): void;   // font size/family, line height, column width
  measureLayout(): LineLayout;           // measureLines over the content, viewport = scroller rect
  getPosition(): ReadingPosition | null; // fraction + nearest paragraph anchor
  progress(): number;                    // 0..1
  onScroll(cb: () => void): Unsubscribe; // raw scroll events
  readonly scroller: HTMLElement;        // the scroll container (overflow-y: auto)
  readonly content: HTMLElement;
  readonly book: Book | null;
}
```
Rendering: a centered column (`max-width: <columnWidthCh>ch`), chapter headings, paragraphs get ids
`c{chapter}-p{n}`, generous bottom padding (≈ 60 % of the viewport) so the last lines of the book can
still be scrolled to the top, and an "End of book" marker. Reading typography CSS lives in
`src/reader/reader.css.ts` (exported string, injected once).

### E · Dewey the buddy — `src/buddy/{buddy,avatar,quips,styles}.ts`

```ts
export class Buddy implements Mountable {
  constructor(opts: { bus: EventBus; getSettings: () => AppSettings });
  mount(parent: HTMLElement | ShadowRoot): void;
  say(text: string, opts?: { priority?: SpeechPriority; durationMs?: number; mood?: BuddyMood }): void;
  setMood(mood: BuddyMood): void;
  lookAt(p: Point | null): void;   // viewport px; null = look at the reader
  destroy(): void;
}
export const QUIPS: Record<string, readonly string[]>; // quips.ts
```
A charming SVG nerd (~120×150 px): messy hair with a cowlick, **big round glasses with lens
glints**, pupils behind the lenses that **follow the reader's gaze** (from `gaze` events, rAF
throttled, max ~3 px travel), freckles, bow tie, argyle sweater vest, pocket protector with pens,
holding a tiny book whose page flips on every `page-turn`. Moods change brows/mouth/eyes: idle,
reading (eyes scan with the reader), happy, excited, thinking, worried, sleepy (Zzz), celebrating
(bounce + sparkles). Idle life: breathing, random blinks (2–6 s), occasional glasses push-up.

Behavior (subscribe to the bus): `page-turn` → flip book + occasional short reaction; `tracking-state`
no-face ≥ 3 s → worried "I can't see you…", back → relieved; no valid gaze 60 s → sleepy;
`calibration` phases → coaching lines; `book-opened` → greeting; `book-progress` milestones (25/50/75 %)
and every 10 pages; `book-finished` → celebrate; `break-due` → 20-20-20 eye-rest reminder;
`buddy-say` → speak; click → small menu (Pause/Resume auto-scroll, Recalibrate, Fun fact, Settings,
Hide Dewey) emitting `command` events, and `buddy-poke`. Draggable; snaps to the nearest corner and
emits `settings-patch { buddyCorner }`. Chattiness gates speech: quiet = high priority only; normal =
+ normal (≤ 1 unprompted remark per 45 s while reading); chatty = + low (fun facts). Speech bubble:
short (≤ 90 chars), auto-dismiss, `aria-live="polite"`, never covers the reading column center
(bubble opens toward the screen edge side). Hidden when `buddyEnabled` is false. Respects
reduced motion. Quips must be **factually accurate** (eye movements, reading science, books,
libraries), nerdy, kind, never snarky about reading speed.

### F · App shell — `index.html`, `src/main.ts`, `src/app/controller.ts`, `src/ui/{topbar,libraryScreen,settingsPanel,cameraPreview,toast,helpDialog,onboarding}.ts`, `src/styles/app.css`

The controller wires everything (see diagram) and owns lifecycle:
* Bus + settings store; theme tokens on `<html>` (`data-theme`, resolving `auto` via
  `prefers-color-scheme`).
* Screens: **Library** (open file via picker/drag-drop, paste text, open URL, sample books,
  recent books with progress, delete) and **Reader** (ReaderView + top bar + Dewey).
* Gaze source management (webcam | mouse | simulated), switching at runtime. Webcam path:
  onboarding/privacy explainer → `CameraFeatureSource.start()` → saved calibration via
  `loadCalibration()` else `CalibrationOverlay.run()` → `WebcamGazeSource`. Camera errors →
  friendly message + offer mouse or demo mode.
* Per gaze sample: `emit('gaze')` → `FixationDetector.push` → on completed fixation
  `LineTracker.onFixation` (+ `emit('fixation')`, `emit('line-estimate')`); `LineTracker.onSample`;
  `PageEndDetector.update` → on trigger and `autoScroll` and not animating and not at end:
  `emit('page-end')`, `ScrollController.turnPage(layout, targetLineIndex, {auto: true, reason})`,
  then re-measure, `LineTracker.setLayout(layout, 'page-turn')`,
  `LineTracker.afterPageTurn(resume)` where resume = index of the first line whose docTop > the
  target line's old docTop, `PageEndDetector.notifyScrolled(t)`. At the end of the book →
  `book-finished` once.
* Layout re-measure: on open, after scroll settles (debounced ~120 ms; manual scrolls also call
  `notifyScrolled` and `setLayout(…, 'scroll')`), resize, settings affecting typography. Emit `layout`.
* Tracking state derivation: `tracking` / `no-face` (invalid > 1 s) / `poor` (low confidence) /
  `paused` / `off` / `error`; emit `tracking-state` on change.
* Progress: save position (debounced), `book-progress` every ~5 s with fraction, words read,
  WPM (words advanced ÷ active reading minutes), pages turned, minutes reading. Break timer →
  `break-due`.
* Commands (from bus, keyboard, top bar, Dewey): Space/PageDown = page forward, Shift+Space/PageUp =
  back, U = undo last turn, P = pause/resume auto-scroll, C = recalibrate, D = debug overlay,
  G = gaze dot, S = settings, L = library, ? = help, Esc = close panels.
* Top bar: title, progress, tracking status pill (camera-on indicator!), source switch, pause,
  recalibrate, settings, library; auto-hides while reading, reappears on pointer near top.
* Settings panel: all `AppSettings`, grouped (Eye tracking, Page turning, Reading, Dewey, Advanced).
* Camera preview: small mirrored thumbnail with landmark dots, toggled by `showCameraPreview`.
* Onboarding (first run): what it does, privacy promise, choose webcam / mouse / demo.

### G · Chrome extension — `extension/**`, `scripts/build-extension.mjs`

MV3 extension "Gaze Reader" that brings auto-scroll + Dewey to any web page (online books,
articles). MediaPipe can't run in a content script (its loader injects a `<script>` into the page's
main world), so:
* **Offscreen document** (`offscreen.html`, reason `USER_MEDIA`) runs `CameraFeatureSource` with
  `wasmBaseUrl = chrome.runtime.getURL('mediapipe/wasm/')` and streams `FeatureFrame`s over a
  runtime Port.
* **Camera permission** must first be granted to the extension origin in a normal tab
  (`setup.html`, which explains why and calls `getUserMedia` once). Offscreen docs can't show prompts.
* **Service worker** (`background.ts`, module): action click / popup toggle → inject the content
  script into the active tab (`chrome.scripting`), create/close the offscreen doc, relay frames from
  offscreen to the tab(s) that are active.
* **Content script** (`content.ts`, bundled as IIFE): shadow-DOM host (`data-gr-ignore`) containing
  Dewey, gaze dot, debug overlay and `CalibrationOverlay`; `RemoteFeatureSource implements
  FeatureSource` over the Port; model training + calibration happen in-page (saved in
  `chrome.storage.local`); reading pipeline identical to the app; `measureLines` over the page's
  main content (`findMainContent(document)` — pick the element with the most paragraph text);
  `ScrollController` on `window` (or the main scrollable ancestor).
* **Popup**: on/off for this tab, source (webcam / mouse), sensitivity, recalibrate, Dewey on/off.
* Build: `scripts/build-extension.mjs` runs Vite's JS API for each entry (content → IIFE; background,
  offscreen, popup, setup) into `dist-extension/`, copies `manifest.json`, icons and the MediaPipe
  WASM (`scripts/copy-mediapipe-wasm.mjs dist-extension/mediapipe/wasm`). `extension/tsconfig.json`
  extends the root with `types: ["chrome", "vite/client"]`. Manifest CSP: extension pages
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

### H · Sample books — `public/samples/{index.json,*.md}`

Two original works (no copyrighted text): a friendly non-fiction guide to how eyes read and a short
story starring Dewey. Enough length for many page turns.

### I · Integration

After A–H: one integrator runs `npm run typecheck`, `npm test`, `npm run build`, `npm run build:ext`,
fixes seams with minimal edits, and writes `README.md`.
