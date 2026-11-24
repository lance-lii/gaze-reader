#!/usr/bin/env python3
"""
Runs the app's own face model (public/mediapipe/models/face_landmarker.task) over the MPIIFaceGaze
dataset and writes what the app would have seen for each picture: face landmarks, blendshapes and
the head matrix, next to where on the screen the person was looking. No pictures are written.

bench/realdata/ reads the result and runs the app's real pipeline (features, calibration, the
corrections) on it. See docs/REAL_DATA.md.

  python3 -m venv .venv-research && .venv-research/bin/pip install mediapipe scipy
  curl -L -o .data/mpiifacegaze/Data.zip https://darus.uni-stuttgart.de/api/access/datafile/198951
  .venv-research/bin/python scripts/research/extract_mpiifacegaze.py

The dataset (Zhang et al., CVPR-W 2017; DOI 10.18419/darus-3240) is CC BY-NC-SA 4.0: research and
other non-commercial use only. Nothing derived from it is committed to this repository.

Output, per participant, in .data/mpiifacegaze/features/:
  pXX.json  screen size, where the camera is in screen pixels, blendshape names, record layout
  pXX.f32   little-endian float32 records (see RECORD below)
and, with --eyes afterwards (for scripts/research/train_eye_cnn.py), for the same records in the same order:
  pXX.u8         two 36×60 grey eye pictures, cut exactly as extract_eott.py cuts them
  pXX.light.f32  the light on the face: its brightness, each half's, the rest of the picture's, clipping (6 numbers)
"""
import argparse, io, json, os, sys, zipfile
from concurrent.futures import ProcessPoolExecutor

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
N_LANDMARKS = 478
N_BLEND = 52
# day, the picture's number within the day (its order in time), target x, target y (screen px), image w, image h,
# face centre xyz and gaze target xyz in camera mm (the dataset's own estimate),
# the dataset's head rotation vector and translation (6),
# then 478 × (x, y) normalized landmarks, 52 blendshape scores, the 4×4 matrix (column-major).
HEADER = 18
RECORD = HEADER + N_LANDMARKS * 2 + N_BLEND + 16


def rodrigues(r):
    r = np.asarray(r, dtype=float).reshape(3)
    theta = np.linalg.norm(r)
    if theta < 1e-12:
        return np.eye(3)
    k = r / theta
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(theta) * K + (1 - np.cos(theta)) * (K @ K)


