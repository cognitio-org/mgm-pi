#!/usr/bin/env python3
"""Builds a color-grade LUT (.cube) that makes our footage look like a set of reference frames.

Per-channel histogram matching (each of R, G, B gets a tone curve mapping our CDF onto the
reference CDF), plus a saturation match, baked into a 3D LUT that ffmpeg's lut3d filter (and
Resolve, Premiere, etc.) can apply. Only *statistics* of the reference frames end up in the LUT --
no pixels -- so it is safe to commit and share.

Usage:
  $(brew --prefix)/bin/python3 match-grade.py --ref reference/pick-*.png --src ours/frame-*.png [--out grade.cube]
  ffmpeg -i ours.mp4 -vf lut3d=grade.cube graded.mp4

  --src: stills from *our* footage (a Veo clip, a screen recording) -- e.g.
         ffmpeg -i clip.mp4 -vf fps=1 ours/frame-%04d.png
  --strength 0..1 blends the curves toward identity (default 1.0).

Requires numpy and Pillow: brew install numpy pillow (then use Homebrew's python3).
"""
import argparse
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("numpy/Pillow missing. Install with: brew install numpy pillow\n"
             "then run with Homebrew's Python: $(brew --prefix)/bin/python3 " + sys.argv[0])

SAMPLE_PX = 200_000  # pixels sampled per image set; plenty for stable CDFs


def load_pixels(paths, rng):
    chunks = []
    for p in paths:
        img = Image.open(p).convert("RGB")
        img.thumbnail((640, 640))
        chunks.append(np.asarray(img, dtype=np.float32).reshape(-1, 3) / 255.0)
    if not chunks:
        sys.exit("no images given")
    px = np.concatenate(chunks)
    if len(px) > SAMPLE_PX:
        px = px[rng.choice(len(px), SAMPLE_PX, replace=False)]
    return px


def channel_curve(src, ref, bins=256):
    """Tone curve f (sampled at `bins` points over 0..1) with CDF_ref(f(x)) ~= CDF_src(x)."""
    xs = np.linspace(0, 1, bins)
    src_cdf = np.searchsorted(np.sort(src), xs, side="right") / len(src)
    return np.quantile(ref, np.clip(src_cdf, 0, 1))


def saturation(px):
    return float(np.mean(px.max(axis=1) - px.min(axis=1)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", nargs="+", required=True, help="reference frames (the look to match)")
    ap.add_argument("--src", nargs="+", required=True, help="stills from our footage")
    ap.add_argument("--out", default="grade.cube")
    ap.add_argument("--size", type=int, default=33, help="LUT cube size (default 33)")
    ap.add_argument("--strength", type=float, default=1.0)
    args = ap.parse_args()

    rng = np.random.default_rng(0)
    ref = load_pixels(args.ref, rng)
    src = load_pixels(args.src, rng)

    xs = np.linspace(0, 1, 256)
    curves = [channel_curve(src[:, c], ref[:, c]) for c in range(3)]
    curves = [args.strength * cv + (1 - args.strength) * xs for cv in curves]

    def apply_curves(px):
        return np.stack([np.interp(px[:, c], xs, curves[c]) for c in range(3)], axis=1)

    # Saturation: after the curves, scale chroma around luma so mean saturation matches the ref.
    graded = apply_curves(src)
    sat_gain = saturation(ref) / max(saturation(graded), 1e-6)
    sat_gain = 1 + args.strength * (np.clip(sat_gain, 0.3, 2.0) - 1)

    n = args.size
    g = np.linspace(0, 1, n)
    # .cube order: red varies fastest, then green, then blue.
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    grid = np.stack([r.ravel(), gg.ravel(), b.ravel()], axis=1)
    out = apply_curves(grid)
    luma = out @ np.array([0.299, 0.587, 0.114])
    out = np.clip(luma[:, None] + (out - luma[:, None]) * sat_gain, 0, 1)

    with open(args.out, "w") as f:
        f.write(f'TITLE "match-grade"\nLUT_3D_SIZE {n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for row in out:
            f.write(f"{row[0]:.6f} {row[1]:.6f} {row[2]:.6f}\n")

    print(f"wrote {args.out} ({n}^3), saturation gain {sat_gain:.2f}")
    for name, c in zip("RGB", range(3)):
        print(f"  {name}: mean ref {ref[:, c].mean():.3f}  ours {src[:, c].mean():.3f}")


if __name__ == "__main__":
    main()
