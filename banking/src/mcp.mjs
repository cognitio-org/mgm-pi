#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountDetails, accounts, balances, listBanks, status, transactionDetail, transactions } from "./actions.mjs";
import { encodeFrame, createFrameParser } from "./framing.mjs";

const TOOLS = [
  {
    name: "status",
    description: "Report whether a local Enable Banking app is configured and whether a bank is linked. Returns no balances and no account numbers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "banks",
    description: "List banks this Enable Banking application can reach for one country. Does not read the user's accounts.",
    inputSchema: {
      type: "object",
      properties: { country: { type: "string", description: "Two-letter country code, for example FI." } },
      required: ["country"],
      additionalProperties: false,
    },
  },
  {
    name: "accounts",
    description: "List the user's linked accounts with a masked IBAN, currency, and product name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "balances",
    description: "Read balances for one linked account. Pass account as the 1-based index from accounts. Omit it when only one account is linked.",
    inputSchema: {
      type: "object",
      properties: { account: { type: "integer", minimum: 1, description: "1-based account index." } },
      additionalProperties: false,
    },
  },
  {
    name: "details",
    description: "Read one linked account's details: holder role, masked identifiers, credit limit, and address when the bank sends them. Account numbers are masked. This cannot move money.",
    inputSchema: {
      type: "object",
      properties: { account: { type: "integer", minimum: 1, description: "1-based account index." } },
      additionalProperties: false,
    },
  },
  {
    name: "transactions",
    description: "Read recent transactions for one linked account. days is 1 to 90 (default 30). limit is 1 to 40 (default 20). Each row includes an id when the bank provides one. Account numbers are masked. This cannot move money.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "integer", minimum: 1 },
        days: { type: "integer", minimum: 1, maximum: 90 },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "transaction",
    description: "Read one transaction by the id from a transactions row. Account numbers are masked. This cannot move money.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "integer", minimum: 1 },
        id: { type: "string", description: "Transaction id from a transactions row." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const ALLOWED = {
  status: [],
  banks: ["country"],
  accounts: [],
  balances: ["account"],
  details: ["account"],
  transactions: ["account", "days", "limit"],
  transaction: ["account", "id"],
};

export async function callTool(name, rawArgs) {
  if (!Object.hasOwn(ALLOWED, name)) throw new Error(`Unknown tool ${name}.`);
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  for (const key of Object.keys(args)) {
    if (!ALLOWED[name].includes(key)) throw new Error(`Unexpected argument ${key}.`);
  }
  if (name === "status") return status();
  if (name === "banks") return listBanks(args.country);
  if (name === "accounts") return accounts();
  if (name === "balances") return balances(args.account);
  if (name === "details") return accountDetails(args.account);
  if (name === "transactions") return transactions(args.account, args.days, args.limit);
  return transactionDetail(args.account, args.id);
}

export async function handleRequest(message) {
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
        serverInfo: { name: "enablebanking-local", version: "0.1.0" },
        instructions: "Read-only access to the user's own linked bank accounts through Enable Banking. This server cannot initiate payments. A person links a bank from the terminal with: node src/cli.mjs link",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const value = await callTool(params?.name, params?.arguments);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } };
    } catch (err) {
      const text = err instanceof Error ? err.message : "Banking request failed.";
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
    console.error("This is the Enable Banking MCP server. It speaks on stdio. Use src/cli.mjs in a terminal.");
    process.exit(1);
  }
  const parser = createFrameParser((message, used) => {
    handleRequest(message).then((response) => {
      if (response) process.stdout.write(encodeFrame(response, used));
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
