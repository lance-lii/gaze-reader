# Changelog

All notable changes to Gaze Reader are listed here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

Steadier tracking. Readers found the tracker "very buggy": the gaze dot trembled, the reading
position sat a line or two off after shifting in the chair, and page turns came early or late.

### New: PDFs as their own pages (web app)

- **A PDF can be read as it is.** Until now a PDF was shown only as its extracted text, set like a
  book: figures, equations, tables and the page's layout were gone. Press **V** (or the new button
  in the top bar) and the PDF shows its original pages instead, one below the other; press it again
  for the text. You keep your place between the two, and the choice is remembered per book. The
  first time a PDF opens, a message points the pages out.
- **Page turns work on the pages.** Each line of a page is laid over its picture where it is drawn,
  so the reading model measures and follows the page's own lines: finish the last one on screen and
  the page scrolls on, with your last lines kept at the top. The text is selectable and read aloud
  by screen readers. Pages are drawn as they come near the view and let go of when they leave; a
  dark or sepia theme tones the white page down.
- **What it can't follow.** Lines on a fitted page are about half as tall as the text view's, so
  the tracker is less sure of its line there; the bottom-right rest and the glance below the page
  still turn it, and a wider window helps. Pages set in two columns, and pages with no text, are
  marked in their corner and turned with Space or a head gesture. A PDF that is only scans still
  can't be opened.
