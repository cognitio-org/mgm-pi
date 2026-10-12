#!/usr/bin/env node
// HTTP MCP for finance. Wise is the first upstream. Add the next one in buildUpstreams.
// Cloud Run reads kernal_wise_key through the runtime service account. The Wise key is not
// the caller credential: callers send FINANCE_MCP_TOKEN. This process does not move money.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGsmReader } from "./gsm.mjs";
import { callTool, TOOLS as wiseTools } from "./wise-mcp.mjs";

const STATE_DIR = "/tmp/finance/wise";
const BODY_LIMIT = 1_000_000;

export function wiseUpstream({ loadCredentials, fetchImpl } = {}) {
  const deps = {};
  if (loadCredentials) deps.loadCredentials = loadCredentials;
  if (fetchImpl) deps.fetchImpl = fetchImpl;
  return {
    name: "wise",
    tools: wiseTools,
    call(name, args, env) {
      return callTool(name, args, env, deps);
    },
  };
}

export function buildUpstreams(env = process.env, deps = {}) {
  const fromGsm = Boolean(env.K_SERVICE) || env.FINANCE_SECRETS === "gsm";
  const loadCredentials = deps.loadCredentials || (fromGsm
    ? createGsmReader({ fetchImpl: deps.fetchImpl, now: deps.now })
    : undefined);
  return [wiseUpstream({ loadCredentials, fetchImpl: deps.fetchImpl })];
}

function bearerOk(header, token) {
  const match = /^Bearer ([!-~]{20,})$/i.exec(String(header || "").trim());
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (status) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("bad request"), { status }));
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(413);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => fail(400));
  });
}

function send(res, status, body) {
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export function createFinanceApp({ token, upstreams, env = process.env } = {}) {
  if (typeof token !== "string" || token.length < 20 || /[\s]/.test(token)) {
    throw new Error("FINANCE_MCP_TOKEN is missing.");
  }
  const byName = new Map();
  const tools = [];
  for (const upstream of upstreams || []) {
    for (const tool of upstream.tools) {
      if (byName.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}.`);
      byName.set(tool.name, upstream);
      tools.push(tool);
    }
  }

  let tail = Promise.resolve();
  function exclusive(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  }

  async function handleMessage(message) {
    const { id, method, params } = message ?? {};
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (id === undefined) return null;
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "finance", version: "0.1.0" },
          instructions: "Read-only finance tools. Wise is the first upstream. This server cannot send money, add a recipient, or create a transfer.",
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
    if (method === "tools/call") {
      const name = params?.name;
      const upstream = byName.get(name);
      if (!upstream) {
        return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Unknown tool ${name}.` }] } };
      }
      try {
        const value = await exclusive(() => upstream.call(name, params?.arguments, env));
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } };
      } catch (err) {
        const text = err instanceof Error ? err.message : "Finance request failed.";
        return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }

  return async function handle(req, res) {
    const path = (req.url || "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true, service: "finance" });
      return;
    }
    if (path !== "/mcp") {
      send(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return;
    }
    if (!bearerOk(req.headers.authorization, token)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    const type = String(req.headers["content-type"] || "");
    if (!type.startsWith("application/json")) {
      send(res, 415, { error: "unsupported media type" });
      return;
    }
    let text = "";
    try {
      text = await readBody(req);
    } catch (err) {
      send(res, err.status || 400, { error: "bad request" });
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send(res, 400, { error: "bad request" });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      send(res, 400, { error: "bad request" });
      return;
    }
    const response = await handleMessage(message);
    if (!response) {
      res.writeHead(202);
      res.end();
      return;
    }
    send(res, 200, response);
  };
}

function runtimeEnv(env) {
  const copy = { ...env };
  if (copy.K_SERVICE && !copy.WISE_CONFIG_DIR) copy.WISE_CONFIG_DIR = STATE_DIR;
  return copy;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function serve() {
  const env = runtimeEnv(process.env);
  let app;
  try {
    app = createFinanceApp({
      token: env.FINANCE_MCP_TOKEN,
      env,
      upstreams: buildUpstreams(env),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Finance MCP failed to start.");
    process.exit(1);
  }
  const port = Number(env.PORT) || 8080;
  const server = createServer((req, res) => {
    app(req, res).catch((err) => {
      console.error(err instanceof Error ? err.message : "Finance MCP request failed.");
      if (!res.headersSent) send(res, 500, { error: "request failed" });
    });
  });
  server.listen(port, "0.0.0.0");
}

if (invokedDirectly()) serve();
