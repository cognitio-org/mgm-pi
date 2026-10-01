#!/usr/bin/env node
/**
 * Entry point. Resolves the run assignment (OUTFITTER_API, RUN_ID, RUN_TOKEN -- from env, or, on a
 * GKE warm pod, by waiting for it; see assignment.ts), gets an auth token, opens the link to the
 * api, and lets RunController drive the state machine once `run.spec` arrives. Also reads
 * OUTFITTER_DEV_TOKEN, WORKSPACE, PI_BIN. See outfitter/docs/protocol.md.
 *
 * HIGH-severity note (fixed): on the env path, `RUN_TOKEN` must be gone from `process.env` before
 * `getPiVersion` and `resolveRunAsUser` run -- both spawn children (`execFile`) that inherit
 * `process.env` wholesale, and a review of the first cut of this file proved the leak with a
 * `PI_BIN` probe that printed `RUN_TOKEN_IN_CHILD=<the real secret>`. `main()` therefore snapshots
 * `process.env` into `bootEnv` and deletes `RUN_TOKEN`/`OUTFITTER_DEV_TOKEN` from the *real*
 * `process.env` as its very first act, before resolving the assignment (which reads from the
 * snapshot, not `process.env`) and before anything else that could spawn a child. On the env path
 * this also restores this file's pre-assignment.ts behaviour exactly: the three env checks
 * (`OUTFITTER_API`/`RUN_ID`/`RUN_TOKEN`, same order, same error text) run before a single phase is
 * logged or a single child is spawned, so a misconfigured deployment fails exactly as fast and as
 * loudly as it always did. Only a GKE warm pod (`assignment.ts`'s `isWarmAssignmentWait`) defers
 * `resolveAssignment` past the run-independent setup below, so it can pre-pay that work while idle.
 */
import { existsSync } from "node:fs";
import { chown } from "node:fs/promises";
import { isWarmAssignmentWait, resolveAssignment, type Assignment } from "./assignment.js";
import { getIdToken } from "./auth.js";
import { BROWSER_CAPTURE_MAX_BYTES, captureDownloadError } from "./browser-capture.js";
import { createGitOps } from "./git.js";
import { Link } from "./link.js";
import { RunController } from "./run.js";
import { resolveRunAsUser, chownRecursive } from "./run-as-user.js";
import { createLogger } from "./logger.js";
import { getPiVersion } from "./pi-version.js";
import { preloadSessionManager } from "./session.js";
import { bootTimings } from "./boot-timings.js";

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

/** Sysop tools (#287): `$OUTFITTER_ADMIN_SOCKET`, or `/run/outfitter/admin.sock` in the image.
 * run.ts opens it only for a tape with admin tools. */
function adminSocketPath(): string | undefined {
  const configured = process.env.OUTFITTER_ADMIN_SOCKET;
  if (configured) return configured;
  if (existsSync("/run/outfitter")) return "/run/outfitter/admin.sock";
  return undefined;
}

/** `https://api.example.com` -> `wss://api.example.com/agent/ws?run=<runId>` (and http -> ws for
 * local dev). */
