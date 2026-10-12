import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUpstreams, createFinanceApp, wiseUpstream } from "../src/finance-mcp.mjs";
import { createGsmReader } from "../src/gsm.mjs";
import { WiseError } from "../src/wise.mjs";

const TOKEN = "finance-mcp-test-token-value";
const WISE_KEY = "kernal-wise-key-token-value";

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return text; },
    async json() { return body; },
  };
}

async function listen(app) {
  const server = createServer((req, res) => {
    app(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "failed" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function post(url, body, { token = TOKEN, raw, headers = {} } = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw == null ? JSON.stringify(body) : raw,
  });
}

test("health is open and the tool list is the Wise set", async () => {
  const app = createFinanceApp({
    token: TOKEN,
    upstreams: [wiseUpstream(), {
      name: "later",
      tools: [{
        name: "later_status",
        description: "Placeholder for the next upstream.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      async call() { return { ok: true }; },
    }],
  });
  const server = await listen(app);
  try {
    const health = await fetch(`${server.url}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: "finance" });
    const missing = await post(`${server.url}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "" });
    assert.equal(missing.status, 401);
    const wrong = await post(`${server.url}/mcp`, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wise_balances", arguments: {} },
    }, { token: "wrong-finance-mcp-token-value" });
    assert.equal(wrong.status, 401);
    const listed = await post(`${server.url}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ["wise_status", "wise_profiles", "wise_balances", "wise_statement", "later_status"]);
    const init = await post(`${server.url}/mcp`, { jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
    assert.equal((await init.json()).result.serverInfo.name, "finance");
    const note = await post(`${server.url}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    const blocked = await post(`${server.url}/mcp`, {
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wise_transfer", arguments: {} },
    });
    const body = await blocked.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Unknown tool/);
  } finally {
    await server.close();
  }
});

test("a Wise balance read uses the production host and does not echo the key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "finance-"));
  await chmod(dir, 0o700);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.Authorization });
    const href = String(url);
    assert.equal(href.startsWith("https://api.wise.com/2026Q4/"), true);
    if (href.endsWith("/profiles")) {
      return jsonResponse([{ id: 7, type: "PERSONAL", fullName: "Hidden Person" }]);
    }
    if (href.includes("/profiles/7/balances")) {
      return jsonResponse([{
        id: 70, currency: "EUR", type: "STANDARD", amount: { value: "1.50", currency: "EUR" }, iban: "DE89370400440532013000",
      }]);
    }
    throw new Error(`unexpected ${href}`);
  };
  const app = createFinanceApp({
    token: TOKEN,
    env: { WISE_CONFIG_DIR: dir },
    upstreams: [wiseUpstream({
      loadCredentials: async () => ({ kind: "key", token: WISE_KEY }),
      fetchImpl,
    })],
  });
  const server = await listen(app);
  try {
    const response = await post(`${server.url}/mcp`, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wise_balances", arguments: {} },
    });
    const body = await response.json();
    const text = body.result.content[0].text;
    assert.match(text, /EUR/);
    assert.equal(text.includes(WISE_KEY), false);
    assert.equal(text.includes("DE893"), false);
    assert.equal(text.includes("Hidden"), false);
    assert.equal(seen[0].authorization, `Bearer ${WISE_KEY}`);
    const stored = await readFile(path.join(dir, "key", "connection.json"), "utf8");
    assert.equal(stored.includes(WISE_KEY), false);
  } finally {
    await server.close();
  }
});

test("Cloud Run reads kernal_wise_key through the metadata server and caches it", async () => {
  let secretReads = 0;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("metadata.google.internal")) {
      return jsonResponse({ access_token: "ya29.metadata-token", expires_in: 3600 });
    }
    if (href.includes("/projects/97916961297/secrets/kernal_wise_key/versions/latest:access")) {
      secretReads += 1;
      return jsonResponse({
        payload: { data: Buffer.from(WISE_KEY).toString("base64") },
        error: { leaked: WISE_KEY },
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  const load = createGsmReader({ fetchImpl, now: () => 1_000 });
  const first = await load();
  const second = await load();
  assert.deepEqual(first, { kind: "key", token: WISE_KEY });
  assert.equal(second.token, WISE_KEY);
  assert.equal(secretReads, 1);

  const denied = createGsmReader({
    fetchImpl: async (url) => {
      if (String(url).includes("metadata")) return jsonResponse({ access_token: "ya29.metadata-token", expires_in: 3600 });
      return jsonResponse({ error: { message: WISE_KEY } }, 403);
    },
  });
  await assert.rejects(denied(), (err) => {
    assert.equal(err instanceof WiseError, true);
    assert.equal(err.message.includes(WISE_KEY), false);
    assert.match(err.message, /HTTP 403/);
    return true;
  });
});

test("the Cloud Run upstream list reads the secret before it calls Wise", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "finance-gsm-"));
  await chmod(dir, 0o700);
  const urls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("metadata.google.internal")) return jsonResponse({ access_token: "ya29.metadata-token", expires_in: 3600 });
    if (href.includes("secretmanager.googleapis.com")) {
      return jsonResponse({ payload: { data: Buffer.from(WISE_KEY).toString("base64") } });
    }
    if (href.endsWith("/profiles")) return jsonResponse([]);
    throw new Error(`unexpected ${href}`);
  };
  const env = { K_SERVICE: "kernal-finance-mcp", WISE_CONFIG_DIR: dir };
  const app = createFinanceApp({
    token: TOKEN,
    env,
    upstreams: buildUpstreams(env, { fetchImpl }),
  });
  const server = await listen(app);
  try {
    const response = await post(`${server.url}/mcp`, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wise_profiles", arguments: {} },
    });
    const body = await response.json();
    assert.deepEqual(JSON.parse(body.result.content[0].text), { profiles: [] });
    assert.equal(urls.some((href) => href.includes("secretmanager.googleapis.com")), true);
    assert.equal(urls.some((href) => href.startsWith("https://api.wise.com/")), true);
    assert.equal(JSON.stringify(body).includes(WISE_KEY), false);
    const huge = await post(`${server.url}/mcp`, { jsonrpc: "2.0", id: 2, method: "ping" }, { raw: "x".repeat(1_000_001) });
    assert.equal(huge.status, 413);
  } finally {
    await server.close();
  }
});

test("the server refuses to start without a caller token", () => {
  assert.throws(() => createFinanceApp({ token: "short", upstreams: [] }), /FINANCE_MCP_TOKEN/);
});

test("a non-JSON 200 does not return a body snippet", async () => {
  const leaked = "kernal-wise-key-token-value";
  const bad = () => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError(`Unexpected token ${leaked} is not valid JSON`);
    },
  });
  const secretBad = createGsmReader({
    fetchImpl: async (url) => {
      if (String(url).includes("metadata")) return jsonResponse({ access_token: "ya29.metadata-token", expires_in: 3600 });
      return bad();
    },
  });
  await assert.rejects(secretBad(), (err) => {
    assert.equal(err instanceof WiseError, true);
    assert.equal(err.message.includes(leaked), false);
    assert.match(err.message, /Secret Manager HTTP 200/);
    return true;
  });
  const metadataBad = createGsmReader({ fetchImpl: async () => bad() });
  await assert.rejects(metadataBad(), (err) => {
    assert.equal(err instanceof WiseError, true);
    assert.equal(err.message.includes(leaked), false);
    assert.match(err.message, /metadata HTTP 200/);
    return true;
  });
});
