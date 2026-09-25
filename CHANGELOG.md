# Changelog

All notable changes to Gaze Reader are listed here. Versions follow
[Semantic Versioning](https://semver.org/).

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
