#!/usr/bin/env node
// Records the Manual tour animation (/manual?autoplay=1&chrome=0) to a .webm video for
// docs/design/tour.webm, then -- if ffmpeg is on PATH -- also renders an optimised 640px-wide gif
// alongside it. Uses playwright-core's `recordVideo` against the *system* Chrome (channel:
// "chrome"), so it never downloads a bundled browser: run it once with Chrome installed on the
// machine, and Playwright's own npx-installed browsers are irrelevant here.
//
// Usage (see docs/reports/manual-tour.md for the full walkthrough):
//   1. Build the web bundle and start packages/api pointed at it (see that report for the exact
//      env vars), or run `npm run dev` in packages/web and pass --url to point at the dev server.
//   2. node scripts/record-tour.mjs [--url http://localhost:8097] [--out ../../docs/design]
//
// Recording length: the tour is ~75s; this script waits for the "READY." closing caption (or a
// generous timeout) before stopping, so the output is close to that length.

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE_URL = argValue("--url", "http://localhost:8097");
const OUT_DIR = path.resolve(__dirname, argValue("--out", "../../../docs/design"));
const WIDTH = 1280;
const HEIGHT = 720;
// Generous cap: the tour is ~75s; give it up to 95s before giving up on the "READY." wait.
const MAX_WAIT_MS = 95_000;

async function ffmpegAvailable() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const videoDir = path.join(OUT_DIR, ".tour-recording-tmp");
  await rm(videoDir, { recursive: true, force: true });
  await mkdir(videoDir, { recursive: true });

  console.log(`Launching system Chrome, recording ${BASE_URL}/manual?autoplay=1&chrome=0 ...`);
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();

  // "load" rather than "networkidle": the header's provider-health strip polls in the background,
  // so the network is never idle and "networkidle" would hang indefinitely.
  await page.goto(`${BASE_URL}/manual?autoplay=1&chrome=0`, { waitUntil: "load", timeout: 30_000 });

  // Wait for the tour to reach its finished state -- TourAnimation.tsx only renders
  // .tour-end-actions ("Start a new floppy" / "Replay") once playback is done -- or time out
  // generously, whichever comes first, so the recording covers the full ~75s tour without running
  // forever if something stalls. (Matching the closing caption's text would be ambiguous: the
  // Kernal scene's caption also contains the word "READY.".)
  try {
    await page.waitForSelector(".tour-end-actions", { timeout: MAX_WAIT_MS, state: "attached" });
    // Small settle so the closing frame isn't cut off mid-transition.
    await page.waitForTimeout(1500);
  } catch {
    console.warn("Timed out waiting for the closing caption -- stopping the recording anyway.");
  }

  await context.close();
  await browser.close();

  // recordVideo writes a randomly-named .webm into videoDir; move it to the final path.
  const files = await readdir(videoDir);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) {
    throw new Error(`No .webm found in ${videoDir} -- recording may have failed.`);
  }
  const finalWebm = path.join(OUT_DIR, "tour.webm");
  await rename(path.join(videoDir, webm), finalWebm);
  await rm(videoDir, { recursive: true, force: true });

  const { size } = await stat(finalWebm);
  console.log(`Wrote ${finalWebm} (${(size / 1024 / 1024).toFixed(2)} MB)`);

  if (await ffmpegAvailable()) {
    const gifPath = path.join(OUT_DIR, "tour.gif");
    console.log("ffmpeg found -- rendering an optimised 640px-wide tour.gif ...");
    // Two-pass palette approach for a smaller, cleaner gif than a naive single-pass conversion.
    const palette = path.join(OUT_DIR, ".tour-palette.png");
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      finalWebm,
      "-vf",
      "fps=12,scale=640:-1:flags=lanczos,palettegen",
      palette,
    ]);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      finalWebm,
      "-i",
      palette,
      "-lavfi",
      "fps=12,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse",
      gifPath,
    ]);
    await rm(palette, { force: true });
    const { size: gifSize } = await stat(gifPath);
    console.log(`Wrote ${gifPath} (${(gifSize / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    console.warn("ffmpeg not found on PATH -- skipping tour.gif (tour.webm was still written).");
  }
}

// Hard watchdog: something in Playwright/Chrome should never hang forever and silently eat CI
// time. If we haven't finished within a generous margin over MAX_WAIT_MS, force-exit.
const watchdog = setTimeout(
  () => {
    console.error(`Watchdog timeout after ${MAX_WAIT_MS + 60_000}ms -- forcing exit.`);
    process.exit(1);
  },
  MAX_WAIT_MS + 60_000,
);
watchdog.unref?.();

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
