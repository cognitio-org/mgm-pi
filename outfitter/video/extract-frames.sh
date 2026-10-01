#!/usr/bin/env bash
# Pulls clean reference frames out of a source video for *look* reference only (color, grain,
# light, framing). Run it on the machine that has the video; output lands in video/reference/,
# which is gitignored -- third-party frames never get committed, and never get cut into the video.
#
# Usage: ./extract-frames.sh <video> [out-dir]
#   env: COUNT (frames to keep, default 24), DESCAN=0 to skip the line filter
#
# Writes <out-dir>/pick-MMmSS.Ss.png (the chosen frames, named by timestamp) and
# <out-dir>/contact-sheet.png. The dense dump it chose from stays in <out-dir>/all/.
#
# Cleanup applied to every frame:
#   - deinterlace (bwdif; a no-op on progressive sources)
#   - DESCAN: kills a baked-in 4px horizontal line pattern (what an interlaced SD tape upscaled
#     to 720p without deinterlacing looks like -- common on YouTube copies). A [1 2 2 2 1]/8
#     vertical kernel has a zero exactly at that period and only mildly softens the rest.
# Selection (pick-frames.py) favors held, sharp frames over cross-dissolves and double exposures.
#
# Then: delete or crop any frame that shows a face up close -- keep set, light, screen glow, wides.
set -euo pipefail

SRC="${1:?usage: extract-frames.sh <video> [out-dir]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-$HERE/reference}"
COUNT="${COUNT:-24}"
NEED_PYTHON=1
. "$HERE/deps.sh"
FPS=4

CLEAN="bwdif=mode=send_frame:deint=interlaced"
if [ "${DESCAN:-1}" != 0 ]; then
  CLEAN="$CLEAN,format=gbrp,convolution=0m='1 2 2 2 1':1m='1 2 2 2 1':2m='1 2 2 2 1':0rdiv=1/8:1rdiv=1/8:2rdiv=1/8:0mode=column:1mode=column:2mode=column"
fi

rm -rf "$OUT/all"
mkdir -p "$OUT/all"
ffmpeg -hide_banner -loglevel error -y -i "$SRC" -vf "$CLEAN,fps=$FPS" "$OUT/all/frame-%05d.png"

"$PYTHON" "$HERE/pick-frames.py" "$OUT/all" "$OUT" --fps "$FPS" --count "$COUNT"

ffmpeg -hide_banner -loglevel error -y -pattern_type glob -i "$OUT/pick-*.png" \
  -vf "scale=320:-2,tile=6x4:padding=4:color=black" -frames:v 1 "$OUT/contact-sheet.png"
echo "contact sheet: $OUT/contact-sheet.png"
