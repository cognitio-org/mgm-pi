// Browser routes over GithubCatalog. With no App secrets the catalog says it isn't set up,
// which is what a dev server does until an operator stores the key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { buildTestApp, type TestApp } from "./helpers.ts";

async function close(app: TestApp): Promise<void> {
  app.stopBackgroundTasks();
  await app.fastify.close();
}

test("GET /api/github/repos is 200 when the App is not set up", async () => {
  const app = await buildTestApp();
  try {
    const res = await app.fastify.inject({ method: "GET", url: "/api/github/repos" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { configured: false, reason: "not-configured", truncated: false, accounts: [], repos: [] });
    const fresh = await app.fastify.inject({ method: "GET", url: "/api/github/repos?fresh=1" });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.json().configured, false);
  } finally {
    await close(app);
  }
});

test("github status is 404 for a missing floppy and not-configured for one with a repository", async () => {
  const app = await buildTestApp();
  try {
    const missing = await app.fastify.inject({ method: "GET", url: "/api/sessions/missing/github-status" });
    assert.equal(missing.statusCode, 404);
    const now = new Date().toISOString();
    await app.store.sessions.insert({
      id: "s1",
      guruId: "g",
      repo: "acme/widget",
      branch: "outfitter/abc",
      baseBranch: "main",
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    });
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s1/github-status" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.connected, false);
    assert.equal(body.reason, "not-configured");
    assert.equal(body.repo, "acme/widget");
    assert.equal(body.branch, "outfitter/abc");
  } finally {
    await close(app);
  }
});

test("creating a repository validates the name and reports an App that isn't set up", async () => {
  const app = await buildTestApp();
  try {
    const bad = await app.fastify.inject({ method: "POST", url: "/api/github/repos", payload: { owner: "..", name: "x" } });
    assert.equal(bad.statusCode, 400);
    const missing = await app.fastify.inject({
      method: "POST",
      url: "/api/github/repos",
      payload: { owner: "acme", name: "widget" },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, "the GitHub App isn't set up");
  } finally {
    await close(app);
  }
});

test("the link role does not serve the catalog", async () => {
  const store = new MemoryStore();
  const web = await buildTestApp({}, { store });
  const link = await buildTestApp({ OUTFITTER_ROLE: "link" }, { store });
  try {
    const created = await web.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "laptop" } });
    const token = created.json().token as string;
    const res = await link.fastify.inject({
      method: "GET",
      url: "/api/github/repos",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await close(web);
    await close(link);
  }
});
