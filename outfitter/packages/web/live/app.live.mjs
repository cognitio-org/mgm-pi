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
import { finish, shot } from "./shots.mjs";

// A fixed id, so a same-named Tape someone else made is never picked up; its settings are put back
// on every run, so E2E_MODEL changes take effect and nobody's edits linger.
const TAPE_ID = "e2e-live-tests";
const TAPE_NAME = "e2e (live tests)";
const MODEL = process.env.E2E_MODEL ?? "litellm/gemini-3.5-flash-lite";
const REPLY_TIMEOUT_MS = Number(process.env.E2E_REPLY_TIMEOUT_MS ?? 6 * 60_000);
const FLOPPY_PREFIX = "live-test ";
// Where a failing test leaves a screenshot and the page's text (CI uploads it as an artifact).
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? "/tmp/outfitter-live";
// Every step's screenshot, pass or fail, plus index.html (shots.mjs). CI uploads this on every run.
const SHOTS = `${ARTIFACTS}/shots`;
const STARTED_AT = new Date().toISOString();

// A leftover from an earlier run is only erased once it's this old, so a run never erases the floppy
// of another run happening at the same time (a local run during CI's, say).
const STALE_MS = 30 * 60_000;

let browser;
let context;
let token;
const pageErrors = [];

before(async () => {
  token = await iapToken();
  // System Chrome, as scripts/record-tour.mjs does: GitHub's ubuntu runners ship it, so nothing to download.
  browser = await chromium.launch({ channel: "chrome" });
  context = await browser.newContext({
    baseURL: LIVE.origin,
    viewport: { width: 1280, height: 800 },
  });
  // The token goes to the app's own origin and nowhere else: not to a third-party asset, an HTML
  // preview's external resources or an off-origin redirect. Authorization, not
  // Proxy-Authorization: Chrome refuses to send the latter on page loads (net::ERR_INVALID_ARGUMENT).
  // IAP takes either, and the api only reads Authorization itself for an `outf_` token, so a Google
  // ID token there goes on to the IAP assertion check.
  const origin = new URL(LIVE.origin).origin;
  await context.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) return route.continue();
    return route.continue({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
  });
  context.on("weberror", (e) => pageErrors.push(e.error().message));
});

after(async () => {
  // What was tested, for the gallery's heading (GET /api/version; absent on older deploys).
  const version = context ? await api("GET", "/api/version").catch(() => undefined) : undefined;
  await finish(SHOTS, {
    origin: LIVE.origin,
    startedAt: STARTED_AT,
    ...(version?.status === 200 && version.body ? { release: version.body.release ?? undefined, commit: version.body.commit ?? undefined } : {}),
  }).catch((err) => console.error("writing the screenshot gallery failed:", err));
  await browser?.close();
});

