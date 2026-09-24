/**
 * The run state machine from protocol.md: `cloning -> restoring -> starting -> running/idle ->
 * checkpointing -> stopping`. Wires together git, session import, the pi RPC process and the link,
 * and handles every down-message in protocol.md (`run.spec`, `ack`, `prompt`, `steer`, `follow_up`,
 * `abort`, `ui_response`, `rpc`, `checkpoint`, `diff`, `read`, `stop`, `browser.capture.entry`,
 * `browser.capture.result`, `browser.action.result`, `browser.inspect.result`, `github.result`).
 */
import { mkdir, readFile, open as openFile, chown } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { branchAllowed, DEFAULT_BRANCH_PREFIX, normalizeBranchPrefix } from "./branch-policy.js";
import { ActionListener } from "./browser-action.js";
import { CaptureListener } from "./browser-capture.js";
import { InspectListener } from "./browser-inspect.js";
import { renderGuru } from "./guru.js";
import { attributionTrailers, authHeaderSecret, botIdentityEnv, sanitizeAuthor, type GitOps } from "./git.js";
import { githubRepoHttps, gitProxyInsteadOfEnv, parseGithubCloneUrl, startGitProxy, type GitProxy } from "./git-proxy.js";
import { listenGithubSocket, type GithubSocket } from "./github-socket.js";
import { createAsyncLock } from "./lock.js";
import { spawnPi, SessionTailer, SpendTailer, validateSpendLine, type PiProcess, type SpendLogLine } from "./pi.js";
import { importSession, writeSnapshotFile, emptySessionJsonl, lastKnownModelState } from "./session.js";
import { StartupPhases } from "./startup-phases.js";
import type { Logger } from "./logger.js";
import type { RunAsUser } from "./run-as-user.js";
import { validateSnapshotUrl, snapshotHostAllowlist, isDevMode } from "./snapshot-url.js";
import {
  snapshotWorkspaceFiles,
  diffWorkspaceFiles,
  restoreWorkspace,
  checkpointWorkspaceTarball,
  type FileMtimes,
} from "./workspace.js";
import { runPlaywrightBeforeCheckpoint, type PlaywrightSpawn } from "./playwright-check.js";
import type {
  ByeReason,
  DownAbort,
  DownFollowUp,
  DownMail,
  DownMessage,
  DownPrompt,
  DownRpc,
  DownRunSpec,
  DownSteer,
  DownUiResponse,
  PiRpcCommand,
  PiRpcEvent,
  RunState,
  UpMessage,
} from "./protocol.js";

/** Down-messages that target the pi process directly. Queued (see `pendingPiMessages`) while `pi`
 * hasn't been spawned yet -- e.g. a prompt that arrives during `cloning`/`restoring`/`starting`. */
type PiTargetedDownMessage = DownPrompt | DownSteer | DownFollowUp | DownAbort | DownUiResponse | DownRpc | DownMail;

function isPiTargetedDownMessage(msg: DownMessage): msg is PiTargetedDownMessage {
  return (
    msg.t === "prompt" ||
    msg.t === "steer" ||
    msg.t === "follow_up" ||
    msg.t === "abort" ||
    msg.t === "ui_response" ||
    msg.t === "rpc" ||
    msg.t === "mail"
  );
}

export interface LinkPort {
  sendSeq(build: (seq: number) => UpMessage): number;
  send(msg: UpMessage): void;
  onMessage(handler: (msg: DownMessage) => void): void;
  /** Optional: Link implements this so later reconnects' `hello` carries the learned sessionId. */
  setSessionId?(sessionId: string): void;
  /** Optional: Link implements this to flush the final `bye` before the process exits (see
   * Link.sendAndFlush). Falls back to a plain `send` when a test double doesn't provide it. */
  sendAndFlush?(msg: UpMessage): Promise<void>;
  /** The API WebSocket opened or dropped. The GitHub broker uses these; seq replay does not. */
  onOpen?(handler: () => void): void;
  onClose?(handler: () => void): void;
}

export type SpawnPiFn = typeof spawnPi;
export type ImportSessionFn = typeof importSession;
export type WriteSnapshotFileFn = typeof writeSnapshotFile;
export type TailerFactory = (
  sessionFile: string,
  onEntry: (entry: Record<string, unknown>) => void,
) => { start(): void; stop(): void; poll(): Promise<void> };

/** E2.11: same shape as TailerFactory, for OUTFITTER_SPEND_FILE (pi-extension/outfitter-spend.ts's
 * output) instead of the pi session file. `onLine` receives the raw parsed JSON value, unvalidated --
 * OUTFITTER_SPEND_FILE lives in /tmp and is writable by the model's own shell user, so `handleSpendLine`
 * validates each line with `validateSpendLine` before using it (see pi.ts). */
export type SpendTailerFactory = (
  spendFile: string,
  onLine: (line: unknown) => void,
) => { start(): void; stop(): void; poll(): Promise<void> };

