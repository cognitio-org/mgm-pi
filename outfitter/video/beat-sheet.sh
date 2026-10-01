#!/usr/bin/env bash
# Turns a reference video into a beat sheet: every shot (start/end), the words spoken over it, the
# on-screen text, how loud the music is, the overall tempo, and a still from each shot's middle --
# the flow of the original, to rewrite beat by beat for our version.
# Output lands in <out-dir> (default video/reference/, gitignored): beat-sheet.md, transcript.srt,
# shots/shot-NNN.png. It's a private reference; don't commit it or publish the transcript.
#
# Usage: ./beat-sheet.sh <video> [out-dir]
#   env: CUT (how different two frames 1 s apart must be to count as a new shot, 0-1, default
#        0.08; lower finds more shots), 
#        WHISPER_MODEL (default reference/ggml-base.en.bin, downloaded on first run)
# Needs: brew install ffmpeg whisper-cpp numpy; optional: brew install tesseract (on-screen text --
# a rough hint on soft VHS footage; read the stills for the real wording)
set -euo pipefail

SRC="${1:?usage: beat-sheet.sh <video> [out-dir]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-$HERE/reference}"
CUT="${CUT:-0.08}"
MODEL="${WHISPER_MODEL:-$HERE/reference/ggml-base.en.bin}"
NEED_PYTHON=1
. "$HERE/deps.sh"

WHISPER="$(command -v whisper-cli || command -v whisper-cpp || true)"
if [ -z "$WHISPER" ]; then
  echo "whisper.cpp not found. Install with: brew install whisper-cpp" >&2
  exit 1
fi
mkdir -p "$OUT/shots" "$(dirname "$MODEL")"
if [ ! -f "$MODEL" ]; then
  echo "downloading whisper model to $MODEL (~150 MB, once)"
  curl -fL -o "$MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
fi

# 1. transcript (whisper.cpp wants 16 kHz mono WAV)
rm -f "$OUT/transcript.srt" "$OUT/audio.raw"
if [ -n "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$SRC")" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$SRC" -vn -ac 1 -ar 16000 "$OUT/audio.wav"
  "$WHISPER" -m "$MODEL" -f "$OUT/audio.wav" -osrt -of "$OUT/transcript" >/dev/null 2>&1
  rm -f "$OUT/audio.wav"
  # mono 11 kHz PCM for tempo and per-shot loudness
  ffmpeg -hide_banner -loglevel error -y -i "$SRC" -vn -ac 1 -ar 11025 -f s16le "$OUT/audio.raw"
else
  echo "no audio track: beat sheet will have shots only" >&2
fi

# 2. tiny grey frames at 4 fps for shot detection. Compares frames 1 s apart rather than
#    neighbours, so slow dissolves register as clearly as hard cuts.
ffmpeg -hide_banner -loglevel error -y -i "$SRC" -vf "fps=4,scale=64:48,format=gray" -f rawvideo "$OUT/frames.raw"
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")"

# 3. merge into beat-sheet.md, grabbing a mid-shot still for each
"$PYTHON" - "$OUT" "$DURATION" "$CUT" > "$OUT/shots.tsv" <<'EOF'
import sys
from pathlib import Path
import numpy as np
out, duration, cut = Path(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
FPS, GAP = 4, 4                     # 4 fps samples; compare frames GAP samples (1 s) apart
f = np.fromfile(out / "frames.raw", dtype=np.uint8).astype(np.float32) / 255
f = f[: len(f) // (64 * 48) * 64 * 48].reshape(-1, 48, 64)
d = np.array([np.abs(f[i + GAP] - f[i]).mean() for i in range(len(f) - GAP)])
thr = max(cut, 2 * float(np.percentile(d, 20))) if len(d) else 1  # 20th pct ~ the quiet floor
bounds = [0.0]
for i in range(len(d)):             # local maxima above threshold, at least 1 s apart
    if d[i] >= thr and d[i] == d[max(0, i - GAP):i + GAP + 1].max():
        t = (i + GAP / 2) / FPS     # centre of the 1 s window
        if t - bounds[-1] >= 1.0 and duration - t >= 0.5:
            bounds.append(t)
bounds.append(duration)

def secs(t):
    h, m, s = t.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)

lines = []
srt = (out / "transcript.srt").read_text(errors="replace") if (out / "transcript.srt").exists() else ""
for block in srt.strip().split("\n\n"):
    parts = block.strip().splitlines()
    if len(parts) >= 3 and "-->" in parts[1]:
        a, b = (secs(x.strip()) for x in parts[1].split("-->"))
        lines.append((a, b, " ".join(parts[2:]).strip()))

# Music: per-shot loudness (dBFS) and one tempo estimate from onset autocorrelation.
SR, HOP = 11025, 256
audio = out / "audio.raw"
x = np.fromfile(audio, dtype=np.int16).astype(np.float32) / 32768 if audio.exists() else np.zeros(0)

def loudness(a, b):
    seg = x[int(a * SR):int(b * SR)]
    return f"{20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9):.0f} dB" if len(seg) else ""

tempo = "n/a"
if len(x) > SR * 8:
    n = len(x) // HOP
    env = np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(1))
    onset = np.maximum(np.diff(np.log(env + 1e-4)), 0)
    k = np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2)                 # smooth ~50 ms so beats that
    onset = np.convolve(onset, k / k.sum(), mode="same")             # straddle frames still line up
    onset -= onset.mean()
    ac = np.correlate(onset, onset, "full")[len(onset) - 1:]
    fps = SR / HOP
    lags = np.arange(int(fps * 60 / 200), int(fps * 60 / 50) + 1)   # 50-200 BPM
    cand = 60 * fps / lags
    prior = np.exp(-0.5 * (np.log2(cand / 120) / 0.9) ** 2)           # favour ~120 BPM over its
    j = int(np.argmax(ac[lags] * prior))                              # half/double, as beat trackers do
    L = float(lags[j])
    if 0 < j < len(lags) - 1:                                         # parabolic peak: sub-frame lag
        y0, y1, y2 = ac[lags[j] - 1], ac[lags[j]], ac[lags[j] + 1]
        if y0 - 2 * y1 + y2 < 0:
            L += 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
    bpm = 60 * fps / L
    tempo = f"~{bpm:.0f} BPM (could be half/double: {bpm / 2:.0f} / {bpm * 2:.0f})"

