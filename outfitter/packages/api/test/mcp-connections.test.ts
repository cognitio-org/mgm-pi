// MO-5 / MO-6 (#487, #488, docs/specs/mcp-connections.md): the Connections routes, the router calls
// behind them, and the Drive notice.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { FakeLitellm } from "./fake-litellm.ts";
import { createLitellmKeys } from "../src/central/litellm-keys.ts";
import { CONNECTABLE_MCP_SERVERS, McpConnections, connectionNotice, connectUrl, type Connection } from "../src/central/mcp-connections.ts";
import { userIdFor } from "../src/central/user-id.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Session } from "../src/store/types.ts";

const CONFIG = { litellmBaseUrl: "https://router.test/v1", litellmAdminKey: "sk-admin-test" };
const DEV = "dev@localhost";
const DEV_USER = userIdFor(DEV);

function sentryRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { server_id: "srv-sentry", server_name: "sentry", credential_type: "oauth2", has_credential: true, connected_at: "2026-10-06T16:47:00Z", ...extra };
}

function fixture(now: () => number = Date.now) {
  const fake = new FakeLitellm();
  const store = new MemoryStore();
  const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
  return { fake, store, keys, connections: new McpConnections(keys, ["ops@example.com"], now) };
}

describe("CONNECTABLE_MCP_SERVERS", () => {
  test("is exactly the gateway OAuth servers in kernal/.pi/mcp.json (render-mcp.sh's rule)", () => {
    const mcp = JSON.parse(readFileSync(new URL("../../../../kernal/.pi/mcp.json", import.meta.url), "utf8"));
    const gateway = Object.entries(mcp.mcpServers as Record<string, { auth?: string; headers?: Record<string, string> }>)
      .filter(([, def]) => def.auth === "oauth" && (def.headers?.["x-litellm-api-key"] ?? "") !== "")
      .map(([name]) => name)
      .sort();
    assert.deepEqual(CONNECTABLE_MCP_SERVERS.map((s) => s.name).sort(), gateway);
  });
});

describe("LitellmKeys MCP credentials", () => {
  test("lists the person's grants by their Outfitter user id and passes on no other field", async () => {
    const { fake, keys } = fixture();
    fake.mcpCredentials.set(DEV_USER, [sentryRow({ reconnect_required: true, reconnect_reason: "invalid_grant", access_token: "never" })]);
    const rows = await keys.mcpUserCredentials(DEV_USER);
    assert.equal(fake.callsTo("/v1/mcp/user-credentials")[0].query.user_id, DEV_USER);
    assert.deepEqual(rows, [
      { serverId: "srv-sentry", serverName: "sentry", connectedAt: "2026-10-06T16:47:00Z", reconnectRequired: true, reconnectReason: "invalid_grant" },
    ]);
  });

  test("a disconnect that finds nothing is done; any other failure throws", async () => {
    const { fake, keys } = fixture();
    fake.failNext("/v1/mcp/user-credentials/srv-x", 404);
    await keys.deleteMcpUserCredential(DEV_USER, "srv-x");
    fake.failNext("/v1/mcp/user-credentials/srv-x", 500);
    await assert.rejects(keys.deleteMcpUserCredential(DEV_USER, "srv-x"));
  });
});

describe("McpConnections", () => {
  test("each visible server's state; gcloud only for operators", async () => {
    const { fake, connections } = fixture();
    fake.mcpCredentials.set(userIdFor("ops@example.com"), [sentryRow(), { server_id: "srv-g", alias: "gcloud", reconnect_required: true, reconnect_required_at: "2026-10-08T00:00:00Z" }]);
    assert.deepEqual(await connections.list("ops@example.com"), [
      { name: "sentry", label: "Sentry", state: "connected", connectedAt: "2026-10-06T16:47:00Z" },
      { name: "gcloud", label: "Google Cloud", state: "reconnect_required", reconnectRequiredAt: "2026-10-08T00:00:00Z" },
    ]);
    assert.deepEqual(await connections.list("someone@example.com"), [{ name: "sentry", label: "Sentry", state: "not_connected" }]);
  });

  test("answers are cached for a minute per person, and a disconnect drops the cache", async () => {
    let now = 0;
    const { fake, connections } = fixture(() => now);
    fake.mcpCredentials.set(DEV_USER, [sentryRow()]);
    await connections.list(DEV);
    await connections.list(DEV);
    assert.equal(fake.callsTo("/v1/mcp/user-credentials").length, 1);
    now = 60_000;
    await connections.list(DEV);
    assert.equal(fake.callsTo("/v1/mcp/user-credentials").length, 2);

    assert.equal(await connections.disconnect(DEV, "sentry"), "done");
    const del = fake.calls.find((c) => c.method === "DELETE")!;
    assert.equal(del.path, "/v1/mcp/user-credentials/srv-sentry");
    assert.equal(del.query.user_id, DEV_USER);
    assert.deepEqual(await connections.list(DEV), [{ name: "sentry", label: "Sentry", state: "not_connected" }]);
  });

  test("a router that is down is asked once a minute, not on every read", async () => {
    let now = 0;
    const { fake, connections } = fixture(() => now);
    fake.down = true;
    await assert.rejects(connections.list(DEV));
    await assert.rejects(connections.list(DEV));
    assert.equal(fake.callsTo("/v1/mcp/user-credentials").length, 1);
    fake.down = false;
    now = 60_000;
    assert.equal((await connections.list(DEV))[0].state, "not_connected");
  });

  test("a fresh read sees a grant made seconds ago, and refills the cache", async () => {
    const { fake, connections } = fixture(() => 0);
    assert.equal((await connections.list(DEV))[0].state, "not_connected");
    fake.mcpCredentials.set(DEV_USER, [sentryRow()]);
    assert.equal((await connections.list(DEV))[0].state, "not_connected", "the cached answer");
    assert.equal((await connections.list(DEV, { fresh: true }))[0].state, "connected");
    assert.equal((await connections.list(DEV))[0].state, "connected");
  });

  test("the Drive notice gives up after its budget instead of holding the page", async () => {
    const { store } = fixture();
    const hung = createLitellmKeys(CONFIG, store, { fetch: () => new Promise<Response>(() => {}) })!;
    const connections = new McpConnections(hung, []);
    const started = Date.now();
    assert.equal(await connections.noticeFor(DEV, ["sentry"], 50), undefined);
    assert.ok(Date.now() - started < 1_000, "returned within the budget");
  });

  test("a server the person can't see is unknown and never reaches the router", async () => {
    const { fake, connections } = fixture();
    assert.equal(await connections.disconnect(DEV, "gcloud"), "unknown");
    assert.equal(await connections.disconnect(DEV, "nope"), "unknown");
    assert.equal(fake.calls.length, 0);
  });
});

