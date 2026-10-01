#!/usr/bin/env bash
# Pulls reference frames out of a source video for *look* reference only (color, grain, light,
# framing). Run it on the machine that has the video; the output lands in video/reference/, which is
# gitignored -- third-party frames never get committed, and never get cut into the final video.
#
# Usage: ./extract-frames.sh <video> [out-dir]
#   Writes <out-dir>/scene-XXXX.png at every shot change, <out-dir>/sec-XXXX.png once per second,
#   and <out-dir>/contact-sheet.png (a 6-wide grid of the scene frames) for picking favorites.
#
# Then: delete or crop any frame that shows a face up close -- keep set, light, screen glow, wides.
set -euo pipefail

SRC="${1:?usage: extract-frames.sh <video> [out-dir]}"
OUT="${2:-$(dirname "$0")/reference}"
mkdir -p "$OUT"

# One frame per shot change (scene score > 0.3), plus the very first frame.
ffmpeg -hide_banner -loglevel error -y -i "$SRC" \
  -vf "select='eq(n\,0)+gt(scene\,0.3)',setpts=N/TB" -fps_mode vfr "$OUT/scene-%04d.png"

# One frame per second, for picking an exact moment.
ffmpeg -hide_banner -loglevel error -y -i "$SRC" -vf "fps=1" "$OUT/sec-%04d.png"

# Contact sheet of the scene frames.
ffmpeg -hide_banner -loglevel error -y -pattern_type glob -i "$OUT/scene-*.png" \
  -vf "scale=320:-2,tile=6x8:padding=4:color=black" -frames:v 1 "$OUT/contact-sheet.png"

echo "frames in $OUT: $(ls "$OUT"/scene-*.png | wc -l) scene, $(ls "$OUT"/sec-*.png | wc -l) per-second"
echo "contact sheet: $OUT/contact-sheet.png"
