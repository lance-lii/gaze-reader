# Gaze accuracy on real faces

Every other accuracy number in this repository comes from simulated faces (`bench/lighting/faceSim.ts`,
`bench/endtoend/`). This is the one measurement on photographs of real people. It is offline: nobody
has measured the app itself with a real camera and a known gaze target.

## The data

[MPIIFaceGaze](https://doi.org/10.18419/darus-3240) (Zhang et al., CVPR-W 2017): 15 people, about
3,000 laptop-webcam pictures each over 7 to 67 days of ordinary use, each with the point on the
screen the person was looking at, the screen's size and where the camera sits.

**Licence: CC BY-NC-SA 4.0.** Non-commercial use only, and anything adapted from it carries the same
terms. This repository is MIT, so nothing derived from the pictures is committed: not the features,
not fitted weights. Everything lives in the git-ignored `.data/`.

## Reproducing

About 1 GB of download, 5 minutes of extraction and 10 minutes of benchmark on an M3 Pro. No GPU.

```sh
python3 -m venv .venv-research && .venv-research/bin/pip install mediapipe scipy
mkdir -p .data/mpiifacegaze
curl -L -o .data/mpiifacegaze/Data.zip https://darus.uni-stuttgart.de/api/access/datafile/198951
.venv-research/bin/python scripts/research/extract_mpiifacegaze.py
npm run bench -- bench/realdata --silent=false --reporter=verbose
```

The extraction runs the app's own face model (`public/mediapipe/models/face_landmarker.task`) on
every picture and stores what the app would have seen: landmarks, blendshapes, the head matrix.
The benchmark feeds those through the app's real `extractEyeFeatures` and `trainGazeModel`. Without
`.data/mpiifacegaze/features/` the suites skip themselves.

## What is measured

One picture is one calibration sample: there is no averaging over frames, no fixation filter and no
line tracker, all of which the app has. Errors here are therefore larger than what a reader sees,
and what matters is the comparison between models. A "line" is 9 mm of screen.

Two protocols (`bench/realdata/protocol.ts`):

- **Consecutive pictures.** Calibrate on 20, 40 or 100 pictures taken one after another, test on the
  rest of that day and on other days.
- **Head moved since calibration.** Calibrate on the 40 or 100 pictures nearest one head pose, test
  on the rest, grouped by how many degrees the head is from where it was.

## Results (15 people, mean angular error)

| Calibration, test | the app now | every feature (1.0) | shared model |
|---|---|---|---|
| 40 pictures, head within 3° | 4.27° | 3.92° | 4.06° |
| 40 pictures, head 3–6° away | 5.20° | 4.20° | 4.05° |
| 40 pictures, head 6–10° away | 6.50° | 5.22° | 4.37° |
| 40 pictures, head over 10° away | 9.23° | 7.31° | 5.39° |
| 100 pictures, head within 3° | 3.28° | 3.01° | 3.12° |
| 100 pictures, head over 10° away | 7.53° | 5.79° | 5.15° |
| 20 consecutive, same day | 7.07° | 6.04° | 4.59° |
| 20 consecutive, other days | 8.30° | 7.20° | 5.25° |
| 100 consecutive, other days | 5.80° | 4.94° | 4.64° |

- **The app now**: `trainGazeModel` with its defaults (head pose excluded from the fit, distance
  corrected geometrically). The head-movement calibration step cannot be tested here: the data has
  no pictures of a person holding their eyes on one point while moving their head.
- **Every feature**: the same with nothing excluded, as in version 1.0.
- **Shared model**: a linear model of gaze direction fitted on the other 14 people
  (`bench/realdata/shared.ts`), whose two outputs are the only inputs of the app's own calibration
  for the tested person. Nobody is tested on a model that saw them.

## What it says

1. A model that has seen other people's faces holds up far better when the head moves after
   calibration, and with a short calibration. Close to the calibration pose and with a long
   calibration the three are about level.
2. Excluding head pose from the personal fit (done in 1.1 because the simulator said so) is worse on
   real faces than leaving it in, in every row.
3. The geometric distance correction makes little difference on real faces either way.
4. The simulator and the real faces disagree. On simulated faces
   (`bench/realdata/simcross.bench.test.ts`) the shared model is about twice as far off as the app's
   calibration, and a 4° head turn throws it by almost six lines. So the simulator's faces do not
   move their features with head pose the way real ones do, and its posture results should be read
   with that in mind.

Small networks and boosted trees on the same features were no better than the linear shared model
(leave-one-person-out, same protocol). A network on the eye images themselves would likely be: the
published figure for this dataset is around 3° after a short calibration. That needs a GPU to train
and a neural-network runtime in the browser.

## Limits

Fifteen people, all on laptops with the camera above the screen, 32 to 74 cm away, photographed
between 2012 and 2015. No external monitors, no phones, few glasses wearers.
