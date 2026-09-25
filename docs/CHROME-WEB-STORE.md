# Publishing Gaze Reader on the Chrome Web Store

This is everything the Web Store dashboard asks for, written out and ready to paste. The
submission itself has to be done by the owner of the developer account (see
[Submission steps](#submission-steps)). The store's forms change from time to time, so check each
answer against the form as you fill it in.

## Package

```bash
npm run build:ext     # builds and checks dist-extension/
npm run package:ext   # zips it to release/gaze-reader-extension-v<version>.zip
```

The zip has `manifest.json` at its root, as the store requires. The version comes from
`package.json`, which the build copies into the manifest. Every upload needs a higher version
than the last one, so bump `version` in `package.json` before rebuilding.

Before uploading, load `dist-extension` unpacked (see [INSTALL-EXTENSION.md](INSTALL-EXTENSION.md))
and check: turning it on and off, the camera setup page, calibration, a few automatic page turns
on a long article, mouse mode, and page mode on a canvas-based reader.

## Single purpose

> Gaze Reader turns the page for you while you read in the browser: it scrolls to the next page
> when your eyes (tracked on-device through the webcam) or your mouse reach the end of the
> visible text.

## Store listing

**Name:** Gaze Reader — eye-tracking auto-scroll (from the manifest)

**Category:** Accessibility (Productivity also fits)

**Language:** English

**Short description** (the manifest `description`, at most 132 characters; the build uses the
manifest's):

> Turns the page when your eyes reach the bottom. Webcam eye tracking that stays on your device, plus Dewey, a reading buddy.

**Detailed description:**

> Read long articles and online books without reaching for the scroll wheel. Gaze Reader watches
> where you're reading through your webcam and scrolls the next page into view when you finish
> the last line on the screen. It keeps a line of context at the top, so you never lose your place.
>
> HOW IT WORKS
> • Turn it on for the page you're reading with the toolbar button or Alt+Shift+G.
> • A one-minute calibration (follow 13 dots with your eyes) teaches it where you look. It works on
>   every site and adjusts for page zoom.
> • It follows the structure of reading, not just raw eye coordinates: fixations, return sweeps to
>   the next line, and a model of which line you're on. That makes it reliable with an ordinary
>   webcam.
> • Want the next page now? Glance just below the bottom of the page.
>
> PRIVATE BY DESIGN
> • Face tracking runs entirely on your computer (MediaPipe, WebAssembly). Video is never
>   recorded, stored or uploaded.
> • No account, no analytics, no ads, no tracking.
> • It runs only in tabs where you turn it on, and uses the camera only while that tab is visible.
>
> YOU STAY IN CONTROL
> • Relaxed, Balanced and Eager page-turn sensitivity.
> • Undo a turn (Alt+Shift+U), pause (Alt+Shift+P), or turn pages yourself (Alt+Shift+↓ / ↑).
> • No webcam? Mouse mode turns the page when your pointer rests at the end of the last line.
>
> MEET DEWEY
> A small nerd with round glasses sits in the corner and reads along with you. His eyes follow
> your gaze, he flips his book when the page turns, cheers your progress, and reminds you to rest
> your eyes. Hide him with one click if you prefer.
>
> WORKS WITH
> Articles, blogs, documentation and online books that show real text. On readers that draw
> pages as pictures (some e-book and PDF viewers), Gaze Reader switches to "page mode": looking at
> the bottom edge turns the page, by scrolling or by sending the reader's next-page key. Some
> readers ignore simulated key presses.
>
> Open source (MIT): https://github.com/lance-lii/gaze-reader

**Homepage URL:** https://github.com/lance-lii/gaze-reader

**Support URL:** https://github.com/lance-lii/gaze-reader/issues

## Privacy practices tab

**Privacy policy URL:**

```
https://github.com/lance-lii/gaze-reader/blob/main/PRIVACY.md
```

### Permission justifications

**activeTab**
> Gaze Reader runs only on the tab where the user turns it on, by clicking the toolbar button or
> pressing its shortcut. activeTab gives temporary access to that one tab at that moment. The
> extension requests no host permissions and can't see any other tab or site.

**scripting**
> Used with activeTab to inject Gaze Reader's content script into the current tab when the user
> turns it on. The script measures where the lines of text are, draws the reading buddy and status
> pill, and scrolls the page when the reader reaches the end. Nothing is injected into pages the
> user hasn't turned it on for; there are no declared content scripts.

**storage**
> Saves the user's settings (sensitivity, mouse or webcam, page-turn method, buddy on or off) and
> their eye-tracking calibration (a small set of numbers, no images) in chrome.storage.local, so
> they apply on every site. Nothing is synced or sent anywhere.

**offscreen**
> The camera and the on-device face tracker (MediaPipe, WebAssembly) must run in a document, and a
> Manifest V3 service worker can't use getUserMedia. The extension creates a single offscreen
> document with the USER_MEDIA reason while a tab is reading along, and closes it when no tab
> needs it. It passes only eye-position numbers to the reading tab, within the browser.

**Camera use** (explain wherever the form asks about sensitive capabilities, and in the
description)
> The webcam is used to estimate where on the screen the user is looking, so the page can turn
> when they reach the end. Camera permission is requested once, on the extension's own setup page
> ("Allow camera" → the browser's permission prompt), because an offscreen document can't show a
> prompt. Frames are processed locally and discarded. Video is never recorded, stored or
> transmitted.

**Remote code:** answer **No, I am not using remote code**. All JavaScript and WebAssembly ship in
the package (the MediaPipe runtime is copied into `mediapipe/wasm/`). The one download, the
face-landmark model `face_landmarker.task` from `storage.googleapis.com`, is model data (neural
network weights) loaded by the bundled runtime, not executable code. If a reviewer disagrees, the
fix is to bundle the model file in the package (about 3.6 MB) and point `modelAssetPath` at it.

### Data usage disclosure

Suggested answers (Gaze Reader transmits nothing, so it collects none of these in the store's sense):

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | No | |
| Health information | No | Eye and face measurements are computed from the camera on the device, used immediately, and discarded; never stored or sent. |
| Financial and payment information | No | |
| Authentication information | No | |
| Personal communications | No | |
| Location | No | |
| Web history | No | The extension keeps no record of pages visited. |
| User activity | No | Gaze positions are used live to decide when to turn the page, then discarded. |
| Website content | No | Line positions and a word count of the page are measured in memory while it's on, never stored or sent. |

Check all three certifications:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

If the form treats data *processed* on the device as "handled", tick **Website content** and
**User activity** and describe them as "processed locally in the browser, never transmitted". The
privacy policy already says this.

## Graphics checklist

| Asset | Size | Notes |
|---|---|---|
| Store icon | 128×128 PNG | Use `extension/icons/icon-128.png` (the build copies it to `dist-extension/icons/`). |
| Screenshots | 1280×800 (or 640×400) PNG or JPEG, 1–5 | Required: at least one. |
| Small promo tile | 440×280 PNG or JPEG | Currently required by the dashboard for listing. |
| Marquee promo tile | 1400×560 | Optional. |

Suggested screenshots, taken at 1280×800 with the browser zoom at 100 %:

1. A long article with Dewey in the corner and the status pill showing "Reading along", just after
   a page turn.
2. The toolbar popup, open, showing the settings: Eyes/Mouse, Page turns, Turn pages by, Dewey.
3. Calibration in progress (a dot on the page) with Dewey coaching.
4. The camera setup page ("Let Gaze Reader see where you're reading"), which shows the privacy
   promises.
5. The debug overlay (Alt+Shift+D) on an article, showing the measured lines and gaze trail. This
   is optional and good for technical readers.

Checklist for every image: no personal data in the tabs, address bar or bookmarks; no copyrighted
book text in large, readable blocks (use the sample books or your own writing); no mockups of other
companies' products; nothing implying Google endorses it.

## Submission steps

Only the account owner can do these steps. No script or agent can do them for you.

1. **Developer account.** Sign in at <https://chrome.google.com/webstore/devconsole> with the
   Google account that will own the listing. Accept the developer agreement and pay the one-time
   US$5 registration fee. Verify the contact email address the dashboard asks for.
2. **New item.** Click **New item** and upload `release/gaze-reader-extension-v<version>.zip`.
3. **Store listing tab.** Paste the descriptions above. Set the category and language, and upload
   the icon, screenshots and promo tile.
4. **Privacy practices tab.** Paste the single-purpose text, the permission justifications, the
   remote-code answer and the data-usage answers. Set the privacy policy URL to
   `https://github.com/lance-lii/gaze-reader/blob/main/PRIVACY.md`. Make sure that URL is public:
   the file must be committed and pushed to `main`.
5. **Distribution tab.** Choose visibility (Public, or Unlisted for a soft launch) and regions.
   Gaze Reader is free.
6. **Submit for review.** Reviews of extensions that use the camera can take several days. Watch
   the account's email for questions from reviewers.
7. **After approval.** Add the store link to `README.md` and `docs/INSTALL-EXTENSION.md`. For each
   update, bump the version, run `npm run build:ext && npm run package:ext`, and upload the new zip
   on the item's **Package** tab.
