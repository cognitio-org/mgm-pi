// Web voice live checks (#254, epic #256): the Composer's mic against real Deepgram, with Chrome's
// fake mic playing a spoken sentence. Run from the lifecycle test in app.live.mjs on the floppy it
// already made (a session page needs a floppy, and a floppy needs a Drive), with "after speaking"
// set to review through the mic's own menu, so nothing is sent and no model runs. The sentence is
// generated, not committed: `say` on macOS; in CI a separate job with no token rights makes it with
// espeak-ng and hands it over as E2E_MIC_FIXTURE.

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const run = promisify(execFile);

export const SENTENCE = "Please fix the login bug and add a test.";
/** What must come back: Deepgram's wording of a synthetic voice varies, but these words make it. */
export const HEARD = /login|bug|test/i;

/** The spoken sentence as a WAV, or undefined when there's none and no speech tool to make one. */
export async function speechFixture(dir) {
  const given = process.env.E2E_MIC_FIXTURE;
  if (given) return (await stat(given).catch(() => undefined))?.size > 1000 ? given : undefined;
  await mkdir(dir, { recursive: true });
  const path = `${dir}/voice-fixture.wav`;
  try {
    if (process.platform === "darwin") {
      await run("say", ["-o", path, "--data-format=LEI16@16000", SENTENCE]);
    } else {
      await run("espeak-ng", ["-s", "140", "-w", path, SENTENCE]);
    }
    if ((await stat(path)).size > 1000) return path;
  } catch {
    // no speech tool: the voice checks skip, saying why
  }
  return undefined;
}

/** Chrome flags that make the fixture its microphone, with no permission prompt. */
export function fakeMicArgs(fixture) {
  return fixture
    ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}`]
    : [];
}

const idle = (page) =>
  page.waitForFunction(() => {
    const mic = document.querySelector(".voice-mic");
    return mic && !mic.classList.contains("is-live") && mic.getAttribute("aria-pressed") === "false";
  }, null, { timeout: 15_000 });

/**
 * Hold, tap-tap, ⌥/Alt+Space and Esc on the session page that's open, then the spend line.
 * `api(method, path, data)` calls the app as the signed-in identity; `snap(step)` screenshots.
 * Returns why it skipped, or undefined when it ran.
 */
export async function voiceChecks({ page, api, snap }) {
  const cfg = await api("GET", "/api/me/voice");
  assert.equal(cfg.status, 200, `GET /api/me/voice: ${cfg.status}`);
  if (!cfg.body.deepgram) return "Deepgram voice is off on this deployment";
  const before = cfg.body.prefs.afterSpeaking;
  const mic = page.locator(".voice-mic");
  const box = page.locator(".composer textarea");
  // Nothing here may send: a message would start a real turn on the floppy.
  const sends = [];
  const onRequest = (req) => {
    if (req.method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(new URL(req.url()).pathname)) sends.push(req.url());
  };
  page.on("request", onRequest);
  try {
    await mic.waitFor();
    // Review, through the menu: the open page reads the setting once, when it loads, so changing
    // it through the API now wouldn't reach it, and "send" would start a real turn.
    await page.locator(".voice-options").click();
    // The Deepgram item turns enabled once the page has its voice settings; clicking before that
    // could be undone when they arrive.
    await page.locator(".voice-menu [role='menuitemradio']:not([disabled])", { hasText: /^Deepgram$/ }).waitFor({ timeout: 10_000 });
    const reviewItem = page.locator(".voice-menu [role='menuitemradio']", { hasText: "Leave it to review" });
    // The menu shows the choice before it's saved and reverts if the save fails, so wait for the save.
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/me/voice", { timeout: 10_000 }),
      reviewItem.click(),
    ]);
    assert.ok(saved.ok(), `saving "after speaking: review" answered ${saved.status()}`);
    assert.equal(await reviewItem.getAttribute("aria-checked"), "true", "after speaking is set to review");
    await page.keyboard.press("Escape");
    await box.fill("");

    // Hold the button: recording while held, the transcript in the box on release.
    const b = await mic.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(4_000);
    assert.equal(await mic.getAttribute("aria-pressed"), "true", "the mic is live while held");
    await snap("Voice: holding the mic");
    await page.mouse.up();
    await idle(page);
    assert.match(await box.inputValue(), HEARD, "a hold transcribes into the box");
    await snap("Voice: after a hold");

    // Tap to latch, tap to stop.
    await box.fill("");
    await mic.click();
    await page.waitForTimeout(500);
    assert.equal(await mic.getAttribute("aria-pressed"), "true", "a tap latches the mic on");
    await page.waitForTimeout(3_500);
    await mic.click();
    await idle(page);
    assert.match(await box.inputValue(), HEARD, "tap, tap transcribes into the box");

    // Hold the shortcut, after typed text.
    await box.fill("Typed:");
    await page.keyboard.down("Alt");
    await page.keyboard.down("Space");
    await page.waitForTimeout(4_000);
    assert.equal(await mic.getAttribute("aria-pressed"), "true", "the mic is live while Alt+Space is held");
    await page.keyboard.up("Space");
    await page.keyboard.up("Alt");
    await idle(page);
    const shortcut = await box.inputValue();
    assert.ok(shortcut.startsWith("Typed: "), `the transcript follows typed text: ${JSON.stringify(shortcut)}`);
    assert.match(shortcut, HEARD, "a shortcut hold transcribes into the box");

    // Esc cancels and puts the draft back.
    await box.fill("keep this");
    await mic.click();
    await page.waitForTimeout(2_500);
    await page.keyboard.press("Escape");
    await idle(page);
    assert.equal(await box.inputValue(), "keep this", "Esc restores the draft");

    // The spend line in the mic's menu (the figures themselves lag, so only their shape).
    await page.locator(".voice-options").click();
    const spend = page.locator(".voice-spend-line");
    await spend.waitFor({ timeout: 15_000 });
    assert.match(await spend.textContent(), /today · .+ week · .+ month/);
    await snap("Voice: settings menu with spend");
    await page.keyboard.press("Escape");
    await box.fill("");
    assert.deepEqual(sends, [], "the voice checks sent nothing");
  } finally {
    page.off("request", onRequest);
    // Reported whether or not an earlier check failed first: a send starts a real turn.
    if (sends.length > 0) console.warn(`voice checks: a message was sent during them: ${sends.join(", ")}`);
    if (before !== "review") {
      const restored = await api("PUT", "/api/me/voice", { afterSpeaking: before }).catch((err) => ({ status: String(err) }));
      if (restored.status !== 200) console.warn(`voice checks: couldn't put "after speaking" back to ${before} (${restored.status})`);
    }
  }
  return undefined;
}
