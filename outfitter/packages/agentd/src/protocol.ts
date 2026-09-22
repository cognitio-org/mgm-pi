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

/** Bug 9 (docs/reports/cloud-fixes.md): the wire protocol version agentd announces in `hello`
 * (UpHello.protocolVersion). Bump this whenever an up/down frame shape changes in a way an older
 * link role couldn't handle, or an older agentd couldn't produce -- the API refuses (WS close
 * 4409) an agentd whose protocolVersion is older than its own, so a deploy that updates the API
 * ahead of the agent image/Job fails loudly (a stuck-in-provisioning run, an explicit close reason)
 * instead of the silent breakage that motivated this (a web role sending `mail` frames an older
 * agentd ignored, docs/reports/agent-messaging.md). Keep in sync with
 * packages/api/src/agentlink.ts's own copy of this constant -- they can't share a module across
 * packages, so both sides document the pairing. */
export const WIRE_PROTOCOL_VERSION = 1;

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
  /** Bug 9: this agentd build's wire protocol version (WIRE_PROTOCOL_VERSION above). Absent means
   * an agentd build that predates this field -- treated as version 0, i.e. always old enough to
   * refuse if the API's own version is bumped past 0. */
  protocolVersion: number;
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
  /** Absent when the provider response carried no (or an incomplete) LiteLLM spend header -- e.g. a
   * key with no budget cap set never sends x-litellm-key-max-budget. Deviation from protocol.md's
   * table, which doesn't mark these optional. */
  keySpend?: number;
  keyMax?: number;
  modelGroup?: string;
  callId?: string;
  /** E2.11: pi's own cumulative cost estimate for this run (sum of assistant-turn usage.cost.total,
   * agentd-side running total over every outfitter-spend.ts log line -- see pi.ts's SpendTailer),
   * independent of LiteLLM's key-spend headers. Lets the API set Run.costEstimate even for a guru
   * whose model group/route never returns x-litellm-key-spend at all. */
  estimate?: number;
  /** E2.11b: true only on the one frame built from the outfitter-spend extension's session_start
   * baseline line -- `keySpend` there is the LiteLLM key's balance *before* this run's first
   * provider call (from GET /key/info), sent ahead of any real call so the API's "pin
   * keySpendStart from the first frame seen" logic baselines from the true pre-call balance
   * instead of under-reporting the first call's cost. */
  baseline?: boolean;
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

/** E5.5: pi accepted a `mail` down-message (its RPC `prompt` response came back success). The api
 * then marks the mail acked; unacked mail is redelivered after its lease. */
export interface UpMailAck {
  t: "mail.ack";
  id: string;
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
  | UpReadResult
  | UpMailAck;

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

/** The session's person (git-github-spec.md, "Attribution"): the Outfitter bot authors and commits
 * every cloud commit, and these fields fill its `Co-authored-by`/`On-behalf-of` trailers. Absent from
 * older apis, or when the session has no owner on record: the bot alone, no trailers. */
export interface RunSpecAuthor {
  name: string;
  /** The address to credit: the person's GitHub noreply address when the api knows it. */
  email: string;
  login?: string;
}

export interface RunSpecSecrets {
  githubToken?: string;
  litellmKey?: string;
  /** Security-review-pr15.md finding #1: the LiteLLM proxy base URL the real `litellmKey` above
   * should be sent to, set by the API from its own server-controlled config -- never from
   * guru.env. run.ts pins this into the spawned pi process's env (spread after `guru.env`), so a
   * guru-supplied LITELLM_BASE_URL (already denylisted at the API/guru.ts level too) can never
   * redirect where the real key gets sent. */
  litellmBaseUrl?: string;
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
  author?: RunSpecAuthor;
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
  author?: RunSpecAuthor;
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

/** E5.5: a mailbox message for this session. Handed to pi as a `prompt` with `streamingBehavior`
 * (starts a turn when idle, queues when busy) and acked with `mail.ack` once pi accepts it. */
export interface DownMail {
  t: "mail";
  id: string;
  text: string;
  behavior?: PromptBehavior;
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
  | DownStop
  | DownMail;

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