/** A positive integer number of milliseconds from the environment, or undefined (use the default). */
function positiveMs(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function buildWsUrl(apiOrigin: string, runId: string): string {
  const url = new URL(apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/agent/ws";
  url.search = `?run=${encodeURIComponent(runId)}`;
  return url.toString();
}

async function main(): Promise<void> {
  // Snapshot process.env before touching it: resolveAssignment (env path, below) still needs to
  // read RUN_TOKEN/OUTFITTER_DEV_TOKEN, but the *real* process.env must never hold them for even one
  // tick after this point, since getPiVersion/resolveRunAsUser (further below) spawn children
  // (execFile) that inherit process.env wholesale -- see this file's HIGH-severity module doc.
  const bootEnv: NodeJS.ProcessEnv = { ...process.env };
  delete process.env.RUN_TOKEN;
  delete process.env.OUTFITTER_DEV_TOKEN;

  const warmWait = isWarmAssignmentWait(bootEnv);
  // Env path (Cloud Run, docker, inprocess, GKE cold, or a genuinely missing assignment): resolve
  // right now, before any phase is logged or any child spawned -- byte for byte the same checks,
  // order and error text this file has always had, and now the same *timing* too (a misconfigured
  // deployment fails exactly as fast and as silently -- zero log lines -- as it did before
  // assignment.ts existed). Only a GKE warm pod defers this (see the `if (!assignment)` block
  // below), so it can pre-pay the run-independent setup while idle waiting to be claimed.
  let assignment: Assignment | undefined = warmWait ? undefined : await resolveAssignment(bootEnv);

  const devToken = bootEnv.OUTFITTER_DEV_TOKEN;
  const workspace = bootEnv.WORKSPACE ?? DEFAULT_WORKSPACE;
  const piBin = bootEnv.PI_BIN ?? DEFAULT_PI_BIN;

  // Startup phases are timed: the first cloud sessions showed ~3 minutes between Cloud Run's start
  // time and agentd's first log line, and nothing here should take more than seconds. `phaseRunId`
  // is already known on the env path (from `assignment` above); on a GKE warm pod it's genuinely
  // unknown until the wait below resolves, so early phase lines there just omit it.
  const bootStart = Date.now();
  let phaseRunId = assignment?.runId;
  const phase = (name: string) => console.log(JSON.stringify({ severity: "INFO", message: `startup: ${name}`, elapsedMs: Date.now() - bootStart, runId: phaseRunId }));
  // Connection attempts (initial connect + every reconnect) get their own counter so a timing line
  // says "startup: ..." only the first time and "reconnect <n>: ..." after -- see the doc on
  // `connectPhase` and #143/LOW-3. Incremented once per attempt, inside `headers()` below.
  let connectAttempt = 0;
  const connectPhase = (name: string) => {
    const label = connectAttempt <= 1 ? `startup: ${name}` : `reconnect ${connectAttempt - 1}: ${name}`;
    console.log(JSON.stringify({ severity: "INFO", message: label, elapsedMs: Date.now() - bootStart, runId: phaseRunId }));
  };
  phase("main entered");
  const piVersion = await getPiVersion(piBin);
  phase(`pi version resolved (${piVersion})`);

  // E1.6: one structured JSON log line per event to stdout (human-readable when stdout is a TTY,
  // e.g. local dev) instead of plain-text console.error, which Cloud Run Jobs was not surfacing
  // anywhere but the job's own audit entries -- see docs/reports/cost-and-logs.md. `devToken` is
  // registered now; RUN_TOKEN and, once run.spec arrives, the per-run secrets (RunController.begin)
  // are registered as soon as each is known, so none can ever appear in a log line even if an error
  // message or pi's own stderr happens to echo one back. `runId` is already in context on the env
  // path (LOW-1: it used to be missing from every log line before the assignment resolved, even
  // though it was known from boot).
  let logger = createLogger(assignment ? { runId: assignment.runId } : {});
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
  // hello.boot (protocol.ts's BootTimings): the run-independent setup ends here. On the env path the
  // assignment was known before bootStart, so everything from here to hello is the person's wait.
  const setupMs = Date.now() - bootStart;
  let assignedAt = bootStart;
  let assignmentWaitMs: number | undefined;

  // Only reached on a GKE warm pod (`assignment` is still undefined here): wait (no default
  // timeout) for a SandboxClaim's annotations to reach the pod's downward-API files (spec §3.5
  // Option B). Never logs a token value; held in memory only (#45), never written to process.env. A
  // presence-only heartbeat every few minutes proves it's still alive and what it's still missing,
  // without ever logging a value (LOW-4).
  if (!assignment) {
    phase("waiting for assignment");
    assignment = await resolveAssignment(bootEnv, {
      onHeartbeat: (present) =>
        phase(
          `still waiting for assignment; present: run-id=${present.runId ? "yes" : "no"} ` +
            `run-token=${present.runToken ? "yes" : "no"} api=${present.api ? "yes" : "no"}`,
        ),
    });
    phaseRunId = assignment.runId;
    assignedAt = Date.now();
    assignmentWaitMs = assignment.waitedMs;
    logger = logger.child({ runId: assignment.runId });
    phase(`assigned (waitedMs=${assignment.waitedMs})`);
  }
  logger.addSecret(assignment.runToken);
  const { runId, runToken, apiOrigin } = assignment;

  const wsUrl = buildWsUrl(apiOrigin, runId);

  // The moment (elapsed since boot) the current connect attempt's identity-token fetch started --
  // read by `onHeadersError` below, which has no other way to know how long the failed attempt ran.
  let tokenFetchStart = 0;
  // The current attempt's identity-token fetch time and when it finished, for hello.boot.
  let identityTokenMs: number | undefined;
  let tokenFetchedAt: number | undefined;

  const link = new Link({
    url: wsUrl,
    // Called fresh on every (re)connect so a run that outlives one identity token's lifetime still
    // authenticates -- see link.ts's module doc. Timed (#143): the spike's S2 report saw 9s pass
    // between agentd logging "connecting to the link" and the request reaching the api, with nothing
    // logged in between; the likeliest cost is this fetch's first Workload Identity token exchange on
    // a fresh GKE node.
    headers: async () => {
      connectAttempt++;
      tokenFetchStart = Date.now();
      identityTokenMs = undefined;
      tokenFetchedAt = undefined;
      const token = await getIdToken(apiOrigin, devToken);
      tokenFetchedAt = Date.now();
      identityTokenMs = tokenFetchedAt - tokenFetchStart;
      connectPhase(`identity token fetched (${identityTokenMs}ms)`);
      return { Authorization: `Bearer ${token}` };
    },
    // #157/#143: a failed fetch used to be silently swallowed by link.ts, indistinguishable from a
    // slow network. `err.message` is safe to log -- getIdToken never puts a token in one.
    onHeadersError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      connectPhase(`identity token fetch failed (${Date.now() - tokenFetchStart}ms): ${message}`);
    },
    runId,
    runToken,
    sessionId: "", // learned from run.spec; see Link.setSessionId
    agentdVersion: AGENTD_VERSION,
    piVersion,
    // Read as each hello is built, i.e. the moment the socket opened. The api keeps the first
    // accepted hello's and ignores later ones, so a reconnect's numbers don't matter.
    bootTimings: () =>
      bootTimings({ now: Date.now(), bootStart, setupMs, assignedAt, assignmentWaitMs, identityTokenMs, tokenFetchedAt }),
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
    adminSocketPath: adminSocketPath(),
    // Drive previews (#217): the listener itself only starts when run.spec carries preview config.
    previewIdleCapMs: positiveMs(process.env.PREVIEW_IDLE_CAP_MS),
    ngrokBin: process.env.OUTFITTER_NGROK_BIN || undefined,
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
  // (re)connect, not just the first -- see link.ts's onOpen doc. `connectPhase`, not `phase`: only
  // the first ever connect says "startup: connected to the link"; reconnects say "reconnect <n>: ..."
  // (LOW-3) since they'd otherwise repeat the same "startup:" line every time the socket drops.
  link.onOpen(() => connectPhase("connected to the link"));

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
