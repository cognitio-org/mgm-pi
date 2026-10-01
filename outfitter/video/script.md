# "Dear Sysop" -- Outfitter intro (draft 3: 75 s cut + 30 s teaser)

Built on the reference promo's structure (from the beat sheet, kept private): a title over a
mailbox montage, then a parade of fan letters, each read aloud by its writer over pictures of the
wish, ending on one short punchline letter with a thumbs-up and a thank-you card. Our version
keeps the *shape* and the music, but every word, person and picture is ours, and the joke is
inverted: the letter writers are grown-ups, not kids.

Letters go to **"Sysop, Outfitter, U.S.A."** (Sysop is Outfitter's own word for an admin), never
to a real person. Every product term is Outfitter's own (see `docs/glossary.md`): Tape, Floppy,
Disk Box, Drive, ▶ Play, ⏏ Eject, Control Panel.

## Decisions
- **Casting: grown-ups writing like kids.** No children on screen or in the voices.
- **Length: both.** The 75 s cut, then a 30 s teaser re-cut from the same material.
- **Voices:** generated for Lee, Pat and Jo; **MGM's letter is MGM's own recorded voice**.
- **Lead:** `[LEAD]` = "a person in their mid-50s with short grey hair, wearing a powder-blue polo
  shirt" -- an original generated character, not modeled on anyone real. Same description and
  reference still everywhere. This is **Rocky, the last fan**: seen only in the final beat
  (silent nod and thumbs-up, "Rocky" writes on). MGM, Age 54, is a letter writer heard but not
  seen: MGM's letter plays over a wish card signed "MGM".

## Structure (mirrors the reference, at its ~84 BPM: 1 bar = 2.86 s)
| Part | Bars | Time | Reference did | We do |
|---|---|---|---|---|
| A Open | 1-3 | 0:00-0:08.6 | Title "Dear Mr. ___" over a mailbox montage | "Dear Sysop," writes on over adults running to the mailbox |
| B Letter 1 | 4-9 | 0:08.6-0:25.7 | Small child learning to program, sends a picture of their first program | **Lee, 61**, learning to program with agents; sends a crayon picture of the first *bug* it fixed |
| C Letter 2 | 10-17 | 0:25.7-0:48.6 | Asks the CEO to persuade a parent; reads an absurd spec list off a printout; "how much will all this cost?" | **Pat, 41**, asks Sysop to write to their *boss*; reads the Outfitter feature list off a dot-matrix printout |
| D Letter 3 | 18-21 | 0:48.6-1:00 | A dream wish (talking to dolphins) over a paint-program beach | **Jo, 47**: a computer you can just talk to, and take your work home -- over a pixel-art beach |
| E Punchline letter | 22-23 | 1:00-1:05.7 | One-line letter: "___ rules the world" | **MGM, 54** (MGM's own voice): "Outfitter rules the fleet." over a wish card; "MGM" writes on |
| F Last fan | 24-25 | 1:05.7-1:11.4 | Nod, turn, thumbs-up, name writes on | **Rocky**: side-on close-up, nod, thumbs-up, freeze; "Rocky" writes on; music swells |
| G Close | 26 | 1:11.4-1:15 | Thank-you card, logo | Thank-you card, `READY.`, logo |

(The reference's reflective "computers are only tools" letter is dropped from the 75 s cut.)

## Shot list
Source key: **VEO** = generated clip (`spec.json`), **UI** = real Outfitter screen recording,
**MADE** = built by us (HTML/ffmpeg + generated drawings), **TOUR** = the pixel-art Manual tour
(`packages/web/src/components/tour/scenes.tsx`). Every shot goes through `vhs.sh ... grade.cube`.
Cuts land on bar lines; transitions are 1-1.5 s dissolves, montage beats double-exposed.

| # | Time | Picture | Source | Voice |
|---|---|---|---|---|
| 1 | 0:00-0:05.7 | Handwritten "Dear Sysop," writes on over four adults running down a sidewalk to a mailbox | MADE over VEO `02-sidewalk` | -- (music up) |
| 2 | 0:05.7-0:08.6 | Envelope "Sysop / Outfitter / U.S.A." into the mailbox, flag up | VEO `03-envelope` + MADE lettering | -- |
| 3 | 0:08.6-0:14.3 | Overhead hand on the mouse, double-exposed with the CRT macro of "New Floppy..." | VEO `07-mouse` + UI | LEE-a, LEE-b |
| 4 | 0:14.3-0:20.0 | ▶ Play; a Drive streams its work (CRT macro, scanlines) | UI | (LEE-b continues) |
| 5 | 0:20.0-0:25.7 | Wish card: crayon bug with a bandage. "Lee, Age 61" | MADE `card-bug` | LEE-c |
| 6 | 0:25.7-0:31.4 | CRT macro: the Disk Box with one lonely Floppy | UI | PAT-a |
| 7 | 0:31.4-0:42.9 | Dot-matrix printout pans down: the wish list (below) | MADE | PAT-b, PAT-c |
| 8 | 0:42.9-0:48.6 | Thought glow: a ring of small beige computers (twelve Drives) | VEO `08-glow` | PAT-d, PAT-e |
| 9 | 0:48.6-0:52.9 | Wish card: crayon computer with a speech bubble and an ear. "Jo, Age 47" | MADE `card-talk` | JO |
| 10 | 0:52.9-1:00.0 | Pixel-art beach; a floppy ejects and flies to a laptop on a towel | TOUR + UI | (JO continues) |
| 11 | 1:00.0-1:05.7 | Wish card: crayon ring of little computers wearing a crown. Quote: "Outfitter rules the fleet." "MGM" writes on, Age 54 | MADE `card-fleet` + `signature.sh` | MGM (recorded by MGM) |
| 12 | 1:05.7-1:11.4 | **Rocky**, tight side-on close-up (the reference's framing): reads, nods, turns to camera, one thumbs-up beside the face, freeze; "Rocky" writes on, lower right | VEO `11-closeup` + `signature.sh` | -- (music swell) |
| 13 | 1:11.4-1:15.0 | White serif on blue: "Thanks for all your letters. Our grown-up fans keep us going." Dissolve to `READY.` and the logo | MADE + UI | -- (music button) |

**Printout (7) text**, matching PAT-c: MY WISH LIST / • Twelve Drives at once / • A Tape for every
job / • MongoDB Atlas memory (remembers where we left off) / • Atlas agents <-> my agents (A2A) /
• Eject to my laptop / • A Control Panel with all the keys.

**Atlas** is the centerpiece of Pat's list: Drives share long-term memory through MongoDB Atlas
Agent Engine, call its hosted agents, and take coding tasks from Atlas agents over A2A (epic E9,
`docs/specs/atlas-agent-engine-and-a2a.md`). It's a third-party product: name it in words, and only
use its logo with MongoDB's permission.

## MADE assets
- **Printout (7):** an HTML page (tractor-feed paper, sprocket holes, a dot-matrix web font)
  recorded with Playwright while it scrolls, like `packages/web/scripts/record-tour.mjs`.
- **Envelope lettering (2):** hand-letter it for real and photograph it, or composite marker
  lettering onto the Veo plate.
- **Wish cards (5, 9):** crayon pictures generated by `generate.py stills`, with the quote in a bold white serif with a grey drop shadow plus a blue-ink signature
  and "Age N" (HTML or ffmpeg `drawtext`).
- **Title write-on (1)** and **signature write-on (12, `signature.sh`):** "Dear Sysop," and the punchline letter writer's own name (as
  the reference signs its letter writer) in Sacramento (bundled, SIL OFL), white fill,
  chrome/purple outline, written on left to right. Run before `vhs.sh`:
  `./signature.sh out/veo/11-closeup-take2.mp4 out/12-rocky.mp4 "Rocky" 5.0 1.2` (time the
  start to the thumbs-up) and, on MGM's card clip, `... out/11-mgm.mp4 "MGM" 3.5 1.0`.

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
- Retime to our cut using the beat sheet's shot times: the swell should land on Rocky's
  thumbs-up (shot 12, ~1:06), where the reference swells into its punchline.

**Option 2: an original soundalike** (if the master or paperwork doesn't come through). Fill the
blanks from `beat-sheet.sh` (tempo, where the music swells and drops) and a listen:
- Tempo: ~84 BPM (beat sheet). Length 75 s; swell into Rocky (shot 12), button on the end card.
- Feel: earnest, optimistic early-90s corporate: warm synth pads, bright digital (FM) electric
  piano and bells, soft gated-reverb snare, fretless-style synth bass, light shaker. A simple
  hopeful melody that "lifts" when the letters are read.
- Mix: music ducks under the VO; the wish cards get a quiet, sparse bed; the hero thumbs-up gets
  the full lift and the final chord.
- Sources: generate with a music model (Lyria on Vertex, same GCP project as Veo), commission a
  musician, or license from a stock library. Keep the license with the project.

## Voices (all generated)
Gemini-TTS (Cloud Text-to-Speech, project `outfitter-509211`) with a natural-language style
direction per voice; `generate.py voices` renders every line in `spec.json`. Prebuilt voices only --
never a clone of a real person, including anyone in the reference video.

| Voice | Who | Direction |
|---|---|---|
| **LEE** | letter 1, Age 61 | Older adult, gentle, proud and a little slow, reading their own letter aloud like a kid at school. |
| **PAT** | letter 2, Age 41 | Adult, earnest and slightly breathless, reading a long list very seriously; the list gets faster. |
| **JO** | letter 3, Age 47 | Adult, soft and dreamy, wistful pauses. |
| **MGM** | punchline letter, Age 54 | **Recorded by MGM** (own voice); the generated MGM takes are spares. |

### Lines
Split so the teaser can reuse pieces. Times are what each piece may take on screen.

| Id | Voice | Line | Max |
|---|---|---|---|
| LEE-a | LEE | "Dear Sysop. My name is Lee, and I am sixty-one years old." | 4 s |
| LEE-b | LEE | "I am learning to program with agents. I pick a Tape, I start a Floppy, and a Drive does the work." | 7 s |
| LEE-c | LEE | "I am sending you a picture of the first bug it fixed. Your friend, Lee." | 5 s |
| PAT-a | PAT | "Dear Sysop. My boss won't let me run more than one agent. So please write a letter to my boss." | 5.5 s |
| PAT-b | PAT | "Here is what I would like:" | 1.5 s |
| PAT-c | PAT | "Twelve Drives at once. A Tape for every job. Atlas memory, so it remembers where we left off. Atlas agents that hand my agents work, and back again. Eject to my laptop. And a Control Panel with all the keys." | 10 s |
| PAT-d | PAT | "How much will all this cost?" | 2 s |
| PAT-e | PAT | "Make it sound official, okay? Sincerely, Pat." | 3.5 s |
| JO | JO | "Dear Sysop. Maybe someday you can make a computer I can just talk to. And when I'm done, I can take my work home. Sincerely, Jo." | 10 s |
| MGM | MGM | "Dear Sysop. Outfitter rules the fleet. Your Outfitter friend, MGM." | 7 s |

Finish every voice line with the same tape treatment as the picture (`vhs.sh` band-limits audio)
plus a touch of room reverb, so it doesn't sound too clean against the 1990 picture.

## 30 s teaser (10.5 bars)
| Time | Picture | Voice |
|---|---|---|
| 0:00-0:05.7 | 1 "Dear Sysop," over the sidewalk run | -- |
| 0:05.7-0:17.1 | 7 Printout pan | PAT-b, PAT-c (first four items, through the Atlas agents), PAT-d |
| 0:17.1-0:21.4 | 11 MGM's wish card, "MGM" writes on | MGM (recorded) |
| 0:21.4-0:25.7 | 12 Rocky's thumbs-up, "Rocky" writes on | -- |
| 0:25.7-0:30.0 | 13 Thank-you card, logo | -- |
