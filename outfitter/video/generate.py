#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["google-genai>=2.20", "google-cloud-texttospeech>=2.30"]
# ///
"""Generates the intro video's stills, Veo shots and voice lines from spec.json.

  uv run generate.py stills            reference stills + wish-card drawings (Gemini image)
  uv run generate.py shots             Veo clips; shots with "start" animate the chosen still
  uv run generate.py voices            every line in Gemini-TTS, one file per take
  uv run generate.py all

Options: --only ID[,ID]  --takes N  --dry-run (print requests, call nothing)  --yes (skip the
cost confirmation)  --project  --image-model / --video-model / --tts-model (override defaults).

Everything lands in out/ (gitignored) as <id>-takeN.*; existing files are skipped, so re-runs only
generate what's missing (and only bill for that). Pick the best still by copying it to
out/stills/<id>.png -- shots that start from a still use that file (take 1 by default).

Setup (once):  brew install uv
               gcloud auth application-default login
               gcloud auth application-default set-quota-project outfitter-509211
"""
import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
PROJECT = "outfitter-509211"
# Best-first; on "model not found" the next one is tried, so a renamed or not-yet-enabled model
# degrades instead of failing.
IMAGE_MODELS = ["gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-image", "gemini-2.5-flash-image"]
VIDEO_MODELS = ["veo-3.1-generate-001", "veo-3.1-generate-preview", "veo-3.0-generate-001"]
TTS_MODELS = ["gemini-2.5-pro-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-tts"]


def fill(text, spec):
    return text.replace("{lead}", spec["lead"]).replace("{suffix}", spec["suffix"])


def selected(items, only):
    return [x for x in items if not only or x["id"] in only]


def not_found(err):
    s = str(err).lower()
    return "not found" in s or "404" in s or "not supported" in s or "does not exist" in s


def with_fallback(models, call, label):
    last = None
    for m in models:
        try:
            return m, call(m)
        except Exception as e:  # noqa: BLE001 -- surfaced below
            if not not_found(e):
                raise
            print(f"  {label}: {m} unavailable ({str(e)[:120]}), trying next", file=sys.stderr)
            last = e
    raise SystemExit(f"{label}: none of {models} is available in {PROJECT}: {last}")


def genai_client(location):
    from google import genai
    return genai.Client(vertexai=True, project=PROJECT, location=location)


# --- stills -------------------------------------------------------------------------------------
def run_stills(spec, args):
    from google.genai import types
    out = OUT / "stills"
    out.mkdir(parents=True, exist_ok=True)
    client = None if args.dry_run else genai_client("global")
    for st in selected(spec["stills"], args.only):
        for k in range(1, takes_for("stills", args) + 1):
            path = out / f"{st['id']}-take{k}.png"
            if path.exists():
                continue
            refs = [out / f"{r}.png" for r in st.get("refs", [])]
            missing = [r for r in refs if not r.exists()]
            if missing and not args.dry_run:
                raise SystemExit(f"{st['id']}: pick a still first: {', '.join(map(str, missing))}")
            prompt = fill(st["prompt"], spec)
            aspect = st.get("aspect", "16:9")
            print(f"still {path.name}: {aspect}, {len(refs)} ref(s)")
            if args.dry_run:
                print(f"  prompt: {prompt}")
                continue
            contents = [types.Part.from_bytes(data=r.read_bytes(), mime_type="image/png") for r in refs]
            contents.append(prompt)
            config = types.GenerateContentConfig(
                response_modalities=["IMAGE"],
                image_config=types.ImageConfig(aspect_ratio=aspect, image_size="2K"),
            )
            model, resp = with_fallback(
                [args.image_model] if args.image_model else IMAGE_MODELS,
                lambda m: client.models.generate_content(model=m, contents=contents, config=config),
                "image")
            parts = [p for c in (resp.candidates or []) for p in (c.content.parts if c.content else [])]
            img = next((p.inline_data.data for p in parts if p.inline_data and p.inline_data.data), None)
            if img is None:
                print(f"  no image returned ({model}); finish reason: "
                      f"{[c.finish_reason for c in resp.candidates or []]}", file=sys.stderr)
                continue
            path.write_bytes(img)
            chosen = out / f"{st['id']}.png"
            if not chosen.exists():
                chosen.write_bytes(img)
            print(f"  wrote {path} ({model})")


