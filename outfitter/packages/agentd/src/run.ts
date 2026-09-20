/**
 * The run state machine from protocol.md: `cloning -> restoring -> starting -> running/idle ->
 * checkpointing -> stopping`. Wires together git, session import, the pi RPC process and the link,
 * and handles every down-message in protocol.md (`run.spec`, `ack`, `prompt`, `steer`, `follow_up`,
 * `abort`, `ui_response`, `rpc`, `checkpoint`, `diff`, `read`, `stop`).
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderGuru } from "./guru.js";
import type { GitOps } from "./git.js";
import { spawnPi, SessionTailer, type PiProcess } from "./pi.js";
import { importSession, writeSnapshotFile, emptySessionJsonl } from "./session.js";
import {
  snapshotWorkspaceFiles,
  diffWorkspaceFiles,
  restoreWorkspace,
  checkpointWorkspaceTarball,
  type FileMtimes,
} from "./workspace.js";
import type {
  ByeReason,
  DownAbort,
  DownFollowUp,
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
type PiTargetedDownMessage = DownPrompt | DownSteer | DownFollowUp | DownAbort | DownUiResponse | DownRpc;

function isPiTargetedDownMessage(msg: DownMessage): msg is PiTargetedDownMessage {
  return (
    msg.t === "prompt" ||
    msg.t === "steer" ||
    msg.t === "follow_up" ||
    msg.t === "abort" ||
    msg.t === "ui_response" ||
    msg.t === "rpc"
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
}

export type SpawnPiFn = typeof spawnPi;
export type ImportSessionFn = typeof importSession;
export type WriteSnapshotFileFn = typeof writeSnapshotFile;
export type TailerFactory = (
  sessionFile: string,
  onEntry: (entry: Record<string, unknown>) => void,
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
  restoreWorkspace?: typeof restoreWorkspace;
  checkpointWorkspaceTarball?: typeof checkpointWorkspaceTarball;
  heartbeatIntervalMs?: number;
  sigtermBudgetMs?: number;
  now?: () => number;
  onExit?: (code: number) => void;
  onLog?: (line: string) => void;
}

export type StateChangeHandler = (state: RunState, detail?: string) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    this.pi?.kill();
  }

  private setState(state: RunState, detail?: string): void {
    this.state = state;
    this.deps.link.send({ t: "status", state, detail });
    for (const h of this.stateHandlers) h(state, detail);
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
    }
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.onLog(`run failed: ${message}`);
    this.stopping = true;
    void this.bye("error", message).then(() => this.onExit(1));
  }

  private async begin(spec: DownRunSpec): Promise<void> {
    this.spec = spec;
    this.deps.link.setSessionId?.(spec.session.id);

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
      }
    }

    const writeSnapshotFileFn = this.deps.writeSnapshotFile ?? writeSnapshotFile;
    const importSessionFn = this.deps.importSession ?? importSession;
    let jsonl = spec.snapshot.jsonl;
    if (!jsonl && spec.snapshot.url) {
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

    if (!spec.repo) {
      this.workspaceBaseline = await snapshotWorkspaceFiles(this.deps.workspace);
    }

    this.setState("starting");
    const rendered = renderGuru(spec.guru, { piBin: this.deps.piBin, sessionFile });
    const secretEnv: Record<string, string> = {};
    if (spec.secrets.litellmKey) secretEnv.LITELLM_AGENT_KEY = spec.secrets.litellmKey;
    const spawnFn = this.deps.spawnPi ?? spawnPi;
    this.pi = spawnFn({
      piBin: this.deps.piBin,
      args: rendered.args,
      env: { ...rendered.env, ...secretEnv },
      cwd: this.deps.workspace,
      onLog: this.onLog,
    });
    this.pi.onEvent((event) => this.handlePiEvent(event));
    this.pi.onStderr((chunk) => this.onLog(`pi stderr: ${chunk}`));
    this.pi.onExit((code, signal) => this.handlePiExit(code, signal));

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

    this.enterIdle();
    this.startHeartbeat();
  }

  private handlePiEvent(event: PiRpcEvent): void {
    this.deps.link.sendSeq((seq) => ({ t: "event", seq, event }));
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
    void this.bye("error", `pi exited: code=${code} signal=${signal}`).then(() => this.onExit(1));
  }

  /** Sends the final `bye` frame and waits (briefly, bounded) for the socket to actually flush it
   * before the caller exits the process -- see Link.sendAndFlush's doc comment for why a plain
   * `send()` right before `process.exit()` can silently drop it. */
  private async bye(reason: ByeReason, message?: string): Promise<void> {
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
    await this.checkpointNow();
    this.setState("stopping");
    await this.tailer?.poll();
    this.pi?.kill();
    this.stopHeartbeat();
    this.tailer?.stop();
    await this.bye("idle");
    this.onExit(0);
  }

  private async handleStop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearIdleTimer();
    this.setState("checkpointing");
    await this.checkpointNow();
    this.setState("stopping");
    await this.tailer?.poll();
    this.pi?.kill();
    this.stopHeartbeat();
    this.tailer?.stop();
    await this.bye("stop", reason);
    this.onExit(0);
  }

  /** SIGTERM: Cloud Run gives ~10s; checkpoint under an 8s budget, then exit regardless. */
  async handleSigterm(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearIdleTimer();
    this.setState("checkpointing");
    await Promise.race([this.checkpointNow(), delay(this.sigtermBudgetMs)]);
    this.setState("stopping");
    this.pi?.kill();
    this.stopHeartbeat();
    this.tailer?.stop();
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

  private async checkpointNow(message?: string): Promise<void> {
    if (!this.spec) return;
    await this.tailer?.poll();

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

    const { committed } = await this.deps.gitOps.commitAll(
      this.deps.workspace,
      message ?? `outfitter checkpoint ${new Date().toISOString()}`,
    );
    let head = await this.deps.gitOps.headSha(this.deps.workspace);
    let pushed = false;
    if (committed) {
      const res = await this.deps.gitOps.push(
        this.deps.workspace,
        this.spec.repo.branch,
        this.spec.secrets.githubToken,
      );
      head = res.head;
      pushed = true;
    }
    this.deps.link.send({ t: "checkpoint", branch: this.spec.repo.branch, head, pushed });
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
      const content = await readFile(join(this.deps.workspace, path), "utf8");
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
