#!/usr/bin/env python3
"""Train a small network that reads the direction of gaze from pictures of the two eyes.

Input: what extract_eott.py cut out of the EOTT dot-test videos (two 36x60 grey pictures of the eyes
per frame, .data/eott/features/P_XX.u8) and what `GR_EOTT_LABELS=1 npm run bench:eott` wrote next to
them (.data/eott/labels: where the person was looking in each frame, and the app's own numbers for
the frame).

What it learns: (where the person looks, mm from the camera) / (their distance from the screen, mm),
across and down. One person's four numbers (a scale and an offset per axis) then put that on their
screen, which is the app's job and the scoreboard's (bench/realdata/eott.bench.test.ts), not this
script's.

Lighting: the constraint of the exercise is that the light stays the same throughout.
  - only frames whose face is within the lighting gate of its own recording's usual brightness;
  - people whose light changed between their calibration and their test are never trained on;
  - each eye picture is brought to zero mean and unit contrast before the network sees it, so a
    brighter or dimmer room is the same picture; training also varies gain and gamma a little.

No person is ever scored by a network that saw them: people are split into folds, and each fold's
people get their answers from a network trained on the other folds. Those answers go to
.data/eott/cnn/P_XX.f32 (two numbers per frame), where the scoreboard picks them up.

  .venv-research/bin/python scripts/research/train_eye_cnn.py            # folds, answers, report
  .venv-research/bin/python scripts/research/train_eye_cnn.py --final    # + one network on everyone, as weights

The dataset is GPLv3; neither it nor weights fitted on it are in the repository (docs/REAL_DATA.md).
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

EYE_H, EYE_W = 36, 60
HEAD = ["yaw", "pitch", "roll", "tx", "ty", "tz"]
BLINK_MAX = 0.5
# A label further than this from the camera, as a share of the distance, is not on any screen here.
LABEL_MAX = 0.6


def load(root):
    index = json.load(open(os.path.join(root, "labels", "index.json")))
    cols = {name: i for i, name in enumerate(index["columns"])}
    W = len(cols)
    people = []
    for p in index["people"]:
        lab = np.fromfile(os.path.join(root, "labels", p["id"] + ".f32"), dtype=np.float32).reshape(-1, W)
        eyes = np.fromfile(os.path.join(root, "features", p["id"] + ".u8"), dtype=np.uint8).reshape(-1, 2, EYE_H, EYE_W)
        assert len(lab) == len(eyes) == p["records"], p["id"]
        people.append({**p, "lab": lab, "eyes": eyes})
    return people, cols


def head_inputs(lab, cols):
    """The head as the app has it: three angles, and where the face is in the camera's view."""
    yaw, pitch, roll = (lab[:, cols[n]] for n in ("yaw", "pitch", "roll"))
    tz = lab[:, cols["tz"]]
    return np.stack([yaw, pitch, roll, lab[:, cols["tx"]] / tz, lab[:, cols["ty"]] / tz], axis=1)


def samples(p, cols, labels):
    """(rows, target) of the frames this person can teach with."""
    lab = p["lab"]
    ok = (lab[:, cols["usable"]] == 1) & (lab[:, cols["steady"]] == 1) & (lab[:, cols["blink"]] <= BLINK_MAX)
    dot = lab[:, [cols["targetX"], cols["targetY"]]]
    ref = lab[:, [cols["referenceX"], cols["referenceY"]]]
    if labels == "dots":
        y = dot
    elif labels == "reference":
        y = ref
    else:  # the dot or click where the frame has one, the reference eye tracker elsewhere
        y = np.where(np.isfinite(dot), dot, ref)
    y = y / p["distanceMm"]
    ok &= np.isfinite(y).all(axis=1) & (np.abs(y) <= LABEL_MAX).all(axis=1)
    ok &= np.isfinite(head_inputs(lab, cols)).all(axis=1)
    rows = np.nonzero(ok)[0]
    return rows, y[rows].astype(np.float32)


class EyeNet(nn.Module):
    """One eye picture -> 64 numbers. Both eyes go through the same one (the second is mirrored at extraction)."""

    def __init__(self, widths=(16, 32, 48, 64)):
        super().__init__()
        layers = []
        c = 1
        for i, w in enumerate(widths):
            layers += [nn.Conv2d(c, w, 3, padding=1, bias=False), nn.BatchNorm2d(w), nn.ReLU(inplace=True)]
            if i < len(widths) - 1:
                layers.append(nn.MaxPool2d(2))
            c = w
        self.body = nn.Sequential(*layers)
        self.out = c

    def forward(self, x):
        return self.body(x).mean(dim=(2, 3))


