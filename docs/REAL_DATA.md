# Gaze accuracy on real faces

Every other accuracy number in this repository comes from simulated faces (`bench/lighting/faceSim.ts`,
`bench/endtoend/`). These are the measurements on real people: photographs first (MPIIFaceGaze,
below), then webcam video of people following dots
([further down](#people-moving-their-eyes-on-video-eott)). Both are offline: nobody has measured
the app itself with a real camera and a known gaze target. The in-app
[accuracy test](ACCURACY_TEST.md) is how to do that.

## The data

[MPIIFaceGaze](https://doi.org/10.18419/darus-3240) (Zhang et al., CVPR-W 2017): 15 people, about
3,000 laptop-webcam pictures each over 7 to 67 days of ordinary use, each with the point on the
screen the person was looking at, the screen's size and where the camera sits.

**Licence: CC BY-NC-SA 4.0.** Non-commercial use only, and anything adapted from it carries the same
terms. This repository is MIT, so the pictures and the features extracted from them are not
committed: they live in the git-ignored `.data/`. One derived file is committed, under the
dataset's licence and not MIT: `src/gaze/realFaceWeights.json`, the 3 kB of weights of the shared
model below, fitted on all 15 people. It is what the app's opt-in **Real-face model** setting
uses. Whether fitted weights are an adaptation of the data in the licence's sense is not settled;
this repository treats them as one.

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
  for the tested person. Nobody is tested on a model that saw them. This is the app's opt-in
  Real-face model setting, run through the same code (`src/gaze/gazePrior.ts`,
  `trainGazeModel(…, { prior })`); the weights the app ships are the same fit on all 15 people, so
  a reader of the app is in the position of the tested person here.

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

The Real-face model setting has only been scored here, one picture at a time. It has not been
measured in the app with a live camera, where the fixation filter, the line tracker and the
head-movement step sit on top of it, and the simulator the regression gates use says it is worse
than the default (`simcross.bench.test.ts`: about twice the error with the head still). That is
why it is off by default.

## People moving their eyes, on video (EOTT)

The photographs above are single pictures. This second set is video of people looking from dot to
dot, which is what a calibration and a reading session are made of.

### The data

The [EOTT dataset](https://webgazer.cs.brown.edu/data/) (Papoutsaki, Gokaslan, Tompkin, He and
Huang, ETRA 2018): 51 people in a lab, each filmed by an ordinary 640×480 webcam, 24 on a desktop
PC with a monitor and 27 on a laptop. Two of each person's recordings are used:

- **the dot test**: they click nine dots (some people a few more). This is the calibration: the
  frames just before each click, with the click's position.
- **the final dot test**, later in the same sitting: a dot jumps between nine known places and
  stays three seconds at each. This is the test. None of it is used to calibrate.

A Tobii Pro X3-120 eye tracker recorded the same sittings, so every table also has a row for what
a dedicated eye tracker scores on the same frames.

Seven laptop people have no usable final dot test, which leaves **44 test cases**.

**Licence: GPLv3**, as the dataset's page gives it. Nothing from it is committed, and nothing
fitted on it either: no videos, no extracted numbers, no network weights. Everything lands in the
git-ignored `.data/eott/`. The app can load a network you trained yourself, and ships none.

### Lighting

The exercise holds the light constant, with the yardstick fixed before any score was looked at
(`bench/realdata/eott.ts`):

- a person counts as **same light** when the face is within 10 % of the same brightness in the
  test as in the calibration, and its left and right halves keep their balance to within 10 %;
- within a recording, frames whose face brightness is more than 10 % from that recording's usual
  are dropped (flicker, a hand across the lamp);
- 40 of the 44 pass. The other four (P_14, P_24, P_58, P_62: the face about a fifth dimmer in the
  test) are scored separately and never trained on.

### Reproducing

About 440 MB of download (the two videos and their logs per person, read out of the 21 GB archive
by byte range), a few minutes of extraction, and 15 minutes of training on an M3 Pro's GPU.

```sh
uv venv .venv-research --python 3.12
uv pip install --python .venv-research/bin/python mediapipe scipy torch remotezip
.venv-research/bin/python scripts/research/extract_eott.py             # videos → what the app would see
.venv-research/bin/python scripts/research/extract_eott_reference.py   # the Tobii's answers
npm run bench:eott                                                     # the scoreboard, without the network
GR_EOTT_LABELS=1 npm run bench:eott                                    # + where each frame was looking, for the trainer
.venv-research/bin/python scripts/research/train_eye_cnn.py --final    # the network: held-out answers + weights
npm run bench:eott                                                     # the scoreboard, with it
```

Without `.data/eott/features/` the suites skip themselves.

### The eye-picture network

The app's calibrations work from about thirty numbers the face tracker draws round the eyes. The
network (`scripts/research/train_eye_cnn.py`) looks at the eyes themselves: two 36×60 grey
pictures, cut out between the eye corners the same way for every face, the second eye mirrored,
each brought to zero mean and unit contrast so a brighter room is the same picture. Four small
convolution layers per eye, then two dense layers that also take five head numbers. About 55,000
weights, half a megabyte as a file.

It answers with a direction: how far across and down the person looks, as a fraction of their
distance from the screen. It does not know the person or the screen. Their calibration turns the
direction into a place on their screen with four numbers, a scale and an offset per axis, which
nine clicks are enough for.

**No one is scored by a network that saw them.** The people are split into five groups, and each
group's answers come from a network trained on the other four. The four people whose light changed
are in no training set.

### Results

Calibrated on the clicks, tested on the final dot test, same light, 40 people. Error is the mean
angle between where the dot was and where the model said. A line is 9 mm.

| | error | vertical, in lines | worst tenth of frames | worst person |
|---|---|---|---|---|
| no tracker: always the middle of the screen | 17.7° | 11.4 | 19.8° | 21.8° |
| the app's default calibration | 9.1° | 7.4 | 24.2° | 21.5° |
| the Real-face model setting | 4.6° | 4.0 | 10.2° | 9.9° |
| **the eye-picture network, as the app calibrates on it** | **3.3°** | **2.4** | **7.2°** | 14.4° |
| the Tobii eye tracker | 1.5° | 1.2 | 3.7° | 8.3° |

| the same, by setup | default | Real-face model | eye-picture network | Tobii |
|---|---|---|---|---|
| desktop PC, 24 people, 62–86 cm away | 8.7° | 4.5° | 2.9° | 1.1° |
| laptop, 16 people, 44–62 cm away | 9.7° | 4.6° | 4.1° | 2.1° |
| light changed, 4 people | 4.9° | 4.5° | 2.1° | 1.1° |

What it says:

1. **Nine clicks are too few for the default calibration.** It fits about thirty weights per axis
   to the person's own dots; the app's 13 dots and head-movement step give it several times the
   frames these people had. With nine clicks it halves the error of always guessing the middle and
   no more. This is a statement about short calibrations, not about the app's own.
2. **A model that has seen other people needs far less from each new one.** The Real-face model
   and the network both ask the person for a handful of numbers, and both are at half the default's
   error or better.
3. **The pictures carry more than the outline.** The network is a quarter better than the
   Real-face model overall and more than a third better on the desktop setups, where the face is
   small in the frame and the tracker's outline is coarsest.
4. **It is not better for everyone.** Its worst person is at 14.4°, against 9.9° for the Real-face
   model: one laptop sitting it reads badly. On the desktop setups its worst person is at 5.0°.
5. **A webcam is still two to three times off a dedicated tracker.**

### In the app

`src/gaze/eyeNet.ts` is the network's arithmetic in plain TypeScript: the same crop and the same
forward pass as the trainer, 5 ms a frame. `bench/realdata/eyeNetCheck.bench.test.ts` runs it on
frames the trainer saved with its own answers (they agree to one part in a million) and is part of
`npm run bench:eott`.

Settings → Advanced → **Eye-picture network** loads the `weights.json` the trainer wrote
(`.data/eott/cnn/weights.json`). It is kept in this browser only. While it is loaded, the eye
region of each camera frame goes to a background thread, which answers with the two numbers; the
next full calibration is then built on those answers. If the network has not answered for enough
of the calibration's frames, the calibration is made the ordinary way. A calibration made on a
network only works while that same network is running; without it the app asks for a new one.
The accuracy test scores it next to the other calibrations.

### Limits

- **One lab, one day.** 51 people in the same room with the same two setups in 2017, and
  40 scored. The network has seen no other rooms, cameras or years, and 47 people is a small
  number to learn faces from. How it does on a different camera is not known.
- **Not measured in the app.** The scores are for frames replayed from video. A headless browser
  with one of these videos as its camera confirms the plumbing (the thread starts, answers every
  frame, and the calibration is built on it), not the accuracy. Nobody has read a book with it.
- **Head still.** These people sat still for a minute or two between calibration and test, and
  nine clicks have no head-movement step. In the app the step and the distance correction sit on
  top of the network as they do on any calibration, but what turning or leaning does to the
  network's answers on a real face is unmeasured. The accuracy test's posture rounds are how to
  find out.
- **Glasses, lighting, distance** are whatever these 51 people happened to bring. The light was
  held constant on purpose; the four people it changed for did no worse, which is four people.
- **The lag.** The laptop recordings run about 0.4 s behind their logs, the desktop ones about
  0.1 s or less. It is estimated per recording from the eye's own movement and removed
  (`bench/realdata/eott.ts`); an error there would cost the laptop rows more than the others.
