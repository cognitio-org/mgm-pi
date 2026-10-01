# "Dear Sysop" -- Outfitter intro (draft 2: 75 s cut + 30 s teaser)

The format: people write wish letters to the company, mail them, and Outfitter answers each wish
on screen. The letters are addressed to **"Sysop, Outfitter, U.S.A."** (Sysop is Outfitter's own
word for an admin), never to a real person. Every term below is Outfitter's own vocabulary (see
`docs/glossary.md`): Tape, Floppy, Disk Box, Drive, ▶ Play, ⏏ Eject.

## Decisions
- **Casting: grown-ups writing like kids.** Engineers in polos write crayon wish letters signed
  "Age 34", "Age 41" (MGM fills in their own). No children on screen or in the voices.
- **Length: both.** The 75 s cut below, then a 30 s teaser re-edited from the same shots.
- **Voices: all generated** (see "Voices"). Nobody records anything.

`[LEAD]` = **MGM**, generated from MGM's own reference photos (see "Lead from photos"), wearing a
powder-blue polo shirt. Use the same reference still and the same one-line description in every
prompt. MGM is the hero letter writer and signs the ending.

## Shot list
Source key: **VEO** = generated clip (prompt below + style-bible prompt suffix), **UI** = real
Outfitter screen recording, **MADE** = built by us (HTML/ffmpeg/hand drawing), **TOUR** = the
existing pixel-art Manual tour (`packages/web/src/components/tour/scenes.tsx`).
Every shot then goes through `vhs.sh ... grade.cube`. Transitions are 1-1.5 s dissolves.

| # | Time | Shot (style-bible device) | Source | Picture | Audio / VO |
|---|---|---|---|---|---|
| 1 | 0:00-0:06 | Printout pan (5) | MADE | Tractor-feed paper scrolls past: **MY WISH LIST** • An agent that codes while I sleep • Twelve of them at once • It remembers where we left off • I can take it home • I can just talk to it | Dot-matrix printer screech; synth pad fades up |
| 2 | 0:06-0:10 | Sidewalk (9) | VEO | Four adults in office casual run down a suburban sidewalk toward a curbside mailbox, waving envelopes | Running feet, kids-show synth sting |
| 3 | 0:10-0:14 | Envelope (9) | MADE + VEO | Hand-lettered envelope "Sysop / Outfitter / U.S.A." slides into the mailbox; flag goes up | VO (deadpan): "Dear Sysop..." |
| 4 | 0:14-0:20 | Wish card (6) | MADE | Crayon drawing of a robot at a desk eating a sandwich. Quote: *"Could you make a computer that writes the code while I eat lunch?"* -- signature "MGM", **Age __** | VO reads the quote |
| 5 | 0:20-0:27 | Lab hero setup (1) | VEO + UI | [LEAD] at a beige computer, monitor edge foreground right; the CRT shows the **Disk Box**. Slow nod | VO: "I picked a Tape. I started a Floppy." |
| 6 | 0:27-0:32 | CRT macro (4) | UI | Extreme close-up of the Outfitter menu, "New Floppy..." row highlights; scanlines and glow | Click, floppy-drive sound (`landing/public/sounds`) |
| 7 | 0:32-0:38 | Overhead mouse (3) + double exposure | VEO + UI | Hand clicks the mouse; dissolve/overlay to **▶ Play** and a Drive streaming its work | VO: "I pressed Play..." |
| 8 | 0:38-0:45 | Thought glow (7) | VEO | Above [LEAD]'s head, a ring of small beige computers floats in a white glow, each screen flickering with text | VO: "...and a Drive in the cloud did it while I slept." |
| 9 | 0:45-0:52 | Paint fantasy (8) | TOUR + UI | Pixel-art beach; a floppy pops out of a computer and flies to a little laptop on a beach towel | VO: "Then I ejected it and finished it on my laptop." |
| 10 | 0:52-0:58 | Wish card (6) | MADE | Crayon drawing of a computer with a speech bubble and an ear. *"Could you make a computer you can talk to?"* -- signature "Pat", **Age 41** | VO reads it; beat; a mic click |
| 11 | 0:58-1:08 | Hero thumbs-up (1, 10) | VEO | [LEAD] reads the screen, nods, turns to camera, single thumbs-up, hold; freeze frame; white-chrome cursive signature writes on: "Your Outfitter friend, MGM" | VO: "Outfitter rules the fleet. Your Outfitter friend... M. G. M." |
| 12 | 1:08-1:15 | End card | UI/MADE | Blue screen, `READY.` and a blinking cursor, dissolves to the Outfitter logo | One warm synth chord |