class GazeNet(nn.Module):
    def __init__(self, n_extra, hidden=64, dropout=0.2):
        super().__init__()
        self.eye = EyeNet()
        self.head = nn.Sequential(nn.Linear(2 * self.eye.out + n_extra, hidden), nn.ReLU(inplace=True), nn.Dropout(dropout), nn.Linear(hidden, 2))

    def forward(self, eyes, extra):
        # Both eyes in one pass: (first eye's 64 numbers, second eye's 64 numbers) per frame.
        both = self.eye(eyes.reshape(-1, 1, EYE_H, EYE_W)).reshape(eyes.shape[0], -1)
        return self.head(torch.cat([both, extra], dim=1))


def normalize(eyes):
    """Each picture to zero mean and unit contrast: the same eye in a brighter or dimmer room is the same input."""
    x = eyes.float()
    m = x.mean(dim=(2, 3), keepdim=True)
    s = x.std(dim=(2, 3), keepdim=True)
    return (x - m) / (s + 4.0)


def augment(eyes, gen):
    """Small changes a camera makes by itself: gain, gamma, noise, and the crop sitting a pixel or two off."""
    n = eyes.shape[0]
    dev = eyes.device
    x = eyes.float() / 255.0
    gamma = torch.exp(torch.empty(n, 1, 1, 1, device=dev).uniform_(-0.35, 0.35, generator=gen))
    gain = torch.exp(torch.empty(n, 1, 1, 1, device=dev).uniform_(-0.3, 0.3, generator=gen))
    x = (x.clamp(1e-3, 1) ** gamma * gain).clamp(0, 1) * 255.0
    x = x + torch.randn(x.shape, device=dev, generator=gen) * 3.0
    # One small shift, scale and turn per eye picture.
    k = n * 2
    ang = torch.empty(k, device=dev).uniform_(-0.06, 0.06, generator=gen)
    sc = torch.empty(k, device=dev).uniform_(0.94, 1.06, generator=gen)
    tx = torch.empty(k, device=dev).uniform_(-0.07, 0.07, generator=gen)
    ty = torch.empty(k, device=dev).uniform_(-0.09, 0.09, generator=gen)
    theta = torch.stack(
        [torch.stack([sc * torch.cos(ang), -sc * torch.sin(ang) * EYE_H / EYE_W, tx], 1), torch.stack([sc * torch.sin(ang) * EYE_W / EYE_H, sc * torch.cos(ang), ty], 1)], 1
    )
    flat = x.reshape(k, 1, EYE_H, EYE_W)
    grid = F.affine_grid(theta, flat.shape, align_corners=False)
    flat = F.grid_sample(flat, grid, mode="bilinear", padding_mode="border", align_corners=False)
    return flat.reshape(n, 2, EYE_H, EYE_W)


def extras(p, rows, cols, inputs):
    parts = []
    if "head" in inputs:
        parts.append(head_inputs(p["lab"][rows], cols))
    if "tracker" in inputs:
        parts.append(p["lab"][rows][:, [cols["priorX"], cols["priorY"]]])
    if not parts:
        return np.zeros((len(rows), 0), dtype=np.float32)
    return np.concatenate(parts, axis=1).astype(np.float32)


def fit(train_people, cols, args, device, seed, log):
    gen = torch.Generator(device="cpu").manual_seed(seed)
    torch.manual_seed(seed)
    eyes, extra, y = [], [], []
    for p in train_people:
        rows, target = samples(p, cols, args.labels)
        eyes.append(p["eyes"][rows])
        extra.append(extras(p, rows, cols, args.inputs))
        y.append(target)
    eyes = torch.from_numpy(np.concatenate(eyes)).to(device)
    extra = torch.from_numpy(np.concatenate(extra))
    extra = torch.nan_to_num(extra)
    y = torch.from_numpy(np.concatenate(y))
    stats = {
        "extraMean": extra.mean(0).tolist() if extra.shape[1] else [],
        "extraSd": (extra.std(0) + 1e-6).tolist() if extra.shape[1] else [],
        "labelMean": y.mean(0).tolist(),
        "labelSd": y.std(0).tolist(),
    }
    em, es = torch.tensor(stats["extraMean"]), torch.tensor(stats["extraSd"])
    lm, ls = torch.tensor(stats["labelMean"]), torch.tensor(stats["labelSd"])
    extra = ((extra - em) / es if extra.shape[1] else extra).to(device)
    y = ((y - lm) / ls).to(device)

    model = GazeNet(extra.shape[1]).to(device)
    n = len(y)
    steps = args.epochs * math.ceil(n / args.batch)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.15)
    dgen = torch.Generator(device=device).manual_seed(seed) if device != "mps" else None
    for epoch in range(args.epochs):
        model.train()
        order = torch.randperm(n, generator=gen).to(device)
        total = 0.0
        for i in range(0, n, args.batch):
            idx = order[i : i + args.batch]
            x = normalize(augment(eyes[idx], dgen))
            loss = F.smooth_l1_loss(model(x, extra[idx]), y[idx], beta=0.5)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(idx)
        log(f"    epoch {epoch + 1}/{args.epochs}: loss {total / n:.4f}")
    model.eval()
    return model, stats, n


