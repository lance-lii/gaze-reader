# Changelog

All notable changes to Gaze Reader are listed here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

Steadier tracking. Readers found the tracker "very buggy": the gaze dot trembled, the reading
position sat a line or two off after shifting in the chair, and page turns came early or late.

### Web app and extension

- **Head turns no longer throw the gaze off.** The calibration used to read head turn and tilt as
  extra gaze cues, but during calibration the head barely moves, so what it learned was mostly
  noise. Sitting with your chin 4° lower then moved the gaze 1.5–2.3 lines in simulation, and a 4°
  turn 70–120 px sideways. The iris-to-corner measure already includes where the head points, so
  the model now leaves head turn and tilt out: the same chin drop moves it 0.9–1.4 lines, the turn
  about 43 px, and calibration accuracy is as good or better. Recalibrate once to get it (older
  calibrations keep working as before).
- **A steadier gaze dot.** The dot now rests on the word you're reading instead of trembling around
  it, and still hops along with your eyes. This changes only what you see; page turning works as
  before.
- **Fewer wrong-line page turns on long paragraphs.** Sitting nearer or further back than at
  calibration stretches the gaze about the middle of the screen: the top reads high and the bottom
  low. The reading layer had to chase that with a fast-moving offset, and a fast-moving offset let
  it settle a line or more away from you on pages with no paragraph breaks. It now learns the
  stretch on its own as you read, so the offset can move half as fast. In simulation, long
  gapless paragraphs keep 93.5 % of fixations on the right line instead of 84 %, with no early
  or missed turn; single-paragraph pages 83 % instead of 69 %; and on web articles (the extension)
  a 15 % stretch costs no turn and keeps 94–98 % on the line. Not yet fixed: if gaze reads 2–3 lines low from the start, the first page of a
  long paragraph still often turns early. The debug overlay shows the learned stretch ("gain").
- **A glance at your phone no longer turns the page.** Looking below the page turns it
  (glance-down), but whenever the reading layer wasn't sure which line you were on, any look down
  counted: a glance at your phone or the keyboard mid-page, or the gaze dipping below the page
  while you read the last lines. A look down now counts only when it starts at the end of the last
  line, where you finish the page. In the new end-to-end simulation (`npm run eval`), unintended
  page turns fell from 12.9 to 7.2 an hour, for one more missed turn in a hundred. The extension's
  page mode, which has no lines to follow, still turns on any look down.
- **Calibration starts over when the window changes.** Resizing or zooming the window, or moving it
  to another screen, in the middle of the dots mixed dots from before and after the change into one
  calibration, which then read your gaze in the wrong place. The dots now start over from the first
  one, with a short note saying why.

### Web app

- **A camera that stops comes back on its own.** After a laptop wakes from sleep the camera often
  freezes or stops: a frozen camera left the reader at "looking for you" for good, and a stopped
  one got a toast blaming another app, even when the camera had been unplugged. Gaze Reader now
  restarts the camera once by itself when it sends no picture for 5 seconds or its video ends.
  If it can't start, the message says why (no camera found, access blocked, busy), and a camera
  that stops again within a minute is reported, with Try again.
- **Switching cameras asks for a recalibration.** A calibration only fits the camera it was made
  with. When the camera changes mid-reading (unplugging an external webcam falls back to the
  built-in one), Gaze Reader now says so and offers to recalibrate, instead of reading your gaze
  through the old camera's calibration.
- **The right message when the browser can't run the face model.** With WebAssembly turned off or
  blocked (some managed or locked-down browsers), the message asked you to check your internet
  connection and offered Try again, which could never work. It now says this browser can't run
  the face tracker, and offers the mouse and the demo.
- **One zoom step asks for the quick refresh.** Zooming the page by one step (to 90 % or 110 %)
  changed the window by less than the size check allowed, so the calibration kept reading your gaze
  about a tenth off, roughly two lines at the bottom of the page. Any zoom change now offers the
  5-dot refresh, and opening a book at another zoom starts with it.
- **Opening a book again finds it in your library.** A library entry was tied to how the app
  rendered the book, so after an update that rendered a file differently, opening the same file
  again added a second copy that started from the beginning. Books are now also recognised by their
  file, page or pasted text, so you land back on your page. A book added with an earlier version is
  recognised this way after you have opened its file once more; if this version renders that file
  differently, that once still adds a second copy.
- **Words no longer run together in some EPUBs.** A space that a book wraps in its own styled run
  (common in InDesign and Calibre EPUBs, and in Word HTML) was dropped: "The quick" became
  "Thequick".
- **XHTML files open.** A standalone .xhtml file with an empty `<title/>` (or a self-closed
  `<script/>`) in its header failed with "We couldn't find any readable text".
- **Arabic and Hebrew books keep their direction.** A right-to-left direction set for the whole
  document was lost, so the text was laid out left to right. Page turning by gaze still expects
  left-to-right lines.
- **Markdown fixes.** A hard-wrapped line that starts with a year ("…ended in / 1945. Then…") no
  longer turns into a numbered list, and a `~~~` code block whose first line holds a backtick no
  longer swallows the rest of the book.
