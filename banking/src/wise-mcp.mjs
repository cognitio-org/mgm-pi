#!/usr/bin/env node
// Local stdio MCP. A laptop Kernal loads it from a project .pi/mcp.json.
// The Cloud Run host is src/finance-mcp.mjs. Do not add this file to a Drive image.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFrame, createFrameParser } from "./framing.mjs";
import { WiseError, wiseBalances, wiseProfiles, wiseStatement, wiseStatus } from "./wise.mjs";

export const TOOLS = [
  {
    name: "wise_status",
    description: "Report the Wise credential on this Mac (API key, OAuth, or unavailable) and whether a profile has been read. Returns no balances and no amounts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wise_profiles",
    description: "Read Wise profile ids and types (PERSONAL or BUSINESS). An API key returns every profile. OAuth returns the linked profile. Does not return a name, email, or address. Cannot move money.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wise_balances",
    description: "Read Wise balances. An API key indexes balances across every profile. Amounts are decimals. Account numbers are not returned. Cannot move money or open a balance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wise_statement",
    description: "Read a compact Wise statement for one balance index from wise_balances. days is 1 to 90 (default 30). At most 40 rows. If Wise asks for in-app approval, this returns SCA_REQUIRED and stops. Cannot move money.",
    inputSchema: {
      type: "object",
      properties: {
        balance: { type: "integer", minimum: 1, description: "1-based index from wise_balances." },
        days: { type: "integer", minimum: 1, maximum: 90 },
      },
      additionalProperties: false,
    },
  },
];

const ALLOWED = {
  wise_status: [],
  wise_profiles: [],
  wise_balances: [],
  wise_statement: ["balance", "days"],
};

export async function callTool(name, rawArgs, env = process.env, deps = {}) {
  if (!Object.hasOwn(ALLOWED, name)) throw new WiseError("BLOCKED", `Unknown tool ${name}.`);
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  for (const key of Object.keys(args)) {
    if (!ALLOWED[name].includes(key)) throw new WiseError("BLOCKED", `Unexpected argument ${key}.`);
  }
  if (name === "wise_status") return wiseStatus(env, deps);
  if (name === "wise_profiles") return wiseProfiles(env, deps);
  if (name === "wise_balances") return wiseBalances(env, deps);
  return wiseStatement(env, args.balance, args.days, deps);
}

export async function handleRequest(message, env = process.env) {
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
        serverInfo: { name: "wise-local", version: "0.1.0" },
        instructions: "Read-only access to the user's own Wise account on this Mac. This server cannot send money, add a recipient, or create a transfer. An API key in Secret Manager kernal_wise_key is used as a bearer token; call wise_balances directly. Browser link is only for an OAuth client id and secret: node src/wise-cli.mjs link",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const value = await callTool(params?.name, params?.arguments, env);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } };
    } catch (err) {
      const text = err instanceof Error ? err.message : "Wise request failed.";
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
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
  if (process.stdin.isTTY) {
    console.error("This is the Wise MCP server. It speaks on stdio. Use src/wise-cli.mjs in a terminal.");
    process.exit(1);
  }
  let framing = "ndjson";
  const parser = createFrameParser((message, used) => {
    framing = used;
    handleRequest(message).then((response) => {
      if (response) process.stdout.write(encodeFrame(response, framing));
    }).catch((err) => {
      console.error(err instanceof Error ? err.message : "MCP request failed.");
    });
  });
  process.stdin.on("data", (chunk) => {
    try {
      parser.push(chunk);
    } catch (err) {
      console.error(err instanceof Error ? err.message : "MCP frame failed.");
      process.exit(1);
    }
  });
}

if (invokedDirectly()) serve();
