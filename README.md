# Gaze Reader

**Your eyes turn the page.** Gaze Reader is a browser e-reader that follows your eyes through the
webcam and scrolls to the next page when you reach the bottom of the current one. Dewey, a small
bespectacled reading buddy, sits in the corner and reads along with you.

Face tracking runs entirely in your browser with [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
Video never leaves your device, there is no account, and nothing is uploaded. A Chrome extension
brings the same page turning (and Dewey) to articles and online books on any website.

## Features

- **Hands-free page turns.** A one-minute calibration maps your eyes to the screen. From then on,
  Gaze Reader notices when you finish the last line and scrolls the next page into place, keeping
  a line of context at the top.
- **Tracking that understands reading.** Webcam gaze is noisy, especially vertically, so the app
  follows the structure of reading instead of trusting raw coordinates. It groups gaze into
  fixations, tracks which line you're on with a hidden Markov model, spots return sweeps to the
  next line, and learns your vertical drift as you read.
- **You stay in control.** Choose from three sensitivity presets. You can also look below the page
  to turn it, press **U** to undo a turn, press **P** to pause, or page with the keyboard as usual.
- **Dewey.** An animated nerd with round glasses whose pupils follow your gaze. He flips his tiny
  book on every page turn, coaches you through calibration, cheers at 25/50/75 % and at the end,
  and reminds you to rest your eyes (20-20-20). He's chatty, quiet or hidden, whichever you like.
  You can drag him to any corner.
- **A proper reader.** Open EPUB, PDF, plain text, Markdown or HTML files, paste text, or load a
  URL. Your library and reading positions stay in the browser (IndexedDB). You can change the
  typeface, size, line spacing, column width and theme (light, sepia, dark, or follow the system).
  Two original sample books are included.
- **No webcam? No problem.** **Mouse mode** follows your pointer, with optional jitter that mimics
  a webcam. **Demo mode** has a simulated reader read the page, so you can watch page turns happen.
- **See under the hood.** A debug overlay shows raw and smoothed gaze, fixations, saccade types,
  the line tracker's beliefs and exactly what the page-end detector is waiting for. There's also a
  gaze dot and a mirrored camera preview.
- **Chrome extension** for any web page (see [below](#chrome-extension)).

## Quick start

Requires Node.js 20.19+ or 22.12+ and a browser with a webcam (recent Chrome, Edge, Firefox or Safari).

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The first run walks you through a short intro and asks how you'd
like to read: **webcam**, **mouse** or **demo**.

`npm run dev` first copies the MediaPipe WASM runtime from `node_modules` into
`public/mediapipe/wasm/`, so it's served from your own origin. The face model (about 3.6 MB) is
downloaded once from Google's model storage and cached by the browser.

Browsers only allow camera access in a secure context. `localhost` counts as one. To use another
device on your network, serve the app over HTTPS.

## Using it

### Webcam mode

1. Open a book. The camera starts and a status pill in the top bar shows that it's on.
2. **Positioning:** sit where you normally read and fit your face in the oval. The checklist
   (face, distance, centered, light) turns green when you're ready.
3. **Calibration:** follow 13 dots with your eyes, then 4 check points. It takes about a minute.
   Press Space or tap the screen to pause, or Esc to cancel. At the end you'll see your accuracy
   in pixels and "≈ N lines at your text size". Choose **Use it** or **Redo**.
4. Read. When you finish the last line on screen, the page turns.

Tips for good tracking:

- **Lighting:** light your face evenly from the front. A bright window *behind* you is the most
  common problem, because it leaves your face in shadow.
- **Distance:** about an arm's length from the screen (50–70 cm), with your face centered in
  the camera image. Put the laptop at a height where your eyes are level with the top of the screen.
- **Keep your head still-ish:** follow the dots with your eyes, not your head, and read in roughly
  the posture you calibrated in. Small movements are fine. After a big change in posture, lighting
  or seating, recalibrate (**C**; takes about a minute).
- **Glasses:** tilt the screen or the lamp to get rid of reflections on the lenses. Glare over
  the iris confuses the tracker.
- **Window size:** calibration is tied to the window size. If you resize, the app offers a quick
  5-dot refresh.
- If pages turn too early, choose **Relaxed** sensitivity. If they turn too late, choose **Eager**.
  **U** undoes a turn, and after a couple of undos the app suggests Relaxed.

The calibration is saved in the browser, so the next session starts right away. To throw it
away, open Settings → Forget calibration.

### Mouse mode

Point at the line you're reading. When the pointer rests near the end of the last line (or
below the text), the page turns. This is a good way to try the app without a camera, or to test
page-turn behaviour. Settings → Advanced adds Gaussian jitter to the pointer so it behaves like a
webcam tracker.

### Demo mode

A simulated reader reads the page at an adjustable speed (Settings → Advanced, words per
minute). It makes realistic fixations, regressions and return sweeps, with noise and drift. The
gaze dot shows where it is looking, so you can watch a page turn happen. Press **D** to see what
the reading model sees.

## Keyboard shortcuts

In the app (shortcuts are ignored while you're typing in a field):

| Key | Action |
|---|---|
| Space, Page Down | Next page |
| Shift+Space, Page Up | Previous page |
| U | Undo the last page turn |
| P | Pause or resume automatic page turns |
| C | Recalibrate the camera |
| D | Show or hide the debug overlay |
| G | Show or hide the gaze dot |
| S | Settings |
| L | Back to the library |
| ? | Help |
| Esc | Close panels / cancel calibration |

The extension uses **Alt+Shift+<key>** on web pages, so it never clashes with the site's own
shortcuts. For example, Alt+Shift+P pauses, Alt+Shift+↓/↑ turns pages, Alt+Shift+U undoes a turn,
Alt+Shift+C recalibrates, Alt+Shift+H lists all of them, and Alt+Shift+X turns Gaze Reader off.
Alt+Shift+G turns it on or off from anywhere; you can change this shortcut at
`chrome://extensions/shortcuts`.

## How page-turn detection works

```
camera → Face Landmarker (478 landmarks, blendshapes, head pose) → eye features
       → calibrated ridge regression → gaze point → One Euro smoothing
       → fixations → line tracker (HMM) → page-end detector → smooth scroll
```

1. **Eye features.** For each video frame, the app measures where each iris sits between the eye
   corners and relative to the lids. It adds lid aperture, head pose and the model's
   "look up/down/in/out" blendshape scores. Blinks, and frames where the eyes are closed, are
   dropped.
2. **Calibration** fits a ridge regression from those features to screen coordinates, with a few
   quadratic terms for the strongest features. The regularisation strength is chosen by
   leave-one-target-out cross-validation. Gaze is then smoothed with a One Euro filter.
3. **Fixations.** A dispersion-based detector groups the smoothed gaze into fixations (pauses of
   roughly 80–600 ms).
4. **Which line?** The reader view measures every visible line of text. A hidden Markov model
   tracks which line you're on. Its transition probabilities follow the saccade just made:
   *forward*, *regression*, *return sweep* to the next line, or *jump*. It also learns the
   tracker's vertical drift, which webcams suffer from most.
5. **Page end.** The page turns when any of these holds for long enough (the thresholds come from
   the sensitivity preset):
   - the tracker is confident you're on the last fully visible line and your gaze has stayed near
     its end for a moment, or you finish it and your eyes jump back to the left looking for a
     next line that isn't there;
   - your gaze rests at the bottom right of the text (a fallback for when the tracker is unsure);
   - you deliberately look below the page (glance-down, which you can switch off).

   Guards prevent false turns: a cooldown after every scroll, enough valid tracking in the last
   second, some reading on the new page, and never a turn during a blink. After a turn, the
   detector waits for your eyes to come back up the page, so a resting gaze or mouse can't page
   through the book on its own.
6. **Scrolling** puts the next unread line near the top (keeping 1 line of context by default)
   with an eased animation, or instantly if you prefer reduced motion. Scrolling or pressing a key
   during the animation cancels it.

## Privacy

- Face tracking runs locally (WebAssembly + WebGL). Video frames are never recorded, uploaded
  or stored.
- The camera runs only while a book is open in the app (or while the extension is on in a tab).
  It stops when you go back to the library or hide the tab for a minute. When it's on, a status
  pill says so.
- Books, reading progress, settings and calibration stay in your browser (IndexedDB,
  `localStorage`, or `chrome.storage.local` for the extension).
- There are no analytics, no telemetry and no remote logging. The only network requests are the
  face-landmark model file and any book URL you ask the reader to open.

## Chrome extension

The extension adds automatic page turns and Dewey to articles and online books on any website.

```bash
npm run build:ext
```

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose the `dist-extension/` folder.
3. On a page you want to read, click the Gaze Reader toolbar button and turn it on (or press
   **Alt+Shift+G**).
4. The first time, a setup tab asks for camera access. Choose **Allow** or **Allow while visiting
   the site**, not "Allow this time", which expires as soon as the tab closes. Chrome runs the
   face tracker in an offscreen document, and that document can't ask for permission itself.
5. Calibrate on the page. The calibration is shared across sites and adjusts automatically for
   each site's zoom level.

The popup can switch between webcam and mouse, change sensitivity, show or hide Dewey and the
gaze dot, and recalibrate. The extension only runs in tabs where you turn it on. It needs the
`activeTab`, `scripting`, `storage` and `offscreen` permissions.

## Project structure

```
index.html, src/main.ts     App entry
src/types.ts                Shared contracts between modules
src/core/                   Event bus, settings store, storage, constants
src/gaze/                   Camera, MediaPipe face tracker, eye features, head pose,
                            ridge regression + calibration model, webcam and mouse gaze sources
src/signal/                 One Euro filter, fixation detector, saccade classification
src/reading/                Line tracker (HMM), page-end detector, simulated reader (demo + tests)
src/reader/                 Book loading (txt/md/html/epub/pdf), sanitizer, library (IndexedDB),
                            reader view, line measurement, scroll controller
src/buddy/                  Dewey: avatar, behaviour, quips, styles
src/ui/                     Calibration overlay, top bar, library, settings, help, onboarding,
                            toasts, camera preview, gaze dot, debug overlay
src/app/                    Controller (wires everything) and pure shell logic
src/styles/app.css          App shell styles and theme tokens
public/samples/             The two sample books
extension/                  Chrome MV3 extension: service worker, offscreen tracker, content
                            script, popup, camera setup page
scripts/                    Extension build, MediaPipe WASM copy, icon generator
docs/ARCHITECTURE.md        Module contracts and design notes
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server at <http://localhost:5173> (copies the MediaPipe WASM first) |
| `npm run build` | Production build of the web app into `dist/` (relative paths, so it works on any static host, e.g. GitHub Pages) |
| `npm run preview` | Serve the production build locally |
| `npm run build:ext` | Build the Chrome extension into `dist-extension/` and check the package |
| `npm run typecheck` | TypeScript checks for the app and the extension |
| `npm test` | Run the unit and integration tests (Vitest, with jsdom for DOM tests) |
| `npm run check` | All of the above: typecheck, tests, app build, extension build |

## Known limitations

- **Webcam accuracy is limited.** A good calibration is typically accurate to about 1–2 lines
  of text. Horizontal accuracy is good. Vertical accuracy is the weak axis: looking down lowers
  your eyelids and hides part of the iris. The line tracker and drift correction make up for a
  lot of this, but large text and generous line spacing (the defaults) help. Very small text makes
  the last line hard to tell apart.
- **Lighting and glasses.** Dim or back-lit faces and reflections on glasses make tracking
  noticeably worse, and so does a camera that sees you from a steep angle.
- **Posture drift.** Calibration assumes you sit roughly as you did while calibrating. The model
  compensates for window moves and learns slow vertical drift, but after a big change in posture
  it's best to recalibrate. Page zoom and browser toolbar changes aren't compensated in the web
  app (the extension handles zoom).
- **Not validated at scale.** The page-end rules were tuned against a simulated reader with noise,
  drift, blinks and calibration bias, not against recordings of real readers. Expect to adjust
  sensitivity to taste.
- **Books.** Images are dropped, since only text is rendered. PDFs need selectable text (there's
  no OCR), and PDFs using CJK/CID fonts may extract poorly. DRM-protected EPUBs can't be opened.
- **Extension.** It needs Chrome 116 or later. A site's main content is detected heuristically,
  so it can miss articles that single-page apps render late. It must be turned on again after a
  full page navigation.

## License

[MIT](LICENSE) © 2026 Lance Li