## VEO prompts
Append the style-bible prompt suffix to each. Generate a reference still of [LEAD] and the lab
set first (image model), then use them as Veo image/reference inputs for 5, 7, 8 and 11 so the
person and room match. Keep every prompt free of brand names and readable text.

- **2 Sidewalk:** Handheld camera at hip height, four adults in 1990 office casual (polos, khakis,
  sneakers) run laughing down a suburban sidewalk past hedges and beige stucco houses toward a
  white curbside mailbox with a red flag in the right foreground, each holding a white envelope.
  Overcast late afternoon. 6 seconds.
- **3 Envelope (plate only):** Close-up of a hand pushing a plain white envelope into an open
  white curbside mailbox, blurred green hedge behind; the envelope's face is blank. *(We add the
  hand lettering in post, or shoot a real envelope on a phone; video models garble text.)*
- **5 Lab hero setup:** Computer lab with mustard-yellow walls and a few posters. [LEAD] sits at
  a beige desktop computer, seen three-quarter from behind the monitor, whose edge fills the
  right fifth of the frame, soft and out of focus. [LEAD] reads the screen and nods slowly. Another
  person works at a second beige computer in the background. Locked-off camera. 7 seconds.
- **7 Overhead mouse:** Top-down insert of a hand clicking a beige one-button mouse on a
  light-wood desk, corner of a beige keyboard and its coiled cable at frame left. 4 seconds.
- **8 Thought glow:** Plain pale blue-grey studio backdrop. The top of [LEAD]'s head at the bottom
  of frame; above it, inside a soft white elliptical glow, a ring of six small beige desktop
  computers float and slowly rotate, their screens flickering with green text. 6 seconds.
- **11 Hero thumbs-up:** Same lab and framing as shot 5. [LEAD] reads the screen, nods slowly
  with an earnest deadpan expression, turns their head toward camera and gives one firm thumbs-up,
  holds it still for a full second. Locked-off camera. 8 seconds.

## Lead from photos (no filming)
MGM appears as the lead without being filmed: we generate them from photos.
1. **Photos** -> `outfitter/video/cast/` (gitignored, never committed): 4-6 recent, sharp,
   evenly lit shots -- front, both three-quarters, one profile, neutral expression, plain
   background, no sunglasses or hats.
2. **Reference stills**: an image model with subject reference (Imagen / Gemini image editing on
   Vertex) puts MGM in the powder-blue polo at the beige computer in the mustard-yellow lab, in
   the shot 5/11 framing. Pick one still as *the* reference and reuse it everywhere.
3. **Motion**: Veo image-to-video from that still for shots 5, 8 and 11 (and reference-image
   input where Veo offers it), with the prompts below.
4. **Pick the take where the face holds.** Faces drift between generations; the thumbs-up shot is
   the one that matters, so generate several takes of 11 and pick the closest. The VHS softness
   hides small differences.

Platform limits: Vertex gates generating identifiable real people. The project needs
`personGeneration` set to allow adults, and reference images of a real person may be refused or
need allowlisting even though it's your own face. If it's refused, fall back to a lookalike
original character for the motion shots and keep MGM's name on the signature.

## MADE assets
- **Printout (1):** an HTML page (tractor-feed paper, sprocket holes, a dot-matrix web font)
  recorded with Playwright while it scrolls, like `packages/web/scripts/record-tour.mjs`.
- **Envelope lettering (3):** hand-letter it for real and photograph it, or composite marker
  lettering onto the Veo plate.
