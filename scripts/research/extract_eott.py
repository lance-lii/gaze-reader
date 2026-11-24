#!/usr/bin/env python3
"""
Real people moving their eyes, on a webcam: the dot tests of the EOTT dataset (Papoutsaki et al.,
ETRA 2018, https://webgazer.cs.brown.edu/data/). 51 people in a lab, each filmed by an ordinary
640×480 webcam while clicking nine dots (the "dot test") and then watching a dot jump between
known places (the "final dot test").

This fetches only those two videos and their logs per person (about 440 MB of the 21 GB archive,
read out of the remote zip by byte range), runs the app's own face model over every frame
(public/mediapipe/models/face_landmarker.task), and writes what the app would have been handed:
landmarks, blendshapes and the head matrix. Next to each frame it writes two small grey pictures
of the eyes (for scripts/research/train_eye_cnn.py) and how the face was lit, so sessions whose
lighting changed can be left out.

  uv venv .venv-research --python 3.12
  uv pip install --python .venv-research/bin/python mediapipe scipy torch remotezip
  .venv-research/bin/python scripts/research/extract_eott.py

The dataset's page gives its licence as GPLv3. Nothing from it, and nothing fitted on it, is
committed to this repository: everything lands in .data/eott/, which git ignores.

Output, per participant, in .data/eott/features/:
  P_XX.json  screen, sessions (when the video started, the clicks, the dots), record layout
  P_XX.f32   little-endian float32 records, one per video frame with a face (see RECORD below)
  P_XX.u8    for the same frames in the same order: two 36×60 grey eye pictures (see eye_crop)
"""
import argparse, csv, json, os, re, sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = "https://webgazer.cs.brown.edu/data/WebGazerETRA2018Dataset_Release20180420.zip"
PREFIX = "WebGazerETRA2018Dataset_Release20180420/"
N_LANDMARKS = 478
N_BLEND = 52
# session (1: dot test, 2: final dot test), frame number in the video, the frame's time in the video (ms),
# image w, image h, then the lighting: mean brightness of the face (0..255), of its left and right halves
# as the picture shows them, of the picture outside the face, and the share of face pixels that are
# blown out (≥ 250) or crushed (≤ 5).
# Then 478 × (x, y) normalized landmarks, 52 blendshape scores, the 4×4 matrix (column-major).
HEADER = 11
RECORD = HEADER + N_LANDMARKS * 2 + N_BLEND + 16
EYE_H, EYE_W = 36, 60
# The picture of an eye is this many times as wide as the eye is from corner to corner.
EYE_SPAN = 1.7
# (corner on the picture's left, corner on its right, mirror?) per eye. The second eye is mirrored,
# so that in both pictures the nose is on the right: one network can then read either.
EYES = ((33, 133, False), (362, 263, True))
SESSIONS = (("dot_test", 1), ("dot_test_final", 2))


def eye_crop(gray, lm, w, h, a, b, mirror):
    """A 36×60 picture of one eye, turned so its corners are level, in the picture's own brightness."""
    import cv2

    ax, ay, bx, by = lm[a].x * w, lm[a].y * h, lm[b].x * w, lm[b].y * h
    cx, cy = (ax + bx) / 2, (ay + by) / 2
    dx, dy = bx - ax, by - ay
    span = max(1e-6, float(np.hypot(dx, dy)))
    s = EYE_SPAN * span / EYE_W  # image px per crop px
    ux, uy = dx / span, dy / span  # the crop's x axis in the image
    vx, vy = -uy, ux  # and its y axis: down
    if mirror:
        ux, uy = -ux, -uy
    # crop (i, j) -> image: c + s·((i − W/2)·u + (j − H/2)·v)
    M = np.array(
        [
            [s * ux, s * vx, cx - s * (ux * EYE_W / 2 + vx * EYE_H / 2)],
            [s * uy, s * vy, cy - s * (uy * EYE_W / 2 + vy * EYE_H / 2)],
        ],
        dtype=np.float64,
    )
    return cv2.warpAffine(gray, M, (EYE_W, EYE_H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)


def lighting(gray, lm, w, h):
    """How the face is lit in one frame: brightness of the face, of each half, of the rest, and clipping."""
    import cv2

    pts = np.array([(p.x * w, p.y * h) for p in lm[:468]], dtype=np.float32)
    hull = cv2.convexHull(pts).astype(np.int32)
    mask = np.zeros(gray.shape, np.uint8)
    cv2.fillConvexPoly(mask, hull, 1)
    face = gray[mask == 1]
    if face.size < 50:
        return [0, 0, 0, 0, 0, 0]
    # The line down the middle of the face: forehead (10) to chin (152).
    tx, ty = lm[10].x * w, lm[10].y * h
    bx, by = lm[152].x * w, lm[152].y * h
    ys, xs = np.nonzero(mask)
    side = (xs - tx) * (by - ty) - (ys - ty) * (bx - tx)
    vals = gray[ys, xs]
    left, right = vals[side > 0], vals[side < 0]
    rest = gray[mask == 0]
    return [
        float(face.mean()),
        float(left.mean()) if left.size else 0.0,
        float(right.mean()) if right.size else 0.0,
        float(rest.mean()) if rest.size else 0.0,
        float((face >= 250).mean()),
        float((face <= 5).mean()),
    ]


def fetch(pid, names, raw_dir):
    """The participant's files, read out of the remote archive unless they are already here."""
    missing = [n for n in names if not os.path.exists(os.path.join(raw_dir, pid, n))]
    if not missing:
        return
    from remotezip import RemoteZip

    os.makedirs(os.path.join(raw_dir, pid), exist_ok=True)
    with RemoteZip(URL, headers={"User-Agent": "Mozilla/5.0"}) as z:
        for n in missing:
            data = z.read(f"{PREFIX}{pid}/{n}")
            tmp = os.path.join(raw_dir, pid, n + ".part")
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, os.path.join(raw_dir, pid, n))


