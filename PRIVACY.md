# Privacy policy

*Gaze Reader web app and Gaze Reader browser extension. Last updated: 25 September 2026.*

Gaze Reader is built so that nothing about you leaves your computer. There is no account, no
server of ours that receives your data, no analytics, no telemetry, no ads and no remote logging.
This page explains exactly what the app and the extension access, what they keep, and the network
requests they make.

## The camera

- Gaze Reader uses your webcam only when you choose eye tracking, and only while it's reading
  along: while a book is open in the app, or in a tab where you turned the extension on and which
  is currently visible. The camera stops when you close the book, switch Gaze Reader off, close or
  leave the page, or switch to another tab. (After a short grace period: a few seconds in the
  extension, up to a minute in the app, in case you come right back.) While the camera is on, the
  status pill on the page says so and your computer's camera light or indicator is on.
- Every video frame is processed **on your device**, in the browser, by
  [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
  running as WebAssembly. From each frame it computes face landmarks and a few numbers about your
  eyes (where each iris sits, how open the lids are, head angle). Those numbers are turned into an
  estimate of where you're looking, and then thrown away.
- A few times a second Gaze Reader also measures the **lighting** in the same frame, so it can
  suggest better light and notice when the light has changed since you calibrated (a lamp
  switched on makes most people squint a little, which can throw the tracking off). It reads
  the pixels of a few small areas that the face landmarks mark out (the whites of your eyes,
  your cheeks, the area around your eyes, the background) into memory, reduces them to about
  17 numbers (for example how bright the whites of your eyes are compared with the background,
  whether one side of your face is lit more than the other, whether your glasses reflect a
  light), and discards the pixels at once. They are never kept, shown on the page or sent
  anywhere. The lighting numbers themselves are used like the eye numbers: on your device,
  then thrown away.
- Video frames and images are **never recorded, stored, uploaded or shared**. Neither are the
  landmarks, the gaze positions or the lighting numbers, unless you record tracking diagnostics
  yourself (see [below](#tracking-diagnostics-web-app-only-if-you-start-it)).
- In the extension the camera runs in a hidden extension page (an "offscreen document"). Only the
  eye and lighting numbers described above are passed from there to the tab you're reading,
  inside your browser. No pictures are passed, and nothing is sent over the network.

## What stays on your device

**Web app** (in your browser's storage for the site, on your computer):

- your library: books you open or paste, their text and your reading positions (IndexedDB);
- your settings and your calibration (`localStorage`). A calibration is a small set of numbers
  that map eye measurements to screen positions. It also keeps a short summary of the
  conditions while you calibrated: a few lighting ratios (such as the whites of your eyes
  against the background, or one side of your face against the other) and how open your eyes
  were, so the app can tell later when the light has changed. The summary uses ratios only,
  not how light or dark your skin is. It contains no images.

**Extension** (in `chrome.storage.local`, on your computer):

- your settings, including how pages turn;
- your calibration (the same kind of numbers as above, including the lighting and eye-openness
  summary, plus the page zoom it was made at);
- the time you last granted camera permission on the setup page, so that open tabs know they can
  retry the camera;
- when the quick 5-dot refresh was last offered or snoozed (`gr.touchUp.v1`, two timestamps), so
  that it isn't offered again too soon in another tab.

The extension doesn't keep a history of the pages you read. On a page where you turn it on, it
measures where the lines of text are, and counts the words and reads the title of the main text
so Dewey can cheer your progress. This happens in memory only. The line positions and the gaze
offset it learned stay in memory until you leave the page, so turning it back on resumes where
you were. It only runs in tabs where you turn it on, and it can only see the page in that tab.

## Tracking diagnostics (web app, only if you start it)

If tracking misbehaves, you can record what it measured and send it to the developers:
**Settings → Advanced → Record tracking diagnostics (no video)**. Nothing is recorded unless you
start it, and a chip in the top bar shows while it records.

- **What is recorded,** for up to 10 minutes, as numbers: your eye measurements (the numbers
  described under "The camera", head angle, how open your eyes are), the gaze estimates, the
  lighting readings (ratios and levels, but not how bright your face itself is, which depends on
  your skin tone), where the lines of text are and when pages turn, your settings and
  calibration, and your browser, screen and camera settings, including the camera's name as your
  computer reports it (usually its model, for example "Integrated Webcam (0bda:5634)").
- **What is not:** video, images, the book's text or its title.
- **Where it goes:** it stays in memory until you press **Stop and download**, which saves a JSON
  file on your computer. It is never uploaded. It reaches the developers only if you send them
  the file yourself.

You can delete everything at any time. In the app, use **Settings → Forget calibration**, delete
books from the library, or clear the site's data in your browser. For the extension, use
**Forget calibration** in the popup (click it twice), or remove the extension (this deletes all
of its stored data).

## Network requests

- **The face-tracking model.** When you first use eye tracking, the app or extension downloads the
  model file (`face_landmarker.task`, about 3.6 MB) from Google's model storage at
  `https://storage.googleapis.com/mediapipe-models/…`. It is a plain file download: no data about
  you is sent with it, and your browser caches it afterwards. Like any web request, it reveals your
  IP address to Google, and Google's own privacy policy applies to that request. The rest of
  MediaPipe (its WebAssembly runtime) ships with the app and the extension.
- **Books you ask for.** If you open a book from a web address in the app, your browser downloads
  it directly from that address. Nothing goes through us.
- **The app itself.** The hosted app at <https://lance-lii.github.io/gaze-reader/> is served by
  GitHub Pages, which, like any web host, receives standard request information (such as your IP
  address) when your browser loads the page. See GitHub's privacy statement. The extension is
  installed on your computer and loads nothing from GitHub.

There are no other network requests: no analytics, crash reporting, fonts or ads from third
parties. MediaPipe has built-in usage logging that would report timing and version data to
Google (`odml.pa.googleapis.com`); Gaze Reader blocks those requests before they are sent.

The hosted app shares its web origin (`https://lance-lii.github.io`) with the account's other
GitHub Pages sites, and browsers scope storage and camera permission per origin. See the Privacy
section of the README for what that means and how to avoid it for private documents.

## Permissions the extension asks for

- **activeTab** and **scripting:** to run on the tab you're looking at, and only after you click
  the Gaze Reader button or press its shortcut. It has no access to other tabs or sites.
- **storage:** to keep the settings and calibration described above.
- **offscreen:** to run the camera and face tracker in a hidden extension page, because a
  background service worker can't use the camera.
- **Camera:** asked for once, on the extension's setup page, through the browser's own permission
  prompt. You can revoke it at any time in the browser's site settings.

## Children

Gaze Reader doesn't knowingly collect information from anyone, including children: it collects
nothing by itself, and we only receive what you choose to send us (such as a diagnostics file).

## Changes and contact

If this policy changes, the new version will be published at
<https://github.com/lance-lii/gaze-reader/blob/main/PRIVACY.md>, with the date at the top updated.
If you have a question, open an issue at <https://github.com/lance-lii/gaze-reader/issues>.
