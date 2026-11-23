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
  for camera access and the app loads its face model (about 3.8 MB) once. Without one, pick
  **Demo** and watch a simulated reader turn the pages, or **Mouse** and point at the line you're
  reading. For private documents, read the note on the shared origin under [Privacy](#privacy).
- **claude.ai Artifact preview.** The same reader, built to run inside a claude.ai Artifact
  (`npm run build:artifact`). The Artifact frame doesn't allow camera access, so this version offers
  **Demo** and **Mouse** only, and its webcam option links to the web app above. See
  [Artifact build](#artifact-build).
- **Chrome extension.** Page turns and Dewey on any website. It isn't in the Chrome Web Store yet:
  download the zip from the [latest release](https://github.com/lance-lii/gaze-reader/releases/latest), unzip it and load the folder in Chrome or
  Edge. [docs/INSTALL-EXTENSION.md](docs/INSTALL-EXTENSION.md) walks through it.
- **Privacy.** [PRIVACY.md](PRIVACY.md) lists what the app and the extension access, what they
  store and every network request they make.

What's new in each release is in [CHANGELOG.md](CHANGELOG.md).

## Features

- **Hands-free page turns.** A one-minute calibration maps your eyes to the screen. From then on,
  Gaze Reader notices when you finish the last line and scrolls the next page into place, keeping
  two lines of context at the top.
- **Tracking that understands reading.** Webcam gaze is noisy, especially vertically, so the app
  follows the structure of reading instead of trusting raw coordinates. It groups gaze into
  fixations, tracks which line you're on with a hidden Markov model, spots return sweeps to the
  next line, and learns your vertical drift as you read.
- **Copes with leaning in and sitting back.** The tracker measures how far you are from the screen
  from the size of your face in the camera image and rescales your gaze to match, so moving nearer
  or further after calibrating no longer shifts the reading position.
- **Copes with changing light.** Turning on a lamp or reading as the sun goes down no longer throws
  the page turns off: the tracker reads your gaze from the iris rather than your eyelids, the reading
  model re-learns the offset by itself, and **A** checks the accuracy in about 10 seconds. See
  [Lighting](#lighting).
- **You stay in control.** Choose from three sensitivity presets. You can also look below the page
  to turn it, press **U** to undo a turn, press **P** to pause, or page with the keyboard as usual.
- **PDFs as they are.** A PDF opens as plain text set like a book, which the eye tracker follows
  best. Press **V** and it shows its original pages instead, with figures, equations and layout,
  and the tracker follows the lines on those pages. See [PDFs](#pdfs).
- **Real-face model (experimental, opt-in).** Builds your calibration on a model fitted on
  photographs of real people, to hold up better when your head moves. Off by default; see
  [Real-face model](#real-face-model-experimental).
- **Head gestures.** With the webcam on, a quick turn of your head pages forward or back and
  raised eyebrows pause, for when you want to steer without reaching for a key. Off until you
  switch it on. See [Head gestures](#head-gestures).
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
`public/mediapipe/wasm/`, and downloads the face model (about 3.8 MB) once into
`public/mediapipe/models/`, checking it against a pinned hash, so both are served from your own
origin and the webcam needs no connection to anyone else. (Started offline before the model was
ever fetched, the dev server still works: the app then gets the model from Google's storage.)

Browsers only allow camera access in a secure context. `localhost` counts as one. To use another
device on your network, serve the app over HTTPS.

## Using it

### Webcam mode

1. Open a book. The camera starts and a status pill in the top bar shows that it's on.
2. **Positioning:** sit where you normally read and fit your face in the oval. The checklist
   (face, distance, centered, light) turns green when you're ready.
3. **Calibration:** follow 13 dots with your eyes. Then comes the **head-movement step**: one dot
   stays in the middle, and you keep your eyes on it while you nod slowly, turn your head a
   little left and right, and tilt it toward each shoulder (about five seconds each). From that
   the tracker learns what your head's own movement does to its estimate, and takes it back out
   while you read, so shifting in your seat moves the reading position much less. **S** skips the
   step. Then 4 check points. All of it takes about a minute and a half. Press Space or tap the
   screen to pause, or Esc to cancel. At the end you'll see your accuracy in pixels and "≈ N lines
   at your text size", and whether the head movement was learned. Choose **Use it** or **Redo**.
4. Read. When you finish the last line on screen, the page turns.

Tips for good tracking:

- **Lighting:** light your face evenly from the front. A bright window *behind* you is the most
  common problem, because it leaves your face in shadow.
- **Distance:** about an arm's length from the screen (50–70 cm), with your face centered in
  the camera image. Put the laptop at a height where your eyes are level with the top of the screen.
- **Head movement:** follow the 13 dots with your eyes, not your head. In the head-movement step
  it is the other way round: the head moves and the **eyes stay on the dot**. That is the one
  thing the step depends on: if your eyes travel with your head, it learns the wrong correction.
  If tracking seems worse after a calibration than before, calibrate again (**C**) and skip the
  step with **S**. With the step done, ordinary shifting (a lowered chin, sliding down in the
  chair, a head resting on a hand) is allowed for; after moving to another seat or screen,
  recalibrate. Changes in the light are handled for you (see [Lighting](#lighting)).
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
| V | PDFs: switch between the original pages and plain text |
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

## PDFs

A PDF opens as **text**: its words are extracted and set as a book in your own typeface and size.
That is the view the eye tracker follows best, because the lines are large and evenly spaced.

Press **V** (or the pages button in the top bar) for the **pages** view: the PDF's own pages, one
below the other, with their figures, equations, tables and layout. Press it again to go back; you
keep your place, and the choice is remembered for that book.

- **Page turns work on the pages too.** Each line of a page is measured where it is drawn, so the
  reading model follows them like any text: finish the last line on screen and the page scrolls on,
  keeping your last lines at the top.
- **Smaller lines are harder to follow.** A page fitted to the window has lines about half as tall
  as the text view's, and a webcam is accurate to a line or two of the text view at best. Expect
  the "Unsure of your line" state more often; resting your eyes at the bottom right of the text,
  or a glance below the page, still turns it. A wider window makes the pages, and their lines,
  larger.
- **Two-column pages and pages without text** (full-page figures) can't be followed line by
  line. They are marked in their corner, and you turn them with Space or a head gesture.
- **Scanned PDFs are read on your device.** A PDF whose pages are pictures (a scanned book) has
  its text recognized when you open it (OCR), page by page, with a progress note and a Cancel
  button: a few seconds for a handful of pages, a few minutes for a whole book, once (the result
  is kept with the book). The text view then shows the recognized text, with the odd wrong
  letter, and the pages view shows the scans themselves with their lines followed like any
  other. The recognition engine and its English language data ship with the app; nothing is
  uploaded. It reads printed English (other Latin-alphabet languages lose their accents);
  handwriting, very faint or very small print, and two-column scans come out poorly.
- **The original file is kept on this device** for the pages view (in the browser's storage, up
  to 64 MB per PDF), and is removed when you remove the book. See [PRIVACY.md](PRIVACY.md).
- PDFs added before this version have no original kept: open the file again to get their pages.
  The Artifact build shows PDFs as text only.

## Head gestures

Switch them on in Settings → Page turning → **Head gestures**. They use the webcam and the face
tracker that is already running for your eyes: no second model, nothing more is measured or stored.

| Gesture | What it does |
|---|---|
| Turn your head quickly to your right, and back | Next page |
| Turn your head quickly to your left, and back | Previous page |
| Raise your eyebrows and hold them for a moment | Pause or resume automatic page turning |

A short message says what was understood each time. A gesture is a movement that is quick, mostly
sideways, and comes straight back (within a second), about 12° or more; keep your eyes on the page
as you make it. Looking away at something, nodding, tilting or shaking your head, leaning, settling
into a new posture, and another person's face passing through the picture don't count, and
nothing happens while Settings or Help is open. The page turns about a sixth of a second after
your head is back, which is how a turn is told from the start of a head shake.

Gestures have been tested on simulated head movement only (no false gesture in 4.5 simulated hours
of reading, fidgeting and looking around), not yet on recordings of real people: if one fires when
you didn't mean it, or doesn't when you did, switch them off and please say so. The Chrome
extension doesn't have them yet.

## Real-face model (experimental)

Settings → Eye tracking → **Real-face model (experimental)**. Off by default, web app only.

Normally your calibration learns everything from your own 13 dots. With this on, the next full
calibration stands on a small model fitted on photographs of 15 other people: it turns the eye and
head measurements into a direction of gaze, and your dots only fit that direction to your eyes and
your screen. A model that has seen many head positions knows what a turned or moved head does to
the measurements; thirteen dots with the head still cannot teach that.

On those photographs it is level with the normal calibration while the head stays where it was
(4.1° against 4.3°), and clearly better once the head has moved: 4.4° against 6.5° with the head
6–10° away, 5.4° against 9.2° beyond 10°. See [docs/REAL_DATA.md](docs/REAL_DATA.md).

It is opt-in because it has not been measured with this app and a live camera, and because this
project's simulator disagrees with the photographs about it. If tracking is worse with it, switch
it off and calibrate again (**C**). The setting changes nothing until your next full calibration;
a quick 5-dot refresh keeps whichever kind you have. The weights are licensed for non-commercial
use only (see [License](#license)).

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
   mean of MediaPipe's five iris points) sits relative to the eye corners. It adds head tilt and
   position and the model's "look up/down/in/out" blendshape scores. Head pose is measured too but
   isn't a gaze input: the iris-to-corner measure already includes where the head points, and the
   distance from the screen is applied in step 2. Lid aperture and blink scores are still
   measured, for blink detection and to notice squinting, but the gaze model ignores them: light
   moves the lids. Blinks, and frames where the eyes are closed, are dropped.
2. **Calibration** fits a ridge regression from those features to screen coordinates, with a few
   quadratic terms for the strongest features. The regularisation strength is chosen by
   leave-one-target-out cross-validation. The prediction is then scaled about the camera by how
   much nearer or further you sit than when you calibrated (the eye features measure an angle, and
   the same angle reaches further across the screen from further away), and smoothed with a One
   Euro filter.
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
   - you deliberately look below the page from the end of the last line (glance-down, which you
     can switch off). A look down that starts anywhere else, at the keyboard or a phone mid-page,
     Dewey in the corner or the edge of the screen, doesn't turn it; neither does one while the
     tracker is confident you're still above the last two lines, or before it has placed you on
     the page at all (a book just opened). If you finish a page and think or re-read for a moment
     before looking down, look back at the end of the last line first: in the end-to-end simulation
     that pause is where most of the missed turns are.

   When the tracker has been unsure which line you're on for about 10 seconds of reading (a noisy
   webcam, dim light), the status pill says **Unsure of your line**: the first rule needs the
   tracker to be sure of the last line, so pages may not turn by themselves then. Press Space to
   turn one; more light on your face, or recalibrating, usually helps. It clears once tracking has
   been steady for a few seconds.

   Guards prevent false turns: a cooldown after every scroll and after a book opens or a
   calibration ends, enough valid tracking in the last second (and tracking fast enough to follow
   the lines: at least 7 frames a second), some reading on the new page, and never a turn during a
   blink. After a turn, the
   detector waits for your eyes to come back up the page, so a resting gaze or mouse can't page
   through the book on its own.
6. **Scrolling** puts the next unread line near the top (keeping 2 lines of context by default)
   with an eased animation, or instantly if you prefer reduced motion. Scrolling (wheel, touch or
   the scrollbar) or pressing a navigation key (arrows, Page Up/Down, Home, End, Space) during
   the animation cancels it.

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
- There are no analytics, no telemetry and no remote logging. The face model and the MediaPipe
  runtime ship with the app, so the only requests to other servers are for a book URL you ask the
  reader to open. MediaPipe's built-in usage logging to Google (`odml.pa.googleapis.com`) is
  blocked before it can send anything, and a test fails if an upgrade of the library would reach
  the network any other way. The built app carries a content security policy: only its own
  scripts run.

## Chrome extension

The extension adds automatic page turns and Dewey to articles and online books on any website.
Download `gaze-reader-extension-v<version>.zip` from the [latest release](https://github.com/lance-lii/gaze-reader/releases/latest) and unzip it
into a folder you'll keep, or build that folder yourself:

```bash
npm run build:ext
```

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose the unzipped folder (or `dist-extension/` from a build).
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
src/gaze/                   Camera, MediaPipe face tracker, eye features, head pose, head gestures,
                            ridge regression + calibration model, webcam and mouse gaze sources
src/signal/                 One Euro filter, fixation detector, saccade classification
src/reading/                Line tracker (HMM) and how sure it is of the line, page-end detector,
                            simulated reader (demo + tests)
src/reader/                 Book loading (txt/md/html/epub/pdf), sanitizer, library (IndexedDB),
                            the PDF pages view and the store for PDF originals,
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
scripts/                    Extension and Artifact builds, copies of the MediaPipe runtime, the face
                            model and the OCR engine into public/, icon generator
bench/                      Slow scoreboards: lighting robustness of the gaze features, reading-layer
                            offset tolerance, replay of diagnostics recordings (npm run bench), and
                            the end-to-end harness: simulated hours of reading from webcam landmarks
                            to page turns (npm run eval)
docs/ARCHITECTURE.md        Module contracts and design notes
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server at <http://localhost:5173> (copies the MediaPipe WASM, the OCR engine and the face model into `public/` first) |
| `npm run build` | Production build of the web app into `dist/` (relative paths, so it works on any static host, e.g. GitHub Pages) |
| `npm run preview` | Serve the production build locally |
| `npm run build:ext` | Build the Chrome extension into `dist-extension/` and check the package |
| `npm run package:ext` | Zip `dist-extension/` into `release/gaze-reader-extension-v<version>.zip` for the Chrome Web Store |
| `npm run build:artifact` | Build the claude.ai Artifact version into `dist-artifact/` and check it (see [Artifact build](#artifact-build)) |
| `npm run typecheck` | TypeScript checks for the app and the extension |
| `npm test` | Run the unit and integration tests (Vitest, with jsdom for DOM tests) |
| `npm run check` | All of the above: typecheck, tests, app build, extension build |
| `npm run bench` | Slow accuracy scoreboards in `bench/` (several minutes). `GR_REPLAY=file.json npm run bench -- bench/replay` replays a diagnostics recording |
| `npm run eval` | End-to-end scoreboard (a few minutes, in parallel shards): a simulated reader with ground-truth gaze, through landmark noise, frame drops, blinks, glare, posture changes, a second face, glances at a phone or the keyboard (also right as a book opens), and pauses or re-reading after finishing a page, scored on unintended and missed page turns (with 95 % intervals), turn latency, gaze error, recalibration prompts and CPU, for the Balanced and Relaxed presets. `GR_EVAL_BASELINE=deployed` also runs the deployed page-end detector on the same seeds and prints each scenario's difference with its interval, and the missed pages per unintended turn prevented. `GR_EVAL_SEEDS`, `GR_EVAL_SEED_BASE`, `GR_EVAL_MINUTES`, `GR_EVAL_SENS`, `GR_EVAL_ONLY` and `GR_EVAL_OUT=file.json` vary it (see `bench/endtoend/eval.ts`); the per-scenario gates are `tests/endToEnd*.test.ts` |

## Releasing

Merging a new version into `main` releases it. Raise the version
(`npm version <x.y.z> --no-git-tag-version`, and the same number in `extension/manifest.json`),
head the changes in [CHANGELOG.md](CHANGELOG.md) with `## <x.y.z> (YYYY-MM-DD)`, and open a pull
request. On the pull request, the Release workflow (`.github/workflows/release.yml`) tests and
packages the extension and writes the release notes without publishing anything; its run summary
shows them. Once merged, the same workflow tags the commit `v<x.y.z>` and publishes a GitHub
release with the extension zip attached and that changelog section as its text
(`scripts/release-notes.mjs`). The web app needs no release step: every merge to `main` deploys
it. A version that is already tagged is never released twice.

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
- **Posture drift.** With the calibration's head-movement step done, a chin lowered or raised by
  4° moves the gaze 0.2–0.3 lines in simulation, and sliding down in the chair 0.4–0.5 (without
  the step: 1.0–1.4 and 2.3–3.1). That is simulation: it has not been measured on real faces, it
  depends on your eyes having stayed on the dot during the step, and it holds only as far as you
  moved your head then (beyond about one and a half times that, the correction stops growing).
  Leaning in or back is corrected (0.1–0.3 lines for 6–10 cm in
  simulation, down from 1–2), but the correction assumes the camera sits just above the middle of
  the screen you're reading on, as a laptop's or a monitor-top webcam does. With the camera
  somewhere else (a laptop's camera while you read on a second monitor), leaning still shifts the
  gaze, and it's best to calibrate where you'll sit. The model also compensates for window moves,
  but after a big change in posture it's best to recalibrate. The web app doesn't compensate for
  page zoom, fullscreen or toolbar changes; it notices them and offers a quick 5-dot refresh
  instead (the extension compensates for zoom). A pinch-zoomed page can't be followed at all: page
  turning waits until you pinch back out.
- **Not validated at scale.** The page-end rules were tuned against a simulated reader with noise,
  drift, blinks and calibration bias, not against recordings of real readers. Expect to adjust
  sensitivity to taste.
- **Books.** Images are dropped in the text view, since only text is rendered (a PDF's pages view
  shows them). Scanned PDFs are read by OCR, in English only, with the mistakes OCR makes; the
  Artifact build and the extension don't have it. PDFs using CJK/CID fonts may extract
  poorly; in the pages view, a PDF that doesn't embed its fonts is drawn in substitutes, two-column
  pages aren't followed line by line, and the smaller lines are tracked less surely
  than the text view's. DRM-protected EPUBs can't be opened, and the parts of an EPUB its
  publisher marks as outside the reading order (`linear="no"`: some footnote and answer pages)
  are left out. Text, Markdown and web pages over 32 MB aren't opened.
- **Extension.** It needs Chrome 116 or later. A site's main content is detected heuristically,
  so it can miss articles that single-page apps render late. Text inside frames isn't measured.
  It must be turned on again after a full page navigation. On canvas and image readers, page mode
  can only watch the bottom edge, not follow the lines, and some readers ignore its simulated
  next-page keys.

## License

[MIT](LICENSE) © 2026 Lance Li

One file is not MIT: `src/gaze/realFaceWeights.json`, the weights behind the opt-in
[real-face model](#real-face-model-experimental). They are fitted on the
[MPIIFaceGaze](https://doi.org/10.18419/darus-3240) dataset (Zhang, Sugano, Fritz and Bulling,
2017) and published under its licence,
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): **non-commercial use only**,
and adaptations carry the same terms. For commercial use, delete the file and the `realFaceModel`
setting; nothing else depends on them.

The built web app also serves, unmodified, the components it needs at run time, under their own
licenses: MediaPipe Tasks Vision and its face model (Apache-2.0), pdf.js (Apache-2.0), JSZip (MIT),
and for scanned PDFs tesseract.js with its WebAssembly build of Tesseract and the English
`tessdata` model (Apache-2.0).
