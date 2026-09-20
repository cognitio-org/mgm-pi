import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OutfitterStore, type FetchFn } from "../.pi/extensions/teleport/outfitter-store.ts";

/** Builds a fake fetch that resolves canned responses per method+path, and records every call. */
function fakeFetch(handler: (method: string, path: string, init: any) => { status: number; body?: unknown; text?: string }) {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fn: FetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    calls.push({ method, url, headers: init.headers ?? {} });
    const { status, body, text } = handler(method, path, init);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => (text ?? (body !== undefined ? JSON.stringify(body) : "")),
    } as Response;
  }) as FetchFn;
  return { fn, calls };
}

describe("OutfitterStore auth header selection", () => {
  test("OUTFITTER_TOKEN wins and is sent as Authorization: Bearer", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "tok-123", fetchFn: fn });
    await store.list();
    assert.equal(calls[0].headers.Authorization, "Bearer tok-123");
  });

  test("falls back to a gcloud identity token for the IAP audience when no token is set", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    let requestedAudience: string | undefined;
    const store = new OutfitterStore({
      apiBase: "https://api.example.com",
      iapClientId: "iap-client-id",
      fetchFn: fn,
      getGcloudIdentityToken: async (audience) => {
        requestedAudience = audience;
        return "id-token-xyz";
      },
    });
    await store.list();
    assert.equal(requestedAudience, "iap-client-id");
    assert.equal(calls[0].headers.Authorization, "Bearer id-token-xyz");
  });

  test("throws an actionable error when neither OUTFITTER_TOKEN nor OUTFITTER_IAP_CLIENT_ID is set", async () => {
    const { fn } = fakeFetch(() => ({ status: 200, body: [] }));
    const store = new OutfitterStore({ apiBase: "https://api.example.com", fetchFn: fn });
    await assert.rejects(() => store.list(), /OUTFITTER_TOKEN|OUTFITTER_IAP_CLIENT_ID/);
  });

  test("a 401 response surfaces a gcloud auth login hint", async () => {
    const { fn } = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "bad", fetchFn: fn });
    await assert.rejects(() => store.list(), /gcloud auth login/);
  });
});

describe("OutfitterStore.list", () => {
  test("maps GET /api/sessions summaries to SessionRefs", async () => {
    const { fn } = fakeFetch((method, path) => {
      assert.equal(method, "GET");
      assert.equal(path, "/api/sessions");
      return {
        status: 200,
        body: [
          { id: "s1", name: "fix bug", status: "open", runState: "running", guru: "g1", repo: "o/r", branch: "main", cost: 0, updatedAt: "2026-09-21T00:00:00.000Z" },
          { id: "s2", status: "closed", guru: "g1", repo: null, cost: 0, updatedAt: "2026-09-20T00:00:00.000Z" },
        ],
      };
    });
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "t", fetchFn: fn });
    const refs = await store.list();
    assert.equal(refs.length, 2);
    assert.deepEqual(refs[0], { id: "s1", name: "fix bug", cwd: "/workspace", repo: "o/r", branch: "main", updatedAt: "2026-09-21T00:00:00.000Z", host: "outfitter:api.example.com" });
    assert.equal(refs[1].repo, undefined);
    // newest first
    assert.equal(refs[0].id, "s1");
  });
});

describe("OutfitterStore.get", () => {
  test("no active run: fetches export.jsonl directly, builds a manifest from the session", async () => {
    const { fn, calls } = fakeFetch((method, path) => {
      if (path === "/api/sessions/s1") {
        return { status: 200, body: { id: "s1", name: "n", repo: "o/r", branch: "main", checkpoint: { head: "deadbeef" }, updatedAt: "2026-09-21T00:00:00.000Z", runState: undefined } };
      }
      if (path === "/api/sessions/s1/export.jsonl") {
        return { status: 200, text: '{"type":"session","id":"s1"}\n{"type":"message","id":"m1"}\n' };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "t", fetchFn: fn });
    const { file, manifest } = await store.get("s1");
    assert.match(file, /"type":"session"/);
    assert.deepEqual(manifest, {
      id: "s1",
      name: "n",
      host: "outfitter:api.example.com",
      cwd: "/workspace",
      pushedAt: "2026-09-21T00:00:00.000Z",
      repo: { remote: "https://github.com/o/r", ownerRepo: "o/r", branch: "main", head: "deadbeef" },
    });
    // Never called /stop when there was nothing active.
    assert.ok(!calls.some((c) => c.url.endsWith("/stop")));
  });

  test("active run: stops it, polls until stopped, then fetches the transcript", async () => {
    let sessionCalls = 0;
    const { fn, calls } = fakeFetch((method, path) => {
      if (path === "/api/sessions/s1" && method === "GET") {
        sessionCalls += 1;
        const runState = sessionCalls < 3 ? "running" : undefined; // stopped on the 3rd poll
        return { status: 200, body: { id: "s1", repo: null, updatedAt: "2026-09-21T00:00:00.000Z", runState } };
      }
      if (path === "/api/sessions/s1/stop" && method === "POST") return { status: 200, body: { run: { state: "stopping" } } };
      if (path === "/api/sessions/s1/export.jsonl") return { status: 200, text: '{"type":"session","id":"s1"}\n' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "t", fetchFn: fn, pollIntervalMs: 0, sleep: async () => {} });
    const { manifest } = await store.get("s1");
    assert.equal(manifest.repo, undefined);
    assert.ok(calls.some((c) => c.url.endsWith("/stop") && c.method === "POST"));
    assert.ok(sessionCalls >= 3);
  });

  test("--force skips the stop-and-wait and pulls whatever is there", async () => {
    const { fn, calls } = fakeFetch((method, path) => {
      if (path === "/api/sessions/s1") return { status: 200, body: { id: "s1", repo: null, updatedAt: "2026-09-21T00:00:00.000Z", runState: "running" } };
      if (path === "/api/sessions/s1/export.jsonl") return { status: 200, text: '{"type":"session","id":"s1"}\n' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "t", fetchFn: fn });
    await store.get("s1", { force: true });
    assert.ok(!calls.some((c) => c.url.endsWith("/stop")));
  });

  test("times out with an actionable error if the run never stops", async () => {
    const { fn } = fakeFetch((method, path) => {
      if (path === "/api/sessions/s1" && method === "GET") return { status: 200, body: { id: "s1", repo: null, updatedAt: "now", runState: "running" } };
      if (path === "/api/sessions/s1/stop") return { status: 200, body: { run: { state: "stopping" } } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    let clock = 0;
    const store = new OutfitterStore({
      apiBase: "https://api.example.com",
      token: "t",
      fetchFn: fn,
      stopTimeoutMs: 5_000,
      pollIntervalMs: 2_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms; // fast-forward the fake clock instead of waiting for real time
      },
    });
    await assert.rejects(() => store.get("s1"), /timed out after 5s.*--force/s);
  });
});

describe("OutfitterStore.put", () => {
  test("PUT /api/sessions/:id/import with the raw jsonl body", async () => {
    const { fn, calls } = fakeFetch((method, path) => {
      assert.equal(method, "PUT");
      assert.equal(path, "/api/sessions/s1/import");
      return { status: 200, body: { id: "s1", imported: 1 } };
    });
    const store = new OutfitterStore({ apiBase: "https://api.example.com", token: "t", fetchFn: fn });
    await store.put("s1", '{"type":"session","id":"s1"}\n', { id: "s1", host: "h", cwd: "/x", pushedAt: "now" });
    assert.equal(calls.length, 1);
  });
});
