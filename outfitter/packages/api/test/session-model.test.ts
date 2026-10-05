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
    for (const bad of ["", "gpt-5", "/x", "litellm/gpt-5:high", "litellm/x:off", "litellm/", "litellm/a b", " litellm/x", 42, null, undefined, `p/${"x".repeat(200)}`]) {
      assert.equal(isModelId(bad), false, String(bad));
    }
  });

  test("setModelCommand splits at the first slash, as pi's set_model wants", () => {
    assert.deepEqual(setModelCommand("litellm/openrouter/qwen/qwen3-coder"), { type: "set_model", provider: "litellm", modelId: "openrouter/qwen/qwen3-coder" });
  });
});

describe("PUT /api/sessions/:id/model", () => {
  test("with no Drive going, stores the floppy's model for the next run, and null copies the tape's", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/claude-auto-llm" });
    const session = await seedStoppedSession(app);

    const res = await putModel(app, session.id, "litellm/gpt-5-mini");
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { modelOverride: "litellm/gpt-5-mini", model: "litellm/gpt-5-mini", applied: "next-run" });
    const detail = (await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json();
    assert.equal(detail.modelOverride, "litellm/gpt-5-mini");
    assert.equal(detail.guruModel, "litellm/claude-auto-llm");

    const copied = await putModel(app, session.id, null);
    assert.deepEqual(copied.json(), { modelOverride: "litellm/claude-auto-llm", model: "litellm/claude-auto-llm", applied: "next-run" });
    assert.equal((await app.store.sessions.findById(session.id))?.modelOverride, "litellm/claude-auto-llm", "a copy, not a link to the tape");
    await app.fastify.close();
  });

  test("a new floppy pins the tape's model; a later tape edit doesn't move it", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/claude-auto-llm" });
    const created = await app.fastify.inject({ method: "POST", url: "/api/sessions", payload: { guruId: "test-guru", prompt: "hi" } });
    const { session, run } = created.json();
    assert.equal(session.modelOverride, "litellm/claude-auto-llm");
    await app.store.gurus.update("test-guru", { model: "litellm/gpt-5-mini" });

    const agent = await openAgentSocket(app, run.id);
    sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
    assert.equal((await agent.nextMessage()).guru.model, "litellm/claude-auto-llm");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a floppy from before the pin restores on its transcript's last model, not the tape's", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/gpt-5-mini" });
    const session = await seedStoppedSession(app); // no modelOverride
    await app.store.entries.insertIfNew(session.id, 1, { id: "m1", type: "model_change", provider: "litellm", modelId: "claude-auto-llm" });
    await app.store.entries.insertIfNew(session.id, 2, { id: "m2", type: "model_change", provider: "litellm", modelId: "qwen3-coder" });

    const run = await app.runs.wake(session.id);
    const agent = await openAgentSocket(app, run.id);
    sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
    assert.equal((await agent.nextMessage()).guru.model, "litellm/qwen3-coder");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
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

  test("two switches at once leave pi on what the floppy stores", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);
    // The first PUT's laptop probe is slow; the second lands while it waits.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const probe = app.laptopProbe.isOnline.bind(app.laptopProbe);
    let calls = 0;
    app.laptopProbe.isOnline = async () => {
      if (calls++ === 0) await gate;
      return probe();
    };
    const first = putModel(app, session.id, "litellm/model-a");
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await putModel(app, session.id, "litellm/model-b");
    release();
    assert.equal((await first).json().modelOverride, "litellm/model-b", "the late one reports what is stored");
    assert.equal(second.json().modelOverride, "litellm/model-b");
    const pending = (await app.store.runs.findById(runId))?.pending ?? [];
    assert.deepEqual(pending.at(-1), { t: "rpc", command: { type: "set_model", provider: "litellm", modelId: "model-b" } });
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