- **Wish cards (4, 10):** crayon pictures generated with an image model ("a child's crayon drawing
  on off-white paper of ..."; or drawn by hand if anyone wants to), and set the quote in a bold white serif with a grey drop shadow plus a blue-ink signature
  and "Age N" (HTML or ffmpeg `drawtext`).
- **Signature write-on (11):** "MGM" in a cursive font, white fill, chrome/purple outline, revealed left
  to right with an animated mask.

## UI captures needed
Disk Box with a few Floppies; the new-Floppy dialog with a Tape picked; "New Floppy..." in a
menu (for the macro); ▶ Play and a Drive streaming output; ⏏ Eject; `READY.`; the voice mic.

## Music
**Option 1: the original track.** The project owner holds the rights to the reference's music.
Keep the proof (license or assignment covering this use: online, commercial, sync to new
picture) with the project files before anything ships. The rights cover the music only; the
visual guardrails in the README still apply to the footage.
- **Use the master, not the YouTube rip.** The rip has the narration and kids' voices mixed on
  top and a generation of tape loss. Ask for the original master or stems (music-only mix).
- **Rip only, as a fallback:** split music from voices with Demucs, then cut to picture. Expect
  artifacts where voices sat on the music; fine for a temp track, not for the final.

  ```bash
  brew install pipx && pipx install demucs
  pipx inject demucs numpy        # demucs 4.1 on Python 3.14 doesn't pull numpy in itself
  ffmpeg -i /Users/mgm/localllm/video/source.mp4 -vn -ac 2 -ar 44100 reference/source-audio.wav
  demucs --two-stems=vocals -o reference/stems reference/source-audio.wav
  # music bed: reference/stems/htdemucs/source-audio/no_vocals.wav
  ```
- Retime to our cut using the beat sheet's shot times: the swell should land on shot 11.

**Option 2: an original soundalike** (if the master or paperwork doesn't come through). Fill the
blanks from `beat-sheet.sh` (tempo, where the music swells and drops) and a listen:
- Tempo: ___ BPM (beat sheet). Length 75 s; swell into shot 11, button on the end card.
- Feel: earnest, optimistic early-90s corporate: warm synth pads, bright digital (FM) electric
  piano and bells, soft gated-reverb snare, fretless-style synth bass, light shaker. A simple
  hopeful melody that "lifts" when the letters are read.
- Mix: music ducks under the VO; the wish cards get a quiet, sparse bed; the hero thumbs-up gets
  the full lift and the final chord.
- Sources: generate with a music model (Lyria on Vertex, same GCP project as Veo), commission a
  musician, or license from a stock library. Keep the license with the project.

## Voices (all generated)
Text-to-speech with a natural-language style direction, so the delivery can be steered without a
human read. Good fits: **Gemini TTS on Vertex** (same GCP project as Veo; takes a style prompt
and does multi-speaker), Google Cloud TTS's HD voices, or ElevenLabs. Use stock or designed
voices only -- never clone a real person's voice, including anyone from the reference video.

| Voice | Who | Direction for the TTS style prompt |
|---|---|---|
| **MGM** | the lead, "Age __" | Adult, mid-range, reads flat and completely earnest, like a kid reading their own letter aloud at school; small pauses between sentences; no irony in the voice. |
| **PAT** | wish card 2, "Age 41" | A different adult voice (contrast MGM's pitch), same earnest, slightly too careful delivery. |
| **ANNOUNCER** | end card only (optional) | Warm, unhurried early-90s corporate narrator; one line. |

### Lines (75 s cut)
Target lengths are the time the line may take on screen; regenerate or adjust pace to fit.

| Shot | Voice | Line | Target |
|---|---|---|---|
| 3 | MGM | "Dear Sysop..." | 1.5 s |
| 4 | MGM | "Could you make a computer that writes the code while I eat lunch?" | 4 s |
| 5 | MGM | "I picked a Tape. I started a Floppy." | 3 s |
| 7 | MGM | "I pressed Play..." | 1.5 s |
| 8 | MGM | "...and a Drive in the cloud did it while I slept." | 3.5 s |
| 9 | MGM | "Then I ejected it, and finished it on my laptop." | 3.5 s |
| 10 | PAT | "Could you make a computer you can talk to?" | 3 s |
| 11 | MGM | "Outfitter rules the fleet. Your Outfitter friend... M. G. M." | 5 s |
| 12 | ANNOUNCER | "Outfitter. Ready when you are." (optional) | 2.5 s |

Finish every voice line with the same tape treatment as the picture (`vhs.sh` band-limits audio),
plus a touch of room reverb, so it doesn't sound too clean against the 1990 picture.

## 30 s teaser
Re-cut from the same shots and voice lines, no new generation:

| Time | Shot | Voice |
|---|---|---|
| 0:00-0:04 | 1 Printout (first 4 s) | -- |
| 0:04-0:09 | 4 Wish card 1 | MGM: "Could you make a computer that writes the code while I eat lunch?" |
| 0:09-0:14 | 5 Lab hero setup | MGM: "I picked a Tape. I started a Floppy." |
| 0:14-0:19 | 8 Thought glow | MGM: "...and a Drive in the cloud did it while I slept." |
| 0:19-0:27 | 11 Hero thumbs-up | MGM: "Outfitter rules the fleet. Your Outfitter friend... M. G. M." |
| 0:27-0:30 | 12 End card | music button |

Music for the teaser: the same track, cut so the swell lands on the thumbs-up at 0:19.