describe("connectionNotice", () => {
  const conn = (name: string, label: string, state: Connection["state"]): Connection => ({ name, label, state });

  test("names the servers the Drive uses that aren't connected", () => {
    assert.equal(connectionNotice([conn("sentry", "Sentry", "connected")], ["sentry"]), undefined);
    assert.equal(connectionNotice([conn("gcloud", "Google Cloud", "not_connected")], ["sentry"]), undefined);
    assert.deepEqual(connectionNotice([conn("sentry", "Sentry", "not_connected")], ["sentry"]), {
      text: "Sentry isn't connected: connect it in Connections.",
      href: "/connections",
    });
    assert.equal(connectionNotice([conn("sentry", "Sentry", "reconnect_required")], ["sentry"])?.text, "Sentry needs reconnecting: reconnect it in Connections.");
    assert.equal(
      connectionNotice([conn("sentry", "Sentry", "not_connected"), conn("gcloud", "Google Cloud", "reconnect_required")], ["sentry", "gcloud"])?.text,
      "Sentry and Google Cloud aren't connected: connect them in Connections.",
    );
  });
});

describe("/api/me/connections", () => {
  test("lists the caller's connections with the router's connect page; DELETE disconnects", async () => {
    const { fake, store, keys } = fixture();
    fake.mcpCredentials.set(DEV_USER, [sentryRow()]);
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/connections" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().connectUrl, "https://router.kernal.one/ui/connect");
    assert.equal(res.json().connections.find((c: Connection) => c.name === "sentry").state, "connected");
    assert.ok(!res.body.includes("srv-sentry"), "router ids stay server-side");

    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/me/connections/sentry" })).statusCode, 204);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/me/connections/unknown" })).statusCode, 404);
    await app.fastify.close();
  });

  test("the page's Refresh shows a grant made in another tab at once", async () => {
    const { fake, store, keys } = fixture();
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const sentry = async () => (await app.fastify.inject({ method: "GET", url: "/api/me/connections" })).json().connections.find((c: Connection) => c.name === "sentry");
    assert.equal((await sentry()).state, "not_connected");
    fake.mcpCredentials.set(DEV_USER, [sentryRow()]);
    assert.equal((await sentry()).state, "connected");
    await app.fastify.close();
  });

  test("a router failure is 502, and no admin key is 503", async () => {
    const { fake, store, keys } = fixture();
    fake.down = true;
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/me/connections" })).statusCode, 502);
    await app.fastify.close();
    const bare = await buildTestApp();
    assert.equal((await bare.fastify.inject({ method: "GET", url: "/api/me/connections" })).statusCode, 503);
    await bare.fastify.close();
  });

  test("connectUrl is the router root's connect page", () => {
    assert.equal(connectUrl("https://router.test/v1"), "https://router.test/ui/connect");
    assert.equal(connectUrl("https://router.test/"), "https://router.test/ui/connect");
  });
});

describe("GET /api/sessions/:id connectionNotice (MO-6)", () => {
  async function sessionApp(owner: string | undefined, rows: Array<Record<string, unknown>> | "down") {
    const { fake, store, keys } = fixture();
    if (rows === "down") fake.down = true;
    else fake.mcpCredentials.set(DEV_USER, rows);
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    await seedGuru(app.store);
    const now = new Date().toISOString();
    const session: Session = { id: "s1", guruId: "test-guru", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now, ...(owner ? { ownerEmail: owner } : {}) };
    await app.store.sessions.insert(session);
    return app;
  }

  test("the owner sees one notice linking Connections while Sentry has no grant", async () => {
    const app = await sessionApp(DEV, []);
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s1" });
    assert.deepEqual(res.json().connectionNotice, { text: "Sentry isn't connected: connect it in Connections.", href: "/connections" });
    await app.fastify.close();
  });

  test("no notice when connected, for someone else's session, or when the router is down", async () => {
    for (const [owner, rows] of [[DEV, [sentryRow()]], ["other@example.com", []], [DEV, "down"]] as const) {
      const app = await sessionApp(owner, rows as Array<Record<string, unknown>> | "down");
      const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s1" });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().connectionNotice, undefined, `${owner} ${JSON.stringify(rows)}`);
      await app.fastify.close();
    }
  });
});
