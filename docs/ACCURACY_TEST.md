# The accuracy test

Every accuracy number this project had came from a simulated face or from photographs taken for
another purpose ([REAL_DATA.md](REAL_DATA.md)), and those two disagree about which calibration is
better. The accuracy test measures it where it matters: your face, your camera, this app.

It takes about four minutes, records numbers only (no video), and uploads nothing.

## Running it

In the [web app](https://lance-lii.github.io/gaze-reader/), with a book open and eye tracking
running:

1. **Settings → Advanced → Run the accuracy test (about 4 minutes).**
2. Do the full calibration it starts with, including the head-movement step. The test is scored
   against this calibration, and it becomes your calibration afterwards, like any other.
3. Follow the dots through five rounds of nine. Before each round a card says how to sit:

   | Round | How to sit |
   | --- | --- |
   | Still | As you sat for the calibration |
   | Head turned | Head turned slightly to one side, eyes following the dots |
   | Leaning back | About a hand's width further from the screen |
   | Sitting lower | Slid down in the chair a little |
   | Back to start | As you sat for the calibration again |

   A round takes about 20 seconds. A dot the camera lost you on is shown once more. **Esc** stops
   a round; finished rounds are still scored.
4. Read the results, then **Save recording** to keep the session as a JSON file
   (`gaze-reader-accuracy-<date>-<time>.json`), or **Copy results** for the table as text.

Keep the window where it is and the size it is for the whole session. If it changes size during
the rounds, the dots no longer line up with the calibration and the session is dropped.

None of the test dots is a calibration dot, so the test measures how the calibration carries to
places it was not fitted on.

## Reading the results

The same frames are scored for six calibrations, each fitted again from your calibration dots:

| Row | What it is |
| --- | --- |
| Default calibration | What the app uses unless you change a setting |
| Real-face model | Settings → Eye tracking → Real-face model (experimental) |
| Default, no head-movement step | The default with the nod, turn and tilt step skipped |
| Default, no distance correction | The default without the correction for leaning in or back |
| 1.1 features | Head pose fed to the gaze fit, as in version 1.1 |
| 1.0 features | Every measurement, eyelids included, as in version 1.0 |

Each cell is the median up-or-down miss in lines of the text you had open, and in brackets the
share of dots read on the right line (within half a line). **All** covers every round;
**After moving** covers the three rounds where you had moved.

The sentence above the table compares the default with the real-face model dot by dot. It says
"clearly better" or "clearly worse" only when a sign test over the dots gives p < 0.01 and the
median gain is at least 15% of the default's error. Anything less is reported as no clear
difference.

One session is 45 dots from one person on one day. It can tell you which calibration suits you
today; it cannot tell the project which should be the default. That needs several people, which
is what the saved recordings are for.

## Scoring recordings later

A saved recording holds the frames, so a change to the calibration code can be tried on real
faces without anyone sitting the test again:

```sh
GR_ACCURACY=path/to/gaze-reader-accuracy-2026-11-23-1405.json npm run bench:live
```

PowerShell: `$env:GR_ACCURACY='…'; npm run bench:live`. Several files can be given, separated by
`:` (`;` on Windows). They are scored one by one and then pooled, with each comparison's sign
test run over all their dots together. Sessions of one person on one day are not independent, so
more people and more days count for more than more sessions.

Without `GR_ACCURACY` the command scores one simulated session, to show the output. That says
nothing about real faces.

## What a recording holds

- For every camera frame used: the eye measurements the tracker computes (the same numbers the
  calibration is fitted on), head angle and position, how open the eyes were, and the tracker's
  quality score.
- Where each dot was, the window's size and place on the screen, the line spacing of the open
  text, the app version, and the date and time.

It holds no video, no images, nothing about the book, and nothing about your browser or camera
beyond the above. It stays in the page's memory until you press **Save recording**, which writes
a file on your computer. Closing the results without saving discards it. See
[PRIVACY.md](../PRIVACY.md#accuracy-test-web-app-only-if-you-start-it).

## Limits

- Web app only. The extension and the Artifact build do not have it.
- The postures are whatever you did when asked. "Leaning back" for one person is not the same
  distance as for another, so compare calibrations within a session, not postures across people.
- The dots are large, steady targets. Reading is small, fast eye movements along a line, and the
  line tracker corrects a good deal of what this test counts as error. A calibration that wins
  here should be better for reading, but the test does not measure page turns.
