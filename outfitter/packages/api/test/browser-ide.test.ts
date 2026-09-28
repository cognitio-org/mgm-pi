/**
 * Browser IDE phase 1 (#241, docs/specs/browser-ide.md §1-§2): the Tape option, the run's copy of
 * it, and `run.spec.ide`, which asks agentd to download code-server. The IDE is served through the
 * Drive previews pieces, so `ide` is only ever sent alongside `preview`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello } from "./agent-socket.ts";
import { FakeNgrok } from "./fake-ngrok.ts";
import { IDE_CODE_SERVER_PIN, loadConfig } from "../src/config.ts";
import type { TestApp } from "./helpers.ts";

const PREVIEWS = { PREVIEW_DOMAIN: "kernal.run", PREVIEW_ALLOW: "domain:mgms.eu" };

/** makeRunningSession seeds the Tape, so this runs inside firstSpec's setup. */
const ideTape = async (app: TestApp) => { await app.store.gurus.update("test-guru", { browserIde: true }); };

/** The first run.spec of a fresh running session, then a clean stop. */
async function firstSpec(app: TestApp, setup?: (runId: string) => Promise<void>) {
  const { session, runId, runToken } = await makeRunningSession(app);
  await setup?.(runId);
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  const spec = await agent.nextMessage();
  assert.equal(spec.t, "run.spec");
  const run = await app.store.runs.findById(runId);
  agent.send({ t: "bye", reason: "stop" });
  await agent.nextClose();
  app.stopBackgroundTasks();
  await app.fastify.close();
  return { spec, run };
}

describe("run.spec.ide (#241)", () => {
  test("sent with the pinned release when the Tape asks for the IDE and previews are on", async () => {
    const app = await buildTestApp(PREVIEWS, { ngrok: new FakeNgrok() });
    const { spec, run } = await firstSpec(app, () => ideTape(app));
    assert.ok(spec.preview, "the IDE rides on the preview pieces");
    assert.deepEqual(spec.ide, {
      version: IDE_CODE_SERVER_PIN.version,
      artifacts: { amd64: IDE_CODE_SERVER_PIN.artifacts.amd64, arm64: IDE_CODE_SERVER_PIN.artifacts.arm64 },
    });
    assert.equal(run?.browserIde, true);
  });

  test("not sent when previews are off, and the run records false", async () => {
    const app = await buildTestApp();
    const { spec, run } = await firstSpec(app, () => ideTape(app));
    assert.equal(spec.preview, undefined);
    assert.equal(spec.ide, undefined);
    assert.equal(run?.browserIde, false, "no button for a run that never got code-server");
  });

  test("not sent for a Tape without the option", async () => {
    const app = await buildTestApp(PREVIEWS, { ngrok: new FakeNgrok() });
    const { spec, run } = await firstSpec(app);
    assert.ok(spec.preview);
    assert.equal(spec.ide, undefined);
    assert.equal(run?.browserIde, false);
  });

  test("a run that already recorded it keeps it, whatever the Tape says now", async () => {
    const app = await buildTestApp(PREVIEWS, { ngrok: new FakeNgrok() });
    const { spec, run } = await firstSpec(app, async (runId) => {
      // As if an earlier connection of this run got `ide`, then the Tape was switched off.
      await app.store.runs.update(runId, { browserIde: true });
    });
    assert.ok(spec.ide);
    assert.equal(run?.browserIde, true);
  });
});

describe("the code-server pin (#241)", () => {
  test("defaults to IDE_CODE_SERVER_PIN, overridable per value", () => {
    assert.deepEqual(loadConfig({} as NodeJS.ProcessEnv).ideCodeServer, {
      version: IDE_CODE_SERVER_PIN.version,
      artifacts: { ...IDE_CODE_SERVER_PIN.artifacts },
    });
    const bumped = loadConfig({
      IDE_CODE_SERVER_VERSION: "4.140.0",
      IDE_CODE_SERVER_SHA256_AMD64: "AB".repeat(32),
    } as NodeJS.ProcessEnv).ideCodeServer;
    assert.equal(bumped.version, "4.140.0");
    assert.equal(bumped.artifacts.amd64, "ab".repeat(32), "lowercased");
    assert.equal(bumped.artifacts.arm64, IDE_CODE_SERVER_PIN.artifacts.arm64);
  });

  test("the pinned checksums are 64 hex characters", () => {
    for (const sha of Object.values(IDE_CODE_SERVER_PIN.artifacts)) assert.match(sha, /^[0-9a-f]{64}$/);
    assert.match(IDE_CODE_SERVER_PIN.version, /^\d+\.\d+\.\d+$/);
  });
});

describe("POST/PUT /api/gurus: browserIde (#241)", () => {
  test("stores a boolean, leaves it absent by default, and rejects anything else", async () => {
    const app = await buildTestApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "plain", model: "litellm/claude-auto-llm" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().browserIde, undefined);

    const ide = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "ide", model: "litellm/claude-auto-llm", browserIde: true },
    });
    assert.equal(ide.statusCode, 201);
    assert.equal(ide.json().browserIde, true);
    const off = await app.fastify.inject({
      method: "PUT",
      url: `/api/gurus/${ide.json().id}`,
      payload: { browserIde: false },
    });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().browserIde, false);

    const bad = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "bad", model: "litellm/claude-auto-llm", browserIde: "yes" },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /browserIde must be a boolean/);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
