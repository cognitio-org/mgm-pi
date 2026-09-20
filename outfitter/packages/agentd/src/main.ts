#!/usr/bin/env node
/**
 * Entry point. Reads env (OUTFITTER_API, RUN_ID, OUTFITTER_DEV_TOKEN, WORKSPACE, PI_BIN), gets an
 * auth token, opens the link to the api, and lets RunController drive the state machine once
 * `run.spec` arrives. See outfitter/docs/protocol.md.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getIdToken } from "./auth.js";
import { createGitOps } from "./git.js";
import { Link } from "./link.js";
import { RunController } from "./run.js";

const execFileAsync = promisify(execFile);

const AGENTD_VERSION = "0.1.0";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_PI_BIN = "/opt/mgm/node_modules/.bin/pi";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`agentd: missing required env var ${name}`);
  return value;
}

/** `https://api.example.com` -> `wss://api.example.com/agent/ws?run=<runId>` (and http -> ws for
 * local dev). */
export function buildWsUrl(apiOrigin: string, runId: string): string {
  const url = new URL(apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/agent/ws";
  url.search = `?run=${encodeURIComponent(runId)}`;
  return url.toString();
}

async function getPiVersion(piBin: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(piBin, ["--version"], { timeout: 5000 });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const apiOrigin = requireEnv("OUTFITTER_API");
  const runId = requireEnv("RUN_ID");
  const devToken = process.env.OUTFITTER_DEV_TOKEN;
  const workspace = process.env.WORKSPACE ?? DEFAULT_WORKSPACE;
  const piBin = process.env.PI_BIN ?? DEFAULT_PI_BIN;

  const piVersion = await getPiVersion(piBin);
  const wsUrl = buildWsUrl(apiOrigin, runId);

  const link = new Link({
    url: wsUrl,
    // Called fresh on every (re)connect so a run that outlives one identity token's lifetime still
    // authenticates -- see link.ts's module doc.
    headers: async () => ({ Authorization: `Bearer ${await getIdToken(apiOrigin, devToken)}` }),
    runId,
    sessionId: "", // learned from run.spec; see Link.setSessionId
    agentdVersion: AGENTD_VERSION,
    piVersion,
  });

  const controller = new RunController({
    link,
    gitOps: createGitOps(),
    workspace,
    piBin,
    agentdVersion: AGENTD_VERSION,
    piVersion,
    workspaceSnapshotDir: process.env.WORKSPACE_SNAPSHOT_DIR,
    onLog: (line) => console.error(`[agentd] ${line}`),
  });

  process.once("SIGTERM", () => {
    void controller.handleSigterm();
  });

  link.connect();
}

main().catch((err) => {
  console.error(`agentd: fatal: ${err?.message ?? err}`);
  process.exit(1);
});