@torch.no_grad()
def answers(model, stats, p, cols, args, device):
    """The network's answer for every frame of a person the app could use (NaN elsewhere)."""
    lab = p["lab"]
    out = np.full((len(lab), 2), np.nan, dtype=np.float32)
    rows = np.nonzero((lab[:, cols["usable"]] == 1) & np.isfinite(head_inputs(lab, cols)).all(axis=1))[0]
    if not len(rows):
        return out
    extra = torch.nan_to_num(torch.from_numpy(extras(p, rows, cols, args.inputs)))
    if extra.shape[1]:
        extra = (extra - torch.tensor(stats["extraMean"])) / torch.tensor(stats["extraSd"])
    lm, ls = torch.tensor(stats["labelMean"]), torch.tensor(stats["labelSd"])
    for i in range(0, len(rows), 2048):
        r = rows[i : i + 2048]
        x = normalize(torch.from_numpy(p["eyes"][r]).to(device))
        pred = model(x, extra[i : i + 2048].to(device)).cpu() * ls + lm
        out[r] = pred.numpy()
    return out


def degrees(pred, y):
    """Angle between the answer and the truth, as seen from the person (both are offsets / distance)."""
    return np.degrees(np.arctan(np.hypot(pred[:, 0] - y[:, 0], pred[:, 1] - y[:, 1])))


def personal(pred_cal, y_cal, pred_test):
    """A scale and an offset per axis from the person's calibration frames, applied to their test frames."""
    out = np.empty_like(pred_test)
    for a in (0, 1):
        k, c = np.polyfit(pred_cal[:, a], y_cal[:, a], 1)
        out[:, a] = k * pred_test[:, a] + c
    return out


def score(p, ans, cols):
    """Held-out error on the person's test frames: as the network says it, and after their own four numbers."""
    lab = p["lab"]
    keep = (lab[:, cols["steady"]] == 1) & (lab[:, cols["blink"]] <= BLINK_MAX) & np.isfinite(ans).all(axis=1)
    cal = keep & (lab[:, cols["role"]] == 1)
    test = keep & (lab[:, cols["role"]] == 2)
    if cal.sum() < 20 or test.sum() < 20:
        return None
    t = lab[:, [cols["targetX"], cols["targetY"]]] / p["distanceMm"]
    raw = degrees(ans[test], t[test])
    fitted = degrees(personal(ans[cal], t[cal], ans[test]), t[test])
    return {"raw": float(raw.mean()), "personal": float(fitted.mean()), "frames": int(test.sum())}