- **The file is kept on your device** for this (the browser's storage, up to 64 MB per PDF) and
  removed with the book; Undo brings it back. PDFs added before this version need opening from the
  file once more. Not in the Artifact build.

### New: head gestures (web app, off by default)

- **Turn your head to turn the page.** Settings → Page turning → Head gestures. A quick turn of
  the head to the right and back is the next page, to the left and back the previous one, and
  eyebrows raised and held for a moment pause or resume automatic page turning. A short message
  says what was understood. It uses the head angle and eyebrow score the face tracker already
  reports: no second model, nothing more measured or kept.
- **What isn't a gesture.** Looking away and back, a nod, a tilt, a shake of the head, leaning,
  settling into a new posture, a tracker glitch, or another face crossing the picture. A gesture is
  quick, mostly sideways, at least about 12°, and back within a second; the page turns a sixth of a
  second after your head is back. Nothing happens while Settings or Help is open.
- **How it was tested.** On synthetic gestures at 10 to 30 frames a second, and on the simulated
  readers of the end-to-end harness, who make no gestures: none was reported in 4.5 simulated
  hours of reading, fidgeting, looking around and being walked past. Not yet on real people.

### Web app and extension

- **Leaning in or sitting back no longer shifts your reading position.** The calibration used to
  treat the head's position as a few more gaze cues, with weights fitted while you sat still, so
  they were mostly noise: leaning 6 cm nearer or further moved the gaze about a line, 10 cm two
  lines, and sitting 3 cm to one side almost a line. What moving nearer or further does is known
  from geometry, so the tracker now applies it directly: it reads your distance from the size of
  your face in the camera image and scales your gaze about the camera to match. In simulation
  those leans now move the gaze 0.1–0.3 lines and the sideways move 0.2; calibration itself fits
  better (1.07–1.24 lines cross-validated, from 1.14–1.48). Over 33 simulated hours of reading
  with ordinary fidgeting, pages that turned when you didn't mean them to fell from 4.3 to 1.6 an
  hour on Balanced (restless posture: 11.3 to 0.7), missed turns from 16.4 % to 13.2 %, and the
  tracker was on your line 83 % of the time, up from 75 %. It assumes the camera is just above the
  middle of the screen you read on (a laptop's, or a webcam on top of the monitor); being 4 cm out
  still gives most of the benefit. Raising or lowering your chin still moves the gaze about a line
  per 4°. Recalibrate once to get it (older calibrations keep working as before).
- **A repeated calibration dot waits until you've read why.** When a dot didn't get enough samples,
  "Once more — keep your eyes on the dot." appeared and the dot started counting again at once,
  with the notice still on screen at the other end of the window. Anyone who read it was looking
  away from the dot for most of its samples, and the calibration learned that spot wrong. The dot
  now waits the 1.8 seconds the notice is shown; the same after "The window changed, so the dots
  start over."
- **A page whose turn you undid turns again when you finish it.** After any page turn the app
  waits for your eyes to go back up the page before it will turn again, so that a gaze or a mouse
  left resting at the bottom can't page through the book. After **U** you are back at the bottom
  of the page you left, reading on, and never look up: the page then never turned again by itself.
  An undone turn now lets the last line turn the page once you have come onto it again; resting
  at the bottom still doesn't.
- **A touch-up is no longer offered on a second of evidence.** The offer for a quick 5-dot refresh
  comes when the reading model has corrected more than 1.5 lines for 20 seconds. It counted the
  seconds from the first such estimate even when every later one came from a tracker that wasn't
  sure of anything. A long unsure stretch now starts the count over.
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
- **Two lines of context after a page turn.** The line you were reading and the one above it now
  stay at the top of the next page, instead of only the last one. A page that turns while you're
  still on its second-to-last line no longer takes that line away: in the end-to-end simulation,
  turns that cost you your place fell from 12.3 to 7.1 an hour on Balanced, with no more missed
  turns. This is only the default. Settings are saved as a whole, so if you have changed any
  setting before, yours keep one line until you set "Lines kept for context" to 2.
- **The reading position holds your line when you shift in your seat.** Leaning in or settling back
  moves where the webcam thinks you look by a line or more within seconds, and the reading layer
  put that down to you having moved up or down a line: its most common mistake. While tracking is
  steady it now trusts the direction of your eye movements (a step to the right stays on the
  line), lets the offset follow faster, tells lines apart by where they end (a return sweep starts
  at the end of the line it leaves, so a paragraph's short last line sets lines apart), and
  re-learns the offset on each page from the line you resume on. In the end-to-end simulation, on
  seeds it wasn't tuned on (27 hours), fixations on the right line went from 71 % to 75 % and
  those on a wrong line with the tracker sure of itself from 5.1 % to 3.9 %; unintended page turns
  fell from 7.0 to 6.1 an hour and missed ones from 20 % to 15 % of pages.
- **The status pill says when it isn't sure which line you're on.** Before, a page that didn't
  turn just didn't, with nothing to say why. Now, once the reading layer has been unsure of your
  line for about 10 seconds of reading, the pill says **Unsure of your line** instead of
  "Tracking". The first time in a session, a message explains that pages may not turn by
  themselves for now, that Space turns one (Alt+Shift+↓ in the extension), and that more light on
  your face or a recalibration usually helps. The pill goes back to normal after 5 seconds of
  steady tracking. Once it appears it stays at least 15 seconds, so it doesn't flicker. In the
  end-to-end simulation, on seeds it wasn't tuned on (an hour per scenario), it shows about 1 % of
  the time in clean light and in everyday reading (about twice an hour), and 88 % of the time with
  a noisy webcam. There the reading layer is on your line for only about one fixation in five, and
  93 % of the pages missed were missed while the pill said so (56 % of the missed pages over all
  scenarios). Page turning itself is unchanged. The "Low confidence"
  pill, which means the camera can't see your eyes well, now says "shaky" rather than "unsure",
  so the two don't read alike.
- **A glance at your phone no longer turns the page.** Looking below the page turns it
  (glance-down), but whenever the reading layer wasn't sure which line you were on, any look down
  counted: a glance at your phone or the keyboard mid-page, or the gaze dipping below the page
  while you read the last lines. A look down now counts only when it starts at the end of the last
  line, where you finish the page: its right half, held for a moment, and not a glance at Dewey
  in the corner beside it, the edge of the screen, or one frame on the way to your phone. When the
  gaze reads a little low at the bottom of the page (dim light, after shifting in your seat), the
  end of the last line can sit just below the page edge; it still counts as where you finished.
  The extension's page mode, which has no lines to follow, still turns on any look down.

  With this and the other page-turn changes below, in the end-to-end simulation (`npm run eval`,
  33 simulated hours per preset) unintended page turns fell from 17.0 to 6.9 an hour on Balanced and
  from 13.2 to 4.2 on Relaxed. Missed turns rose from 17.5 to 20.4 % of pages on Balanced and from
  24.6 to 27.2 % on Relaxed: about one more missed page for every three or four unintended turns
  prevented, mostly in dim light, with glasses and with noisy webcams. Both rises are within the
  simulation's 95 % intervals (± 9 to 13 points over all scenarios). A missed turn waits for you to
  look down again or press a key; an unintended one loses your place.
- **No page turns before you have read anything.** When a book opened or a calibration ended, the
  reading layer had nothing to go on until your first look at the text, and until then any look
  below the page counted as the turn gesture: glancing at your phone or the keyboard as the camera
  came up turned page 1, unread. A look down now counts only once the reading layer has placed you
  on the page, and opening a book or finishing a calibration starts the usual short wait after a
  turn. The extension's page mode, which has no lines to follow, still turns on any look down.
- **No page turns on tracking too slow to follow you.** Below about 7 frames a second (an
  overloaded or throttled machine, or face tracking on the CPU) no fixation can form, so there are
  no lines to follow, and in the end-to-end simulation a glance at a phone then turned the page
  about 5 times an hour. Page turns now wait until tracking is fast enough again. After 5 seconds the
  web app says why, and says it again if the camera slows down again later (at most every 10
  minutes). At 10 frames a second and above nothing changes.
- **A page no longer turns the moment you come back.** Gaze resting at the end of the page counts up
  towards a turn. If tracking stopped meanwhile (you opened Settings, switched tabs, or the camera
  froze and restarted), the count carried on from where it was, so a page could turn a frame or two
  after you came back. A gap of more than 0.4 s now starts the count over, as a long blink already did.
- **Calibration starts over when the window changes.** Resizing or zooming the window, or moving it
  to another screen, in the middle of the dots mixed dots from before and after the change into one
  calibration, which then read your gaze in the wrong place. The dots now start over from the first
  one, with a short note saying why.
- **A pinch-zoomed page waits, and says why.** After a trackpad or touch-screen pinch the screen
  shows a magnified part of the page while every measured line is still where it was before the
  pinch, so the gaze was scored against lines that weren't under it. Nothing noticed. Page turning
  now waits until you pinch back out, with one note saying so.
- **Camera frames are timed by when they were taken.** A frame's time was when the page got round
  to processing it, so a busy moment (a page turn, a book being opened) bunched frames together
  and the gaze filter read that as movement. Where the browser reports the capture time, that is
  used.
- **A calibration pauses when you switch tabs**, instead of using up each dot's attempts on the one
  frame a second a hidden tab gets and training on what was left.
- **Small windows keep turning pages.** On a window only a few lines tall, the rule "you must have
  been back up the page before the bottom counts" was never met after the first turn. Reading the
  line a turn resumes on now counts.
- **A look-away that is undone is undone completely**: the sideways offset and the noise estimate
  it may have taught are restored with the line. The tracker also no longer loses a third of its
  confidence in a short last line when a long look back leaves it.
- **The eye-break reminder counts real rest.** Time with the laptop asleep counts as rest, and the
  extension's count now rests the way the app's does (and is shown by the pill when Dewey is hidden).

### Web app

- **Web pages keep their sections.** Opening a saved page or a URL removed anything whose name
  contained words like "related", "social", "sharing", "comments" or "modal", to drop sharing
  buttons and comment threads. Documentation and papers name their sections after their headings,
  so "Related work", "Social impact" and headings such as "Modal verbs" vanished without a word.
  Headings are now never removed for their name, and a block named by its id alone stays when it
  reads as running text. Pages whose whole body sits in one form (many council and university
  sites) or behind a dialog that was open when the page was saved used to come out as "no readable
  text"; they open now.
- **A finished book is finished.** A book read to its end by eye showed "The end!" while the top
  bar said 0 % (a short text) or ninety-something, and the library offered to continue it: the
  last page of a book can't scroll to the bottom. Finished now counts as 100 %.
- **Clicking a top-bar button doesn't capture the Space bar.** After a click on Pause, Settings or
  Help, the button kept the keyboard: Space pressed it again instead of turning the page, and the
  bar never hid. A pointer click now gives the keyboard back to the page.
- **Help can be scrolled from the keyboard.** The Help dialog is taller than most windows and
  nothing in it took focus, so the arrow keys scrolled the page behind it. It also lists the head
  gestures now.
- **A book that can't be saved says so.** When the browser's storage is full, a book opened and was
  simply missing from the library next time. A message now says it couldn't be saved.
- **A camera that stops comes back on its own.** After a laptop wakes from sleep the camera often
  freezes or stops: a frozen camera left the reader at "looking for you" for good, and a stopped
  one got a toast blaming another app, even when the camera had been unplugged. Gaze Reader now
  restarts the camera by itself when it sends no picture for 5 seconds or its video ends. If it
  can't start, the message says why (no camera found, access blocked, busy). A camera that stops
  again within a minute, or for the third time in 10 minutes, is reported with Try again instead of
  being restarted over and over.
- **After a camera switch, pages wait for you.** Read through another camera than the one you
  calibrated with, the calibration puts your gaze in the wrong place, and a wrong page turn loses
  your place. So after a switch, pages don't turn on their own until you recalibrate or choose
  Keep reading on the old calibration (remembered for that camera). The status pill says why, and
  P brings the choice back if you closed it.
- **A calibration survives the camera restarting.** If the camera stopped while you were on the
  calibration dots, it restarted by itself but went back to reading on the old calibration without
  a word. The dots now start over once the camera is back, with a note saying why.
- **Switching cameras asks for a recalibration.** A calibration only fits the camera it was made
  with. Gaze Reader now remembers which camera that was and checks it whenever the camera starts,
  however the reading began. When it changes (unplugging an external webcam or undocking a laptop
  falls back to the built-in one), it says so and offers to recalibrate, and keeps offering until
  you do or the old camera is back. Meanwhile it re-learns where your gaze sits.
- **The right message when the browser can't run the face model.** With WebAssembly turned off or
  blocked (some managed or locked-down browsers, or a site served with a security policy that
  forbids it), the message asked you to check your internet connection and offered Try again, which
  could never work. It now says this browser can't run the face tracker, and offers the mouse and
  the demo.
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
- **PDF text:** a drop cap is the first letter of its paragraph, not a heading that opens a chapter.
- **Plain text:** in a book with numbered chapters, a line that only looks like a heading (a sign
  in capitals) stays in the story. A UTF-8 file with one damaged byte is read as UTF-8 instead of
  turning every accent into two wrong characters.
- **Files too large to parse are refused with the reason**, instead of freezing the tab: text,
  Markdown and web pages over 32 MB (a long novel is about 5), and a single EPUB chapter over 16 MB.
- **"Storage is full" is reported as that.** A library save that failed for lack of space was
  reported as "couldn't be read or saved right now".
- **Cancel stops an Open-from-URL download** instead of only hiding it.
- **Two tabs no longer undo each other's settings.** A tab now takes over what another tab changed
  instead of writing its stale copy back.
- **A camera that freezes during calibration is restarted** and the calibration opens again (it
  used to sit on "I lost sight of your eyes" until Esc). A tracker that is still warming up is not
  mistaken for a frozen camera.
- **The lines are measured again when Dewey moves** to another corner or is shown or hidden (on a
  narrow window the text moves to make room for him).
- **Easier to see and use:** text fields, menus and switches that are off have an edge that keeps
  3:1 contrast in all three themes, and placeholders 4.5:1; buttons in the settings drawer wrap on
  a 320 px screen; tapping the status pill says what it means (on a phone it is only a coloured
  dot); after you click a top-bar button, Space pages again; the Help window scrolls from the
  keyboard; a fourth notice pushes out the oldest one that isn't waiting for you.
- **Undo forgets a page you have left.** After scrolling more than a screen away by hand, Undo no
  longer jumps back to a turn from long before.

### Chrome extension

- **Scrolling the page yourself no longer confuses the reading position.** While you scrolled an
  article, and during a page turn's animation, the extension kept scoring your gaze against the
  lines where they had been measured before the page moved. A scroll of 100 px put you three or
  four lines from where you were, or taught the tracker a gaze offset that wasn't there, and the
  next page turned late or early. The reading model now waits until the page is still and has
  been measured again, as the web app's does. A scroll of your own right at the end of a page
  turn is no longer mistaken for the turn's last scroll event either, which left the lines stale
  for the whole page.
- **Web pages can no longer press Gaze Reader's shortcuts.** A page's own scripts could send fake
  Alt+Shift key presses to turn Gaze Reader off, change your settings in every tab, start a
  calibration or, with the camera blocked, keep bringing the setup tab to the front. The shortcuts
  now answer only real key presses. On a site that forwards your keys out of an embedded frame as
  fake key presses, the Alt+Shift shortcuts stop working; the toolbar button and Alt+Shift+G still
  work there.
- **The extension makes no network requests at all.** The face model now ships in the package (it
  was downloaded from Google's model storage the first time the camera started), and the
  extension's own pages are restricted to their own files. The package is also 12 MB smaller: a
  copy of the MediaPipe runtime that was never loaded is left out.
- **A page can't keep the camera on behind other tabs** by lying about being visible, or cancel a
  calibration with fake key presses.
- **Articles that render late are found.** On a page that fills in its text after loading, the
  extension looks again for a while instead of treating the whole page as the text.
- **Moving the page inside the window is noticed.** Going fullscreen or showing a toolbar after
  calibrating shifts everything under the gaze; the extension now says so once.
- **Smaller fixes:** the calibration's zoom is read when it is trained, not when "Use it" is
  pressed; Undo history doesn't survive a navigation; a calibration refresh asked for while the
  camera had failed doesn't open after switching to the mouse; the extension's panel is put back
  if a page removes it; the popup's status is announced only when it changes.

### Privacy

- **The camera promises are tested.** Automated tests now check that the camera stays off in the
  library and stops when you go back to it, and that it stops after a tab has been hidden for a
  minute and comes back with the tab, as [PRIVACY.md](PRIVACY.md) says.
- **Using the webcam no longer contacts Google.** The face model (3.8 MB) is served with the app,
  from its own address, instead of being downloaded from Google's model storage. The build
  downloads it once and refuses a file whose SHA-256 isn't the pinned one.
- **The hosted app has a content security policy.** Only the app's own scripts run, so a book or
  web page you open can't bring code of its own even if a sanitizer missed something.
- **MediaPipe's usage logging stays blocked across upgrades.** The library version is pinned
  exactly, and a test reads the installed library and fails if it names any network address other
  than the one that is blocked, or any way to reach the network that the block doesn't cover.
- **[PRIVACY.md](PRIVACY.md) corrected** where it was imprecise: when the model loads, the small
  markers kept beside your settings, that the lighting summary holds one brightness level besides
  ratios, and that a diagnostics recording includes the length of each line of text on screen.

### Testing

- **A harder end-to-end simulation, compared scenario by scenario.** The simulated reader of
  `npm run eval` now also does what made the page-end rules look better than they are:
  - after finishing a page, now and then pauses or re-reads for 1.6–4 s before looking below it to turn it;
  - glances at the phone or the keyboard as a book opens or is reopened, and after a calibration refresh;
  - glances at the keyboard mid-page (unlike most phone glances, the keyboard is within the tracker's reach);
  - closes and reopens the book, which starts the reading layer over.

  The cooldown after a turn now starts when the scroll ends, as in the app. The eval runs the Balanced and
  Relaxed presets in parallel shards, with three seeds for the two-hour row, and gives 95 % intervals.
  `GR_EVAL_BASELINE=deployed` adds the deployed page-end detector on the same seeds and shows, per scenario,
  each difference with its interval and the missed pages per unintended turn prevented.
- **The simulation follows the app's new cooldown after a book opens or a calibration ends**, and
  the eval's "missed pages per unintended turn prevented" is left blank when a change prevents
  fewer than 0.1 an hour (it divided by almost nothing before).
- **Per-scenario gates.** `tests/endToEnd*.test.ts` give each scenario its own limits: clean,
  everyday (also on Relaxed), distracted, fidgety (also on Relaxed), glasses, a noisy webcam and dim
  light. A regression in one kind of light or behaviour can no longer hide in a total over all of them.
  The noisiest scenarios count three shorter sessions instead of one long one: an early difference
  can send one long session down a much worse path (one dim hour swung from 14 to 37 missed pages
  where three 20-minute sessions stayed at 30).
- **A gate for "Unsure of your line".** `tests/endToEnd.unsure.test.ts` checks, on fixed seeds,
  that the pill is up most of the time with a noisy webcam, and covers most of the pages missed
  there, and that it stays down in clean light and everyday reading.

### Development

- **A scoreboard for the line tracker itself.** `npm run bench -- bench/reading/lineTracker` scores,
  in every scenario of the end-to-end simulation, how often the tracker is on the line the reader
  is really reading, how often it is wrong while sure of itself, and how often it puts the reader on
  the last line while they are two or more lines above it (the kind of error that turns pages
  early), apart from what the page-end detector then does with it. It also scores the pill's
  "Unsure of your line": how often it is up, how often the tracker is on the line with it up and
  without, and how many of the missed pages were missed while it was up.
- **Supply chain.** CI's actions are pinned to exact commits and CI fails on a known vulnerability
  in a shipped dependency (`npm audit --omit=dev`); the open advisories in the build tools are
  cleared (Vite 8.3.8, Vitest 5.1.0). `npm run build` and `npm run build:ext` now need the network
  once, to fetch the face model (`scripts/fetch-face-model.mjs`, hash-checked, cached in
  `public/mediapipe/models/`); `npm run dev` works without it.

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
