#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10"]
# ///
"""Builds the finished cuts from picks.json + cut.json.

  uv run assemble.py full            the 75 s cut   -> out/dear-sysop-75.mp4
  uv run assemble.py teaser          the 30 s cut   -> out/dear-sysop-30.mp4
  uv run assemble.py both

Options: --grade grade.cube (LUT from match-grade.py, applied in the VHS pass)
         --music PATH / --music-start SECONDS (override cut.json)
         --keep (leave the per-segment renders in out/cut/ for inspection)

What it makes itself (Pillow + ffmpeg, no extra services): the "Dear Sysop," title write-on, the
wish cards (drawing + quote + signature + age, MGM's name written on), the dot-matrix printout,
labelled placeholder slates for the Outfitter UI shots still to be recorded, and the end card
(thank-you, then READY.). Then: dissolves on the bar lines, voices placed in order, the music
ducked under them, and the VHS finishing pass. Everything lands in out/ (gitignored).
"""
import argparse
import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
FONTS = HERE / "fonts"
W, H, FPS = 1920, 1080, "30000/1001"
VIS_X = (W - H * 4 // 3) // 2           # left edge of the 4:3 area vhs.sh keeps
VIS_W = H * 4 // 3
SERIF = FONTS / "PTSerif-Bold.ttf"
DOT = FONTS / "VT323-Regular.ttf"
PEN = FONTS / "Sacramento-Regular.ttf"
C64_BORDER, C64_SCREEN, C64_TEXT = (120, 105, 196), (64, 49, 141), (160, 150, 230)


# --- plumbing ------------------------------------------------------------------------------------
def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def pick(picks, ref):
    group, key = ref.split(".", 1)
    val = picks.get(group, {}).get(key)
    if isinstance(val, dict):
        val = val.get("file")
    if not val:
        raise SystemExit(f"picks.json has no pick for {ref}")
    path = OUT / val
    if not path.exists():
        raise SystemExit(f"{ref}: {path} doesn't exist yet")
    return path


def font(path, size):
    return ImageFont.truetype(str(path), size)


def x264(*extra):
    return [*extra, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-an"]


# --- images --------------------------------------------------------------------------------------
def lettering(text, path, size, fill, outline=None, outer=0, inner_outline=None, inner=0, shadow=None):
    """Transparent PNG of text, cropped to its ink. outline/inner_outline = stroke colours."""
    f = font(path, size)
    pad = size // 3 + outer
    lines = text.split("\n")
    lh = int(size * 1.15)
    widths = [f.getbbox(line or " ", stroke_width=outer)[2] for line in lines]
    img = Image.new("RGBA", (max(widths) + 2 * pad, lh * len(lines) + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        xy = (pad, pad + i * lh)
        if shadow:
            d.text((xy[0] + shadow[1], xy[1] + shadow[1]), line, font=f, fill=shadow[0],
                   stroke_width=outer, stroke_fill=shadow[0])
        if outline:
            d.text(xy, line, font=f, fill=fill, stroke_width=outer, stroke_fill=outline)
        if inner_outline:
            d.text(xy, line, font=f, fill=fill, stroke_width=inner, stroke_fill=inner_outline)
        if not outline and not inner_outline:
            d.text(xy, line, font=f, fill=fill)
    return img.crop(img.getbbox() or (0, 0, 1, 1))


def chrome(text, size=170):
    """The reference's signature/title look: white, purple outer stroke, pale inner stroke."""
    return lettering(text, PEN, size, (255, 255, 255, 255), outline=(90, 58, 138, 255), outer=8,
                     inner_outline=(216, 208, 240, 255), inner=3)


def cover(img, w, h):
    s = max(w / img.width, h / img.height)
    img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    x, y = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def card(seg, picks):
    """Wish card: drawing filling the 4:3 area, quote top-left, name + age bottom-right."""
    canvas = Image.new("RGB", (W, H), (20, 18, 22))
    drawing = Image.open(pick(picks, f"stills.{seg['still']}")).convert("RGB")
    canvas.paste(cover(drawing, VIS_W, H), (VIS_X, 0))
    quote = "\n".join(textwrap.wrap(seg["quote"], 16))
    q = lettering(quote, SERIF, 92, (255, 255, 255, 255), outline=(150, 150, 160, 255), outer=2,
                  shadow=((90, 90, 100, 200), 6))
    canvas.paste(q, (VIS_X + 90, 90), q)
    name = lettering(seg["name"], PEN, 150, (28, 42, 150, 255), outline=(28, 42, 150, 255), outer=1)
    age = lettering(f"Age {seg['age']}", SERIF, 72, (255, 255, 255, 255), outline=(150, 150, 160, 255),
                    outer=2, shadow=((90, 90, 100, 200), 5))
    ax, ay = VIS_X + VIS_W - age.width - 90, H - age.height - 70
    nx, ny = VIS_X + VIS_W - name.width - 110, ay - name.height - 10
    canvas.paste(age, (ax, ay), age)
    if not seg.get("write"):
        canvas.paste(name, (nx, ny), name)
    return canvas, name, (nx, ny)


def ui_canvas(picks, key):
    """A UI screenshot centred on a dark 16:9 canvas, so pans never distort it."""
    shot = Image.open(pick(picks, f"ui.{key}")).convert("RGB")
    cw = max(shot.width, round(shot.height * 16 / 9))
    canvas = Image.new("RGB", (cw, round(cw * 9 / 16)), (24, 20, 44))
    canvas.paste(shot, ((canvas.width - shot.width) // 2, (canvas.height - shot.height) // 2))
    return canvas


def slate(text):
    img = Image.new("RGB", (W, H), C64_BORDER)
    d = ImageDraw.Draw(img)
    d.rectangle((VIS_X + 110, 90, VIS_X + VIS_W - 110, H - 90), fill=C64_SCREEN)
    d.multiline_text((VIS_X + 170, 150), text, font=font(DOT, 76), fill=C64_TEXT, spacing=14)
    return img


def printout(lines):
    """Tall tractor-feed greenbar page on a dark desk, for a slow scroll."""
    pw, lh, top = 1180, 92, 300
    lines = [w for line in lines for w in (textwrap.wrap(line, 30, subsequent_indent="  ") or [""])]
    ph = top + lh * len(lines) + 420
    img = Image.new("RGB", (W, ph), (34, 28, 30))
    page = Image.new("RGB", (pw, ph), (244, 242, 232))
    d = ImageDraw.Draw(page)
    for i, y in enumerate(range(0, ph, lh * 2)):
        if i % 2:
            d.rectangle((90, y, pw - 90, y + lh * 2), fill=(222, 236, 222))
    for y in range(40, ph, 64):
        for x in (40, pw - 40):
            d.ellipse((x - 14, y - 14, x + 14, y + 14), fill=(34, 28, 30))
    f = font(DOT, 80)
    for i, line in enumerate(lines):
        d.text((150, top + i * lh), line, font=f, fill=(48, 46, 56))
    img.paste(page, ((W - pw) // 2, 0))
    return img


# --- video pieces --------------------------------------------------------------------------------
def still_video(img, seconds, out, push=0.00035):
    png = out.with_suffix(".png")
    img.save(png)
    frames = round(seconds * 30000 / 1001) + 2
    ff("-loop", "1", "-i", png, "-vf",
       f"scale={W * 2}:{H * 2},zoompan=z='1+{push}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
       f":d={frames}:s={W}x{H}:fps={FPS},trim=duration={seconds}", *x264("-t", seconds), out)


def clip_video(src, start, seconds, out, freeze=0.0):
    play = seconds - freeze
    avail = max(duration(src) - start, 0.1)
    slow = max(1.0, play / avail)                # stretch a short clip rather than run out
    ff("-ss", start, "-i", src, "-vf",
       f"setpts={slow:.4f}*(PTS-STARTPTS),scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
       f"fps={FPS},trim=duration={play},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={seconds},"
       f"trim=duration={seconds}", *x264(), out)


def reveal(base, overlay_img, x, y, start, dur, out):
    """Write overlay_img onto base left to right from `start` over `dur` seconds."""
    png = out.with_name(out.stem + "-ink.png")
    overlay_img.save(png)
    ff("-i", base, "-loop", "1", "-framerate", FPS, "-i", png, "-filter_complex",
       f"[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*lte(X,W*clip((T-{start})/{dur},0,1))'[ink];"
       f"[0:v][ink]overlay=x={x}:y={y}:shortest=1:enable='gte(t,{start})'", *x264(), out)


def blend(base, top_img, mix, out):
    png = out.with_name(out.stem + "-top.png")
    top_img.save(png)
    ff("-i", base, "-loop", "1", "-framerate", FPS, "-i", png, "-filter_complex",
       f"[1:v]format=yuv420p,scale={W}:{H}[t];[0:v][t]blend=all_mode=screen:all_opacity={mix}:shortest=1",
       *x264(), out)


def screen_video(canvas, seconds, out, frm, to):
    """Pan/zoom across a screenshot: frm/to = [centre x, centre y, visible width] as fractions."""
    png = out.with_suffix(".png")
    canvas.save(png)
    frames = round(seconds * 30000 / 1001) + 2
    (x0, y0, w0), (x1, y1, w1) = frm, to
    p = f"(on/{frames})"
    p = f"({p}*{p}*(3-2*{p}))"                       # ease in and out
    z = f"(1/({w0}+({w1}-{w0})*{p}))"
    cx, cy = f"({x0}+({x1}-{x0})*{p})", f"({y0}+({y1}-{y0})*{p})"
    ff("-loop", "1", "-i", png, "-vf",
       f"scale={W * 2}:{H * 2},zoompan=z='{z}':x='max(0,min(iw-iw/zoom,{cx}*iw-iw/zoom/2))'"
       f":y='max(0,min(ih-ih/zoom,{cy}*ih-ih/zoom/2))':d={frames}:s={W}x{H}:fps={FPS},trim=duration={seconds}",
       *x264("-t", seconds), out)


def endcard(seg, seconds, out):
    thanks = Image.new("RGB", (W, H), (36, 48, 140))
    t = lettering(seg["thanks"], SERIF, 84, (255, 255, 255, 255), outline=(150, 150, 170, 255), outer=2,
                  shadow=((20, 24, 70, 255), 6))
    thanks.paste(t, ((W - t.width) // 2, (H - t.height) // 2), t)
    ready_off = slate("READY.")
    ready_on = ready_off.copy()
    ImageDraw.Draw(ready_on).rectangle((VIS_X + 172, 250, VIS_X + 214, 318), fill=C64_TEXT)
    a, b = out.with_name(out.stem + "-a.mp4"), out.with_name(out.stem + "-b.mp4")
    first = round(seconds * 0.55, 2)
    still_video(thanks, first + 0.4, a, push=0.0002)
    ready_off.save(out.with_name("ready-off.png"))
    ready_on.save(out.with_name("ready-on.png"))
    ff("-loop", "1", "-framerate", FPS, "-i", out.with_name("ready-off.png"),
       "-loop", "1", "-framerate", FPS, "-i", out.with_name("ready-on.png"), "-filter_complex",
       "[0:v][1:v]overlay=enable='lt(mod(t,0.6),0.3)'", *x264("-t", seconds - first + 0.4), b)
    ff("-i", a, "-i", b, "-filter_complex",
       f"[0:v][1:v]xfade=transition=fade:duration=0.4:offset={first}", *x264(), out)


# --- one cut ---------------------------------------------------------------------------------------
def render_segment(i, seg, length, picks, work):
    out = work / f"seg{i:02d}.mp4"
    t = seg["t"]
    if t in ("clip", "file"):
        clip_video(pick(picks, seg["src"]), seg.get("in", 0), length, out, seg.get("freeze", 0))
    elif t == "card":
        img, name, (nx, ny) = card(seg, picks)
        still_video(img, length, out)
        if seg.get("write"):
            tmp = out.with_name(out.stem + "-nosig.mp4")
            out.rename(tmp)
            reveal(tmp, name, nx, ny, seg["write"]["start"], seg["write"]["dur"], out)
    elif t == "screen":
        screen_video(ui_canvas(picks, seg["ui"]), length, out, seg.get("from", [0.5, 0.5, 1.0]),
                     seg.get("to", [0.5, 0.5, 0.8]))
    elif t == "slate":
        still_video(slate(seg["text"]), length, out, push=0.0)
    elif t == "printout":
        img = printout(seg["lines"])
        png = out.with_suffix(".png")
        img.save(png)
        ff("-loop", "1", "-i", png, "-vf",
           f"crop={W}:{H}:0:'min(ih-{H},(ih-{H})*t/{length})',fps={FPS}", *x264("-t", length), out)
    elif t == "endcard":
        endcard(seg, length, out)
    else:
        raise SystemExit(f"segment {i}: unknown type {t!r}")
    if seg.get("title"):
        title = chrome(seg["title"]["text"], 190)
        tmp = out.with_name(out.stem + "-notitle.mp4")
        out.rename(tmp)
        reveal(tmp, title, VIS_X + (VIS_W - title.width) // 2, 120,
               seg["title"]["start"], seg["title"]["write"], out)
    if seg.get("double"):
        tmp = out.with_name(out.stem + "-single.mp4")
        out.rename(tmp)
        dbl = seg["double"]
        top = cover(ui_canvas(picks, dbl["ui"]), W, H) if dbl.get("ui") else slate(dbl["slate"])
        blend(tmp, top, dbl["mix"], out)
    return out


def build(name, cut, edit, picks, args):
    work = OUT / "cut" / name
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    segs, d = cut["segments"], edit["dissolve"]
    total = sum(s["slot"] for s in segs)
    print(f"{name}: {len(segs)} segments, {total:.1f} s")
    files = []
    for i, seg in enumerate(segs):
        length = seg["slot"] + (d if i < len(segs) - 1 else 0)   # overlap feeds the dissolve
        print(f"  [{i + 1}/{len(segs)}] {seg['t']} {seg.get('src') or seg.get('still') or ''}")
        files.append(render_segment(i, seg, length, picks, work))

    # Picture: dissolve each segment into the next on its bar line.
    inputs = [x for f in files for x in ("-i", f)]
    chain, prev, offset = [], "0:v", 0.0
    for i in range(1, len(files)):
        offset += segs[i - 1]["slot"]
        chain.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={d}:offset={offset:.3f}[v{i}]")
        prev = f"v{i}"
    picture = work / "picture.mp4"
    ff(*inputs, "-filter_complex", ";".join(chain), "-map", f"[{prev}]", *x264("-t", total), picture)

    # Sound: voices in order (never overlapping), music ducked under them.
    music_file = Path(args.music or edit["music"]["file"])
    music_file = music_file if music_file.is_absolute() else HERE / music_file
    music_start = args.music_start if args.music_start is not None else edit["music"]["start"]
    a_in, filt, labels, end = [], [], [], 0.0
    for n, v in enumerate(cut["voices"]):
        f = pick(picks, f"voices.{v['id']}")
        at = max(v["at"], end + edit["voice_gap"]) if end else v["at"]
        end = at + duration(f)
        print(f"  voice {v['id']:6} {at:6.2f}-{end:6.2f} s")
        a_in += ["-i", f]
        filt.append(f"[{n + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,"   # input 0 is the picture
                    f"adelay={int(at * 1000)}:all=1[a{n}]")
        labels.append(f"[a{n}]")
    nv = len(labels)
    filt.append(f"{''.join(labels)}amix=inputs={nv}:normalize=0,aecho=0.8:0.4:35:0.12,"
                f"apad=whole_dur={total}[vox]")
    if music_file.exists():
        a_in += ["-ss", music_start, "-i", music_file]
        fade = edit["music"]["fade_out"]
        filt.append(f"[{nv + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=duration={total},"
                    f"volume={edit['music']['gain_db']}dB,afade=t=out:st={total - fade}:d={fade}[mus]")
        filt.append("[vox]asplit[vk][vm]")
        filt.append("[mus][vk]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[duck]")
        filt.append(f"[duck][vm]amix=inputs=2:normalize=0,alimiter=limit=0.9,atrim=duration={total}[mix]")
    else:
        print(f"  (no music: {music_file} not found -- voices only)", file=sys.stderr)
        filt.append(f"[vox]alimiter=limit=0.9,atrim=duration={total}[mix]")
    mixed = work / "mixed.mp4"
    ff("-i", picture, *a_in, "-filter_complex", ";".join(filt), "-map", "0:v", "-map", "[mix]",
       "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", total, mixed)

    final = OUT / cut["out"]
    vhs = [str(HERE / "vhs.sh"), str(mixed), str(final)] + ([str(args.grade)] if args.grade else [])
    subprocess.run(vhs, check=True, stdout=subprocess.DEVNULL)
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    print(f"wrote {final}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("which", choices=["full", "teaser", "both"])
    ap.add_argument("--grade")
    ap.add_argument("--music")
    ap.add_argument("--music-start", type=float)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} not found. Install with: brew install ffmpeg")
    picks = json.loads((HERE / "picks.json").read_text())
    edit = json.loads((HERE / "cut.json").read_text())
    for name in (["full", "teaser"] if args.which == "both" else [args.which]):
        build(name, edit["cuts"][name], edit, picks, args)


if __name__ == "__main__":
    main()
