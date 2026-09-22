#!/usr/bin/env node
/**
 * Entry point. Reads env (OUTFITTER_API, RUN_ID, RUN_TOKEN, OUTFITTER_DEV_TOKEN, WORKSPACE, PI_BIN), gets an
 * auth token, opens the link to the api, and lets RunController drive the state machine once
 * `run.spec` arrives. See outfitter/docs/protocol.md.
 */
import { getIdToken } from "./auth.js";
import { createGitOps } from "./git.js";
import { Link } from "./link.js";
import { RunController } from "./run.js";
import { resolveRunAsUser, chownRecursive } from "./run-as-user.js";
import { createLogger } from "./logger.js";
import { getPiVersion } from "./pi-version.js";
import { preloadSessionManager } from "./session.js";

const AGENTD_VERSION = "0.1.0";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_PI_BIN = "/opt/kernal/node_modules/.bin/pi";

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

async function main(): Promise<void> {
  const apiOrigin = requireEnv("OUTFITTER_API");
  const runId = requireEnv("RUN_ID");
  const runToken = requireEnv("RUN_TOKEN");
  const devToken = process.env.OUTFITTER_DEV_TOKEN;
  const workspace = process.env.WORKSPACE ?? DEFAULT_WORKSPACE;
  const piBin = process.env.PI_BIN ?? DEFAULT_PI_BIN;

  // Startup phases are timed: the first cloud sessions showed ~3 minutes between Cloud Run's start
  // time and agentd's first log line, and nothing here should take more than seconds.
  const bootStart = Date.now();
  const phase = (name: string) => console.log(JSON.stringify({ severity: "INFO", message: `startup: ${name}`, elapsedMs: Date.now() - bootStart, runId }));
  phase("main entered");
  const piVersion = await getPiVersion(piBin);
  phase(`pi version resolved (${piVersion})`);
  const wsUrl = buildWsUrl(apiOrigin, runId);

  // E1.6: one structured JSON log line per event to stdout (human-readable when stdout is a TTY,
  // e.g. local dev) instead of plain-text console.error, which Cloud Run Jobs was not surfacing
  // anywhere but the job's own audit entries -- see docs/reports/cost-and-logs.md. RUN_TOKEN and,
  // once run.spec arrives, the per-run secrets (RunController.begin) are registered so they can
  // never appear in a log line even if an error message or pi's own stderr happens to echo one back.
  const logger = createLogger({ runId });
  logger.addSecret(runToken);
  logger.addSecret(devToken);
  const onLog = (line: string) => logger.info(line);

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
    logger,
    spendFile: process.env.OUTFITTER_SPEND_FILE,
    spendExtensionPath: process.env.OUTFITTER_SPEND_EXTENSION,
    mailExtensionPath: process.env.OUTFITTER_MAIL_EXTENSION,
    startupPhases: true,
  });

  controller.onStateChange((state) => logger.info("state change", { state }));

  process.once("SIGTERM", () => {
    void controller.handleSigterm();
  });

  // See link.ts's TERMINAL_CLOSE_CODES doc: the first real Cloud Run execution hit 4404 ("run not
  // found") and reconnected twice a second forever because no close code was ever treated as
  // terminal. 4404/4409 mean the run is already done server-side (exit 0, nothing to do); 4400/4401
  // mean agentd itself is misconfigured (exit 1); 4412 means the run has no usable secret and can
  // never start (exit 1).
  link.onClose((code, reason, terminal) => {
    logger.info("link closed", { code, reason: reason || undefined, terminal });
  });

  link.onTerminal((code, reason) => {
    logger.error(`link closed with terminal code ${code}: ${reason || "(no reason given)"}`, { code });
    process.exit(code === 4404 || code === 4409 ? 0 : 1);
  });

  // A misconfigured job (bad URL, api never provisions the run, ...) would otherwise reconnect
  // quietly until it hits its own much longer (e.g. 24h) timeout. Give up loudly well before that.
  link.onUnspecTimeout(() => {
    logger.error("no run.spec received within the retry window; giving up");
    process.exit(1);
  });

  phase("connecting to the link");
  link.connect();
  // Loading pi's package for the session import takes seconds on a cold sandbox. Started once the
  // connect is under way, it fills the network wait for the ID token, the handshake and run.spec
  // instead of sitting between run.spec and spawning pi (docs/reports/startup-trim.md).
  preloadSessionManager();
}

main().catch((err) => {
  // Fallback logger: main() can throw before requireEnv/createLogger ever runs (e.g. a missing env
  // var), so this can't rely on the `logger` declared inside main(). Still structured JSON on stdout,
  // matching every other agentd log line, rather than a bare console.error string on stderr.
  createLogger().error(`agentd: fatal: ${err?.message ?? err}`);
  process.exit(1);
});
