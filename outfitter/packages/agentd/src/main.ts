#!/usr/bin/env node
/**
 * Entry point. Resolves the run assignment (OUTFITTER_API, RUN_ID, RUN_TOKEN -- from env, or, on a
 * GKE warm pod, by waiting for it; see assignment.ts), gets an auth token, opens the link to the
 * api, and lets RunController drive the state machine once `run.spec` arrives. Also reads
 * OUTFITTER_DEV_TOKEN, WORKSPACE, PI_BIN. See outfitter/docs/protocol.md.
 */
import { existsSync } from "node:fs";
import { chown } from "node:fs/promises";
import { resolveAssignment } from "./assignment.js";
import { getIdToken } from "./auth.js";
import { BROWSER_CAPTURE_MAX_BYTES, captureDownloadError } from "./browser-capture.js";
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

/** `$OUTFITTER_GITHUB_SOCKET`, or `/run/outfitter/github.sock` when the image created that
 * directory. Local dev has neither the variable nor the directory: no broker socket. */
function githubSocketPath(): string | undefined {
  const configured = process.env.OUTFITTER_GITHUB_SOCKET;
  if (configured) return configured;
  if (existsSync("/run/outfitter")) return "/run/outfitter/github.sock";
  return undefined;
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
  const devToken = process.env.OUTFITTER_DEV_TOKEN;
  const workspace = process.env.WORKSPACE ?? DEFAULT_WORKSPACE;
  const piBin = process.env.PI_BIN ?? DEFAULT_PI_BIN;

  // Read exactly once, here, and held in `devToken` above for the rest of the process: drop it
  // from process.env immediately so nothing agentd spawns can inherit it by accident. pi's own
  // environment is already built from an allowlist that excludes it (pi.ts's baseEnvForPi), but
  // every *other* child agentd spawns -- `git`, `pi --version`, anything a future code path adds --
  // inherits process.env wholesale (git.ts's execFile). RUN_TOKEN gets the same treatment, inside
  // `resolveAssignment` (assignment.ts), wherever it's actually read from -- env today, or, on a GKE
  // warm pod, from a root-only downward-API file that was never in process.env to begin with.
  delete process.env.OUTFITTER_DEV_TOKEN;

  // Startup phases are timed: the first cloud sessions showed ~3 minutes between Cloud Run's start
  // time and agentd's first log line, and nothing here should take more than seconds. `runId` isn't
  // known yet on a GKE warm pod (see below), so phase lines before the assignment resolves just omit
  // it; `phaseRunId` is filled in once it is.
  const bootStart = Date.now();
  let phaseRunId: string | undefined;
  const phase = (name: string) => console.log(JSON.stringify({ severity: "INFO", message: `startup: ${name}`, elapsedMs: Date.now() - bootStart, runId: phaseRunId }));
  phase("main entered");
  const piVersion = await getPiVersion(piBin);
  phase(`pi version resolved (${piVersion})`);

  // E1.6: one structured JSON log line per event to stdout (human-readable when stdout is a TTY,
  // e.g. local dev) instead of plain-text console.error, which Cloud Run Jobs was not surfacing
  // anywhere but the job's own audit entries -- see docs/reports/cost-and-logs.md. `devToken` is
  // registered now; RUN_TOKEN and, once run.spec arrives, the per-run secrets (RunController.begin)
  // are registered as soon as each is known, so none can ever appear in a log line even if an error
  // message or pi's own stderr happens to echo one back.
  let logger = createLogger();
  logger.addSecret(devToken);
  const onLog = (line: string) => logger.info(line);

  // Resolved once at startup: the uid/gid pi is spawned as (finding #1, run-as-user.ts). undefined
  // when agentd isn't root (local dev outside the sandbox image) -- nothing to drop there. Run-
  // independent work: doesn't need the run assignment, so it happens before the wait below (PR4,
  // gke-sandbox-provider-plan.md §3) rather than after -- a warm GKE pod pre-pays it while idle.
  const runAsUser = await resolveRunAsUser({ onLog });

  // Loading pi's package for the session import takes seconds on a cold sandbox. Started here,
  // before the (possibly long) wait for a warm pod's assignment, so it overlaps that wait instead of
  // sitting between run.spec and spawning pi (docs/reports/startup-trim.md and PR4: a warm pod that
  // waits idle to be claimed pre-pays this for free).
  preloadSessionManager();

  // Env first (Cloud Run, docker, inprocess, GKE cold claims): RUN_ID/RUN_TOKEN/OUTFITTER_API are
  // already set, and this resolves immediately, exactly as before assignment.ts existed. On a GKE
  // warm pod, RUN_ID isn't in env yet -- this waits (no default timeout) for a SandboxClaim's
  // annotations to reach the pod's downward-API files (spec §3.5 Option B). Never logs the token;
  // held in memory only (#45), never written to process.env.
  phase("waiting for assignment");
  const { runId, runToken, apiOrigin, waitedMs } = await resolveAssignment();
  phaseRunId = runId;
  logger = logger.child({ runId });
  logger.addSecret(runToken);
  phase(`assigned (waitedMs=${waitedMs})`);

  const wsUrl = buildWsUrl(apiOrigin, runId);

  const link = new Link({
    url: wsUrl,
    // Called fresh on every (re)connect so a run that outlives one identity token's lifetime still
    // authenticates -- see link.ts's module doc. Timed (#143): the spike's S2 report saw 9s pass
    // between agentd logging "connecting to the link" and the request reaching the api, with nothing
    // logged in between; the likeliest cost is this fetch's first Workload Identity token exchange on
    // a fresh GKE node.
    headers: async () => {
      const tokenFetchStart = Date.now();
      const token = await getIdToken(apiOrigin, devToken);
      phase(`identity token fetched (${Date.now() - tokenFetchStart}ms)`);
      return { Authorization: `Bearer ${token}` };
    },
    runId,
    runToken,
    sessionId: "", // learned from run.spec; see Link.setSessionId
    agentdVersion: AGENTD_VERSION,
    piVersion,
  });

  const controller = new RunController({
    link,
    // Local git (the checkout included) runs as the same user as pi, never as root inside the
    // agent-owned workspace; root only clones, fetches and pushes (git.ts's module doc).
    gitOps: createGitOps(
      undefined,
      runAsUser
        ? {
            runAs: runAsUser,
            // The image's /workspace belongs to `agent`; root needs it for the clone itself, and
            // hands the whole tree back straight afterwards (git.ts's takeOver/handOver).
            takeOver: async (dir: string) => {
              // Not fatal on its own: the clone may still work (a root-owned or already-correct
              // directory), and the git error that follows a real failure is cryptic enough that
              // this line is what explains it.
              try {
                await chown(dir, 0, 0);
              } catch (err: any) {
                logger.warn("could not take the workspace for the clone", { dir, error: String(err?.message ?? err) });
              }
            },
            handOver: (dir: string) => chownRecursive(dir, runAsUser.uid, runAsUser.gid),
          }
        : {},
    ),
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
    browserExtensionPath: process.env.OUTFITTER_BROWSER_EXTENSION,
    // The socket's credential: the same Google ID token (or OUTFITTER_DEV_TOKEN) plus RUN_TOKEN.
    // Held here, not in pi's environment. A user Dongle is never added.
    downloadCapture: async (sessionId, captureId) => {
      const token = await getIdToken(apiOrigin, devToken);
      const url = new URL(
        `/api/sessions/${encodeURIComponent(sessionId)}/browser/captures/${encodeURIComponent(captureId)}`,
        apiOrigin,
      );
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-outfitter-run-token": runToken,
        },
      });
      if (res.status === 413) throw captureDownloadError("too_large");
      if (!res.ok) throw captureDownloadError("timeout");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > BROWSER_CAPTURE_MAX_BYTES) throw captureDownloadError("too_large");
      return bytes;
    },
    startupPhases: true,
    githubSocketPath: githubSocketPath(),
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

  // Timed (#143), paired with "connecting to the link" below: the delta between the two elapsedMs
  // values is the full connect cost (identity token fetch, TCP/TLS, WS upgrade). Fires on every
  // (re)connect, not just the first -- see link.ts's onOpen doc.
  link.onOpen(() => phase("connected to the link"));

  phase("connecting to the link");
  link.connect();
}

main().catch((err) => {
  // Fallback logger: main() can throw before resolveAssignment/createLogger ever runs (e.g. a
  // missing env var), so this can't rely on the `logger` declared inside main(). Still structured
  // JSON on stdout, matching every other agentd log line, rather than a bare console.error string on
  // stderr.
  createLogger().error(`agentd: fatal: ${err?.message ?? err}`);
  process.exit(1);
});