export interface RunControllerDeps {
  link: LinkPort;
  gitOps: GitOps;
  workspace: string;
  piBin: string;
  agentdVersion: string;
  piVersion: string;
  spawnPi?: SpawnPiFn;
  importSession?: ImportSessionFn;
  writeSnapshotFile?: WriteSnapshotFileFn;
  createTailer?: TailerFactory;
  fetchFn?: typeof fetch;
  /** WORKSPACE_SNAPSHOT_DIR: where repo-less checkpoints write their workspace tarball. */
  workspaceSnapshotDir?: string;
  /** E2.11 (OUTFITTER_SPEND_FILE): path the outfitter-spend pi extension appends one JSON line to per
   * LiteLLM-backed response. Set -> the extension is loaded (`spendExtensionPath` below) and this
   * file is set as its own OUTFITTER_SPEND_FILE env var, and this run tails it and emits `spend`
   * up-frames. Unset -> no extension, no tailer, unchanged from before E2.11. */
  spendFile?: string;
  /** E2.11: path to pi-extension/outfitter-spend.ts (or its built .js), passed to renderGuru so it
   * adds `-e <path>` -- see guru.ts's RenderOptions doc. */
  spendExtensionPath?: string;
  /** E5.5 (OUTFITTER_MAIL_EXTENSION): path to pi-extension/outfitter-mail.ts (or its built .js). */
  mailExtensionPath?: string;
  /** Chrome companion §13 (OUTFITTER_BROWSER_EXTENSION): path to pi-extension/outfitter-browser.ts.
   * Set together with `downloadCapture`: the loopback listener starts only while the extension loads. */
  browserExtensionPath?: string;
  /** GET the capture jpeg with the run's API credential (the socket's bearer plus the run token).
   * Not a user Dongle, and not passed into the sandbox. */
  downloadCapture?: (sessionId: string, captureId: string) => Promise<Buffer>;
  createSpendTailer?: SpendTailerFactory;
  /** E1.6: structured JSON logging (logger.ts). Optional so existing tests (and any caller that only
   * wants the plain `onLog` string sink) keep working unchanged. When present, pi's own stderr goes
   * to `logger.debug` (tagged `source: "pi"`) instead of `onLog`, and run.spec's secrets are
   * registered with it (`logger.addSecret`) the moment they're known. */
  logger?: Logger;
  restoreWorkspace?: typeof restoreWorkspace;
  checkpointWorkspaceTarball?: typeof checkpointWorkspaceTarball;
  heartbeatIntervalMs?: number;
  sigtermBudgetMs?: number;
  now?: () => number;
  onExit?: (code: number) => void;
  onLog?: (line: string) => void;
  /** Resolved once at startup (main.ts, via run-as-user.ts's resolveRunAsUser): the uid/gid pi is
   * spawned as when agentd itself is root, so pi (and the model's shell) never shares a Linux user
   * -- and therefore /proc/<pid>/environ visibility -- with agentd's own git child. `undefined` when
   * agentd isn't root (nothing to drop; see run-as-user.ts). */
  runAsUser?: RunAsUser;
  /** Recursively chowns a path to `runAsUser`'s uid/gid. Called after `git clone` because the clone
   * runs as agentd's own (root) user for the auth env vars to stay root-only-readable, which would
   * otherwise leave /workspace owned by root instead of the `agent` user pi actually runs as. Later
   * git work (checkpoint commits, diff) runs as that user itself, and push runs as root from a
   * private repository outside /workspace (git.ts's module doc), so nothing needs chowning after a
   * checkpoint. No-op when `runAsUser` is undefined. */
  chownWorkspace?: (path: string) => Promise<void>;
  /** Start-up timing (startup-phases.ts): when set, `phase` lines are logged through `logger` from
   * `run.spec` to the first answer, and pi is sent one readiness probe right after it is spawned.
   * main.ts turns it on; tests leave it off so pi sees only the commands they send. */
  startupPhases?: boolean;
  /** Unix socket for GitHub API calls (`$OUTFITTER_GITHUB_SOCKET`). Unset: no socket, nothing pinned. */
  githubSocketPath?: string;
  /** Injected by tests. Production uses playwright-check.ts's own spawn, which never throws. */
  spawnPlaywright?: PlaywrightSpawn;
}

export type StateChangeHandler = (state: RunState, detail?: string) => void;

const MAIL_RESPONSE_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "error";
}

/** Renders an untrusted, already-parsed spend-line value for a WARNING log without ever throwing
 * (a hostile line could be a huge string or a structure that isn't cleanly JSON-serialisable) or
 * flooding the log with an attacker-controlled amount of text. */
