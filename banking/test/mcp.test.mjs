import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFrameParser, encodeFrame } from "../src/framing.mjs";
import { callTool, handleRequest } from "../src/mcp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("frames newline JSON and Content-Length messages", () => {
  const got = [];
  const parser = createFrameParser((message, framing) => got.push({ message, framing }));
  parser.push(encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" }, "ndjson"));
  parser.push(encodeFrame({ jsonrpc: "2.0", id: 2, method: "ping" }, "content-length"));
  assert.deepEqual(got.map((item) => item.framing), ["ndjson", "content-length"]);
  assert.deepEqual(got.map((item) => item.message.id), [1, 2]);
});

test("MCP tools are read-only and reject payment or login arguments", async () => {
  const listed = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["status", "banks", "accounts", "balances", "details", "transactions", "transaction"]);
  await assert.rejects(callTool("balances", { code: "secret" }), /Unexpected argument code/);
  await assert.rejects(callTool("pay", {}), /Unknown tool/);
  await assert.rejects(callTool("transaction", { id: "../payments" }), /transaction id/);
});

test("banks without a country fails before describing a result", async () => {
  await assert.rejects(callTool("banks", {}), /country/);
});

test("spawned server answers initialize and status without a key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eb-mcp-"));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ENABLEBANKING_")) env[key] = value;
  }
  env.ENABLEBANKING_CONFIG_DIR = path.join(dir, "missing");
  const child = spawn(process.execPath, [path.join(root, "src", "mcp.mjs")], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let cursor = 0;
  const next = async () => {
    for (let i = 0; i < 100; i += 1) {
      const nl = stdout.indexOf("\n", cursor);
      if (nl !== -1) {
        const line = stdout.slice(cursor, nl);
        cursor = nl + 1;
        return JSON.parse(line);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no MCP response\nstderr: ${stderr}\nstdout: ${stdout}`);
  };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`);
    const init = await next();
    assert.equal(init.result.serverInfo.name, "enablebanking-local");
    assert.match(init.result.instructions, /cannot initiate payments/);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } })}\n`);
    const status = await next();
    assert.equal(status.id, 2);
    assert.match(status.result.content[0].text, /not configured/i);
    assert.equal(stdout.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(stderr.includes("BEGIN PRIVATE KEY"), false);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
