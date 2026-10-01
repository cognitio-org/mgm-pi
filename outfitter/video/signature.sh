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
OUTER_PAD=$(awk -v k="$SCALE" 'BEGIN{printf "%d", 8*k+1}')
# The text layer is a box sized to the name (measured with the font itself); the reveal sweeps it.
TEXTW=$("$PYTHON" -c 'import sys; from PIL import ImageFont
f = ImageFont.truetype(sys.argv[1], int(sys.argv[2])); l, t, r, b = f.getbbox(sys.argv[3]); print(r)' "$FONT" "$SIZE" "$NAME")
BOXW=$(( TEXTW + SIZE / 2 + 2 * OUTER_PAD ))
BOXH=$(awk -v s="$SIZE" 'BEGIN{printf "%d", s*1.6}')
# Place it inside the centre 4:3 area, since vhs.sh crops 16:9 down to 4:3 afterwards.
VISW=$(( W * 3 > H * 4 ? H * 4 / 3 : W ))
RIGHT=$(( (W + VISW) / 2 ))
X="${SIG_X:-$(( RIGHT - BOXW - VISW / 14 ))}"
Y="${SIG_Y:-$(( H - BOXH - H / 14 ))}"
OUTER=$(awk -v k="$SCALE" 'BEGIN{printf "%d", 7*k+1}')
INNER=$(awk -v k="$SCALE" 'BEGIN{printf "%d", 3*k+1}')
# The name goes through a file, so apostrophes, colons and accents need no escaping.
TXT="$(mktemp)"; trap 'rm -f "$TXT"' EXIT
printf '%s' "$NAME" > "$TXT"

ffmpeg -hide_banner -loglevel error -y -i "$IN" -filter_complex "
color=c=black@0.0:s=${BOXW}x${BOXH}:r=30000/1001,format=rgba,
drawtext=fontfile='$FONT':textfile='$TXT':fontsize=$SIZE:x=$((SIZE/4)):y=$((SIZE/8)):fontcolor=white:borderw=$OUTER:bordercolor=0x5a3a8a,
drawtext=fontfile='$FONT':textfile='$TXT':fontsize=$SIZE:x=$((SIZE/4)):y=$((SIZE/8)):fontcolor=white:borderw=$INNER:bordercolor=0xd8d0f0,
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*lte(X, W*clip((T-$START)/$WRITE,0,1))'[sig];
[0:v][sig]overlay=x=$X:y=$Y:shortest=1:enable='gte(t,$START)',format=yuv420p[v]" \
  -map "[v]" -map "0:a?" -c:v libx264 -crf 16 -preset medium -c:a copy "$OUT"
echo "wrote $OUT ($NAME at ${START}s)"
