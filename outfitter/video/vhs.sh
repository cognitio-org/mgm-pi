#!/usr/bin/env bash
# The "1990 corporate VHS tape" finishing pass. Takes any clip (a Veo shot, a Playwright screen
# recording) and makes it 4:3, soft, slightly smeary in chroma, noisy, and optionally graded with a
# LUT from match-grade.py. Apply it to *every* shot so AI footage and real UI footage sit together.
#
# Usage: ./vhs.sh <in> <out.mp4> [grade.cube]
#   env: VHS_NOISE (default 10), VHS_FILL=crop|pad (default crop: center-crop 16:9 to 4:3)
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deps.sh"

IN="${1:?usage: vhs.sh <in> <out.mp4> [grade.cube]}"
OUT="${2:?usage: vhs.sh <in> <out.mp4> [grade.cube]}"
LUT="${3:-}"
NOISE="${VHS_NOISE:-10}"
FILL="${VHS_FILL:-crop}"

if [ "$FILL" = pad ]; then
  FIT="scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2"
else
  FIT="scale=640:480:force_original_aspect_ratio=increase,crop=640:480"
fi

GRADE=""
[ -n "$LUT" ] && GRADE="lut3d='$LUT',"

# 1. fit to 4:3 at roughly VHS luma resolution (~330 lines -> 360 tall), then back up: softness
# 2. grade, then lift blacks / crush highlights a touch, mute saturation
# 3. chroma smear: shrink chroma to ~1/4 width and blur it, shift it right a couple of pixels
# 4. grain (temporal), slight sharpening halo typical of consumer decks, 29.97 interlaced feel
VF="${FIT},fps=30000/1001,\
scale=480:360:flags=bilinear,scale=640:480:flags=bicubic,\
${GRADE}\
eq=contrast=0.92:brightness=0.02:saturation=0.85:gamma=1.05,\
format=yuv444p,\
split[l][c];\
[c]scale=160:480,boxblur=luma_radius=0:chroma_radius=2,scale=640:480,chromashift=cbh=2:crh=3[cs];\
[l][cs]mergeplanes=0x001112:yuv444p,\
noise=alls=${NOISE}:allf=t,\
unsharp=5:5:0.6:5:5:0,\
scale=1440:1080:flags=neighbor,\
format=yuv420p"

ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -filter_complex "[0:v]${VF}[v]" -map "[v]" -map "0:a?" \
  -c:v libx264 -crf 18 -preset medium \
  -c:a aac -b:a 128k -af "highpass=f=80,lowpass=f=10000" \
  "$OUT"
echo "wrote $OUT"
