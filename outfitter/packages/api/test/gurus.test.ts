// Finding #6 (docs/reports/security-review-pr1.md): guru.env is merged verbatim into the pi child
// process's environment (agentd's guru.ts renderGuru), so any domain user creating/editing a guru
// must not be able to set an env var that would let them plant code-exec or hijack agentd's own
// auth-header env vars into a guru other people also use.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";

describe("POST /api/gurus: guru.env denylist", () => {
  for (const key of ["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "HOME", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND"]) {
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
