/**
 * Types mirroring outfitter/docs/protocol.md exactly. This is the wire contract between agentd and
 * the api over the WebSocket link (`wss://<api>/agent/ws?run=<runId>`). Keep this file in lockstep
 * with protocol.md; if a shape here diverges from the doc, the doc wins and this file is the bug.
 */

// ---------- shared ----------

export type RunState =
  | "cloning"
  | "restoring"
  | "starting"
  | "running"
  | "idle"
  | "checkpointing"
  | "stopping";

export type ByeReason = "idle" | "stop" | "sigterm" | "error";

export type PromptBehavior = "steer" | "followUp";

/** A pi session entry exactly as pi writes it to JSONL (message, model_change, compaction, custom, ...). */
export type PiSessionEntry = Record<string, unknown> & { type: string; id: string };

/** A raw pi RPC event (agent_start, message_update, tool_execution_start/update/end, agent_end, ...). */
export type PiRpcEvent = Record<string, unknown> & { type: string };

/** A raw pi RPC command object, as sent to pi's stdin (the `rpc` down-message escape hatch). */
export type PiRpcCommand = Record<string, unknown> & { type: string };

// ---------- up: agentd -> api ----------

export interface UpHello {
  t: "hello";
  runId: string;
  sessionId: string;
  agentdVersion: string;
  piVersion: string;
  lastAckedSeq: number;
  /** The RUN_TOKEN the provider launched this sandbox with (docs/reports/security-review-pr1.md
   * finding #2). Proves the connecting process is the execution the api itself started for this
   * run, not just something holding a valid agent SA id token for some other run. */
  runToken: string;
}

export interface UpStatus {
  t: "status";
  state: RunState;
  detail?: string;
}

export interface UpEntry {
  t: "entry";
  seq: number;
  entry: PiSessionEntry;
}

export interface UpEvent {
  t: "event";
  seq: number;
  event: PiRpcEvent;
}

export interface UpSpend {
  t: "spend";
  keySpend: number;
  keyMax: number;
  modelGroup: string;
  callId: string;
}

export interface UpCheckpoint {
  t: "checkpoint";
  /** Git fields are absent for repo-less runs (protocol.md: `run.spec.repo` is optional); those
   * runs report `workspaceUrl` (a tarball) instead of pushing. */
  branch?: string;
  head?: string;
  pushed?: boolean;
  snapshotUrl?: string;
  workspaceUrl?: string;
}

export interface UpHeartbeat {
  t: "heartbeat";
  idleSeconds: number;
  memMb: number;
}

export interface UpBye {
  t: "bye";
  reason: ByeReason;
  message?: string;
}

export type UpMessage =
  | UpHello
  | UpStatus
  | UpEntry
  | UpEvent
  | UpSpend
  | UpCheckpoint
  | UpHeartbeat
  | UpBye
  | UpDiffResult
  | UpReadResult;

/** Up-messages that carry a `seq` and are subject to the buffer-until-ack contract. */
export type SeqUpMessage = UpEntry | UpEvent;

export function isSeqUpMessage(msg: UpMessage): msg is SeqUpMessage {
  return msg.t === "entry" || msg.t === "event";
}

// ---------- down: api -> agentd ----------

export interface RunSpecSession {
  id: string;
  name: string;
  cwd: "/workspace";
}

export interface RunSpecRepo {
  cloneUrl: string;
  branch: string;
  baseBranch: string;
  createBranch: boolean;
}

export interface RunSpecGuru {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  model: string;
  thinking?: string;
  tools?: string[];
  excludeTools?: string[];
  packages?: string[];
  env?: Record<string, string>;
}

export interface RunSpecSnapshot {
  url?: string;
  jsonl?: string;
}

/** Non-coding sessions (no `repo`) may still restore a prior workspace from a tarball. For now
 * `snapshotUrl` is a local file path or an http(s) URL; GCS comes later. */
export interface RunSpecWorkspace {
  snapshotUrl?: string;
}

export interface RunSpecSecrets {
  githubToken?: string;
  litellmKey?: string;
}

export interface RunSpec {
  session: RunSpecSession;
  /** Absent for non-coding sessions: agentd starts with an empty /workspace (or restores
   * `workspace.snapshotUrl`) instead of cloning, and checkpoints tar the workspace instead of
   * pushing. */
  repo?: RunSpecRepo;
  workspace?: RunSpecWorkspace;
  guru: RunSpecGuru;
  snapshot: RunSpecSnapshot;
  secrets: RunSpecSecrets;
  idleStopSeconds: number;
  checkpointEvery: string;
}

export interface DownRunSpec {
  t: "run.spec";
  session: RunSpecSession;
  repo?: RunSpecRepo;
  workspace?: RunSpecWorkspace;
  guru: RunSpecGuru;
  snapshot: RunSpecSnapshot;
  secrets: RunSpecSecrets;
  idleStopSeconds: number;
  checkpointEvery: string;
}

export interface DownAck {
  t: "ack";
  seq: number;
}

export interface DownPrompt {
  t: "prompt";
  text: string;
  images?: unknown[];
  behavior?: PromptBehavior;
}

export interface DownSteer {
  t: "steer";
  text: string;
}

export interface DownFollowUp {
  t: "follow_up";
  text: string;
}

export interface DownAbort {
  t: "abort";
}

export interface DownUiResponse {
  t: "ui_response";
  id: string;
  value: unknown;
}

export interface DownRpc {
  t: "rpc";
  command: PiRpcCommand;
}

export interface DownCheckpoint {
  t: "checkpoint";
  message?: string;
}

export interface DownDiff {
  t: "diff";
  reqId: string;
}

export interface DownRead {
  t: "read";
  reqId: string;
  path: string;
}

export interface DownStop {
  t: "stop";
  reason: string;
}

export type DownMessage =
  | DownRunSpec
  | DownAck
  | DownPrompt
  | DownSteer
  | DownFollowUp
  | DownAbort
  | DownUiResponse
  | DownRpc
  | DownCheckpoint
  | DownDiff
  | DownRead
  | DownStop;

// ---------- replies to diff/read (sent up as `entry`-less custom up-frames) ----------
// protocol.md does not give these a `t`; agentd sends them as ad-hoc up-frames named after the
// down-message they answer, following the same `{ t, ... }` envelope convention.

/** Repo runs reply with a patch; repo-less runs (no git) reply with the list of files changed in
 * /workspace since the last checkpoint instead. */
export interface UpDiffResult {
  t: "diff.result";
  reqId: string;
  base?: string;
  patch?: string;
  files?: string[];
}

export interface UpReadResult {
  t: "read.result";
  reqId: string;
  content?: string;
  error?: string;
}
