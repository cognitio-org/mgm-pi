# Outfitter intro video toolkit

Tools for an Outfitter intro/tutorial video in the style of an early-90s corporate promo -- the
"Dear Mr. ___, ___ rules the world" fan-letter format with the slow nod and thumbs-up. We borrow the
*look and format*, not the source: an original character, generic beige hardware, no Apple (or any
other) branding, no real people's likenesses, and no third-party frames in the final cut.

## Pipeline

```
source video (local only) --extract-frames.sh--> reference/*.png (gitignored)
                                                    |            \
                                     look notes -> style-bible.md  match-grade.py -> grade.cube
                                                    |                                  |
     Veo / image-model prompts <--------------------+                                  |
     Veo clips + Playwright UI recordings --vhs.sh (with grade.cube)--> graded shots --+--> edit
```

0. **Setup** (macOS, Homebrew):

   ```bash
   brew install ffmpeg numpy pillow
   ```

   Homebrew's numpy/Pillow install into Homebrew's own `python3`, not macOS's `/usr/bin/python3`.
   The shell scripts find it automatically (`PYTHON=...` to override); run the Python scripts
   with `$(brew --prefix)/bin/python3` as below.

1. **Reference frames** (on the machine with the video):

   ```bash
   cd outfitter/video
   ./extract-frames.sh /Users/mgm/localllm/video/source.mp4
   open reference/contact-sheet.png
   ```

   It deinterlaces, filters out baked-in 4px scanlines (`DESCAN=0` to skip), samples 4 fps into
   `reference/all/`, and `pick-frames.py` keeps the `COUNT` (default 24) most stable, sharpest
   frames as `reference/pick-*.png` -- held shots, not mid-dissolve. Keep 10-20 that carry the
   look: set, light, screen glow, wides. Delete or crop out close-ups of faces. `reference/` is
   gitignored; keep it that way.

   For the original's *flow* (shots, words, on-screen text, music), make a beat sheet:

   ```bash
   brew install whisper-cpp tesseract
   ./beat-sheet.sh /Users/mgm/localllm/video/source.mp4
   open reference/beat-sheet.md
   ```

   One row per shot (dissolves included): time, a mid-shot still, the words spoken or sung over
   it (whisper.cpp; the model downloads once into `reference/`), a rough OCR of on-screen text,
   and the music level, plus an overall tempo. It stays in `reference/`: private, never
   committed. `script.md` is our rewrite of that flow.

2. **Style bible.** Fill in `style-bible.md` from the frames (or hand Claude a few face-free frames
   and ask it to). Its "prompt suffix" goes at the end of every Veo / image prompt.

3. **Generate stills, shots and voices** (Google Cloud project `outfitter-509211`):

   ```bash
   brew install uv
   gcloud auth application-default login
   gcloud auth application-default set-quota-project outfitter-509211
   uv run generate.py all --dry-run      # see every request, call nothing
   uv run generate.py stills             # pick the best: cp out/stills/lead-lab-take2.png out/stills/lead-lab.png
   uv run generate.py shots
   uv run generate.py voices
   ```

   Prompts, voices and lines live in `spec.json`. Best models first, with automatic fallback:
   Gemini 3 Pro Image for stills, Veo 3.1 (1080p, no generated audio) for shots, Gemini-TTS for
   voices. Output goes to `out/` (gitignored) as numbered takes; existing files are skipped, so
   re-runs only generate (and bill) what's missing. `--only 11-thumbsup --takes 6` for more takes
   of one shot.

4. **UI footage.** Record real Outfitter screens, never AI-generated UI: `packages/web/scripts/record-tour.mjs`
   for the Manual tour, or a Playwright script for a specific flow.

5. **Grade.** Build one LUT that pulls our footage toward the reference look:

   ```bash
   mkdir -p ours && ffmpeg -i some-veo-clip.mp4 -vf fps=1 ours/frame-%04d.png
   $(brew --prefix)/bin/python3 match-grade.py --ref reference/pick-*.png --src ours/frame-*.png --out grade.cube
   ```

   The `.cube` holds only color statistics, so it's fine to commit.
   `--strength 0.6` if the full match is too heavy.

5c. **Assemble the cuts** from `picks.json` (the chosen takes) and `cut.json` (the edit):

   ```bash
   uv run assemble.py full      # -> out/dear-sysop-75.mp4   (teaser | both)
   uv run assemble.py both --grade grade.cube
   ```

   It makes the title, wish cards, printout and end card itself, puts the Outfitter screenshots
   in `out/ui/` on the green screens of the `crt-*` monitor stills (curvature, scanlines, glow;
   a plain pan until those stills exist), dissolves on the bar lines, loudness-matches the voices
   (so a home recording sits level with the TTS lines), places them, ducks the music (Demucs
   `no_vocals.wav` by default) and runs the VHS pass. A clip shorter than its slot ends in a VHS
   pause glitch instead of a dead freeze (`"fill": "freeze"` for a deliberate one). Edit timings
   in `cut.json`.

5b. **Signature** on the punchline close-up (before the VHS pass):
   `./signature.sh in.mp4 out/12-signed.mp4 "<letter writer's name>" [start-s] [write-s]`.

6. **Finish every shot** with the same pass so AI and screen footage sit together:

   ```bash
   ./vhs.sh shot01.mp4 out/shot01.mp4 grade.cube
   VHS_FILL=pad ./vhs.sh ui-recording.webm out/ui.mp4 grade.cube   # letterbox instead of crop
   VHS_NOISE=6 ./vhs.sh ...                                          # lighter grain
   ```

   Output is 1440x1080 (4:3), 29.97 fps, H.264, with a band-limited audio track.

## Guardrails

- Source footage and frames stay local (`reference/`, `*.mp4` are gitignored) and never appear in
  the final video, not even as b-roll.
- No Apple / Mac / rainbow logo, no Mac-shaped all-in-one; generic beige desktop and CRT.
- No real people: original character, fictional CEO name in the letter. Don't feed real faces to
  Veo. The cast is adults (see script.md); voices are generated, never cloned from a real person.
