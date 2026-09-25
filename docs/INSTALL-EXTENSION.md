# Installing the Gaze Reader extension (Chrome and Edge)

Gaze Reader isn't in the Chrome Web Store yet, so you install it from a folder on your computer.
This takes about five minutes. You need Chrome 116 or later, or a recent Microsoft Edge, and a
webcam. Without a webcam you can still use it with the mouse.

## 1. Build the extension folder

You need [Node.js](https://nodejs.org/) 20.19+ or 22.12+. In a terminal, from the repository
folder, run:

```bash
npm install
npm run build:ext
```

The build creates a folder called `dist-extension` inside the repository. That folder is the
extension: `<where you cloned gaze-reader>\dist-extension` on Windows, or
`<where you cloned gaze-reader>/dist-extension` on macOS and Linux.

If someone sent you a zip made with `npm run package:ext`
(`gaze-reader-extension-v<version>.zip`), unzip it into a folder you'll keep, such as
`Documents\gaze-reader-extension`. The browser loads the extension from that folder every time it
starts, so don't delete or move it afterwards.

## 2. Load it in Chrome

1. Open a new tab and go to `chrome://extensions`.
2. Turn on **Developer mode** with the switch in the top-right corner. A row of buttons appears.
3. Click **Load unpacked**.
4. In the folder picker, open the `dist-extension` folder (for example
   `C:\Users\<you>\Documents\gaze-reader\dist-extension`) and click **Select Folder**. Select the
   folder itself; don't go inside it and pick a file.
5. A **Gaze Reader — eye-tracking auto-scroll** card appears. Make sure its switch is on.
6. Pin the button so it's easy to reach: click the **puzzle-piece** (Extensions) icon to the
   right of the address bar, then click the **pin** next to Gaze Reader. The orange Gaze Reader
   icon now sits in the toolbar.

## 2b. Or load it in Microsoft Edge

1. Go to `edge://extensions`.
2. Turn on **Developer mode**. The switch is in the left sidebar, near the bottom. On a narrow
   window, open the sidebar with the ☰ menu first.
3. Click **Load unpacked** and select the `dist-extension` folder, as in step 4 above.
4. Make sure the Gaze Reader card is switched on.
5. Pin it: click the **Extensions** (puzzle-piece) button in the toolbar, then click the **eye**
   icon ("Show in toolbar") next to Gaze Reader.

Edge sometimes shows a "Turn off extensions in developer mode" message when it starts. Choose
**Keep** (or just close the message) to keep Gaze Reader. Chrome can show a similar reminder;
dismiss it the same way.

## 3. First use: camera permission

1. Open a page you want to read, such as a long article or an online book.
2. Click the Gaze Reader toolbar button. In the popup, turn on **On this page**. You can also
   press **Alt+Shift+G**.
3. The first time you use the webcam, a **Camera setup** tab opens. Chrome runs the face tracker
   in a hidden (offscreen) page, and a hidden page can't ask for camera permission, so this tab
   asks on its behalf.
4. Click **Allow camera**. Chrome shows a permission prompt near the address bar. Choose
   **Allow while visiting the site** (in some versions it's just **Allow**). Don't choose
   **Allow this time**, because that permission ends as soon as the setup tab closes.
5. Click **Back to my page**. The setup tab closes and you return to your article.

You only do this once. The permission belongs to the extension, not to the websites you read.
Video is processed on your computer and never uploaded (see [PRIVACY.md](../PRIVACY.md)).

If you'd rather not use the camera, pick **Follow my: Mouse** in the popup. Then the page turns
when your mouse pointer rests at the end of the last line.

## 4. Calibrate

Back on your page, calibration starts on its own. It takes about a minute.

1. Sit the way you normally read, about an arm's length from the screen, with your face evenly
   lit (not with a bright window behind you).
2. Fit your face in the oval until the checklist turns green.
3. Follow each dot with your **eyes**, keeping your head still. There are 13 dots, then 4 check
   points. Press **Space** to pause or **Esc** to cancel.
4. At the end you'll see your accuracy. Choose **Use it**, or **Redo** if it looks poor.

The calibration is saved in the extension and shared by every site. It adjusts automatically for
each site's zoom level. Recalibrate (popup → **Recalibrate**, or **Alt+Shift+C**) after a big
change in posture, lighting or seating.

## 5. Reading

- Read normally. When you finish the last line on screen, Gaze Reader scrolls the next part of the
  page into view and keeps a line of context at the top.
- Want the next page right away? Look just below the bottom edge of the window for a moment.
- Dewey, the small reading buddy in the corner, reads along with you. Click him for a menu, or drag
  him to another corner. The popup can hide him.
- The status pill next to Dewey shows whether Gaze Reader can see your eyes. It also has
  pause, recalibrate and close buttons.
- The popup lets you choose eyes or mouse, how eager page turns are (**Relaxed / Balanced /
  Eager**), how pages turn (**Auto / Scrolling / Next-page key**, see
  [page mode](#canvas-and-image-readers-page-mode)), whether Dewey is shown, and whether the gaze
  dot is shown.

Gaze Reader runs only in tabs where you turn it on. It uses the camera only while that tab is
visible, and lets go of it a few seconds after you switch away.

## Keyboard shortcuts

On a page where Gaze Reader is on (ignored while you type in a text field):

| Keys | Action |
|---|---|
| Alt+Shift+P | Pause or resume automatic page turns |
| Alt+Shift+↓ (or Alt+Shift+Page Down) | Next page |
| Alt+Shift+↑ (or Alt+Shift+Page Up) | Previous page |
| Alt+Shift+U | Undo the last page turn |
| Alt+Shift+C | Recalibrate |
| Alt+Shift+O | Show or hide the gaze dot |
| Alt+Shift+D | Debug overlay (measured lines, what the page-end detector is waiting for) |
| Alt+Shift+H | List these shortcuts |
| Alt+Shift+X | Turn Gaze Reader off in this tab |

Anywhere: **Alt+Shift+G** turns Gaze Reader on or off in the current tab. To change it, go to
`chrome://extensions/shortcuts` in Chrome or `edge://extensions/shortcuts` in Edge.

## Updating after a rebuild

After you pull new code or change it:

1. Run `npm run build:ext` again. It rebuilds `dist-extension` in the same place.
2. Go to `chrome://extensions` (or `edge://extensions`) and click the **reload** button (the
   circular arrow) on the Gaze Reader card.
3. Reload any tab where Gaze Reader was on. The copy already running in an open page belongs to
   the old version. It notices the update and says "Gaze Reader was updated or reloaded. Refresh
   the page to use it here again."

Your settings and calibration are kept across reloads and updates.

## Turning it off or uninstalling

- **In one tab:** click **×** on the status pill, press **Alt+Shift+X**, or switch **On this
  page** off in the popup. Closing or leaving the page also turns it off.
- **Everywhere, for now:** turn off the switch on the Gaze Reader card in `chrome://extensions`.
- **Uninstall:** click **Remove** on the card, or right-click the toolbar button and choose
  **Remove from Chrome** (**Remove from Microsoft Edge**). This deletes the extension's settings
  and calibration. You can then delete the `dist-extension` folder too.

## Troubleshooting

### The camera is blocked

- In the popup, click **Camera setup**. The setup page checks the permission and tells you what to
  do.
- If it says the camera is blocked, open `chrome://settings/content/camera` (Edge:
  `edge://settings/content/camera`). Under **Not allowed to use your camera**, find the entry that
  starts with `chrome-extension://` (Gaze Reader). Change it to **Allow**, or remove it and go
  through the setup page again.
- On Windows, open **Settings → Privacy & security → Camera** and make sure **Camera access** and
  **Let desktop apps access your camera** are both on. On macOS, open **System Settings → Privacy &
  Security → Camera** and allow your browser.
- "Another app is using the camera": close Teams, Zoom or any other app that has the camera open,
  then click **Try again** on the page.
- If you revoke the permission while reading, Gaze Reader stops and offers the setup page again.

### Nothing happens on a page

- **The switch is greyed out, or you see "Chrome doesn't let extensions read along on this
  page."** Browsers don't allow extensions on their own pages (`chrome://`, `edge://`, the new tab
  page) or on the Chrome Web Store. The built-in PDF viewer can't be read along either. Open the
  PDF in the [Gaze Reader app](https://lance-lii.github.io/gaze-reader/) instead.
- **Local files (`file://`):** on the Gaze Reader card, click **Details** and turn on **Allow access
  to file URLs**.
- **After you follow a link to a new page,** Gaze Reader is off again. Turn it on for each page
  you read. (Pages that change their content without a full reload keep it on.)
- **Check the popup's status line.** "Not calibrated yet" means you need to calibrate. "Auto-scroll
  paused" means press **Alt+Shift+P**. "Can't see your eyes" means check the light and your
  position.
- **The page turns at the wrong time, or never.** Press **Alt+Shift+D** to see the lines Gaze Reader
  measured. If it chose the wrong part of the page (a sidebar instead of the article, say), the
  site's layout fooled its main-text detection. Text inside frames (`<iframe>`) isn't measured.
  If pages turn too early, choose **Relaxed**. If they turn too late, choose **Eager**.
  **Alt+Shift+U** undoes a turn.

### Canvas and image readers (page mode)

Some online readers draw each page as a picture instead of as text. Examples are Kindle Cloud
Reader, Google Play Books and some PDF viewers. Gaze Reader has no text lines to follow on those
sites. When it finds fewer than 3 lines of text around the view for about 2 seconds, it switches
that tab to **page mode**:

- Dewey says (once per page load) that he can't read the text here and that glancing at the bottom
  edge turns the page. The popup's status line shows "page mode".
- To turn the page, look at the bottom edge of the page for a moment, or rest your eyes at the bottom
  right of the text. Line-by-line tracking isn't possible here.
- How the page turns is set by **Turn pages by** in the popup:
  - **Auto** (the default): scroll when the page scrolls, otherwise press the page's own "next
    page" keys (→ and Page Down).
  - **Scrolling:** always scroll.
  - **Next-page key:** always press → and Page Down, even on pages with normal text. This is useful
    for readers that show one page at a time.
- The key presses are **best effort**. They are synthetic, and many readers ignore key presses that
  don't come from a real keyboard, or listen for them inside a frame the extension can't reach. If
  pages don't turn, click once inside the book page (so it has keyboard focus) and try again. If
  that doesn't help, switch to **Scrolling** or turn the pages yourself.
- As soon as real text lines appear (you move on to an ordinary page), Gaze Reader switches back to
  normal line tracking by itself.

### "Developer mode" or "Load unpacked" isn't available

On a computer managed by your school or employer, an administrator policy can switch off developer
mode or block extensions that aren't in the store. The switch is then greyed out with a note such as
"Managed by your organization". To see the active policies, go to `chrome://policy` (or
`edge://policy`) and look for `ExtensionDeveloperModeSettings`, `DeveloperToolsAvailability`,
`ExtensionInstallBlocklist` or `ExtensionInstallAllowlist`. You can't work around these policies.
Ask your IT department, use a personal computer or browser profile, or use the
[web app](https://lance-lii.github.io/gaze-reader/), which needs no installation.