function summarizeForLog(raw: unknown): string {
  const MAX_LENGTH = 300;
  let text: string;
  try {
    text = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    text = "<unserialisable>";
  }
  text ??= String(raw);
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}...(truncated)` : text;
}

/** Maps a `ui_response` down-message's generic `{id, value}` onto pi's extension_ui_response shape,
 * which distinguishes value/confirmed/cancelled responses (see rpc.md's Extension UI Protocol).
 * Deviation from protocol.md: the doc gives `ui_response` a single generic `value` field; pi needs to
 * know which shape the original dialog expects. Boolean -> confirmed, null/undefined -> cancelled,
 * anything else -> value. */
export function toExtensionUiResponse(msg: DownUiResponse): PiRpcCommand {
  if (typeof msg.value === "boolean") {
    return { type: "extension_ui_response", id: msg.id, confirmed: msg.value };
  }
  if (msg.value === null || msg.value === undefined) {
    return { type: "extension_ui_response", id: msg.id, cancelled: true };
  }
  return { type: "extension_ui_response", id: msg.id, value: msg.value };
}

export class RunController {
  private state: RunState = "cloning";
  private began = false;
  private pi: PiProcess | undefined;
  private tailer: { start(): void; stop(): void; poll(): Promise<void> } | undefined;
  /** E2.11: only set when deps.spendFile is configured. */
  private spendTailer: { start(): void; stop(): void; poll(): Promise<void> } | undefined;
  /** Loopback listener for the Drive browser_capture tool. Only set when that extension is loaded. */
  private captureListener: CaptureListener | undefined;
  /** Sibling loopback listener for browser_action. Same lifetime as the capture listener. */
  private actionListener: ActionListener | undefined;
  /** Sibling loopback listener for browser_inspect. Same lifetime as the capture listener. */
  private inspectListener: InspectListener | undefined;
  /** E2.11: running sum of every outfitter-spend.ts log line's `usage` (pi's own per-message cost
   * estimate) seen so far this run -- sent as `spend.estimate` on every frame. */
  private costEstimate = 0;
  private spec: DownRunSpec | undefined;
  private stateHandlers: StateChangeHandler[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastActivityAt = 0;
  private idleSince: number | undefined;
  private stopping = false;
  private disposed = false;
  /** Repo-less runs only: file mtimes as of the last checkpoint (or run start), for `diff` and
   * `checkpoint` without git. */
  private workspaceBaseline: FileMtimes | undefined;
  /** prompt/steer/follow_up/abort/ui_response/rpc down-messages that arrived before `pi` was
   * spawned (still `cloning`/`restoring`/`starting`). Flushed in order right after `begin()` spawns
   * pi -- without this, e.g. a prompt sent the instant a session opens is silently dropped. */
  private pendingPiMessages: PiTargetedDownMessage[] = [];
  /** Set by `handlePiEvent` when `agent_start`/`agent_settled` arrives *during* an explicit
   * `checkpoint()`, so it isn't lost -- `checkpoint()` would otherwise blindly restore whatever
   * state preceded it, even if that's now stale (see `checkpoint()`). */
  private stateAfterCheckpoint: RunState | undefined;
  /** E5.5: pi RPC request id -> mail id, for mail handed to pi whose `response` hasn't come back. */
  private readonly mailInFlight = new Map<string, string>();
  /** Mail pi has already accepted this run. A redelivery (the ack was lost, the lease expired) is
   * re-acked without prompting pi a second time. */
  private readonly mailAccepted = new Set<string>();
  /** Start-up phase timing; only set when deps.startupPhases is on (startup-phases.ts). */
  private startup: StartupPhases | undefined;
  /** Localhost git smart-HTTP proxy for this run, if it has a GitHub repo and token. */
  private gitProxy: GitProxy | undefined;
  /** Broker socket for GitHub API calls. Network git does not use it. */
  private githubSocket: GithubSocket | undefined;
  /** True once the API link has opened, false after it drops, until the next open. */
  private apiLinkUp = true;
  /** Serializes git-proxy forwards with the phase-0 checkpoint push. */
  private readonly networkGitLock = createAsyncLock();
  private readonly now: () => number;
  private readonly onExit: (code: number) => void;
  private readonly onLog: (line: string) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly sigtermBudgetMs: number;

  constructor(private readonly deps: RunControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.onExit = deps.onExit ?? ((code) => process.exit(code));
    this.onLog = deps.onLog ?? (() => {});
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 15_000;
    this.sigtermBudgetMs = deps.sigtermBudgetMs ?? 8_000;
    this.deps.link.onMessage((msg) => this.handleDown(msg));
    this.deps.link.onOpen?.(() => {
      this.apiLinkUp = true;
      this.githubSocket?.onLinkUp();
    });
    this.deps.link.onClose?.(() => {
      this.apiLinkUp = false;
      this.githubSocket?.onLinkDown();
    });
  }

  onStateChange(handler: StateChangeHandler): void {
    this.stateHandlers.push(handler);
  }

  getState(): RunState {
    return this.state;
  }

  /** Releases the pi child process, timers, and the tailer without sending a final `bye` -- for
   * tests and abrupt shutdown paths that don't want the full checkpoint-then-stop sequence. */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.stopHeartbeat();
    this.tailer?.stop();
    this.spendTailer?.stop();
    this.pi?.kill();
    void this.stopGitProxy();
    void this.stopCaptureListener();
    void this.stopGithubSocket();
  }

  private setState(state: RunState, detail?: string): void {
    this.state = state;
    this.deps.link.send({ t: "status", state, detail });
    for (const h of this.stateHandlers) h(state, detail);
  }

  /** Bug 7: sends a `status` frame for the *current* state carrying only `detail`, without treating
   * it as a state transition (no stateHandlers call) -- used to surface a one-off notice like a
   * rejected RPC command onto the run without disturbing idle timers or anything else keyed on an
   * actual state change. */
  private sendStatusDetail(detail: string): void {
    this.deps.link.send({ t: "status", state: this.state, detail });
  }

  handleDown(msg: DownMessage): void {
    if (isPiTargetedDownMessage(msg)) {
      if (!this.pi) {
        // pi isn't up yet (still cloning/restoring/starting) -- queue it rather than dropping it;
        // begin() flushes this queue, in order, right after spawning pi.
        this.pendingPiMessages.push(msg);
        return;
      }
      this.dispatchToPi(msg);
      return;
    }
    switch (msg.t) {
      case "run.spec":
        if (!this.began) {
          this.began = true;
          void this.begin(msg).catch((err) => this.fail(err));
        }
        return;
      case "ack":
        return; // Link already drops acked frames from its own buffer.
      case "checkpoint":
        void this.checkpoint(msg.message);
        return;
      case "diff":
        void this.handleDiff(msg.reqId);
        return;
      case "read":
        void this.handleRead(msg.reqId, msg.path);
        return;
      case "stop":
        void this.handleStop(msg.reason);
        return;
      case "browser.capture.entry":
        // Same counter as pi's own entry/event frames. One up-frame per down-frame.
        this.deps.link.sendSeq((seq) => ({ t: "entry", seq, entry: msg.entry }));
        return;
      case "browser.capture.result":
        // The tool is waiting on the loopback listener. No seq: the transcript row is the entry frame.
        this.captureListener?.deliver(msg);
        return;
      case "github.result":
        this.githubSocket?.deliver(msg);
        return;
      case "browser.action.result":
        // The action tool is waiting on its own loopback listener. No transcript row.
        this.actionListener?.deliver(msg);
        return;
      case "browser.inspect.result":
        // The inspect tool is waiting on its own loopback listener. No transcript row.
        this.inspectListener?.deliver(msg);
        return;
    }
  }

  /** Sends a pi-targeted down-message to the (assumed running) pi process. Shared by `handleDown`
   * (once pi is up) and `begin()` (flushing messages queued before pi was up). */
  private dispatchToPi(msg: PiTargetedDownMessage): void {
    switch (msg.t) {
      case "prompt":
        this.markActivity();
        this.pi?.send({
          type: "prompt",
          message: msg.text,
          ...(msg.images ? { images: msg.images } : {}),
          ...(msg.behavior ? { streamingBehavior: msg.behavior } : {}),
        });
        return;
      case "steer":
        this.markActivity();
        this.pi?.send({ type: "steer", message: msg.text });
        return;
      case "follow_up":
        this.markActivity();
        this.pi?.send({ type: "follow_up", message: msg.text });
        return;
      case "abort":
        this.pi?.send({ type: "abort" });
        return;
      case "ui_response":
        this.pi?.send(toExtensionUiResponse(msg));
        return;
      case "rpc":
        this.pi?.send(msg.command);
        return;
      case "mail":
        this.dispatchMail(msg);
        return;
    }
  }

  private dispatchMail(msg: DownMail): void {
    if (this.mailAccepted.has(msg.id)) {
      this.deps.link.send({ t: "mail.ack", id: msg.id });
      return;
    }
    // A stop is checkpointing and about to kill pi: a prompt accepted now would be acked but its
    // turn never run. Leave it unacked; the api re-queues it when this run's `bye` arrives.
    if (this.stopping) return;
    const rpcId = `mail:${msg.id}`;
    if (this.mailInFlight.has(rpcId)) return;
    this.markActivity();
    this.mailInFlight.set(rpcId, msg.id);
    // If pi never answers, forget it so a redelivery after the lease can try again.
    setTimeout(() => this.mailInFlight.delete(rpcId), MAIL_RESPONSE_TIMEOUT_MS).unref?.();
    this.pi?.send({ id: rpcId, type: "prompt", message: msg.text, streamingBehavior: msg.behavior ?? "followUp" });
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.onLog(`run failed: ${message}`);
    this.stopping = true;
    void this.bye("error", message).then(() => this.onExit(1));
  }

  private async begin(spec: DownRunSpec): Promise<void> {
    if (this.deps.startupPhases && this.deps.logger) {
      const logger = this.deps.logger;
      this.startup = new StartupPhases({ log: (message, fields) => logger.info(message, fields) });
      this.startup.mark("run.spec received");
    }
    this.spec = spec;
    this.deps.link.setSessionId?.(spec.session.id);
    // E1.6: register the run's own secrets before anything else can log a line that might echo one
    // back (a failed clone, a raw fetch error). RUN_TOKEN itself is registered once at startup, in
    // main.ts, before this controller even exists.
    this.deps.logger?.addSecret(spec.secrets.githubToken);
    // ...and the base64 form git carries in its auth header, in case a trace ever echoes it.
    if (spec.secrets.githubToken) this.deps.logger?.addSecret(authHeaderSecret(spec.secrets.githubToken));
    this.deps.logger?.addSecret(spec.secrets.litellmKey);

    if (spec.repo) {
      this.setState("cloning");
      await this.deps.gitOps.clone(
        {
          cloneUrl: spec.repo.cloneUrl,
          baseBranch: spec.repo.baseBranch,
          branch: spec.repo.branch,
          createBranch: spec.repo.createBranch,
          githubToken: spec.secrets.githubToken,
        },
        this.deps.workspace,
      );
      // git ran as agentd's own (root, in the sandbox image) user -- see git.ts's module doc and
      // RunControllerDeps.chownWorkspace's doc comment. Hand the clone back to the user pi is about
      // to run as before pi (or the model's shell) ever touches it.
      await this.deps.chownWorkspace?.(this.deps.workspace);
      this.startup?.mark("repo cloned");
      this.setState("restoring");
    } else {
      // Non-coding session: no repo to clone. Start with an empty /workspace, optionally restored
      // from a prior workspace tarball.
      await mkdir(this.deps.workspace, { recursive: true });
      this.setState("restoring");
      if (spec.workspace?.snapshotUrl) {
        const restoreWorkspaceFn = this.deps.restoreWorkspace ?? restoreWorkspace;
        await restoreWorkspaceFn(spec.workspace.snapshotUrl, this.deps.workspace, {
          fetchFn: this.deps.fetchFn,
        });
        this.startup?.mark("workspace restored");
      }
    }

    const writeSnapshotFileFn = this.deps.writeSnapshotFile ?? writeSnapshotFile;
    const importSessionFn = this.deps.importSession ?? importSession;
    let jsonl = spec.snapshot.jsonl;
    if (!jsonl && spec.snapshot.url) {
      // Finding #3 (docs/reports/security-review-pr1.md): validate before fetching, same as
      // workspace.ts's restoreWorkspace -- an unvalidated snapshot.url is a blind SSRF primitive.
      validateSnapshotUrl(spec.snapshot.url, { allowlist: snapshotHostAllowlist(), devMode: isDevMode() });
      const fetchFn = this.deps.fetchFn ?? fetch;
      const res = await fetchFn(spec.snapshot.url);
      if (!res.ok) {
        throw new Error(
          `snapshot fetch failed: ${res.status} ${res.statusText} (${spec.snapshot.url})`,
        );
      }
      jsonl = await res.text();
    }
    if (!jsonl) jsonl = emptySessionJsonl(spec.session.id, spec.session.cwd);
    const snapshotFile = await writeSnapshotFileFn(jsonl);
    const sessionFile = await importSessionFn(snapshotFile, this.deps.workspace, spec.session.id);
    // The import ran as agentd (root in the image); pi, running as the unprivileged agent user,
    // appends to this file and creates siblings in its directory, so hand both over now. Without
    // this the first round-two session died with EACCES on its first write.
    await this.deps.chownWorkspace?.(resolve(sessionFile, ".."));
    this.startup?.mark("session import done");

    if (!spec.repo) {
      this.workspaceBaseline = await snapshotWorkspaceFiles(this.deps.workspace);
    }

    this.setState("starting");
    // Bug 8 (docs/reports/cloud-fixes.md): skip --model/--thinking when the restored session's own
    // last-known model+thinking already match the guru's resolved ones -- see session.ts's
    // lastKnownModelState doc comment for why passing them unconditionally caused a fresh, genuinely
    // distinct-id model_change/thinking_level_change entry on every restore.
    const restoredModelState = lastKnownModelState(jsonl);
    const resolvedThinking = spec.guru.thinking ?? "off";
    const skipModelArg =
      restoredModelState.model === spec.guru.model &&
      (restoredModelState.thinking ?? "off") === resolvedThinking;
    const rendered = renderGuru(spec.guru, {
      piBin: this.deps.piBin,
      sessionFile,
      onLog: this.onLog,
      spendExtensionPath: this.deps.spendFile ? this.deps.spendExtensionPath : undefined,
      mailExtensionPath: this.deps.mailExtensionPath,
      browserExtensionPath: this.deps.browserExtensionPath,
      skipModelArg,
    });
    const secretEnv: Record<string, string> = {};
    // Not a secret, but pinned here after guru.env like the rest so a guru can't spoof it; the
    // outfitter-mail extension tells the model its own address with it.
    secretEnv.OUTFITTER_SESSION_ID = spec.session.id;
    // Same for commit identity: the agent's own commits are made by the Outfitter bot (author and
    // committer; git-github-spec.md, "Attribution"), and the session's person rides along as
    // OUTFITTER_AUTHOR_* for tooling that appends the attribution trailers. No token here.
    Object.assign(secretEnv, botIdentityEnv());
    const author = sanitizeAuthor(spec.author);
    if (author) {
      secretEnv.OUTFITTER_AUTHOR_NAME = author.name;
      secretEnv.OUTFITTER_AUTHOR_EMAIL = author.email;
      if (author.login) secretEnv.OUTFITTER_AUTHOR_LOGIN = author.login;
    }
    if (spec.secrets.litellmKey) secretEnv.LITELLM_AGENT_KEY = spec.secrets.litellmKey;
    // Security-review-pr15.md finding #1: pin the LiteLLM base URL from the server-controlled
    // spec, spread after `rendered.env` (guru.env), so a guru-supplied LITELLM_BASE_URL can never
    // redirect where outfitter-spend.ts sends the real per-run key -- belt and suspenders on top of
    // the guru.env denylist in guru.ts/routes/gurus.ts.
    if (spec.secrets.litellmBaseUrl) secretEnv.LITELLM_BASE_URL = spec.secrets.litellmBaseUrl;
    // E2.11: only set when this run actually wants spend frames (deps.spendFile configured) --
    // otherwise the outfitter-spend extension isn't loaded at all (spendExtensionPath above), so the
    // env var would just be unused.
    if (this.deps.spendFile) {
      secretEnv.OUTFITTER_SPEND_FILE = this.deps.spendFile;
      await this.ensureSpendFile(this.deps.spendFile);
    }
    // Pin the git proxy insteadOf here, after guru.env. The token stays out of this env;
    // baseEnvForPi is unchanged and still drops inherited GIT_CONFIG_* (allowlisting those
    // is what used to leak the GitHub token into the model's shell).
    const gitProxyEnv = await this.startGitProxy(spec);
    // The capture extension is loaded only with the listener. Port and token are pinned after
    // guru.env, and OUTFITTER_TOKEN is never set: the jpeg download uses agentd's own credential.
    if (this.deps.browserExtensionPath && this.deps.downloadCapture) {
      const downloadCapture = this.deps.downloadCapture;
      const listener = new CaptureListener({
        workspace: this.deps.workspace,
        peerUid: this.deps.runAsUser?.uid,
        chownTo: this.deps.runAsUser
          ? { uid: this.deps.runAsUser.uid, gid: this.deps.runAsUser.gid }
          : undefined,
        download: (captureId) => downloadCapture(spec.session.id, captureId),
        sendRequest: (requestId) => this.deps.link.send({ t: "browser.capture.request", requestId }),
        onLog: this.onLog,
      });
      this.captureListener = listener;
      await listener.start();
      if (listener.port === undefined) throw new Error("browser capture listener did not bind");
      this.deps.logger?.addSecret(listener.token);
      secretEnv.OUTFITTER_BROWSER_PORT = String(listener.port);
      secretEnv.OUTFITTER_BROWSER_TOKEN = listener.token;
      const actions = new ActionListener({
        peerUid: this.deps.runAsUser?.uid,
        sendRequest: (action) =>
          this.deps.link.send({
            t: "browser.action.request",
            requestId: action.requestId,
            kind: action.kind,
            selector: action.selector,
            ...(action.text !== undefined ? { text: action.text } : {}),
          }),
        onLog: this.onLog,
      });
      this.actionListener = actions;
      await actions.start();
      if (actions.port === undefined) throw new Error("browser action listener did not bind");
      this.deps.logger?.addSecret(actions.token);
      secretEnv.OUTFITTER_BROWSER_ACTION_PORT = String(actions.port);
      secretEnv.OUTFITTER_BROWSER_ACTION_TOKEN = actions.token;
      const inspects = new InspectListener({
        peerUid: this.deps.runAsUser?.uid,
        sendRequest: (requestId) => this.deps.link.send({ t: "browser.inspect.request", requestId }),
        onLog: this.onLog,
      });
      this.inspectListener = inspects;
      await inspects.start();
      if (inspects.port === undefined) throw new Error("browser inspect listener did not bind");
      this.deps.logger?.addSecret(inspects.token);
      secretEnv.OUTFITTER_BROWSER_INSPECT_PORT = String(inspects.port);
      secretEnv.OUTFITTER_BROWSER_INSPECT_TOKEN = inspects.token;
    }
    // Same pin as OUTFITTER_SESSION_ID: after guru.env, so a guru cannot point the broker
    // socket somewhere else. The token is not part of this overlay.
    if (this.deps.githubSocketPath) {
      secretEnv.OUTFITTER_GITHUB_SOCKET = this.deps.githubSocketPath;
      await this.startGithubSocket(this.deps.githubSocketPath);
    }
    if (this.spec.repo) {
      secretEnv.OUTFITTER_SESSION_BRANCH = this.spec.repo.branch;
      secretEnv.OUTFITTER_BRANCH_PREFIX = normalizeBranchPrefix(this.spec.repo.branchPrefix) ?? DEFAULT_BRANCH_PREFIX;
    }
    // pi runs as the unprivileged agent user but would otherwise inherit root's HOME from agentd's
    // environment; the first extension to touch ~/.pi then dies with EACCES on /root (every run of
    // the first benchmark). Point the child at that user's own home.
    const userEnv: Record<string, string> = this.deps.runAsUser
      ? { HOME: this.deps.runAsUser.home, USER: this.deps.runAsUser.user, LOGNAME: this.deps.runAsUser.user }
      : {};
    const spawnFn = this.deps.spawnPi ?? spawnPi;
    this.pi = spawnFn({
      piBin: this.deps.piBin,
      args: rendered.args,
      env: { ...rendered.env, ...secretEnv, ...gitProxyEnv, ...userEnv },
      cwd: this.deps.workspace,
      uid: this.deps.runAsUser?.uid,
      gid: this.deps.runAsUser?.gid,
      onLog: this.onLog,
    });
    this.pi.onEvent((event) => this.handlePiEvent(event));
    // E1.6: pi's own stderr goes to the structured logger at DEBUG (tagged so it's distinguishable
    // from agentd's own INFO lines) when one is configured; falls back to the old onLog string sink
    // otherwise, unchanged from before E1.6.
    this.pi.onStderr((chunk) => {
      if (this.deps.logger) this.deps.logger.debug(chunk, { source: "pi" });
      else this.onLog(`pi stderr: ${chunk}`);
    });
    this.pi.onExit((code, signal) => this.handlePiExit(code, signal));
    this.startup?.mark("pi spawned");
    this.startup?.probe(this.pi);

    // Flush anything that arrived (prompt/steer/follow_up/abort/ui_response/rpc) while pi was still
    // being spawned, in the order it was received.
    const queued = this.pendingPiMessages;
    this.pendingPiMessages = [];
    for (const queuedMsg of queued) this.dispatchToPi(queuedMsg);

    const createTailer = this.deps.createTailer ?? ((file, onEntry) => new SessionTailer(file, onEntry as any));
    this.tailer = createTailer(sessionFile, (entry) => {
      this.deps.link.sendSeq((seq) => ({ t: "entry", seq, entry: entry as any }));
    });
    this.tailer.start();

    // E2.11: reuses the SessionTailer approach (poll-by-byte-offset over an append-only file) for
    // OUTFITTER_SPEND_FILE -- see pi.ts's SpendTailer and pi-extension/outfitter-spend.ts.
    if (this.deps.spendFile) {
      const createSpendTailer =
        this.deps.createSpendTailer ?? ((file, onLine) => new SpendTailer(file, onLine));
      this.spendTailer = createSpendTailer(this.deps.spendFile, (line) => this.handleSpendLine(line));
      this.spendTailer.start();
    }

    this.enterIdle();
    this.startHeartbeat();
  }

  /** v1 allow-list is the session branch (`refs/heads/<branch>` unless it is already a full ref). */
  private async startGitProxy(spec: DownRunSpec): Promise<Record<string, string>> {
    const token = spec.secrets.githubToken;
    if (!spec.repo || !token) return {};
    const parsed = parseGithubCloneUrl(spec.repo.cloneUrl);
    if (!parsed) return {};
    const branch = spec.repo.branch;
    const allowed = branch.startsWith("refs/") ? [branch] : [`refs/heads/${branch}`];
    const prefix = normalizeBranchPrefix(spec.repo.branchPrefix) ?? DEFAULT_BRANCH_PREFIX;
    this.gitProxy = await startGitProxy({
      owner: parsed.owner,
      repo: parsed.repo,
      token,
      allowedRefs: allowed,
      allowedPrefixes: [prefix],
      log: (line) => this.onLog(line),
      lock: this.networkGitLock,
    });
    return gitProxyInsteadOfEnv(this.gitProxy.url, githubRepoHttps(parsed.owner, parsed.repo));
  }

  private async stopGitProxy(): Promise<void> {
    const proxy = this.gitProxy;
    this.gitProxy = undefined;
    if (!proxy) return;
    try {
      await proxy.close();
    } catch (err) {
      this.onLog(`git proxy stop failed: ${err instanceof Error ? err.name : "Error"}`);
    }
  }

  private async startGithubSocket(path: string): Promise<void> {
    try {
      await listenGithubSocket({
        path,
        group: this.deps.runAsUser?.gid,
        linkOpen: this.apiLinkUp,
        log: (line) => this.onLog(line),
        send: (msg) => this.deps.link.send(msg),
        // Synchronous, before listen: a link drop while chmod is in flight still finds the broker.
        // Connections are paused until after chmod, so nothing is read before that.
        attach: (socket) => {
          this.githubSocket = socket;
          // Reconcile after the awaits in listen: the link may have opened while the socket
          // was still being created, and onOpen's onLinkUp would have missed this broker.
          if (this.apiLinkUp) socket.onLinkUp();
          else socket.onLinkDown();
        },
      });
    } catch (err) {
      this.githubSocket = undefined;
      this.onLog(`github socket listen failed: ${codeOf(err)}`);
    }
  }

  private async stopGithubSocket(): Promise<void> {
    const socket = this.githubSocket;
    this.githubSocket = undefined;
    if (!socket) return;
    try {
      await socket.close();
    } catch (err) {
      this.onLog(`github socket stop failed: ${codeOf(err)}`);
    }
  }

  /** E2.11: the spend file lives in a root-owned 0750 directory in the image (/run/outfitter, see
   * image/Dockerfile), so pi, running as the unprivileged agent user, cannot create it. agentd (root
   * in the image) creates it empty with mode 0660 and hands the agent user's group write access, so
   * pi's extension can append. Outside the image (local dev, tests) the directory is whatever the
   * caller chose and any failure here is logged, not fatal: the run just has no spend frames. */
  private async ensureSpendFile(path: string): Promise<void> {
    try {
      await mkdir(resolve(path, ".."), { recursive: true });
      const handle = await openFile(path, "a", 0o660);
      // The mode passed to open() is subject to root's umask (022 in the image), which strips the
      // group write bit and leaves the agent user unable to append. Set it explicitly.
      await handle.chmod(0o660);
      await handle.close();
      if (this.deps.runAsUser) await chown(path, 0, this.deps.runAsUser.gid);
    } catch (err: any) {
      this.onLog(`spend file ${path} could not be prepared: ${err?.message ?? err}`);
    }
  }

  /** E2.11: one outfitter-spend.ts log line -> one `spend` up-frame, with `estimate` accumulated
   * across every line seen this run (independent of the LiteLLM key-spend headers, which may be
   * absent for a non-LiteLLM route or a key with no budget cap).
   *
   * `raw` is unvalidated: OUTFITTER_SPEND_FILE lives in /tmp inside the sandbox image and is
   * writable by the model's own shell user (it can run arbitrary shell commands), so a line in it is
   * untrusted input, not just possibly-malformed JSON -- validateSpendLine (pi.ts) checks shape and
   * ranges before anything here trusts it. Anything that fails validation is dropped and logged at
   * WARNING rather than used. */
  private handleSpendLine(raw: unknown): void {
    const line = validateSpendLine(raw);
    if (!line) {
      const detail = summarizeForLog(raw);
      if (this.deps.logger) this.deps.logger.warn("dropped invalid spend line", { line: detail });
      else this.onLog(`dropped invalid spend line: ${detail}`);
      return;
    }
    this.costEstimate += line.usage ?? 0;
    this.deps.link.send({
      t: "spend",
      keySpend: line.keySpend,
      keyMax: line.keyMax,
      modelGroup: line.modelGroup,
      callId: line.callId,
      estimate: this.costEstimate,
      baseline: line.baseline,
    });
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (this.startup?.observe(event)) return; // agentd's own readiness probe, not the api's business
    this.deps.link.sendSeq((seq) => ({ t: "event", seq, event }));
    if (event.type === "response" && typeof event.id === "string" && this.mailInFlight.has(event.id)) {
      const mailId = this.mailInFlight.get(event.id)!;
      this.mailInFlight.delete(event.id);
      if (event.success === true) {
        this.mailAccepted.add(mailId);
        this.deps.link.send({ t: "mail.ack", id: mailId });
      } else {
        // Left unacked on purpose: the api redelivers after the lease, up to its attempt limit.
        this.onLog(`pi rejected mail ${mailId}: ${String(event.error ?? "no reason given")}`);
      }
      return;
    }
    // Bug 7 (docs/reports/cloud-fixes.md): every other unsuccessful pi RPC `response` (prompt,
    // steer, follow_up -- the mail case above already handles its own) used to vanish entirely:
    // handlePiEvent forwarded it as a raw `event` frame (never persisted, not distinguishable from
    // any other RPC ack in the UI) and nothing logged it. A refused prompt/steer/follow_up then
    // looked exactly like one that was silently ignored, with no signal anywhere that pi ever saw
    // and rejected it. Log it at WARN (command + error only -- never `msg.text`/the prompt itself,
    // which this event never carries anyway) and surface it on the run's status so the web UI can
    // show it (protocol.md's `status` frame already carries an optional `detail`).
    if (event.type === "response" && event.success === false && event.command !== undefined) {
      const command = String(event.command);
      const errorMessage = String(event.error ?? "no reason given");
      if (this.deps.logger) this.deps.logger.warn("pi rejected an RPC command", { command, error: errorMessage });
      else this.onLog(`pi rejected ${command}: ${errorMessage}`);
      this.sendStatusDetail(`pi rejected ${command}: ${errorMessage}`);
    }
    if (event.type === "agent_start") {
      this.markActivity();
      this.clearIdleTimer();
      if (this.state === "checkpointing") {
        // Don't flip state mid-checkpoint -- record it so checkpoint() resolves to "running"
        // afterward instead of blindly restoring whatever state preceded the checkpoint.
        this.stateAfterCheckpoint = "running";
      } else if (this.state !== "stopping") {
        this.setState("running");
      }
    } else if (event.type === "agent_settled") {
      if (this.state === "checkpointing") {
        // Same deal: the turn settled while checkpointNow() was still in flight. Without tracking
        // this, checkpoint() would restore "running" once the checkpoint finishes even though pi
        // is actually idle now -- losing this agent_settled entirely.
        this.stateAfterCheckpoint = "idle";
      } else if (this.state !== "stopping") {
        this.enterIdle();
      }
    }
  }

  private handlePiExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping || this.disposed) return;
    this.stopping = true;
    this.onLog(`pi exited unexpectedly: code=${code} signal=${signal}`);
    this.clearIdleTimer();
    this.stopHeartbeat();
    this.tailer?.stop();
    this.spendTailer?.stop();
    void this.bye("error", `pi exited: code=${code} signal=${signal}`).then(() => this.onExit(1));
  }

  /** Sends the final `bye` frame and waits (briefly, bounded) for the socket to actually flush it
   * before the caller exits the process -- see Link.sendAndFlush's doc comment for why a plain
   * `send()` right before `process.exit()` can silently drop it. */
  private stopCaptureListener(): Promise<void> {
    const listener = this.captureListener;
    this.captureListener = undefined;
    const actions = this.actionListener;
    this.actionListener = undefined;
    const inspects = this.inspectListener;
    this.inspectListener = undefined;
    return Promise.all([
      listener ? listener.stop() : Promise.resolve(),
      actions ? actions.stop() : Promise.resolve(),
      inspects ? inspects.stop() : Promise.resolve(),
    ]).then(() => undefined);
  }

  private async bye(reason: ByeReason, message?: string): Promise<void> {
    await this.stopGitProxy();
    await this.stopCaptureListener();
    await this.stopGithubSocket();
    const msg = { t: "bye" as const, reason, message };
    if (this.deps.link.sendAndFlush) {
      await Promise.race([this.deps.link.sendAndFlush(msg), delay(1000)]);
    } else {
      this.deps.link.send(msg);
    }
  }

  private enterIdle(): void {
    this.setState("idle");
    this.idleSince = this.now();
    this.armIdleTimer();
  }

  private markActivity(): void {
    this.lastActivityAt = this.now();
    if (this.state === "idle") {
      // Activity while idle -- e.g. a `/command` prompt pi handles locally, or one it rejects
      // outright -- never produces agent_start/agent_settled, so nothing would otherwise re-arm
      // the idle timer: it would stay cleared (disarmed) for the rest of the run. Reset it instead,
      // the same way entering idle does, so idle-stop still eventually fires.
      this.idleSince = this.now();
      this.armIdleTimer();
    } else {
      this.idleSince = undefined;
      this.clearIdleTimer();
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.spec) return;
    const ms = this.spec.idleStopSeconds * 1000;
    this.idleTimer = setTimeout(() => {
      void this.idleStop();
    }, ms);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async idleStop(): Promise<void> {
    if (this.stopping) return; // already stopping via handleStop/handleSigterm/a prior idleStop
    this.stopping = true;
    this.setState("checkpointing");
    await this.stopGitProxy();
    await this.checkpointNow();
    this.setState("stopping");
    await this.tailer?.poll();
    this.pi?.kill();
    this.stopHeartbeat();
    this.tailer?.stop();
    this.spendTailer?.stop();
    await this.bye("idle");
    this.onExit(0);
  }

  private async handleStop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearIdleTimer();
    this.setState("checkpointing");
    await this.stopGitProxy();
    await this.checkpointNow();
    this.setState("stopping");
    await this.tailer?.poll();
    this.pi?.kill();
    this.stopHeartbeat();
    this.tailer?.stop();
    this.spendTailer?.stop();
    await this.bye("stop", reason);
    this.onExit(0);
  }

  /** SIGTERM: Cloud Run gives ~10s; checkpoint under an 8s budget, then exit regardless. */
  async handleSigterm(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearIdleTimer();
    this.setState("checkpointing");
    await this.stopGitProxy();
    await Promise.race([this.checkpointNow(), delay(this.sigtermBudgetMs)]);
    this.setState("stopping");
    this.pi?.kill();
    this.stopHeartbeat();
    this.tailer?.stop();
    this.spendTailer?.stop();
    await this.bye("sigterm");
    this.onExit(0);
  }

  private async checkpoint(message?: string): Promise<void> {
    const previous = this.state;
    this.stateAfterCheckpoint = undefined;
    this.setState("checkpointing");
    await this.checkpointNow(message);
    if (this.stopping) return;
    // Prefer what actually happened to pi *during* the checkpoint (an agent_start/agent_settled
    // that arrived mid-checkpoint) over blindly restoring the pre-checkpoint state -- restoring
    // "running" when pi has since settled (or vice versa) would silently lose that transition and
    // leave the idle timer disarmed. See handlePiEvent().
    const resolved = this.stateAfterCheckpoint ?? previous;
    if (resolved === "idle") {
      this.enterIdle();
    } else {
      this.setState(resolved);
    }
  }

  /** The proxy lock must not outlive a push. A forward that ignores stop is abandoned here so bye can proceed. */
  private withNetworkGit<T>(fn: () => Promise<T>): Promise<T> {
    const LOCK_MS = 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("network git timed out")), LOCK_MS);
    });
    return Promise.race([this.networkGitLock(fn), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Never rejects: a failed checkpoint (a rejected push, a git error) is logged and the run carries
   * on -- checkpoints are fired with `void` from down-messages and awaited on every stop path, so a
   * throw here would crash agentd with an unhandled rejection or skip `bye`. No `checkpoint` frame
   * is sent for a failure: the api replaces session.checkpoint wholesale with each one. The next
   * checkpoint retries from scratch. */
  private async checkpointNow(message?: string): Promise<void> {
    try {
      await this.checkpointOnce(message);
    } catch (err: any) {
      const detail = String(err?.message ?? err);
      if (this.deps.logger) this.deps.logger.error("checkpoint failed", { error: detail });
      else this.onLog(`checkpoint failed: ${detail}`);
    }
  }

  private async checkpointOnce(message?: string): Promise<void> {
    if (!this.spec) return;
    await this.tailer?.poll();

    // Tape option, default off. Before the git push or the workspace snapshot. A missing spec
    // or a browser that cannot start is an entry; this does not reject, so the checkpoint continues.
    const playwrightEntry = await runPlaywrightBeforeCheckpoint({
      enabled: this.spec.guru.playwrightBeforeCheckpoint === true,
      workspace: this.deps.workspace,
      spawn: this.deps.spawnPlaywright,
      uid: this.deps.runAsUser?.uid,
      gid: this.deps.runAsUser?.gid,
      home: this.deps.runAsUser?.home,
    });
    if (playwrightEntry) {
      this.deps.link.sendSeq((seq) => ({ t: "entry", seq, entry: playwrightEntry as any }));
    }

    if (!this.spec.repo) {
      // Repo-less run: no git. Tar the workspace (if configured) and refresh the mtime baseline so
      // the next `diff` reports only what changed since this checkpoint.
      const checkpointWorkspaceTarballFn = this.deps.checkpointWorkspaceTarball ?? checkpointWorkspaceTarball;
      const workspaceUrl = await checkpointWorkspaceTarballFn(
        this.deps.workspace,
        this.spec.session.id,
        this.deps.workspaceSnapshotDir,
        this.onLog,
      );
      this.workspaceBaseline = await snapshotWorkspaceFiles(this.deps.workspace);
      this.deps.link.send({ t: "checkpoint", workspaceUrl });
      return;
    }

    // Both run the workspace's git as the workspace's own user (git.ts's GitOpsOptions.runAs), so
    // unlike the clone there is nothing root-owned to chown back afterwards.
    await this.deps.gitOps.commitAll(
      this.deps.workspace,
      message ?? `outfitter checkpoint ${new Date().toISOString()}`,
      attributionTrailers(sanitizeAuthor(this.spec.author)),
    );
    // Push HEAD when it is the session branch or under the guru prefix. A detached HEAD, or a
    // branch outside that set, is not pushed onto the session branch.
    const sessionBranch = this.spec.repo.branch;
    const prefix = normalizeBranchPrefix(this.spec.repo.branchPrefix) ?? DEFAULT_BRANCH_PREFIX;
    const checked = this.deps.gitOps.headBranch ? await this.deps.gitOps.headBranch(this.deps.workspace) : sessionBranch;
    const target = checked && branchAllowed(checked, sessionBranch, prefix) ? checked : null;
    if (!target) {
      const head = this.deps.gitOps.tip ? await this.deps.gitOps.tip(this.deps.workspace, sessionBranch) : undefined;
      this.deps.link.send({ t: "checkpoint", branch: sessionBranch, ...(head ? { head } : {}), pushed: false });
      return;
    }
    // Phase-0 path (root-owned bare repo), not the broker socket. The same lock covers the git
    // proxy's fetch/push forwards so those don't overlap this push.
    const { head, pushed } = await this.withNetworkGit(() =>
      this.deps.gitOps.push(this.deps.workspace, {
        remoteUrl: this.spec!.repo!.cloneUrl,
        branch: target,
        githubToken: this.spec!.secrets.githubToken,
      }),
    );
    this.deps.link.send({ t: "checkpoint", branch: target, head, pushed });
  }

  private async handleDiff(reqId: string): Promise<void> {
    if (!this.spec) return;
    if (!this.spec.repo) {
      const current = await snapshotWorkspaceFiles(this.deps.workspace);
      const files = diffWorkspaceFiles(this.workspaceBaseline ?? new Map(), current);
      this.deps.link.send({ t: "diff.result", reqId, files });
      return;
    }
    const patch = await this.deps.gitOps.diff(this.deps.workspace, this.spec.repo.baseBranch);
    this.deps.link.send({ t: "diff.result", reqId, base: this.spec.repo.baseBranch, patch });
  }

  private async handleRead(reqId: string, path: string): Promise<void> {
    try {
      // Finding #4 (docs/reports/security-review-pr1.md): join() alone doesn't contain a `path`
      // like "../../../../etc/passwd" -- resolve it and refuse anything that lands outside the
      // workspace, rather than trusting a relative-looking down-message field.
      const target = resolve(this.deps.workspace, path);
      if (target !== this.deps.workspace && !target.startsWith(this.deps.workspace + sep)) {
        throw new Error(`read: path escapes workspace: ${path}`);
      }
      const content = await readFile(target, "utf8");
      this.deps.link.send({ t: "read.result", reqId, content });
    } catch (err: any) {
      this.deps.link.send({ t: "read.result", reqId, error: String(err?.message ?? err) });
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const idleSeconds = this.idleSince ? Math.floor((this.now() - this.idleSince) / 1000) : 0;
      const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
      this.deps.link.send({ t: "heartbeat", idleSeconds, memMb });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