def ts(t):
    return f"{int(t // 60)}:{t % 60:04.1f}"

md = ["# Beat sheet (private reference -- do not commit)", "",
      f"Duration {ts(duration)}, {len(bounds) - 1} shots. Music tempo: {tempo}.", "",
      "| # | Time | Still | Spoken / sung | On-screen text | Music level | What we see, music feel (fill in) |",
      "|---|---|---|---|---|---|---|"]
for i, (a, b) in enumerate(zip(bounds, bounds[1:]), 1):
    still = f"shots/shot-{i:03d}.png"
    print(f"{i}\t{(a + b) / 2:.2f}\t{out / still}")
    said = " ".join(t for (x, y, t) in lines if x < b and y > a and min(y, b) - max(x, a) > 0.3)
    md.append(f"| {i} | {ts(a)}-{ts(b)} | ![]({still}) | {said} | {{{{OCR:{i:03d}}}}} | {loudness(a, b)} | |")
(out / "beat-sheet.md").write_text("\n".join(md) + "\n")
EOF

OCR="$(command -v tesseract || true)"
[ -n "$OCR" ] || echo "tesseract not found: skipping on-screen text (brew install tesseract)" >&2
while IFS=$'\t' read -r i mid still; do
  ffmpeg -nostdin -hide_banner -loglevel error -y -ss "$mid" -i "$SRC" -frames:v 1 "$still.full.png"
  ffmpeg -nostdin -hide_banner -loglevel error -y -i "$still.full.png" -vf "scale=480:-2" "$still"
  : > "${still%.png}.txt"
  if [ -n "$OCR" ]; then
    # white-on-light title cards OCR badly as-is: sharpen, crush, invert to dark-on-white first
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$still.full.png" \
      -vf "format=gray,scale=iw*2:-1,unsharp=7:7:3,eq=contrast=6:brightness=-0.6,negate" "$still.ocr.png"
    "$OCR" "$still.ocr.png" "${still%.png}" --psm 11 >/dev/null 2>&1 || true
  fi
  rm -f "$still.full.png" "$still.ocr.png"
done < "$OUT/shots.tsv"

# fill the on-screen-text column: keep words of 3+ characters that OCR likely got right
"$PYTHON" - "$OUT" <<'EOF'
import re, sys
from pathlib import Path
out = Path(sys.argv[1])
md = (out / "beat-sheet.md").read_text()
def fill(m):
    txt = out / "shots" / f"shot-{m.group(1)}.txt"
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'.,?!-]{2,}", txt.read_text(errors="replace")) if txt.exists() else []
    return " ".join(words).replace("|", "/")
(out / "beat-sheet.md").write_text(re.sub(r"\{\{OCR:(\d+)\}\}", fill, md))
EOF
rm -f "$OUT/shots.tsv" "$OUT/frames.raw" "$OUT/audio.raw"
echo "beat sheet: $OUT/beat-sheet.md ($(grep -c '^| [0-9]' "$OUT/beat-sheet.md") shots)"