def participant(args):
    zip_path, prefix, pid, model_path, out_dir, limit = args
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    from scipy.io import loadmat

    z = zipfile.ZipFile(zip_path)
    base = f"{prefix}{pid}/"

    def mat(name):
        return loadmat(io.BytesIO(z.read(f"{base}Calibration/{name}.mat")))

    size = mat("screenSize")
    w_px, h_px = float(size["width_pixel"].ravel()[0]), float(size["height_pixel"].ravel()[0])
    w_mm, h_mm = float(size["width_mm"].ravel()[0]), float(size["height_mm"].ravel()[0])
    pose = mat("monitorPose")
    R = rodrigues(pose["rvects"].ravel() if "rvects" in pose else pose["rvecs"].ravel())
    t = (pose["tvecs"].ravel()).astype(float)
    # Screen (mm, origin top-left, x right, y down, z into the screen) -> camera: X = R s + t.
    cam_in_screen_mm = -R.T @ t
    camera_px = [cam_in_screen_mm[0] * w_px / w_mm, cam_in_screen_mm[1] * h_px / h_mm]
    cam = mat("Camera")
    K = cam["cameraMatrix"].astype(float)

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
    )

    lines = z.read(f"{base}{pid}.txt").decode().strip().split("\n")
    if limit:
        lines = lines[:: max(1, len(lines) // limit)]
    names = None
    out = []
    no_face = 0
    reproj = []
    for idx, line in enumerate(lines):
        f = line.split()
        rel = f[0]
        target = (float(f[1]), float(f[2]))
        head = [float(v) for v in f[15:21]]
        fc = [float(v) for v in f[21:24]]
        gt = [float(v) for v in f[24:27]]
        # The dataset's 3D target against the screen pose: the two must agree, or the camera point is wrong.
        s = np.array([target[0] * w_mm / w_px, target[1] * h_mm / h_px, 0.0])
        reproj.append(float(np.linalg.norm(R @ s + t - np.array(gt))))
        img = cv2.imdecode(np.frombuffer(z.read(base + rel), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            no_face += 1
            continue
        h, w = img.shape[:2]
        res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
        if not res.face_landmarks or len(res.face_landmarks[0]) < N_LANDMARKS:
            no_face += 1
            continue
        lm = res.face_landmarks[0]
        blend = res.face_blendshapes[0] if res.face_blendshapes else []
        if names is None and blend:
            names = [b.category_name for b in blend]
        scores = [b.score for b in blend] + [0.0] * (N_BLEND - len(blend))
        m = res.facial_transformation_matrixes[0] if res.facial_transformation_matrixes else np.eye(4)
        day = int(rel.split("/")[0].replace("day", ""))
        rec = np.empty(RECORD, dtype=np.float32)
        number = int(os.path.splitext(rel.split("/")[-1])[0])
        rec[:HEADER] = [day, number, target[0], target[1], w, h, *fc, *gt, *head]
        rec[HEADER : HEADER + 2 * N_LANDMARKS] = np.array([(p.x, p.y) for p in lm[:N_LANDMARKS]], dtype=np.float32).ravel()
        rec[HEADER + 2 * N_LANDMARKS : HEADER + 2 * N_LANDMARKS + N_BLEND] = scores[:N_BLEND]
        # Column-major, as the browser build hands it to the app.
        rec[-16:] = np.asarray(m, dtype=np.float32).T.ravel()
        out.append(rec)

    os.makedirs(out_dir, exist_ok=True)
    np.stack(out).astype("<f4").tofile(os.path.join(out_dir, f"{pid}.f32"))
    meta = {
        "participant": pid,
        "records": len(out),
        "recordLength": RECORD,
        "header": HEADER,
        "landmarks": N_LANDMARKS,
        "blendshapeNames": names or [],
        "screen": {"widthPx": w_px, "heightPx": h_px, "widthMm": w_mm, "heightMm": h_mm},
        "cameraPx": camera_px,
        "cameraOffScreenPlaneMm": float(cam_in_screen_mm[2]),
        "focalPx": [float(K[0, 0]), float(K[1, 1])],
        "noFace": no_face,
        "annotated": len(lines),
        "targetReprojectionMm": {"median": float(np.median(reproj)), "max": float(np.max(reproj))},
    }
    with open(os.path.join(out_dir, f"{pid}.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    return meta


def eye_pictures(args):
    """Second pass: the two eye pictures and the light on the face for every record already written, in the same order."""
    zip_path, prefix, pid, out_dir = args
    import cv2
    from types import SimpleNamespace

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from extract_eott import EYES, eye_crop, lighting

    meta = json.load(open(os.path.join(out_dir, f"{pid}.json")))
    rec = np.fromfile(os.path.join(out_dir, f"{pid}.f32"), dtype="<f4").reshape(-1, meta["recordLength"])
    z = zipfile.ZipFile(zip_path)
    crops = np.zeros((len(rec), 2, 36, 60), dtype=np.uint8)
    light = np.zeros((len(rec), 6), dtype=np.float32)
    for i, r in enumerate(rec):
        img = cv2.imdecode(np.frombuffer(z.read(f"{prefix}{pid}/day{int(r[0]):02d}/{int(r[1]):04d}.jpg"), np.uint8), cv2.IMREAD_GRAYSCALE)
        h, w = img.shape[:2]
        assert (w, h) == (int(r[4]), int(r[5])), (pid, i)
        xy = r[HEADER : HEADER + 2 * N_LANDMARKS].reshape(-1, 2)
        lm = [SimpleNamespace(x=float(x), y=float(y)) for x, y in xy]
        crops[i] = np.stack([eye_crop(img, lm, w, h, a, b, mirror) for a, b, mirror in EYES])
        light[i] = lighting(img, lm, w, h)
    crops.tofile(os.path.join(out_dir, f"{pid}.u8"))
    light.astype("<f4").tofile(os.path.join(out_dir, f"{pid}.light.f32"))
    return pid, len(rec)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", default=os.path.join(ROOT, ".data/mpiifacegaze/Data.zip"))
    ap.add_argument("--model", default=os.path.join(ROOT, "public/mediapipe/models/face_landmarker.task"))
    ap.add_argument("--out", default=os.path.join(ROOT, ".data/mpiifacegaze/features"))
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 3))
    ap.add_argument("--limit", type=int, default=0, help="about this many pictures per participant (0: all)")
    ap.add_argument("--only", default="", help="comma-separated participants, e.g. p00,p03")
    ap.add_argument("--eyes", action="store_true", help="only add the eye pictures (pXX.u8) and the light on the face (pXX.light.f32) to records already extracted")
    a = ap.parse_args()

    z = zipfile.ZipFile(a.zip)
    txts = sorted(n for n in z.namelist() if n.endswith(".txt") and os.path.basename(n)[:-4] == os.path.basename(os.path.dirname(n)))
    if not txts:
        sys.exit("no pXX/pXX.txt in the archive")
    prefix = txts[0][: -len("p00/p00.txt")]
    pids = [os.path.basename(n)[:-4] for n in txts]
    if a.only:
        pids = [p for p in pids if p in a.only.split(",")]
    if a.eyes:
        with ProcessPoolExecutor(max_workers=a.workers) as pool:
            for pid, n in pool.map(eye_pictures, [(a.zip, prefix, p, a.out) for p in pids]):
                print(f"{pid}: {n} pairs of eye pictures", flush=True)
        return
    jobs = [(a.zip, prefix, p, a.model, a.out, a.limit) for p in pids]
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        for meta in pool.map(participant, jobs):
            s = meta["screen"]
            print(
                f"{meta['participant']}: {meta['records']}/{meta['annotated']} faces, screen {s['widthPx']:.0f}×{s['heightPx']:.0f} px "
                f"({s['widthMm']:.0f}×{s['heightMm']:.0f} mm), camera at ({meta['cameraPx'][0]:.0f}, {meta['cameraPx'][1]:.0f}) px, "
                f"{meta['cameraOffScreenPlaneMm']:.0f} mm off the screen plane, target check {meta['targetReprojectionMm']['median']:.1f} mm",
                flush=True,
            )


if __name__ == "__main__":
    main()
