#!/usr/bin/env bash
# Writes a letter writer's signature onto a clip, the way the reference's punchline shot does:
# white cursive with a purple/chrome outline, revealed left to right at the lower right while the
# thumb is up. Run it BEFORE vhs.sh so the signature degrades with the tape like the picture.
#
# Usage: ./signature.sh <in> <out.mp4> "<name>" [start-seconds] [write-seconds]
#   start: when the pen starts (default 4.0); write: how long the stroke takes (default 1.4)
#   env:   SIG_SIZE (font px at 1080p, default 180), SIG_X / SIG_Y (top-left, default lower right of the 4:3 crop),
#          SIG_FONT (default fonts/Sacramento-Regular.ttf, SIL OFL -- see fonts/OFL-Sacramento.txt)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NEED_PYTHON=1
. "$HERE/deps.sh"

IN="${1:?usage: signature.sh <in> <out.mp4> \"<name>\" [start] [write-seconds]}"
OUT="${2:?usage: signature.sh <in> <out.mp4> \"<name>\" [start] [write-seconds]}"
NAME="${3:?usage: signature.sh <in> <out.mp4> \"<name>\" [start] [write-seconds]}"
START="${4:-4.0}"
WRITE="${5:-1.4}"
FONT="${SIG_FONT:-$HERE/fonts/Sacramento-Regular.ttf}"

IFS=x read -r W H < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$IN")
SCALE=$(awk -v h="$H" 'BEGIN{print h/1080}')
SIZE=$(awk -v s="${SIG_SIZE:-180}" -v k="$SCALE" 'BEGIN{printf "%d", s*k}')
# The name is drawn with Pillow (Homebrew's ffmpeg has no drawtext/freetype): white fill, a
# purple outer stroke and a pale inner stroke, like the reference's chrome-tube lettering.
SIGPNG="${TMPDIR:-/tmp}/signature-$$.png"; trap 'rm -f "$SIGPNG"' EXIT
read -r BOXW BOXH < <("$PYTHON" - "$FONT" "$SIZE" "$NAME" "$SCALE" "$SIGPNG" <<'EOF'
import sys
from PIL import Image, ImageDraw, ImageFont
font_path, size, name, scale, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], float(sys.argv[4]), sys.argv[5]
font = ImageFont.truetype(font_path, size)
outer, inner = int(7 * scale) + 1, int(3 * scale) + 1
l, t, r, b = font.getbbox(name, stroke_width=outer)
pad = size // 6
w, h = (r - l) + 2 * pad, (b - t) + 2 * pad
img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
xy = (pad - l, pad - t)
d.text(xy, name, font=font, fill=(255, 255, 255, 255), stroke_width=outer, stroke_fill=(90, 58, 138, 255))
d.text(xy, name, font=font, fill=(255, 255, 255, 255), stroke_width=inner, stroke_fill=(216, 208, 240, 255))
img.save(out)
print(w, h)
EOF
)
# Place it inside the centre 4:3 area, since vhs.sh crops 16:9 down to 4:3 afterwards.
VISW=$(( W * 3 > H * 4 ? H * 4 / 3 : W ))
RIGHT=$(( (W + VISW) / 2 ))
X="${SIG_X:-$(( RIGHT - BOXW - VISW / 14 ))}"
Y="${SIG_Y:-$(( H - BOXH - H / 12 ))}"

# Reveal left to right: the PNG's alpha is cut at a line that sweeps across it over WRITE seconds.
ffmpeg -hide_banner -loglevel error -y -i "$IN" -loop 1 -framerate 30000/1001 -i "$SIGPNG" -filter_complex "
[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*lte(X, W*clip((T-$START)/$WRITE,0,1))'[sig];
[0:v][sig]overlay=x=$X:y=$Y:shortest=1:enable='gte(t,$START)',format=yuv420p[v]" \
  -map "[v]" -map "0:a?" -c:v libx264 -crf 16 -preset medium -c:a copy "$OUT"
echo "wrote $OUT ($NAME at ${START}s)"
