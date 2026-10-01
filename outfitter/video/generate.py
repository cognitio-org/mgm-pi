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
    out = text.replace("{lead}", spec["lead"]).replace("{set}", spec.get("set", "")).replace("{suffix}", spec["suffix"])
    return out[:1].upper() + out[1:]


def selected(items, only):
    return [x for x in items if not only or x["id"] in only]


def not_found(err):
    s = str(err).lower()
    return ("not found" in s or "404" in s or "not supported" in s or "does not exist" in s
            # Vertex answers a model id the project can't see with a 403 that "may not exist"
            or ("permission" in s and "may not exist" in s))


def denied(err):
    s = str(err).lower()
    return "permission_denied" in s or "permission denied" in s or "403" in s


FIX_ACCESS = f"""
Every model was refused. Check, in order (as the account `gcloud auth application-default login`
used):
  1. APIs on:  gcloud services enable aiplatform.googleapis.com texttospeech.googleapis.com --project {{project}}
  2. Your role: gcloud projects add-iam-policy-binding {{project}} \\
                  --member=user:YOUR_EMAIL --role=roles/aiplatform.user
     (and roles/serviceusage.serviceUsageConsumer for the quota project)
  3. Quota project: gcloud auth application-default set-quota-project {{project}}
  4. The model is offered in your project/region: Vertex AI > Model Garden, or pass
     --image-model / --video-model / --tts-model with an id it lists.
"""


TRANSIENT = ("429", "resource_exhausted", "resource has been exhausted",  # per-minute quotas
             "499", "cancelled", "503", "unavailable", "504", "deadline", "500 internal",
             "connection reset", "connection aborted", "temporarily")
FAILED = []  # takes that failed for good this run; a rerun retries just these


def transient(err):
    s = str(err).lower()
    return any(t in s for t in TRANSIENT) or ("quota" in s and "exceeded" in s)


def with_retry(call, m, label, waits=(15, 30, 60, 120, 240)):
    """Quotas and server hiccups clear on their own: wait and retry instead of dying."""
    for wait in (*waits, None):
        try:
            return call(m)
        except Exception as e:  # noqa: BLE001
            if wait is None or not transient(e):
                raise
            print(f"  {label}: temporary error on {m} ({str(e)[:80]}), retrying in {wait} s", file=sys.stderr)
            time.sleep(wait)


def skip(path, err):
    """One bad take shouldn't stop the run: note it and move on (a rerun retries it)."""
    FAILED.append(path.name)
    print(f"  {path.name}: failed, skipped ({str(err)[:200]})", file=sys.stderr)


def with_fallback(models, call, label):
    errors = []
    for m in models:
        try:
            return m, with_retry(call, m, label)
        except Exception as e:  # noqa: BLE001 -- surfaced below
            if not not_found(e):
                raise
            print(f"  {label}: {m} unavailable ({str(e)[:140]}), trying next", file=sys.stderr)
            errors.append(e)
    hint = FIX_ACCESS.format(project=PROJECT) if errors and all(denied(e) for e in errors) else ""
    raise SystemExit(f"{label}: none of {models} is usable in {PROJECT}.{hint}\nLast error: {errors[-1] if errors else ''}")


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
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                response_modalities=["IMAGE"],
                image_config=types.ImageConfig(aspect_ratio=aspect, image_size="2K"),
            )
            try:
                model, resp = with_fallback(
                    [args.image_model] if args.image_model else IMAGE_MODELS,
                    lambda m: client.models.generate_content(model=m, contents=contents, config=config),
                    "image")
            except Exception as e:  # noqa: BLE001
                skip(path, e)
                continue
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
            def submit(m, source=source, config=config):
                return client.models.generate_videos(model=m, source=source, config=config)
            try:
                model, op = with_fallback(
                    [args.video_model] if args.video_model else VIDEO_MODELS, submit, "video")
            except Exception as e:  # noqa: BLE001
                skip(path, e)
                continue
            pending.append({"path": path, "op": op, "model": model, "submit": submit, "tries": 1})
    while pending:                              # all jobs run in parallel server-side
        time.sleep(15)
        still = []
        for job in pending:
            path, model = job["path"], job["model"]
            try:
                op = job["op"] = with_retry(lambda _m: client.operations.get(job["op"]), model, "video")
            except Exception as e:  # noqa: BLE001
                skip(path, e)
                continue
            if not op.done:
                still.append(job)
                continue
            if op.error:
                # Veo sometimes fails a job server-side ("Service is currently unavailable");
                # those aren't billed, so resubmit a couple of times before giving up.
                if transient(op.error) and job["tries"] < 3:
                    job["tries"] += 1
                    print(f"  {path.name}: Veo error ({str(op.error)[:90]}); resubmitting, try {job['tries']} of 3",
                          file=sys.stderr)
                    try:
                        job["op"] = with_retry(job["submit"], model, "video")
                        still.append(job)
                    except Exception as e:  # noqa: BLE001
                        skip(path, e)
                    continue
                skip(path, op.error)
                continue
            vids = op.response.generated_videos if op.response else []
            if not vids:
                reasons = op.response.rai_media_filtered_reasons if op.response else None
                skip(path, f"no video returned (safety filter: {reasons}); try rewording the prompt")
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
            try:
                model, resp = with_fallback([args.tts_model] if args.tts_model else TTS_MODELS, call, "tts")
            except Exception as e:  # noqa: BLE001
                skip(path, e)
                continue
            path.write_bytes(resp.audio_content)
            print(f"  wrote {path} ({model})")


def takes_for(kind, args, item=None):
    if args.takes:
        return args.takes
    return {"stills": 3, "voices": 2}.get(kind) or (item or {}).get("takes", 2)


def missing(kind, ext, items, args, subdir):
    """Takes that don't exist yet -- the only ones a run generates (and bills)."""
    return [it for it in items for k in range(1, takes_for(kind, args, it) + 1)
            if not (OUT / subdir / f"{it['id']}-take{k}.{ext}").exists()]


def confirm(spec, args):
    want = lambda k: args.what in (k, "all")  # noqa: E731
    stills = len(missing("stills", "png", selected(spec["stills"], args.only), args, "stills")) if want("stills") else 0
    shots = missing("shots", "mp4", selected(spec["shots"], args.only), args, "veo") if want("shots") else []
    secs = sum(sh["seconds"] for sh in shots)
    lines = len(missing("voices", "wav", selected(spec["lines"], args.only), args, "voices")) if want("voices") else 0
    if not (stills or secs or lines):
        print("nothing to generate: every take already exists in out/")
        raise SystemExit(0)
    print(f"project {PROJECT}: will generate {stills} still(s), {secs} s of 1080p Veo video, {lines} voice take(s)"
          " (takes already in out/ are skipped)")
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
    if FAILED:
        raise SystemExit(f"{len(FAILED)} take(s) failed: {', '.join(FAILED)}. Run the same command again to retry just those.")


if __name__ == "__main__":
    main()
