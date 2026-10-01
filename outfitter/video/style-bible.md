# Style bible: "Dear Outfitter" (early-90s corporate promo)

Fill this in from the reference frames (`reference/contact-sheet.png`). Describe; don't name the
source. Everything under "Prompt suffix" gets pasted onto every generation prompt.

## Observed so far (first 5 frames, measured)
- **Edit style is the look**: almost nothing is a clean held shot. Slow cross-dissolves and
  2-3 layer double exposures throughout (a macro of a keyboard over a face, faces over faces),
  plus glowing horizontal graphic bands (warm yellow-orange text strips) sliding across.
- **Color**: lavender / blue-violet cast in backgrounds and highlights (mean B > R > G on wide
  frames); warm, slightly magenta skin. Green is the lowest channel in every frame, so the
  whole thing leans magenta.
- **Contrast**: graphics-heavy frames have lifted blacks (2nd-percentile luma ~55-60 of 255);
  people shots go deeper (~20). Highlights bloom rather than clip.
- **Framing**: tight profile close-ups, shallow focus, groups huddled around a letter or a
  screen; a Dutch-angle macro of keys.
- **Texture**: very soft, low resolution, smeared chroma. The 4px scanlines in the YouTube
  copy are a transfer artifact, not part of the look (extract-frames.sh removes them).
- Edit implication: build transitions as long `xfade=fade` dissolves (1-1.5 s) and keep 2-layer
  overlays (blend=all_mode=screen at ~40%) for the montage beats.

## Format
- Aspect / resolution feel: 4:3, standard-definition VHS dub
- Frame rate / motion: 29.97, locked-off tripod or slow push-ins
- Shot vocabulary: _e.g. over-the-shoulder onto CRT; medium close-up, eye level; insert of hands on keyboard_

## Light
- Key: _e.g. soft, high, camera-left; CRT glow as fill on the face_
- Background: _e.g. dim, warm practical lamp; slight falloff_
- Contrast: _e.g. lifted blacks, no true black; highlights roll off softly_

## Color
- Overall cast: _e.g. warm/yellow mids, slightly green shadows_
- Saturation: _e.g. muted, except saturated primaries on screen_
- Skin: _..._

## Texture
- Grain / noise: _..._
- Softness / sharpening halos: _..._
- Chroma bleed, tape artifacts: _..._

## Set and props (generic, unbranded)
- Computer: beige desktop, separate CRT monitor, beige keyboard, one-button mouse not required
- Room: _e.g. kid's bedroom / suburban den, wood-panel or pastel wallpaper, posters (invented)_
- Wardrobe: _e.g. bold geometric sweater, turtleneck_

## Performance beats
- Reads the letter in a flat, earnest deadpan
- Slow, approving nod at the screen
- Turns to camera; single thumbs-up; hold 1 s; freeze frame

## Prompt suffix
> _1990 corporate promotional video, shot on Betacam and dubbed to VHS, 4:3 standard definition,
> soft warm practical lighting with CRT screen glow, lifted blacks, muted colors, mild tape grain,
> generic beige desktop computer with CRT monitor, no logos, no brand names._
