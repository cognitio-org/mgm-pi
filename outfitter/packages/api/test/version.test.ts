/** GET /api/version: what's deployed, for the web app's version indicator. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";

test("GET /api/version returns the deployed commit and release", async () => {
  const app = await buildTestApp({ OUTFITTER_BUILD_COMMIT: "34d84792da6a", OUTFITTER_RELEASE: "outfitter-v2026.09.27.9" });
  assert.deepEqual((await app.fastify.inject({ method: "GET", url: "/api/version" })).json(), { commit: "34d84792da6a", release: "outfitter-v2026.09.27.9" });
  await app.fastify.close();
});

test("GET /api/version is null/null in dev", async () => {
  const app = await buildTestApp();
  assert.deepEqual((await app.fastify.inject({ method: "GET", url: "/api/version" })).json(), { commit: null, release: null });
  await app.fastify.close();
});
