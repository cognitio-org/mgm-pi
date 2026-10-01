#!/usr/bin/env bash
# Makes the website copies of the finished cut for the little TV on kernal.one (landing/tv.js):
#   dear-sysop.mp4          the big set, with sound: 960x720, ~12-15 MB
#   dear-sysop-preview.mp4  the little TV: 480x360, no sound, ~4 MB
#   dear-sysop.jpg          the still shown before (or instead of) the preview
# into ../landing/public/video/. Both videos start playing before they finish downloading
# (+faststart). Commit the three files and the next release puts them on the site.
#
# Usage: ./web.sh [cut.mp4] [poster-seconds]   (defaults: out/dear-sysop.mp4, 1.8 = the logo)
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deps.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
IN="${1:-$HERE/out/dear-sysop.mp4}"
AT="${2:-1.8}"
DEST="$HERE/../landing/public/video"
[ -f "$IN" ] || { echo "no $IN -- run: uv run assemble.py" >&2; exit 1; }
mkdir -p "$DEST"

ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -vf "scale=960:720:flags=area,format=yuv420p" -c:v libx264 -crf 25 -preset slow -profile:v high \
  -c:a aac -b:a 128k -movflags +faststart "$DEST/dear-sysop.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -vf "scale=480:360:flags=area,format=yuv420p" -c:v libx264 -crf 29 -preset slow -profile:v main \
  -an -movflags +faststart "$DEST/dear-sysop-preview.mp4"
ffmpeg -hide_banner -loglevel error -y -ss "$AT" -i "$IN" -frames:v 1 \
  -vf "scale=640:480:flags=area" -q:v 4 "$DEST/dear-sysop.jpg"

ls -lh "$DEST"
echo "now: git add ${DEST#"$HERE/"} && git commit -m 'kernal.one: Dear Sysop video' && git push"
