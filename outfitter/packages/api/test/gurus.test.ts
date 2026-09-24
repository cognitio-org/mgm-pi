// Finding #6 (docs/reports/security-review-pr1.md): guru.env is merged verbatim into the pi child
// process's environment (agentd's guru.ts renderGuru), so any domain user creating/editing a guru
// must not be able to set an env var that would let them plant code-exec or hijack agentd's own
// auth-header env vars into a guru other people also use.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";

describe("POST /api/gurus: guru.env denylist", () => {
  for (const key of [
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "PATH",
    "HOME",
    "GIT_CONFIG_COUNT",
    "GIT_SSH_COMMAND",
    "LITELLM_BASE_URL",
    "LITELLM_API_KEY",
    "LITELLM_AGENT_KEY",
    "OUTFITTER_TOKEN",
  ]) {
    test(`rejects guru.env.${key} with 400`, async () => {
      const app = await buildTestApp();
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/gurus",
        payload: { name: "evil-guru", model: "litellm/local-qwen-mlx", env: { [key]: "x" } },
      });
      assert.equal(res.statusCode, 400);
      await app.fastify.close();
    });
  }

  test("accepts a guru with a benign env var", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "fine-guru", model: "litellm/local-qwen-mlx", env: { MY_APP_FLAG: "1" } },
    });
    assert.equal(res.statusCode, 201);
    await app.fastify.close();
  });
});

describe("PUT /api/gurus/:id: guru.env denylist", () => {
  test("rejects updating guru.env to include a denylisted key", async () => {
    const app = await buildTestApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "ok-guru", model: "litellm/local-qwen-mlx" },
    });
    const { id } = created.json();

    const res = await app.fastify.inject({
      method: "PUT",
      url: `/api/gurus/${id}`,
      payload: { env: { LD_PRELOAD: "/tmp/evil.so" } },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });
});

describe("POST /api/gurus: model/fallbackModel/thinking validation", () => {
  test("rejects a model with no provider prefix", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "bad-model", model: "gpt-5" },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /provider\/id/);
    await app.fastify.close();
  });

  test("rejects a fallbackModel with no provider prefix", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "bad-fallback", model: "litellm/claude-auto-llm", fallbackModel: "gpt-5" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("rejects an unrecognized thinking level", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "bad-thinking", model: "litellm/claude-auto-llm", thinking: "ultra" },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /off, minimal, low, medium, high, xhigh, max/);
    await app.fastify.close();
  });

  test("accepts a valid model, fallbackModel and thinking level", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: {
        name: "good-guru",
        model: "litellm/claude-auto-llm",
        fallbackModel: "litellm/claude-auto-llm",
        thinking: "medium",
      },
    });
    assert.equal(res.statusCode, 201);
    await app.fastify.close();
  });
});

describe("PUT /api/gurus/:id: model/thinking validation", () => {
  test("rejects an update with an invalid thinking level", async () => {
    const app = await buildTestApp();
    const guru = await seedGuru(app.store);
    const res = await app.fastify.inject({
      method: "PUT",
      url: `/api/gurus/${guru.id}`,
      payload: { thinking: "nope" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });
});

describe("GET /api/gurus/meta", () => {
  test("echoes the env denylist and thinking levels", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/gurus/meta" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.envDenylist.includes("LITELLM_BASE_URL"));
    assert.ok(body.envDenylist.includes("GIT_*"));
    assert.deepEqual(body.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    await app.fastify.close();
  });
});

describe("DELETE /api/gurus/:id", () => {
  test("404s for an unknown guru", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/gurus/nope" });
    assert.equal(res.statusCode, 404);
    await app.fastify.close();
  });

  test("400s for the default guru", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "default" });
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/gurus/default" });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("409s with a count when a session references the guru", async () => {
    const app = await buildTestApp();
    const guru = await seedGuru(app.store);
    await app.store.sessions.insert({
      id: "s1",
      guruId: guru.id,
      repo: null,
      status: "open",
      cost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.fastify.inject({ method: "DELETE", url: `/api/gurus/${guru.id}` });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().count, 1);
    await app.fastify.close();
  });

  test("deletes a guru with no referencing sessions", async () => {
    const app = await buildTestApp();
    const guru = await seedGuru(app.store);
    const res = await app.fastify.inject({ method: "DELETE", url: `/api/gurus/${guru.id}` });
    assert.equal(res.statusCode, 204);
    assert.equal(await app.store.gurus.findById(guru.id), null);
    await app.fastify.close();
  });
});

describe("POST/PUT /api/gurus: playwrightBeforeCheckpoint", () => {
  test("a guru without the flag does not gain it as true", async () => {
    const app = await buildTestApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "plain", model: "litellm/claude-auto-llm" },
    });
    assert.equal(created.statusCode, 201);
    assert.notEqual(created.json().playwrightBeforeCheckpoint, true);
    assert.equal(created.json().playwrightBeforeCheckpoint, undefined);

    const listed = await app.fastify.inject({ method: "GET", url: "/api/gurus" });
    const row = (listed.json() as { id: string; playwrightBeforeCheckpoint?: boolean }[]).find(
      (guru) => guru.id === created.json().id,
    );
    assert.notEqual(row?.playwrightBeforeCheckpoint, true);

    const renamed = await app.fastify.inject({
      method: "PUT",
      url: `/api/gurus/${created.json().id}`,
      payload: { name: "plain-renamed" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.notEqual(renamed.json().playwrightBeforeCheckpoint, true);
    await app.fastify.close();
  });

  test("a guru with the flag set is returned as true", async () => {
    const app = await buildTestApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "checked", model: "litellm/claude-auto-llm", playwrightBeforeCheckpoint: true },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().playwrightBeforeCheckpoint, true);

    const listed = await app.fastify.inject({ method: "GET", url: "/api/gurus" });
    const row = (listed.json() as { name: string; playwrightBeforeCheckpoint?: boolean }[]).find(
      (guru) => guru.name === "checked",
    );
    assert.equal(row?.playwrightBeforeCheckpoint, true);

    const guru = await seedGuru(app.store, { id: "other-guru" });
    const updated = await app.fastify.inject({
      method: "PUT",
      url: `/api/gurus/${guru.id}`,
      payload: { playwrightBeforeCheckpoint: true },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().playwrightBeforeCheckpoint, true);
    await app.fastify.close();
  });

  test("rejects a non-boolean playwrightBeforeCheckpoint", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/gurus",
      payload: { name: "bad-flag", model: "litellm/claude-auto-llm", playwrightBeforeCheckpoint: "yes" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });
});
