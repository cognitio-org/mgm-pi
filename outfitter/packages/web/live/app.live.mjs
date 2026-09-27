// Live tests against the deployed web app (#219), signed in through IAP as the live-test service
// account (live/iap-token.mjs). Not part of `npm test`: run with `npm run test:live` (web package).
// The lifecycle test starts a real Drive and one short LLM turn on the "e2e (live tests)" Tape,
// which it creates on E2E_MODEL if missing, then archives and formats the floppy it made.
//
//   npm run test:live                         # mints a token with gcloud (configuration "outfitter")
//   E2E_IAP_TOKEN=... npm run test:live       # CI: token from google-github-actions/auth
//   E2E_SKIP_LIFECYCLE=1 npm run test:live    # page smoke only, creates nothing

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { LIVE, iapToken } from "./iap-token.mjs";

const TAPE_NAME = "e2e (live tests)";
const MODEL = process.env.E2E_MODEL ?? "litellm/gemini-3.5-flash-lite";
const REPLY_TIMEOUT_MS = Number(process.env.E2E_REPLY_TIMEOUT_MS ?? 6 * 60_000);
const FLOPPY_PREFIX = "live-test ";
// Where a failing test leaves a screenshot and the page's text (CI uploads it as an artifact).
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? "/tmp/outfitter-live";

let browser;
let context;
const pageErrors = [];

before(async () => {
  const token = await iapToken();
  // System Chrome, as scripts/record-tour.mjs does: GitHub's ubuntu runners ship it, so nothing to download.
  browser = await chromium.launch({ channel: "chrome" });
  context = await browser.newContext({
    baseURL: LIVE.origin,
    viewport: { width: 1280, height: 800 },
    // Authorization, not Proxy-Authorization: Chrome refuses to send the latter on page loads
    // (net::ERR_INVALID_ARGUMENT). IAP takes either, and the api only reads Authorization itself
    // for an `outf_` token, so a Google ID token there goes on to the IAP assertion check.
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  context.on("weberror", (e) => pageErrors.push(e.error().message));
});

after(async () => {
  await browser?.close();
});

async function api(method, path, data) {
  const res = await context.request.fetch(path, { method, data, failOnStatusCode: false });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : undefined };
}

/** Archive (stops the drive), then format; retries while the drive is still stopping. */
async function eraseFloppy(id) {
  const archived = await api("POST", `/api/sessions/${id}/archive`);
  if (archived.status === 404) return;
  for (let i = 0; i < 24; i++) {
    const res = await api("DELETE", `/api/sessions/${id}`);
    if (res.status === 204 || res.status === 404) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`floppy ${id} would not format`);
}

test("IAP admits the live-test identity, and the app sees it as a plain user", async () => {
  const me = await api("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.email, LIVE.serviceAccount);
  assert.equal(me.body.operator, false);
});

test("the main pages render without errors", async () => {
  const page = await context.newPage();
  for (const [path, heading] of [
    ["/fleet", "Disk Box"],
    ["/fleet?archived=only", "Archive"],
    ["/gurus", "Tapes"],
  ]) {
    await page.goto(path);
    await page.getByRole("heading", { level: 2, name: heading, exact: true }).waitFor();
  }
  await page.goto("/manual");
  await page.locator("#glossary-heading").waitFor();
  await page.goto("/");
  await page.locator(".desk-surface").first().waitFor();
  assert.equal(await page.locator('[aria-labelledby="notice-title"], .bomb-dialog').count(), 0, "no error dialog");
  assert.deepEqual(pageErrors, [], "no uncaught page errors");
  await page.close();
});

test("a floppy: create, get a reply, archive, format", { skip: process.env.E2E_SKIP_LIFECYCLE === "1" }, async () => {
  // Leftovers from a run that died half-way: erase any old live-test floppy this account owns.
  const old = await api("GET", "/api/sessions?archived=all");
  for (const s of old.body ?? []) {
    if (s.canManage && s.name?.startsWith(FLOPPY_PREFIX)) await eraseFloppy(s.id);
  }

  const tapes = await api("GET", "/api/gurus");
  let tape = tapes.body.find((g) => g.name === TAPE_NAME);
  if (!tape) {
    const created = await api("POST", "/api/gurus", {
      name: TAPE_NAME,
      model: MODEL,
      appendSystemPrompt: "You are a fixture for automated tests. Answer in one short line and do nothing else.",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    tape = created.body;
  }

  const page = await context.newPage();
  const name = `${FLOPPY_PREFIX}${new Date().toISOString()}`;
  let floppyId;
  try {
    await page.goto("/fleet");
    await page.getByRole("button", { name: "+ New Floppy" }).click();
    await page.locator("#ns-guru").selectOption(tape.id);
    await page.locator("#ns-name").fill(name);
    await page.locator("#ns-prompt").fill("Reply with exactly one word: pong");
    await page.getByRole("button", { name: "Start session" }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);
    floppyId = page.url().split("/").pop();

    // A cold Drive start plus one turn.
    await page.locator(".entry.assistant-text").first().waitFor({ timeout: REPLY_TIMEOUT_MS });

    await page.locator(".run-controls").getByRole("button", { name: "Archive" }).click();
    await page.locator(".archived-note").waitFor();
    assert.equal((await api("GET", `/api/sessions/${floppyId}`)).body.archivedAt !== undefined, true);

    // Format answers 409 while the drive is still stopping; retry through the UI a few times.
    for (let attempt = 0; ; attempt++) {
      await page.locator(".archived-note").getByRole("button", { name: "Format…" }).click();
      await page.getByRole("button", { name: "Yes, format" }).click();
      const outcome = await Promise.race([
        page.waitForURL(/\/fleet\?archived=only$/).then(() => "formatted"),
        // SystemErrorDialog's notice; FormatFloppyDialog also has .notice-dialog, so match its title.
        page.locator('[aria-labelledby="notice-title"]').waitFor().then(() => "refused"),
        page.locator(".bomb-dialog").waitFor().then(() => "failed"),
      ]);
      assert.notEqual(outcome, "failed", "format hit a system error");
      if (outcome === "formatted") break;
      assert.ok(attempt < 12, "format kept being refused");
      await page.getByRole("button", { name: "OK" }).click();
      await page.waitForTimeout(5_000);
    }
    assert.equal((await api("GET", `/api/sessions/${floppyId}`)).status, 404);
    floppyId = undefined;
    assert.deepEqual(pageErrors, [], "no uncaught page errors");
  } catch (err) {
    await mkdir(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: `${ARTIFACTS}/lifecycle.png`, fullPage: true }).catch(() => {});
    await writeFile(`${ARTIFACTS}/lifecycle.txt`, `${page.url()}\n\n${await page.locator("body").innerText().catch(() => "")}`);
    throw err;
  } finally {
    if (floppyId) await eraseFloppy(floppyId);
    await page.close();
  }
});
