#!/usr/bin/env python3
"""Picks the cleanest reference frames out of a dense frame dump.

Promo videos of this era are mostly cross-dissolves and double exposures, so "the picture changed a
lot" (ffmpeg scene detection) lands mid-transition. Instead, score every frame on
  - stability: how little it differs from the frames around it (a dissolve keeps changing; a held
    shot doesn't), and
  - sharpness: variance of a Laplacian (dissolves and motion blur are soft),
then greedily keep the best frames, at least --gap seconds apart and not near-duplicates of a frame
already kept.

Usage: $(brew --prefix)/bin/python3 pick-frames.py <frames-dir> <out-dir> [--fps 4] [--count 24] [--gap 1.5]
  <frames-dir> holds frame-%05d.png sampled at --fps (extract-frames.sh writes these).
"""
import argparse
import sys
import shutil
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("numpy/Pillow missing. Install with: brew install numpy pillow\n"
             "then run with Homebrew's Python: $(brew --prefix)/bin/python3 " + sys.argv[0])


def load_small(path):
    img = Image.open(path).convert("L")
    img.thumbnail((256, 256))
    return np.asarray(img, dtype=np.float32) / 255.0


def sharpness(g):
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def histogram(g):
    h, _ = np.histogram(g, bins=32, range=(0, 1))
    return h / max(h.sum(), 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--fps", type=float, default=4)
    ap.add_argument("--count", type=int, default=24)
    ap.add_argument("--gap", type=float, default=1.5, help="minimum seconds between picks")
    args = ap.parse_args()

    paths = sorted(Path(args.frames_dir).glob("frame-*.png"))
    if len(paths) < 3:
        raise SystemExit(f"need at least 3 frames in {args.frames_dir}")
    frames = [load_small(p) for p in paths]

    # Mean abs difference to each neighbor; a frame is only as stable as its worse side.
    diffs = np.array([np.abs(a - b).mean() for a, b in zip(frames, frames[1:])])
    instability = np.maximum(np.r_[diffs[0], diffs], np.r_[diffs, diffs[-1]])
    # Smooth over +-2 samples so a single quiet frame inside a dissolve doesn't win.
    instability = np.convolve(instability, np.ones(5) / 5, mode="same")
    sharp = np.array([sharpness(f) for f in frames])

    def rank(x):
        return np.argsort(np.argsort(x)) / (len(x) - 1)

    score = (1 - rank(instability)) * 0.65 + rank(sharp) * 0.35
    hists = [histogram(f) for f in frames]

    picked = []
    min_gap = args.gap * args.fps
    for i in np.argsort(-score):
        if len(picked) >= args.count:
            break
        if any(abs(i - j) < min_gap for j in picked):
            continue
        if any(np.abs(hists[i] - hists[j]).sum() < 0.08 for j in picked):  # near-duplicate look
            continue
        picked.append(int(i))

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("pick-*.png"):
        old.unlink()
    for i in sorted(picked):
        t = i / args.fps
        shutil.copy(paths[i], out / f"pick-{int(t // 60):02d}m{t % 60:04.1f}s.png")
    print(f"picked {len(picked)} of {len(paths)} frames into {out}")


if __name__ == "__main__":
    main()