def export(model, stats, args, path):
    """The network as plain numbers, batch normalisation folded into the convolutions, for a forward pass anywhere."""
    convs = []
    mods = list(model.eye.body)
    for i, m in enumerate(mods):
        if isinstance(m, nn.Conv2d):
            bn = mods[i + 1]
            scale = bn.weight / torch.sqrt(bn.running_var + bn.eps)
            w = m.weight * scale[:, None, None, None]
            b = bn.bias - bn.running_mean * scale
            pool = i + 3 < len(mods) and isinstance(mods[i + 3], nn.MaxPool2d)
            convs.append({"in": m.in_channels, "out": m.out_channels, "pool": bool(pool), "w": [round(v, 6) for v in w.detach().cpu().flatten().tolist()], "b": [round(v, 6) for v in b.detach().cpu().tolist()]})
    lin = [m for m in model.head if isinstance(m, nn.Linear)]
    dense = [{"in": m.in_features, "out": m.out_features, "w": [round(v, 6) for v in m.weight.detach().cpu().flatten().tolist()], "b": [round(v, 6) for v in m.bias.detach().cpu().tolist()]} for m in lin]
    doc = {
        "id": f"eye-cnn-eott-{args.inputs}-{args.seed}",
        "eye": {"height": EYE_H, "width": EYE_W, "span": 1.7, "contrastFloor": 4.0},
        "inputs": args.inputs,
        "convs": convs,
        "dense": dense,
        **stats,
    }
    json.dump(doc, open(path, "w"), separators=(",", ":"))
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".data/eott")
    ap.add_argument("--out", default=None, help="where the answers go (default <root>/cnn)")
    ap.add_argument("--inputs", default="eyes+head", choices=["eyes", "eyes+head", "eyes+head+tracker"])
    ap.add_argument("--labels", default="both", choices=["both", "dots", "reference"])
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=14)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--seed", type=int, default=20261123)
    ap.add_argument("--final", action="store_true", help="also train one network on everyone and write its weights")
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    args = ap.parse_args()
    out = args.out or os.path.join(args.root, "cnn")
    os.makedirs(out, exist_ok=True)
    lines = []

    def log(s):
        print(s, flush=True)
        lines.append(s)

    people, cols = load(args.root)
    # Who may teach: anyone whose light did not change between their calibration and their test.
    teach = [p for p in people if p["sameLight"] is not False and len(samples(p, cols, args.labels)[0]) >= 100]
    barred = [p["id"] for p in people if p["sameLight"] is False]
    order = np.random.default_rng(args.seed).permutation(len(people))
    fold_of = {people[i]["id"]: k % args.folds for k, i in enumerate(order)}
    log(f"{len(people)} people; {len(teach)} may teach ({sum(len(samples(p, cols, args.labels)[0]) for p in teach)} frames); never trained on, light changed: {', '.join(barred) or 'nobody'}")
    log(f"inputs {args.inputs}; labels {args.labels}; {args.folds} folds; {args.epochs} epochs; device {args.device}")

    report = {"args": vars(args), "people": {}, "folds": []}
    t0 = time.time()
    for k in range(args.folds):
        train = [p for p in teach if fold_of[p["id"]] != k]
        held = [p for p in people if fold_of[p["id"]] == k]
        log(f"fold {k + 1}/{args.folds}: train on {len(train)} people, answer for {len(held)}")
        model, stats, n = fit(train, cols, args, args.device, args.seed + k, log)
        for p in held:
            ans = answers(model, stats, p, cols, args, args.device)
            ans.tofile(os.path.join(out, p["id"] + ".f32"))
            s = score(p, ans, cols)
            report["people"][p["id"]] = {"fold": k, "setting": p["setting"], "sameLight": p["sameLight"], **(s or {})}
        got = [report["people"][p["id"]] for p in held if "raw" in report["people"][p["id"]]]
        if got:
            log(f"  held out: {np.mean([g['raw'] for g in got]):.2f} deg as the network says it, {np.mean([g['personal'] for g in got]):.2f} deg after each person's four numbers ({len(got)} people)")
        report["folds"].append({"fold": k, "trainPeople": len(train), "trainFrames": n})
    same = [v for v in report["people"].values() if "raw" in v and v["sameLight"]]
    log(f"ALL FOLDS, same light ({len(same)} people): {np.mean([v['raw'] for v in same]):.2f} deg raw, {np.mean([v['personal'] for v in same]):.2f} deg after four personal numbers  [{time.time() - t0:.0f} s]")
    report["sameLight"] = {"people": len(same), "raw": float(np.mean([v["raw"] for v in same])), "personal": float(np.mean([v["personal"] for v in same]))}

    if args.final:
        log(f"final: one network on all {len(teach)} people who may teach")
        model, stats, n = fit(teach, cols, args, args.device, args.seed + 1000, log)
        size = export(model.cpu(), stats, args, os.path.join(out, "weights.json"))
        # One frame and the answer to it, so another implementation of the forward pass can be checked against this one.
        p = teach[0]
        rows, _ = samples(p, cols, args.labels)
        r = rows[:8]
        ans = answers(model, stats, p, cols, args, "cpu")[r]
        json.dump(
            {"eyes": p["eyes"][r].reshape(len(r), -1).tolist(), "extra": extras(p, r, cols, args.inputs).tolist(), "answer": ans.tolist()},
            open(os.path.join(out, "check.json"), "w"),
            separators=(",", ":"),
        )
        log(f"  weights: {size / 1024:.0f} kB, {sum(q.numel() for q in model.parameters())} numbers -> {os.path.join(out, 'weights.json')}")
    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=1)
    open(os.path.join(out, "train.log"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
