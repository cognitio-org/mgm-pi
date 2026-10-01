#!/usr/bin/env bash
# The "1990 corporate VHS tape" finishing pass. Takes any clip (a Veo shot, a Playwright screen
# recording) and makes it 4:3, soft, slightly smeary in chroma, noisy, and optionally graded with a
# LUT from match-grade.py. Apply it to *every* shot so AI footage and real UI footage sit together.
#
# On top of the softness it plays back like a worn tape: interlaced scanlines, a wobbling timebase,
# the head-switching noise band along the bottom edge, dropout specks, and every few seconds a short
# tracking glitch (a torn, shifted, brighter band rolling through the picture).
#
# Usage: ./vhs.sh <in> <out.mp4> [grade.cube]
#   env: VHS_NOISE      grain (default 9)
#        VHS_GLITCH     share of quarter-seconds with a tracking glitch, 0-1 (default 0.07; 0 = none)
#        VHS_LINES      scanline darkness, 0-1 (default 0.28; 0 = none)
#        VHS_SIZE       output size (default 1280:960, 2 pixels per tape line so the scanlines stay crisp)
#        VHS_FILL=crop|pad (default crop: center-crop 16:9 to 4:3)
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deps.sh"

IN="${1:?usage: vhs.sh <in> <out.mp4> [grade.cube]}"
OUT="${2:?usage: vhs.sh <in> <out.mp4> [grade.cube]}"
LUT="${3:-}"
NOISE="${VHS_NOISE:-9}"
GLITCH="${VHS_GLITCH:-0.07}"
LINES="${VHS_LINES:-0.28}"
SIZE="${VHS_SIZE:-1280:960}"
FILL="${VHS_FILL:-crop}"

if [ "$FILL" = pad ]; then
  FIT="scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2"
else
  FIT="scale=640:480:force_original_aspect_ratio=increase,crop=640:480"
fi

GRADE=""
[ -n "$LUT" ] && GRADE="lut3d='$LUT',"

# Tape transport (X, Y, T = position and time; 640x480 tape lines). Always on, cheap per pixel:
#   WOB   timebase wobble + a small odd/even field offset
#   HEAD  the bottom 7 lines, where the video heads switch: torn sideways and brighter
#   DROP  dropouts: now and then a short white streak on one line
# A tracking glitch (a torn, shifted, brighter band rolling up the picture, the frame jumping) is a
# second pass switched on only for its frames: quarter-second slots picked by a hash of the time,
# VHS_GLITCH of them.
WOB="(0.9*sin(Y/38+T*2.3)+0.6*mod(Y,2)*sin(T*9))"
HEADX="(12+(Y-473)*5+6*sin(T*50))"
R='(st(1,sin(Y*78.233+floor(T*30)*12.9898)*43758.5453);ld(1)-floor(ld(1)))'
DROP="if(gt($R,0.9985),170*between(X,mod(ld(1)*9973,640),mod(ld(1)*9973,640)+18+mod(ld(1)*313,40)),0)"
TAPE="geq=lum='if(gte(Y,473),clip(lum(X+$HEADX,Y)+25,0,255),clip(lum(X+$WOB,Y)+$DROP,0,255))'\
:cb='cb(X+if(gte(Y,473),$HEADX,$WOB)+2,Y)':cr='cr(X+if(gte(Y,473),$HEADX,$WOB)+3,Y)'"
GATE="gt(st(0,sin(floor(t*4)*12.9898+3.1)*43758.5453)*0+ld(0)-floor(ld(0)),1-$GLITCH)"
BAND="between(mod(Y+T*420,600),0,46)"
TEAR="if($BAND,18+14*sin(Y*0.9+T*70),0)+3*sin(T*41)"
TRACK="geq=lum='clip(lum(X+$TEAR,Y+1.5*sin(T*33))+40*$BAND,0,255)'\
:cb='cb(X+$TEAR,Y+1.5*sin(T*33))':cr='cr(X+$TEAR,Y+1.5*sin(T*33))':enable='$GATE'"
[ "$GLITCH" = 0 ] && TRACK="null"

# 1. fit to 4:3 at roughly VHS luma resolution (~330 lines -> 360 tall), then back up: softness
# 2. grade, then lift blacks / crush highlights a touch, mute saturation
# 3. chroma smear: shrink chroma to ~1/4 width and blur it
# 4. the tape transport above, then grain and the slight sharpening halo of consumer decks
# 5. double the height line for line and darken every other line: the interlaced scanlines
VF="${FIT},fps=30000/1001,\
scale=480:360:flags=bilinear,scale=640:480:flags=bicubic,\
${GRADE}\
eq=contrast=0.92:brightness=0.02:saturation=0.85:gamma=1.05,\
format=yuv444p,\
split[l][c];\
[c]scale=160:480,boxblur=luma_radius=0:chroma_radius=2,scale=640:480[cs];\
[l][cs]mergeplanes=0x001112:yuv444p,\
${TAPE},\
${TRACK},\
noise=alls=${NOISE}:allf=t,\
unsharp=5:5:0.7:5:5:0,\
split[f][p];[f]scale=640:960:flags=neighbor[full];[p]tinterlace=mode=pad[pad];\
[full][pad]blend=all_mode=normal:all_opacity=${LINES},\
scale=${SIZE}:flags=neighbor,\
format=yuv420p"

ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -filter_complex "[0:v]${VF}[v]" -map "[v]" -map "0:a?" \
  -c:v libx264 -crf 23 -preset medium -x264-params aq-mode=3 \
  -c:a aac -b:a 128k -af "highpass=f=80,lowpass=f=10000" \
  "$OUT"
echo "wrote $OUT"