def session_log(events, page):
    """When the page's video started and stopped, its clicks, and how page coordinates sit on the screen."""
    mine = [e for e in events if e.get("webpage") == f"/study/{page}.htm"]
    start = next((e["epoch"] for e in mine if e.get("type") == "recording start"), None)
    stop = next((e["epoch"] for e in mine if e.get("type") == "recording stop"), None)
    clicks = [{"t": e["epoch"] - start, "x": e["screenX"], "y": e["screenY"]} for e in mine if e.get("type") == "mouseclick" and start is not None and "screenX" in e]
    offsets = [(e["screenX"] - e["clientX"], e["screenY"] - e["clientY"]) for e in mine if "screenX" in e and "clientX" in e]
    window = next(({"innerWidth": e["windowInnerWidth"], "innerHeight": e["windowInnerHeight"]} for e in mine if "windowInnerWidth" in e), None)
    return start, stop, clicks, offsets, window


def participant(args):
    pid, files, row, model_path, raw_dir, out_dir = args
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    log_name = next((n for n in files if re.fullmatch(r"\d+\.json", n)), None)
    videos = {page: next((n for n in files if n.endswith(f"-study-{page}.webm")), None) for page, _ in SESSIONS}
    has_tsv = "final_dot_test_locations.tsv" in files
    wanted = [n for n in [log_name, *videos.values(), "final_dot_test_locations.tsv" if has_tsv else None] if n]
    fetch(pid, wanted, raw_dir)
    base = os.path.join(raw_dir, pid)
    events = json.load(open(os.path.join(base, log_name)))

    # VIDEO mode: the tracker the app runs, frame after frame with its own smoothing between them.
    def make():
        return vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=model_path),
                running_mode=vision.RunningMode.VIDEO,
                num_faces=1,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=True,
            )
        )

    names = None
    records, crops, sessions = [], [], []
    all_offsets = []
    for page, number in SESSIONS:
        start, stop, clicks, offsets, window = session_log(events, page)
        all_offsets += offsets
        video = videos[page]
        if not video or start is None:
            continue
        cap = cv2.VideoCapture(os.path.join(base, video))
        landmarker = make()
        frames = no_face = 0
        last_t = -1.0
        last_stamp = -1
        w = h = 0
        while True:
            ok, img = cap.read()
            if not ok:
                break
            t = float(cap.get(cv2.CAP_PROP_POS_MSEC))
            frames += 1
            if t <= last_t:
                t = last_t + 1.0
            last_t = t
            h, w = img.shape[:2]
            # The landmarker wants whole milliseconds that always rise; two frames can round to the same one.
            stamp = max(int(round(t)), last_stamp + 1)
            last_stamp = stamp
            res = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)), stamp)
            if not res.face_landmarks or len(res.face_landmarks[0]) < N_LANDMARKS:
                no_face += 1
                continue
            lm = res.face_landmarks[0]
            blend = res.face_blendshapes[0] if res.face_blendshapes else []
            if names is None and blend:
                names = [b.category_name for b in blend]
            scores = [b.score for b in blend] + [0.0] * (N_BLEND - len(blend))
            m = res.facial_transformation_matrixes[0] if res.facial_transformation_matrixes else np.eye(4)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            rec = np.empty(RECORD, dtype=np.float32)
            rec[:HEADER] = [number, frames - 1, t, w, h, *lighting(gray, lm, w, h)]
            rec[HEADER : HEADER + 2 * N_LANDMARKS] = np.array([(p.x, p.y) for p in lm[:N_LANDMARKS]], dtype=np.float32).ravel()
            rec[HEADER + 2 * N_LANDMARKS : HEADER + 2 * N_LANDMARKS + N_BLEND] = scores[:N_BLEND]
            rec[-16:] = np.asarray(m, dtype=np.float32).T.ravel()
            records.append(rec)
            crops.append(np.stack([eye_crop(gray, lm, w, h, a, b, mirror) for a, b, mirror in EYES]))
        cap.release()
        landmarker.close()
        sessions.append(
            {
                "name": page,
                "session": number,
                "startEpoch": start,
                "stopEpoch": stop,
                "videoMs": last_t,
                "frames": frames,
                "noFace": no_face,
                "image": [w, h],
                "window": window,
                "clicks": clicks,
                "dots": [],
            }
        )

    # Page coordinates -> screen pixels: the same shift for every event of a participant's window.
    shift = [float(np.median([o[0] for o in all_offsets])), float(np.median([o[1] for o in all_offsets]))] if all_offsets else [0.0, 0.0]
    final = next((s for s in sessions if s["name"] == "dot_test_final"), None)
    if final and has_tsv:
        rows = []
        with open(os.path.join(base, "final_dot_test_locations.tsv")) as fh:
            for r in csv.DictReader(fh, delimiter="\t"):
                rows.append((float(r["Dot_X"]), float(r["Dot_Y"]), float(r["Epoch"])))
        dots = []
        for x, y, epoch in rows:
            t = epoch - final["startEpoch"]
            if dots and dots[-1]["pageX"] == x and dots[-1]["pageY"] == y:
                dots[-1]["t1"] = t
            else:
                dots.append({"t0": t, "t1": t, "pageX": x, "pageY": y, "x": x + shift[0], "y": y + shift[1]})
        final["dots"] = dots

    def number_or_none(key):
        try:
            return float(row.get(key, ""))
        except ValueError:
            return None

    os.makedirs(out_dir, exist_ok=True)
    if records:
        np.stack(records).astype("<f4").tofile(os.path.join(out_dir, f"{pid}.f32"))
        np.stack(crops).astype(np.uint8).tofile(os.path.join(out_dir, f"{pid}.u8"))
    meta = {
        "participant": pid,
        "records": len(records),
        "recordLength": RECORD,
        "header": HEADER,
        "landmarks": N_LANDMARKS,
        "blendshapeNames": names or [],
        "eye": {"height": EYE_H, "width": EYE_W, "span": EYE_SPAN, "eyes": [list(e) for e in EYES]},
        "setting": row.get("Setting", ""),
        "screen": {
            "widthPx": number_or_none("Display Width (pixels)"),
            "heightPx": number_or_none("Display Height (pixels)"),
            "widthMm": (number_or_none("Screen Width (cm)") or 0) * 10 or None,
            "heightMm": (number_or_none("Screen Height (cm)") or 0) * 10 or None,
        },
        "distanceMm": (number_or_none("Distance From Screen (cm)") or 0) * 10 or None,
        "pageToScreen": shift,
        "notes": {k: row.get(k, "") for k in ("Self-Reported Vision", "Weather", "Time of day", "Facial Hair", "Notes")},
        "sessions": sessions,
    }
    with open(os.path.join(out_dir, f"{pid}.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.join(ROOT, "public/mediapipe/models/face_landmarker.task"))
    ap.add_argument("--raw", default=os.path.join(ROOT, ".data/eott/raw"))
    ap.add_argument("--out", default=os.path.join(ROOT, ".data/eott/features"))
    ap.add_argument("--workers", type=int, default=max(1, min(6, (os.cpu_count() or 4) - 3)))
    ap.add_argument("--only", default="", help="comma-separated participants, e.g. P_01,P_07")
    a = ap.parse_args()

    os.makedirs(a.raw, exist_ok=True)
    listing = os.path.join(os.path.dirname(a.raw), "listing.json")
    if not os.path.exists(listing):
        from remotezip import RemoteZip

        with RemoteZip(URL, headers={"User-Agent": "Mozilla/5.0"}) as z:
            json.dump([(i.filename, i.file_size, i.compress_size) for i in z.infolist()], open(listing, "w"))
    files = {}
    for name, _size, _packed in json.load(open(listing)):
        m = re.match(re.escape(PREFIX) + r"(P_\d+)/([^/]+)$", name)
        if m:
            files.setdefault(m.group(1), []).append(m.group(2))
    sheet = os.path.join(a.raw, "participant_characteristics.csv")
    if not os.path.exists(sheet):
        from remotezip import RemoteZip

        with RemoteZip(URL, headers={"User-Agent": "Mozilla/5.0"}) as z:
            open(sheet, "wb").write(z.read(PREFIX + "participant_characteristics.csv"))
    rows = {r["Participant ID"]: r for r in csv.DictReader(open(sheet, encoding="utf-8-sig"))}

    pids = sorted(files)
    if a.only:
        pids = [p for p in pids if p in a.only.split(",")]
    if not pids:
        sys.exit("no participants")
    jobs = [(p, files[p], rows.get(p, {}), a.model, a.raw, a.out) for p in pids]
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        for meta in pool.map(participant, jobs):
            parts = ", ".join(f"{s['name']} {s['frames'] - s['noFace']}/{s['frames']} frames, {len(s['clicks'])} clicks, {len(s['dots'])} dots" for s in meta["sessions"])
            print(f"{meta['participant']} ({meta['setting']}): {parts}", flush=True)


if __name__ == "__main__":
    main()