- **Odd files can't freeze the tab.** A Project Gutenberg text with a very long run of blank lines,
  or a Markdown paragraph full of `**` or `_` that never close, took several seconds to open; both
  now open at once.

### Chrome extension

- **Web pages can no longer press Gaze Reader's shortcuts.** A page's own scripts could send fake
  Alt+Shift key presses to turn Gaze Reader off, change your settings in every tab, start a
  calibration or, with the camera blocked, keep bringing the setup tab to the front. The shortcuts
  now answer only real key presses. On a site that forwards your keys out of an embedded frame as
  fake key presses, the Alt+Shift shortcuts stop working; the toolbar button and Alt+Shift+G still
  work there.

### Privacy

- **The camera promises are tested.** Automated tests now check that the camera stays off in the
  library and stops when you go back to it, and that it stops after a tab has been hidden for a
  minute and comes back with the tab, as [PRIVACY.md](PRIVACY.md) says.

## 1.1.0 (unreleased, 2026-09-25)

Lighting robustness. Beta readers found that "if there's light then it sometimes offsets where
I am reading": switching on a lamp made pages turn early, and dim light made them turn late or not
at all. Light changes how open the eyes are (most people squint a little in bright light or glare,
and open their eyes wider in the dark), and 1.0 read up-and-down gaze mostly from the eyelids.
See [Lighting](README.md#lighting) in the README.

### Please recalibrate once

- The eye tracking changed, so a 1.0 calibration no longer fits. On your first visit the app
  (and the extension) explains this and asks you to calibrate again. Calibrate in the light you
  usually read in.

### Web app and extension

- **Gaze from the iris, not the eyelids.** Vertical gaze now comes from the centre of each iris
  (all five of MediaPipe's iris points) measured from the eye corners, plus the "look up/down"
  scores and head pose. Lid opening and blink scores are still measured, for blinks and to notice
  squinting, but no longer steer the gaze. In simulation a 10% squint used to move the gaze by
  0.8–5.5 lines; now it moves it by 0.2–1.1 lines (0.5–2.8 when only the upper lid drops).
  Calibration accuracy is as good or better.
- **The reading model corrects a larger offset by itself.** It tracks a vertical gaze offset of up
  to ±5 lines (1.0: ±1.5), checks it again at every page turn, and starts learning it afresh when
  the camera sees the light or your eyelids change. In the simulator, a steady offset of 2–4 lines
  keeps 95–99.5% of fixations on the right line with no early or missed page turns (1.0: 0–5%,
  with every turn early or missed). The learned offset is kept when you open another book with
  the same calibration.
- **It notices the light.** A few times a second the app reduces a few small areas of the camera
  frame to about 17 lighting numbers (never pictures) and compares them with the light you
  calibrated in. The comparison uses ratios, such as the whites of your eyes against the
  background, so it doesn't depend on skin tone. "Too dark" is now judged from the whites of your
  eyes rather than your face.
- **Lighting tips.** The calibration's positioning step checks the light: light behind you,
  reflections on your glasses, too dark, too bright, light from one side, flickering light. While
  you read, Dewey (or a short message, when he's hidden or quiet) mentions a back light,
  reflections or a very dark room once per book. In the extension the status line names the light
  problem ("Shaky: bright light behind you").
- **Accuracy check.** Press **A** (**Alt+Shift+A** in the extension), or use Settings → Eye
  tracking → Check accuracy or the extension popup. Five dots, about 10 seconds, show how far off
  the tracking is right now ("reads about 2 lines low") and whether the light has changed since
  calibration. **Correct it** fixes the offset from those same dots; **Done** leaves the
  calibration alone; when a quick fix can't help, it suggests a full calibration.
- **Quick 5-dot refresh on offer.** When the light has changed since calibration, or the reading
  model has had to correct 1.5 lines or more for about 20 seconds, Dewey and a small message
  offer a 10-second refresh. It waits for a pause or a page turn (web app), comes at most every
  10 minutes and once per change of light, and **Not now** silences it for 30 minutes. A change
  noticed while offers are held back (just after opening a book or calibrating) is offered once
  they're allowed again.
- **The gaze dot and Dewey's eyes** subtract the offset the reading model has learned, so they
  show where you are actually reading.

### Web app

- **Tracking diagnostics.** Settings → Advanced → **Record tracking diagnostics (no video)**
  records up to 10 minutes of numbers (eye measurements, gaze estimates, lighting readings, line
  positions, page turns, settings, browser and camera details) in memory. **Stop and download**
  saves a JSON file you can send to the developers. Nothing is recorded unless you start it, and
  nothing is uploaded. See [PRIVACY.md](PRIVACY.md).

### Chrome extension

- The same lighting handling as the web app: the offscreen camera document sends the lighting
  numbers along with the eye numbers, and the popup shows when the light differs from calibration
  and has a **Check accuracy** button.
- Refresh offers are rate-limited across all your tabs (a small record, `gr.touchUp.v1`, holds
  when one was last offered or snoozed).
- Turning Gaze Reader off and on again on a page, or the camera coming back after a hidden tab,
  keeps the offset it had learned.

### Privacy

- The calibration now also stores a short summary of the conditions you calibrated in: a few
  lighting ratios and how open your eyes were. Ratios only, no images, nothing about skin tone.
- Diagnostics recordings leave out face brightness (which depends on skin tone). They include the
  camera's name as the computer reports it, which is disclosed in PRIVACY.md and in Settings.

### Known limitations

- The lighting and eyelid thresholds were tuned on simulations and a synthetic face, not yet on
  many real webcams. Diagnostics recordings are the way to check them.
- The iris-based gaze jitters slightly more from frame to frame, and a reflection right on the
  iris moves it more than it moved 1.0's lid-based gaze.
- With very noisy tracking on long paragraphs without gaps, a page can still turn a line early or
  late now and then.
- Switching between a very bright and a very dark page (a dark theme or site) can be taken for a
  change of light and bring one unnecessary refresh offer.

## 1.0.0 (2026-09-25)

The first release. Try it at <https://lance-lii.github.io/gaze-reader/>.

### Web app

- **Hands-free page turns.** The webcam follows your eyes and scrolls the next page into place when
  you finish the last line on screen, keeping a line of context at the top. Face tracking runs
  entirely in your browser with MediaPipe Face Landmarker. Video is never recorded or uploaded.
- **Calibration** takes about a minute: a positioning check, 13 dots, then 4 check points, with
  your accuracy shown in pixels and in lines of text. It is saved in the browser for next time.
  If you resize or zoom the window, go fullscreen or show a toolbar, the app offers a quick 5-dot
  refresh.
- **Tracking built for reading.** Gaze is grouped into fixations, a line tracker follows which line
  you're on and learns the webcam's vertical drift, and the page turns only when you've clearly
  reached the end. Choose **Relaxed**, **Balanced** or **Eager** sensitivity. You can also look
  below the page to turn it (glance-down, ignored while you're clearly still mid-page), press **U**
  to undo a turn or **P** to pause, or page with the keyboard as usual.
- **Mouse and demo modes** for trying it without a webcam. In demo mode a simulated reader reads
  the page so you can watch the pages turn by themselves.
- **Dewey**, a small reading buddy in the corner. His eyes follow your gaze, he flips his book on
  every page turn, coaches you through calibration, cheers your progress and reminds you to rest
  your eyes. Make him chatty, quiet or hidden, and drag him to any corner.
- **A proper reader.** Open EPUB, PDF (with selectable text), plain text, Markdown or HTML files,
  paste text, or load a URL. Your library and reading positions stay in the browser. Choose the
  typeface, size, line spacing, column width and theme (light, sepia, dark or system). Two
  original sample books are included.
- **See under the hood** with a debug overlay (**D**) that shows raw and smoothed gaze, fixations,
  the line tracker's beliefs and what the page-end detector is waiting for.
- **Private by design.** No account, analytics, telemetry or remote logging. The only downloads
  are the face model and any book URL you open. MediaPipe's built-in usage logging to Google is
  blocked before it can send anything.

### Chrome extension

- **Page turns and Dewey on any website**, for articles and online books. Turn it on per tab from
  the toolbar button or with **Alt+Shift+G**. On-page shortcuts use **Alt+Shift+<key>** so they
  never clash with the site's own.
- **Page mode** for readers that draw pages as pictures (such as Kindle Cloud Reader, Google Play
  Books or some PDF viewers). Looking at the bottom edge of the page turns it, by scrolling or by
  pressing the reader's next-page keys. The popup's **Turn pages by: Auto / Scrolling / Next-page
  key** setting chooses which.
- One calibration works on every site and adjusts for each site's zoom level. **Forget
  calibration** in the popup asks you to click twice, so it can't be deleted by accident.
- A camera setup page handles the permission prompt, including a camera permission revoked and
  granted again later.
- Needs Chrome 116 or later (or a recent Edge). Install it from source with
  [docs/INSTALL-EXTENSION.md](docs/INSTALL-EXTENSION.md). `npm run package:ext` builds the zip for
  the Chrome Web Store.

### claude.ai Artifact preview

- `npm run build:artifact` builds a version that runs inside a claude.ai Artifact. The frame
  doesn't allow camera access, so it offers **Demo** and **Mouse** only, links to the web app for
  the webcam, and with the Auto theme follows the host page's light or dark mode.

### Known limitations

- A good webcam calibration is accurate to about 1–2 lines of text; vertical accuracy is the weak
  axis. Lighting, glasses and big changes in posture affect it.
- The page-turn rules were tuned against a simulated reader, not recordings of real readers, so
  expect to adjust sensitivity to taste.
- PDFs need selectable text (no OCR), images in books aren't shown, and DRM-protected EPUBs can't
  be opened.
- In the extension, page mode can only watch the bottom edge of the page, and some readers ignore
  its simulated next-page keys.

See [PRIVACY.md](PRIVACY.md) for what the app and the extension access and store.
