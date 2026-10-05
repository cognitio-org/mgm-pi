import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, runTokenFor, sendHello } from "./agent-socket.ts";
import { isModelId, setModelCommand } from "../src/session-model.ts";
import type { Session } from "../src/store/types.ts";

type App = Awaited<ReturnType<typeof buildTestApp>>;

async function seedStoppedSession(app: App, overrides: Partial<Session> = {}): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = { id: "s-model", guruId: "test-guru", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now, ...overrides };
  await app.store.sessions.insert(session);
  return session;
}

function putModel(app: App, sessionId: string, model: unknown) {
  return app.fastify.inject({ method: "PUT", url: `/api/sessions/${sessionId}/model`, payload: { model } });
}

describe("session model helpers", () => {
  test("isModelId takes provider/id and nothing looser", () => {
    for (const ok of ["litellm/gpt-5-mini", "litellm/openrouter/qwen/qwen3-coder", "bedrock/anthropic.claude-v2:1"]) assert.equal(isModelId(ok), true, ok);
    for (const bad of ["", "gpt-5", "/x", "litellm/", "litellm/a b", " litellm/x", 42, null, undefined, `p/${"x".repeat(200)}`]) {
      assert.equal(isModelId(bad), false, String(bad));
    }
  });

  test("setModelCommand splits at the first slash, as pi's set_model wants", () => {
    assert.deepEqual(setModelCommand("litellm/openrouter/qwen/qwen3-coder"), { type: "set_model", provider: "litellm", modelId: "openrouter/qwen/qwen3-coder" });
  });
});

describe("PUT /api/sessions/:id/model", () => {
  test("with no Drive going, stores the floppy's model for the next run, and null goes back to the tape's", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/claude-auto-llm" });
    const session = await seedStoppedSession(app);

    const res = await putModel(app, session.id, "litellm/gpt-5-mini");
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { modelOverride: "litellm/gpt-5-mini", model: "litellm/gpt-5-mini", applied: "next-run" });
    const detail = (await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json();
    assert.equal(detail.modelOverride, "litellm/gpt-5-mini");
    assert.equal(detail.guruModel, "litellm/claude-auto-llm");

    const cleared = await putModel(app, session.id, null);
    assert.deepEqual(cleared.json(), { modelOverride: null, model: "litellm/claude-auto-llm", applied: "next-run" });
    const stored = await app.store.sessions.findById(session.id);
    assert.equal("modelOverride" in stored!, false, "cleared, not set to null");
    await app.fastify.close();
  });

  test("the next run's spec starts on the switched model", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/claude-auto-llm" });
    const session = await seedStoppedSession(app);
    await putModel(app, session.id, "litellm/gpt-5-mini");

    const run = await app.runs.wake(session.id);
    assert.deepEqual(await app.store.runs.drainDownMessages(run.id), [], "a run started after the switch needs no set_model");
    const agent = await openAgentSocket(app, run.id);
    sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
    const spec = await agent.nextMessage();
    assert.equal(spec.guru.model, "litellm/gpt-5-mini");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a running Drive's pi is told to set_model straight away", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec
    agent.send({ t: "status", state: "idle" });
    for (let i = 0; i < 50 && (await app.store.runs.findById(runId))?.state !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));

    const res = await putModel(app, session.id, "litellm/openrouter/qwen/qwen3-coder");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().applied, "live");
    assert.deepEqual(await agent.nextMessage(), {
      t: "rpc",
      command: { type: "set_model", provider: "litellm", modelId: "openrouter/qwen/qwen3-coder" },
    });

    // Back to the tape's model (seedGuru's provider/model), live too.
    await putModel(app, session.id, null);
    assert.deepEqual(await agent.nextMessage(), { t: "rpc", command: { type: "set_model", provider: "provider", modelId: "model" } });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a Drive still starting gets set_model queued, delivered once pi is up", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app); // provisioning
    const res = await putModel(app, session.id, "litellm/gpt-5-mini");
    assert.equal(res.json().applied, "live");
    const run = await app.store.runs.findById(runId);
    assert.deepEqual(run?.pending, [{ t: "rpc", command: { type: "set_model", provider: "litellm", modelId: "gpt-5-mini" } }]);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a laptop model with the laptop offline switches to the tape's fallback and says so", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);
    await app.store.gurus.update("test-guru", { fallbackModel: "litellm/gpt-5-mini" });
    app.laptopProbe.setOnline(false);

    const res = await putModel(app, session.id, "litellm/local-qwen-mlx");
    assert.deepEqual(res.json(), {
      modelOverride: "litellm/local-qwen-mlx",
      model: "litellm/gpt-5-mini",
      applied: "live",
      modelFallback: { wanted: "litellm/local-qwen-mlx", used: "litellm/gpt-5-mini" },
    });
    const run = await app.store.runs.findById(runId);
    assert.deepEqual(run?.modelFallback, { wanted: "litellm/local-qwen-mlx", used: "litellm/gpt-5-mini" });
    assert.deepEqual(run?.pending, [{ t: "rpc", command: { type: "set_model", provider: "litellm", modelId: "gpt-5-mini" } }]);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a stopping Drive is left alone; the next run starts on the new model", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);
    await app.store.runs.update(runId, { state: "stopping" });
    const res = await putModel(app, session.id, "litellm/gpt-5-mini");
    assert.equal(res.json().applied, "next-run");
    assert.deepEqual((await app.store.runs.findById(runId))?.pending, []);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("refuses a malformed model, a missing one, and an archived floppy", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const session = await seedStoppedSession(app);
    assert.equal((await putModel(app, session.id, "not a model")).statusCode, 400);
    assert.equal((await app.fastify.inject({ method: "PUT", url: `/api/sessions/${session.id}/model`, payload: {} })).statusCode, 400);
    assert.equal((await putModel(app, "nope", "litellm/x")).statusCode, 404);
    await app.store.sessions.setArchivedAt(session.id, new Date().toISOString());
    assert.equal((await putModel(app, session.id, "litellm/x")).statusCode, 409);
    assert.equal((await app.store.sessions.findById(session.id))?.modelOverride, undefined);
    await app.fastify.close();
  });
});