async function api(method, path, data) {
  const res = await context.request.fetch(path, {
    method,
    data,
    headers: { authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  // IAP answers a refusal with HTML: keep the status, don't throw a SyntaxError.
  const json = (res.headers()["content-type"] ?? "").includes("application/json");
  return { status: res.status(), body: json ? await res.json() : undefined };
}

/** Navigates, waits for `ready`, checks no error dialog or uncaught page error showed up, and takes
 * the step's screenshot (a FAILED one if any of that didn't hold). */
async function visit(page, path, ready, testName, step) {
  const own = [FLOPPY_PREFIX, TAPE_NAME]; // the suite's own floppies and Tape stay readable in shots
  try {
    await page.goto(path);
    await ready.waitFor();
    assert.equal(await page.locator('[aria-labelledby="notice-title"], .bomb-dialog').count(), 0, `no error dialog on ${path}`);
    assert.deepEqual(pageErrors, [], `no uncaught page errors on ${path}`);
  } catch (err) {
    await shot(page, SHOTS, testName, `${step} (failed)`, { own, ok: false });
    throw err;
  }
  await shot(page, SHOTS, testName, step, { own });
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
  const heading = (name) => page.getByRole("heading", { level: 2, name, exact: true });
  const t = "main pages";
  await visit(page, "/fleet", heading("Disk Box"), t, "Disk Box");
  await visit(page, "/fleet?archived=only", heading("Archive"), t, "Archive");
  await visit(page, "/gurus", heading("Tapes"), t, "Tapes");
  await visit(page, "/manual", page.locator("#glossary-heading"), t, "Manual");
  await visit(page, "/", page.locator(".desk-surface").first(), t, "Desk");
  await page.close();
});

test("a floppy: create, get a reply, archive, format", { skip: process.env.E2E_SKIP_LIFECYCLE === "1" }, async () => {
  // Leftovers from a run that died half-way: erase any old live-test floppy this account owns.
  const old = await api("GET", "/api/sessions?archived=all");
  assert.equal(old.status, 200, `listing floppies: ${old.status}`);
  for (const s of old.body) {
    const startedAt = Date.parse(s.name?.slice(FLOPPY_PREFIX.length) ?? "");
    if (s.canManage && s.name?.startsWith(FLOPPY_PREFIX) && Date.now() - startedAt > STALE_MS) await eraseFloppy(s.id);
  }

  const settings = {
    name: TAPE_NAME,
    model: MODEL,
    appendSystemPrompt: "You are a fixture for automated tests. Answer in one short line and do nothing else.",
  };
  const put = await api("PUT", `/api/gurus/${TAPE_ID}`, settings);
  if (put.status === 404) {
    const created = await api("POST", "/api/gurus", { id: TAPE_ID, ...settings });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  } else {
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }
  const tape = { id: TAPE_ID };

  const page = await context.newPage();
  const name = `${FLOPPY_PREFIX}${new Date().toISOString()}`;
  // Its own floppy and Tape stay readable in the shots; everyone else's rows are masked.
  const snap = (step) => shot(page, SHOTS, "floppy lifecycle", step, { own: [name, TAPE_NAME] });
  let floppyId;
  try {
    await page.goto("/fleet");
    await page.getByRole("button", { name: "+ New Floppy" }).click();
    await page.locator("#ns-guru").selectOption(tape.id);
    await page.locator("#ns-name").fill(name);
    await page.locator("#ns-prompt").fill("Reply with exactly one word: pong");
    await snap("New Floppy, filled in");
    await page.getByRole("button", { name: "Start session" }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);
    floppyId = page.url().split("/").pop();
    await snap("Session page, starting");

    // A cold Drive start plus one turn.
    await page.locator(".entry.assistant-text").first().waitFor({ timeout: REPLY_TIMEOUT_MS });
    await snap("The reply arrived");

    await page.locator(".run-controls").getByRole("button", { name: "Archive" }).click();
    await page.locator(".archived-note").waitFor();
    await snap("Archived");
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
      if (outcome === "formatted") {
        await snap("Formatted, back in the Archive");
        break;
      }
      assert.ok(attempt < 12, "format kept being refused");
      await page.getByRole("button", { name: "OK" }).click();
      await page.waitForTimeout(5_000);
    }
    assert.equal((await api("GET", `/api/sessions/${floppyId}`)).status, 404);
    floppyId = undefined;
    assert.deepEqual(pageErrors, [], "no uncaught page errors");
  } catch (err) {
    await shot(page, SHOTS, "floppy lifecycle", "Failed here", { own: [name, TAPE_NAME], ok: false });
    await mkdir(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: `${ARTIFACTS}/lifecycle.png`, fullPage: true }).catch(() => {});
    // The page text too, locally: CI uploads only the screenshot (the text can name other people's
    // floppies, and artifacts are readable by anyone with repository read access).
    await writeFile(`${ARTIFACTS}/lifecycle.txt`, `${page.url()}\n\n${await page.locator("body").innerText().catch(() => "")}`);
    throw err;
  } finally {
    if (floppyId) await eraseFloppy(floppyId);
    await page.close();
  }
});
