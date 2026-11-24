#!/usr/bin/env python3
"""
The reference eye tracker of the EOTT dataset, for the two dot tests extract_eott.py has read.

Every EOTT participant was also followed by a Tobii Pro X3-120 (a dedicated infrared eye tracker,
accurate to about half a degree). This reads its log for each participant out of the remote
archive (1.1 GB packed in all; nothing but the dot tests' seconds is kept) and does two things:

 1. Writes where the Tobii says the person looked, sample by sample: P_XX.ref.f32.
 2. Lines the webcam video up with the clock of the logs. The video starts a few hundred
    milliseconds after the log's "recording start", by a different amount per recording. The
    shift is the one at which the side-to-side movement of the irises in the video best follows
    the Tobii's gaze; it is written into P_XX.json as each session's `videoLagMs`, with the
    correlation reached (`lagCorrelation`), so a recording that could not be lined up shows.

  .venv-research/bin/python scripts/research/extract_eott_reference.py

Record of P_XX.ref.f32 (little-endian float32): session, ms since that session's "recording
start", gaze x and y in screen pixels (mean of the eyes the Tobii had), eyes it had (1 or 2).
"""
import argparse, json, os, re, sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = "https://webgazer.cs.brown.edu/data/WebGazerETRA2018Dataset_Release20180420.zip"
PREFIX = "WebGazerETRA2018Dataset_Release20180420/"
MARGIN_MS = 3000
LAGS = np.arange(-1500, 1501, 10)
TIME = re.compile(rb'"true_time": ([0-9.]+)')


def iris_side(records, meta):
    """Where the irises sit between the eye corners, both eyes averaged: follows a look to the side."""
    h = meta["header"]
    lm = records[:, h : h + 2 * meta["landmarks"]].reshape(len(records), -1, 2).astype(np.float64)

    def ratio(iris, a, b):
        d = lm[:, b] - lm[:, a]
        return ((lm[:, iris] - lm[:, a]) * d).sum(1) / (d * d).sum(1)

    return (ratio(468, 33, 133) + ratio(473, 362, 263)) / 2


def participant(args):
    pid, out_dir = args
    from remotezip import RemoteZip

    meta_path = os.path.join(out_dir, f"{pid}.json")
    meta = json.load(open(meta_path))
    # A log can lack its "recording stop": the video's own length then says when it ended.
    windows = [(s["session"], s["startEpoch"], s["startEpoch"] - MARGIN_MS, (s["stopEpoch"] or s["startEpoch"] + s["videoMs"]) + MARGIN_MS) for s in meta["sessions"]]
    lo, hi = min(w[2] for w in windows), max(w[3] for w in windows)
    w_px, h_px = meta["screen"]["widthPx"], meta["screen"]["heightPx"]
    rows = []
    with RemoteZip(URL, headers={"User-Agent": "Mozilla/5.0"}) as z:
        with z.open(f"{PREFIX}{pid}/{pid}.txt") as fh:
            for line in fh:
                m = TIME.search(line)
                if not m:
                    continue
                t = float(m.group(1)) * 1000
                if t < lo:
                    continue
                if t > hi:
                    break
                for session, start, a, b in windows:
                    if a <= t <= b:
                        o = json.loads(line)
                        pts = [o[f"{k}_gaze_point_on_display_area"] for k in ("left", "right") if o.get(f"{k}_gaze_point_validity")]
                        if pts:
                            rows.append((session, t - start, float(np.mean([p[0] for p in pts])) * w_px, float(np.mean([p[1] for p in pts])) * h_px, len(pts)))
                        break
    ref = np.array(rows, dtype=np.float64).reshape(-1, 5)
    ref.astype("<f4").tofile(os.path.join(out_dir, f"{pid}.ref.f32"))

    records = np.fromfile(os.path.join(out_dir, f"{pid}.f32"), "<f4").reshape(-1, meta["recordLength"])
    side = iris_side(records, meta)
    out = []
    for s in meta["sessions"]:
        mine = records[:, 0] == s["session"]
        r = ref[ref[:, 0] == s["session"]]
        s["referenceSamples"] = int(len(r))
        s["videoLagMs"], s["lagCorrelation"] = None, None
        if mine.sum() >= 60 and len(r) >= 200:
            t = records[mine, 2].astype(np.float64)
            f = side[mine]
            best = max((abs(float(np.corrcoef(f, np.interp(t + lag, r[:, 1], r[:, 2]))[0, 1])), int(lag)) for lag in LAGS)
            s["videoLagMs"], s["lagCorrelation"] = best[1], round(best[0], 4)
        out.append(f"{s['name']} lag {s['videoLagMs']} ms (r {s['lagCorrelation']}, {len(r)} samples)")
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=1)
    return f"{pid}: " + ", ".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, ".data/eott/features"))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    pids = sorted(f[:-5] for f in os.listdir(a.out) if re.fullmatch(r"P_\d+\.json", f))
    if a.only:
        pids = [p for p in pids if p in a.only.split(",")]
    if not pids:
        sys.exit("run scripts/research/extract_eott.py first")
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        for line in pool.map(participant, [(p, a.out) for p in pids]):
            print(line, flush=True)


if __name__ == "__main__":
    main()