# --- shots --------------------------------------------------------------------------------------
def run_shots(spec, args):
    from google.genai import types
    out = OUT / "veo"
    out.mkdir(parents=True, exist_ok=True)
    client = None if args.dry_run else genai_client("us-central1")
    pending = []
    for sh in selected(spec["shots"], args.only):
        for k in range(1, takes_for("shots", args, sh) + 1):
            path = out / f"{sh['id']}-take{k}.mp4"
            if path.exists():
                continue
            start = OUT / "stills" / f"{sh['start']}.png" if sh.get("start") else None
            if start and not start.exists() and not args.dry_run:
                raise SystemExit(f"{sh['id']}: needs {start} -- run `generate.py stills` first")
            prompt = fill(sh["prompt"], spec)
            print(f"shot {path.name}: {sh['seconds']} s, start={start.name if start else 'text only'}")
            if args.dry_run:
                print(f"  prompt: {prompt}")
                continue
            source = types.GenerateVideosSource(
                prompt=prompt,
                image=types.Image(image_bytes=start.read_bytes(), mime_type="image/png") if start else None,
            )
            config = types.GenerateVideosConfig(
                aspect_ratio="16:9",           # Veo does 16:9 / 9:16; vhs.sh crops to 4:3
                duration_seconds=sh["seconds"],
                resolution="1080p",
                generate_audio=False,          # music and voices are ours
                number_of_videos=1,
                person_generation="allow_adult",
                negative_prompt=spec["negative"],
            )
            model, op = with_fallback(
                [args.video_model] if args.video_model else VIDEO_MODELS,
                lambda m: client.models.generate_videos(model=m, source=source, config=config),
                "video")
            pending.append((path, op, model))
    while pending:                              # all jobs run in parallel server-side
        time.sleep(15)
        still = []
        for path, op, model in pending:
            op = client.operations.get(op)
            if not op.done:
                still.append((path, op, model))
                continue
            if op.error:
                print(f"  {path.name}: failed: {op.error}", file=sys.stderr)
                continue
            vids = op.response.generated_videos if op.response else []
            if not vids:
                reasons = op.response.rai_media_filtered_reasons if op.response else None
                print(f"  {path.name}: no video (filtered: {reasons})", file=sys.stderr)
                continue
            path.write_bytes(vids[0].video.video_bytes)
            print(f"  wrote {path} ({model})")
        pending = still
        if pending:
            print(f"  waiting on {len(pending)} clip(s)...")


# --- voices -------------------------------------------------------------------------------------
def run_voices(spec, args):
    out = OUT / "voices"
    out.mkdir(parents=True, exist_ok=True)
    if not args.dry_run:
        from google.cloud import texttospeech as tts
        client = tts.TextToSpeechClient(client_options={"quota_project_id": PROJECT})
    for line in selected(spec["lines"], args.only):
        v = spec["voices"][line["who"]]
        for k in range(1, takes_for("voices", args) + 1):
            path = out / f"{line['id']}-take{k}.wav"
            if path.exists():
                continue
            print(f"voice {path.name}: {line['who']} ({v['voice']}): {line['text']}")
            if args.dry_run:
                continue

            def call(model):
                return client.synthesize_speech(
                    input=tts.SynthesisInput(text=line["text"], prompt=v["direction"]),
                    voice=tts.VoiceSelectionParams(language_code="en-US", name=v["voice"], model_name=model),
                    audio_config=tts.AudioConfig(audio_encoding=tts.AudioEncoding.LINEAR16, sample_rate_hertz=24000),
                )
            model, resp = with_fallback([args.tts_model] if args.tts_model else TTS_MODELS, call, "tts")
            path.write_bytes(resp.audio_content)
            print(f"  wrote {path} ({model})")


def takes_for(kind, args, item=None):
    if args.takes:
        return args.takes
    return {"stills": 3, "voices": 2}.get(kind) or (item or {}).get("takes", 2)


def confirm(spec, args):
    want = lambda k: args.what in (k, "all")  # noqa: E731
    stills = sum(takes_for("stills", args) for _ in selected(spec["stills"], args.only)) if want("stills") else 0
    secs = sum(sh["seconds"] * takes_for("shots", args, sh) for sh in selected(spec["shots"], args.only)) if want("shots") else 0
    lines = sum(takes_for("voices", args) for _ in selected(spec["lines"], args.only)) if want("voices") else 0
    print(f"project {PROJECT}: up to {stills} still(s), {secs} s of 1080p Veo video, {lines} voice take(s)"
          " (files that already exist are skipped and not billed)")
    if args.dry_run or args.yes:
        return
    if input("Generate? [y/N] ").strip().lower() != "y":
        raise SystemExit("cancelled")


def main():
    global PROJECT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["stills", "shots", "voices", "all"])
    ap.add_argument("--only", type=lambda s: set(s.split(",")), default=set())
    ap.add_argument("--takes", type=int, help="takes per item (default: stills 3, shots per spec or 2, voices 2)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--image-model")
    ap.add_argument("--video-model")
    ap.add_argument("--tts-model")
    args = ap.parse_args()
    PROJECT = args.project
    spec = json.loads((HERE / "spec.json").read_text())
    confirm(spec, args)
    if args.what in ("stills", "all"):
        run_stills(spec, args)
    if args.what in ("shots", "all"):
        run_shots(spec, args)
    if args.what in ("voices", "all"):
        run_voices(spec, args)


if __name__ == "__main__":
    main()
