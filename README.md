# Gaze Reader

**Your eyes turn the page.** Gaze Reader is a browser e-reader that follows your eyes through the
webcam and scrolls to the next page when you reach the bottom of the current one. Dewey, a small
bespectacled reading buddy, sits in the corner and reads along with you.

Face tracking runs entirely in your browser with [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
Video never leaves your device, there is no account, and nothing is uploaded. A Chrome extension
brings the same page turning (and Dewey) to articles and online books on any website.

## Try it

- **Web app: <https://lance-lii.github.io/gaze-reader/>.** Nothing to install. The site is served
  over HTTPS, so the webcam works there in a recent Chrome, Edge, Firefox or Safari. The first run
  asks how you'd like to read: **webcam**, **mouse** or **demo**. With the webcam, the browser asks
  for camera access and the app downloads the face model (about 3.6 MB) once. Without one, pick
  **Demo** and watch a simulated reader turn the pages, or **Mouse** and point at the line you're
  reading. For private documents, read the note on the shared origin under [Privacy](#privacy).
- **claude.ai Artifact preview.** The same reader, built to run inside a claude.ai Artifact
  (`npm run build:artifact`). The Artifact frame doesn't allow camera access, so this version offers
  **Demo** and **Mouse** only, and its webcam option links to the web app above. See
  [Artifact build](#artifact-build).
- **Chrome extension.** Page turns and Dewey on any website. It isn't in the Chrome Web Store yet;
  [docs/INSTALL-EXTENSION.md](docs/INSTALL-EXTENSION.md) walks through building it and loading it
  in Chrome or Edge.
- **Privacy.** [PRIVACY.md](PRIVACY.md) lists what the app and the extension access, what they
  store and every network request they make.

What's new in each release is in [CHANGELOG.md](CHANGELOG.md).

## Features

- **Hands-free page turns.** A one-minute calibration maps your eyes to the screen. From then on,
  Gaze Reader notices when you finish the last line and scrolls the next page into place, keeping
  a line of context at the top.
- **Tracking that understands reading.** Webcam gaze is noisy, especially vertically, so the app
  follows the structure of reading instead of trusting raw coordinates. It groups gaze into
  fixations, tracks which line you're on with a hidden Markov model, spots return sweeps to the
  next line, and learns your vertical drift as you read.
- **Copes with changing light.** Turning on a lamp or reading as the sun goes down no longer throws
  the page turns off: the tracker reads your gaze from the iris rather than your eyelids, the reading
  model re-learns the offset by itself, and **A** checks the accuracy in about 10 seconds. See
  [Lighting](#lighting).
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
downloaded from Google's model storage and cached by the browser, but the web app has no offline
mode: the webcam needs a connection the first time it starts in a tab.

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
  the posture you calibrated in. Small movements are fine. After a big change in posture or
  seating, recalibrate (**C**; takes about a minute). Changes in the light are handled for you
  (see [Lighting](#lighting)).
- **Glasses:** tilt the screen or the lamp to get rid of reflections on the lenses. Glare over
  the iris confuses the tracker.
- **Window size:** calibration is tied to the window's size and layout. If you resize or zoom the
  window, or go fullscreen or show a toolbar, the app offers a quick 5-dot refresh.
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
| P | Pause or resume auto-scroll |
| C | Recalibrate the camera |
| A | Check tracking accuracy (a few dots; correct it on the spot if it's off) |
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

## Lighting

Light changes how open your eyes are. In bright light or glare most people squint a little
(the lid opening shrinks by about 0.75 mm at 1,200 lux), and in a dim room the eyes open wider.
Gaze Reader 1.0 read up-and-down gaze mostly from the eyelids, so a lamp switched on made it
think you were reading a few lines lower than you were (pages turned early), and dim light made
it read higher (pages turned late). Here is what changed:

- **The tracker reads the iris, not the lids.** Vertical gaze now comes from the centre of the
  iris (averaged over MediaPipe's five iris points) measured from the eye corners, plus the
  "look up/down" scores and head pose. In simulation a 10% squint used to move the gaze by
  0.8–5.5 lines; now it moves it by 0.2–1.1 lines, or 0.5–2.8 when only the upper lid drops (the
  usual case in bright light). The reading model and the accuracy check absorb the rest.
  Cross-validated calibration error is as good or better; frame-to-frame jitter is slightly
  higher. Calibrations from 1.0 no longer fit, so the app asks you to **recalibrate once**.
- **The reading model re-learns the offset.** It tracks a vertical offset of up to ±5 lines (1.0:
  ±1.5), re-anchors it at every page turn, and resets it when the camera sees the light or your
  eyelids change. In the simulator, offsets of ±2 to ±4 lines keep the reader on the right line
  95–99.5% of the time with no early or missed page turns (1.0: 0–5%, and every turn early or
  missed).
- **It notices the light.** A few times a second the app measures the lighting on your face
  (about 17 numbers, never pictures; see [PRIVACY.md](PRIVACY.md)) and compares it with the light
  you calibrated in. The comparison uses ratios (the whites of your eyes against the background,
  one cheek against the other), so it doesn't depend on skin tone.

**Tips.** Calibrate in the light you read in. Light your face from the front; a window or lamp
behind you leaves your face in shadow. If your glasses reflect a lamp, tilt the screen or the lamp
a little. Dewey mentions a back light, reflections or a very dark room once per book (a small
message does, when he's hidden or set to quiet).

**Accuracy check (A).** Five dots show how far off the tracking is right now, in lines ("reads
about 2 lines low", or "up to 2 lines off near the top and bottom" when the dots disagree), and
whether the light has changed since calibration. **Correct it** applies a quick fix fitted on
those same dots; **Done** leaves the calibration alone. When the quick fix can't take the error
out (typically after sitting nearer or further than when you calibrated), it suggests a full
calibration instead. It's also in Settings → Eye tracking → Check accuracy.

**Quick 5-dot refresh.** When the light has changed since calibration, or the reading model has had
to correct more than 1.5 lines for about 20 seconds, Dewey and a small message offer a quick
refresh: five dots that re-centre your calibration (about 10 seconds). The offer waits until you
pause or turn a page, comes at most every 10 minutes (twice per book, once per change of light),
and **Not now** silences it for half an hour.

**Tracking diagnostics.** If tracking misbehaves, Settings → Advanced → **Record tracking
diagnostics (no video)** records up to 10 minutes of numbers: the eye measurements, gaze
estimates, lighting readings, line positions and page turns, plus your settings, your browser, and
your camera's settings and name (usually its model). No video, no images and no book text. It
stays in the browser until you press **Stop and download**, which saves a JSON file you can share
with the developers; see [PRIVACY.md](PRIVACY.md). A chip in the top bar shows while it records. Developers replay a recording through the current reading model
with `GR_REPLAY=path/to/file.json npm run bench -- bench/replay` (PowerShell:
`$env:GR_REPLAY='…'; npm run bench -- bench/replay`). The web app only; the Artifact build has
no camera and no downloads.

## How page-turn detection works

```
camera → Face Landmarker (478 landmarks, blendshapes, head pose) → eye features
       → calibrated ridge regression → gaze point → One Euro smoothing
       → fixations → line tracker (HMM) → page-end detector → smooth scroll
```

1. **Eye features.** For each video frame, the app measures where the centre of each iris (the
   mean of MediaPipe's five iris points) sits relative to the eye corners. It adds head pose and
   the model's "look up/down/in/out" blendshape scores. Lid aperture and blink scores are still
   measured, for blink detection and to notice squinting, but the gaze model ignores them: light
   moves the lids. Blinks, and frames where the eyes are closed, are dropped.
2. **Calibration** fits a ridge regression from those features to screen coordinates, with a few
   quadratic terms for the strongest features. The regularisation strength is chosen by
   leave-one-target-out cross-validation. Gaze is then smoothed with a One Euro filter.
3. **Fixations.** A dispersion-based detector groups the smoothed gaze into fixations (pauses of
   roughly 80–600 ms).
4. **Which line?** The reader view measures every visible line of text. A hidden Markov model
   tracks which line you're on. Its transition probabilities follow the saccade just made:
   *forward*, *regression*, *return sweep* to the next line, or *jump*. It also learns the
   tracker's vertical offset (up to ±5 lines), which webcams suffer from most, re-anchors it at
   every page turn, and re-learns it when the camera reports that the light or the eyelids
   changed.
5. **Page end.** The page turns when any of these holds for long enough (the thresholds come from
   the sensitivity preset):
   - the tracker is confident you're on the last fully visible line and your gaze has stayed near
     its end for a moment, or you finish it and your eyes jump back to the left looking for a
     next line that isn't there;
   - your gaze rests at the bottom right of the text (a fallback for when the tracker is unsure);
   - you deliberately look below the page (glance-down, which you can switch off). It is ignored
     while the tracker is confident you're still above the last two lines, so a look at the
     keyboard mid-page doesn't turn it.

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
- The hosted demo runs on https://lance-lii.github.io, and every GitHub Pages project site of
  that account (for example `/habitat-designer/`) shares that origin. Those sites can read the
  library (IndexedDB `gazeReader`) and settings/calibration (`localStorage` `gazeReader.*`). If
  you choose a persistent camera grant, they can also use the camera without asking. For private
  documents, run it locally (`npm run dev` / `npm run preview`) or host it on its own origin, and
  prefer "Allow this time" for the camera on the hosted demo. Forks deployed to
  `<you>.github.io` have the same property.
- There are no analytics, no telemetry and no remote logging. The only network requests are the
  face-landmark model file and any book URL you ask the reader to open. MediaPipe's built-in
  usage logging to Google (`odml.pa.googleapis.com`) is blocked before it can send anything.

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

The popup can switch between webcam and mouse, change sensitivity, choose how pages turn, show or
hide Dewey and the gaze dot, and recalibrate. The extension only runs in tabs where you turn it
on. It needs the `activeTab`, `scripting`, `storage` and `offscreen` permissions.

Some readers draw their pages as pictures (Kindle Cloud Reader, Google Play Books, some PDF
viewers), so there are no text lines to follow. On those pages the extension switches to **page
mode**: looking at the bottom edge of the page turns it, either by scrolling or by pressing the
reader's own next-page keys (→ and Page Down). The popup's **Turn pages by: Auto / Scrolling /
Next-page key** setting chooses which. Simulated key presses are best effort, because many readers
ignore them.

Step-by-step install for Chrome and Edge, with troubleshooting, is in
[docs/INSTALL-EXTENSION.md](docs/INSTALL-EXTENSION.md). `npm run package:ext` zips the build for
the Chrome Web Store (see [docs/CHROME-WEB-STORE.md](docs/CHROME-WEB-STORE.md)). What the app and
the extension access and store is in [PRIVACY.md](PRIVACY.md).

## Artifact build

`npm run build:artifact` builds a version that runs inside a claude.ai Artifact frame, in
`dist-artifact/`: `gaze-reader.html` (content only: the frame supplies the doctype, head and body;
all CSS and JS are inline), `pdf.worker.min.mjs` and `samples/`. Publish all of them together.

The frame refuses camera access and blocks MediaPipe's model and runtime, so this build leaves
MediaPipe out and offers **Demo** and **Mouse** only. The webcam option says it needs the
[full app](https://lance-lii.github.io/gaze-reader/) and links there. "Open from URL" is hidden
(cross-origin fetches are blocked), and the "auto" theme follows the viewer's theme on the host
page. The target is a compile-time constant (`__GR_TARGET__`, read through `src/core/target.ts`),
so the web app contains none of this and the Artifact page none of MediaPipe. The build checks
the page against the frame's rules (no document tags, scripts only inline or from the allowed
CDNs, no network URLs in `fetch()`, no leftover chunks, under 16 MB) and fails otherwise.

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
src/app/                    Controller (wires everything), pure shell logic, diagnostics recorder
src/styles/app.css          App shell styles and theme tokens
src/styles/artifact.css     Extra styles for the Artifact build (layout inside the frame)
public/samples/             The two sample books
extension/                  Chrome MV3 extension: service worker, offscreen tracker, content
                            script, popup, camera setup page
scripts/                    Extension and Artifact builds, MediaPipe WASM copy, icon generator
bench/                      Slow scoreboards: lighting robustness of the gaze features, reading-layer
                            offset tolerance, replay of diagnostics recordings (npm run bench)
docs/ARCHITECTURE.md        Module contracts and design notes
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server at <http://localhost:5173> (copies the MediaPipe WASM first) |
| `npm run build` | Production build of the web app into `dist/` (relative paths, so it works on any static host, e.g. GitHub Pages) |
| `npm run preview` | Serve the production build locally |
| `npm run build:ext` | Build the Chrome extension into `dist-extension/` and check the package |
| `npm run package:ext` | Zip `dist-extension/` into `release/gaze-reader-extension-v<version>.zip` for the Chrome Web Store |
| `npm run build:artifact` | Build the claude.ai Artifact version into `dist-artifact/` and check it (see [Artifact build](#artifact-build)) |
| `npm run typecheck` | TypeScript checks for the app and the extension |
| `npm test` | Run the unit and integration tests (Vitest, with jsdom for DOM tests) |
| `npm run check` | All of the above: typecheck, tests, app build, extension build |
| `npm run bench` | Slow accuracy scoreboards in `bench/` (several minutes). `GR_REPLAY=file.json npm run bench -- bench/replay` replays a diagnostics recording |

## Known limitations

- **Webcam accuracy is limited.** A good calibration is typically accurate to about 1–2 lines
  of text. Horizontal accuracy is good. Vertical accuracy is the weak axis: looking down lowers
  your eyelids and hides part of the iris. The line tracker and drift correction make up for a
  lot of this, but large text and generous line spacing (the defaults) help. Very small text makes
  the last line hard to tell apart.
- **Lighting and glasses.** Dim or back-lit faces and reflections on glasses make tracking
  noticeably worse, and so does a camera that sees you from a steep angle. A reflection right on
  the iris moves the iris-based gaze more than it moved 1.0's lid-based gaze. The lighting and
  eyelid thresholds were tuned on simulations and a synthetic face, not yet on many real webcams:
  diagnostics recordings (see [Lighting](#lighting)) are the way to check them.
- **Posture drift.** Calibration assumes you sit roughly as you did while calibrating. The model
  compensates for window moves and learns slow vertical drift, but after a big change in posture
  it's best to recalibrate. The web app doesn't compensate for page zoom, fullscreen or toolbar
  changes; it notices them and offers a quick 5-dot refresh instead (the extension compensates for
  zoom).
- **Not validated at scale.** The page-end rules were tuned against a simulated reader with noise,
  drift, blinks and calibration bias, not against recordings of real readers. Expect to adjust
  sensitivity to taste.
- **Books.** Images are dropped, since only text is rendered. PDFs need selectable text (there's
  no OCR), and PDFs using CJK/CID fonts may extract poorly. DRM-protected EPUBs can't be opened.
- **Extension.** It needs Chrome 116 or later. A site's main content is detected heuristically,
  so it can miss articles that single-page apps render late. Text inside frames isn't measured.
  It must be turned on again after a full page navigation. On canvas and image readers, page mode
  can only watch the bottom edge, not follow the lines, and some readers ignore its simulated
  next-page keys.

## License

[MIT](LICENSE) © 2026 Lance Li
