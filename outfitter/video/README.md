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

2. **Style bible.** Fill in `style-bible.md` from the frames (or hand Claude a few face-free frames
   and ask it to). Its "prompt suffix" goes at the end of every Veo / image prompt.

3. **Original reference stills.** Generate the character and set with an image model using the
   style bible, then hand those (ours, not the source frames) to Veo as image or reference inputs
   so every shot shows the same original character.

4. **UI footage.** Record real Outfitter screens, never AI-generated UI: `packages/web/scripts/record-tour.mjs`
   for the Manual tour, or a Playwright script for a specific flow.

5. **Grade.** Build one LUT that pulls our footage toward the reference look:

   ```bash
   mkdir -p ours && ffmpeg -i some-veo-clip.mp4 -vf fps=1 ours/frame-%04d.png
   python3 match-grade.py --ref reference/pick-*.png --src ours/frame-*.png --out grade.cube
   ```

   (`pip install numpy pillow`.) The `.cube` holds only color statistics, so it's fine to commit.
   `--strength 0.6` if the full match is too heavy.

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
  Veo. Prefer an adult lead or an over-the-shoulder child with a voice actor.
