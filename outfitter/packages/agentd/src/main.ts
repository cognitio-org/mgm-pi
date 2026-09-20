#!/usr/bin/env node
/**
 * Entry point. Reads env (OUTFITTER_API, RUN_ID, RUN_TOKEN, OUTFITTER_DEV_TOKEN, WORKSPACE, PI_BIN), gets an
 * auth token, opens the link to the api, and lets RunController drive the state machine once
 * `run.spec` arrives. See outfitter/docs/protocol.md.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getIdToken } from "./auth.js";
import { createGitOps } from "./git.js";
import { Link } from "./link.js";
import { RunController } from "./run.js";
import { resolveRunAsUser, chownRecursive } from "./run-as-user.js";

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
  const runToken = requireEnv("RUN_TOKEN");
  const devToken = process.env.OUTFITTER_DEV_TOKEN;
  const workspace = process.env.WORKSPACE ?? DEFAULT_WORKSPACE;
  const piBin = process.env.PI_BIN ?? DEFAULT_PI_BIN;

  const piVersion = await getPiVersion(piBin);
  const wsUrl = buildWsUrl(apiOrigin, runId);
  const onLog = (line: string) => console.error(`[agentd] ${line}`);

  // Resolved once at startup: the uid/gid pi is spawned as (finding #1, run-as-user.ts). undefined
  // when agentd isn't root (local dev outside the sandbox image) -- nothing to drop there.
  const runAsUser = await resolveRunAsUser({ onLog });

  const link = new Link({
    url: wsUrl,
    // Called fresh on every (re)connect so a run that outlives one identity token's lifetime still
    // authenticates -- see link.ts's module doc.
    headers: async () => ({ Authorization: `Bearer ${await getIdToken(apiOrigin, devToken)}` }),
    runId,
    runToken,
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
    runAsUser,
    chownWorkspace: runAsUser
      ? (path: string) => chownRecursive(path, runAsUser.uid, runAsUser.gid)
      : undefined,
    onLog,
  });

  process.once("SIGTERM", () => {
    void controller.handleSigterm();
  });

  // See link.ts's TERMINAL_CLOSE_CODES doc: the first real Cloud Run execution hit 4404 ("run not
  // found") and reconnected twice a second forever because no close code was ever treated as
  // terminal. 4404/4409 mean the run is already done server-side (exit 0, nothing to do); 4400/4401
  // mean agentd itself is misconfigured (exit 1); 4412 means the run has no usable secret and can
  // never start (exit 1).
  link.onTerminal((code, reason) => {
    console.error(`[agentd] link closed with terminal code ${code}: ${reason || "(no reason given)"}`);
    process.exit(code === 4404 || code === 4409 ? 0 : 1);
  });

  // A misconfigured job (bad URL, api never provisions the run, ...) would otherwise reconnect
  // quietly until it hits its own much longer (e.g. 24h) timeout. Give up loudly well before that.
  link.onUnspecTimeout(() => {
    console.error("[agentd] no run.spec received within the retry window; giving up");
    process.exit(1);
  });

  link.connect();
}

main().catch((err) => {
  console.error(`agentd: fatal: ${err?.message ?? err}`);
  process.exit(1);
});
