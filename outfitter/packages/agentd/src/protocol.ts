/**
 * Types mirroring outfitter/docs/protocol.md exactly. This is the wire contract between agentd and
 * the api over the WebSocket link (`wss://<api>/agent/ws?run=<runId>`). Keep this file in lockstep
 * with protocol.md; if a shape here diverges from the doc, the doc wins and this file is the bug.
 * `github.request` / `github.result` are not seq/ack replayed.
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
 * packages, so both sides document the pairing. Version 2 adds `github.request` /
 * `github.result`, which are not seq/ack replayed. */
export const WIRE_PROTOCOL_VERSION = 2;

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
  /** Optional: this sandbox's boot durations, measured on agentd's own clock (main.ts). The api
   * records them on the run's first accepted hello and ignores them on a reconnect. Timings only,
   * never a secret. An api that predates the field ignores it (hello is parsed loosely). */
  boot?: BootTimings;
}

/** hello.boot. All relative durations in ms, so sandbox clock skew doesn't matter. Named after the
 * "startup: ..." log phases in main.ts. */
export interface BootTimings {
  /** main entered -> this hello. On a warm pod this includes the whole idle wait. */
  bootMs: number;
  /** main entered -> pi version resolved and run-as-user set up. */
  setupMs: number;
  /** GKE warm pod only: how long it waited to be claimed. Not part of anyone's wait. */
  assignmentWaitMs?: number;
  /** Assignment known -> this hello: agentd's share of the person's wait. */
  sinceAssignedMs: number;
  /** This connect attempt's identity-token fetch. */
  identityTokenMs?: number;
  /** Identity token fetched -> socket open. */
  connectMs?: number;
  /** true when agentd waited over a second for its assignment: it sat in a warm pool before this run
   * claimed it. The api combines this with its own clocks to call a start warm or cold. */
  preBooted?: boolean;
}

/** agentd's run phases from run.spec through "pi ready" (startup-phases.ts), sent when pi ready
 * fires and again after every reconnect until the run ends (the api keeps the first). `ms` counts
 * from run.spec arriving. Not seq/ack replayed. An api that doesn't know this frame ignores it. */
export interface UpStartup {
  t: "startup";
  phases: Array<{ name: string; ms: number }>;
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
  /** agentd's own rss. */
  memMb: number;
  /** #187: the whole sandbox's peak memory since the previous heartbeat, and its limit (cgroup
   * inside gVisor). Absent when the runtime exposes neither; an older api ignores both. */
  sandboxMemMb?: number;
  sandboxMemLimitMb?: number;
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

/** The Drive `browser_capture` tool asked for the session's one shared tab. `requestId` is minted
 * once per tool call. The api creates that browser-request row, or answers `browser.capture.result`
 * with `error: "no_share"`. A repeat of the same id is the same row. */
export interface UpBrowserCaptureRequest {
  t: "browser.capture.request";
  requestId: string;
}

/** GitHub API call from the broker socket, forwarded as an up frame. Not a seq frame —
 * a dropped link does not replay it (a read may be sent once more by the socket, a write never). */
export interface UpGithubRequest {
  t: "github.request";
  reqId: string;
  op: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
}

/** The Drive `browser_action` tool asked to click or type in the session's one shared tab.
 * `requestId` is minted once per tool call. The selector is CSS, not JavaScript. */
export interface UpBrowserActionRequest {
  t: "browser.action.request";
  requestId: string;
  kind: "click" | "type";
  selector: string;
  text?: string;
}

/** The Drive `browser_inspect` tool asked to read the shared tab's console and selected element.
 * `requestId` is minted once per tool call. There is no tab id. */
export interface UpBrowserInspectRequest {
  t: "browser.inspect.request";
  requestId: string;
}

/** The Drive `preview` tool asked for a public URL for a dev server (drive-previews.md, #217). agentd
 * has already bound the ngrok internal endpoint `internalUrl` for it; the api creates the public
 * `https://<id>.kernal.run` cloud endpoint forwarding there and answers `preview.result`. */
export interface UpPreviewOpen {
  t: "preview.open";
  requestId: string;
  port: number;
  internalUrl: string;
  /** An anonymous, time-boxed share link instead of the secure (session access) mode. */
  share: boolean;
}

/** The preview on `port` ended (the tool closed it, its tunnel died, or the run is stopping): the api
 * deletes its public endpoint. */
export interface UpPreviewClose {
  t: "preview.close";
  port: number;
}

/** Browser IDE (#242, docs/specs/browser-ide.md §3): how an `ide.open` is going. `installing` →
 * `starting` → `ready` (with `internalUrl`, the ngrok internal endpoint the api forwards to) or
 * `error` (with `detail`); each carries the request's `reqId`. `stopped` is sent unprompted, without
 * one, when code-server or its tunnel dies. Not seq/ack-replayed. */
export type IdeStatusState = "installing" | "starting" | "ready" | "error" | "stopped";
export interface UpIdeStatus {
  t: "ide.status";
  reqId?: string;
  state: IdeStatusState;
  detail?: string;
  internalUrl?: string;
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
  | UpMailAck
  | UpBrowserCaptureRequest
  | UpGithubRequest
  | UpBrowserActionRequest
  | UpBrowserInspectRequest
  | UpPreviewOpen
  | UpPreviewClose
  | UpIdeStatus
  | UpStartup;

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
  /** Branches under this prefix may be pushed in addition to `branch`. Default `outfitter/`. */
  branchPrefix?: string;
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
  /** Tape option, default off. When true, run a Playwright spec in the workspace against a fresh
   * headless Chromium before the checkpoint push or workspace snapshot. Absent means off. */
  playwrightBeforeCheckpoint?: boolean;
  /** Tape option, default off (issue #132). Picks which HTML preview paragraph renderGuru appends
   * to pi's system prompt: external CSS and JS allowed when true, sealed otherwise. Absent means
   * off. */
  allowExternalHtmlResources?: boolean;
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
  /** Drive previews (#217): a per-run ngrok credential whose ACL only lets it bind
   * `*.<preview.internalDomain>` internal endpoints. agentd keeps it in a root-only config for the
   * ngrok agent; it is never put in pi's environment. */
  ngrokAuthtoken?: string;
}

/** Drive previews (#217). Present, with `secrets.ngrokAuthtoken`, only when the api can serve them;
 * absent, agentd starts no preview listener and the tool says previews are unavailable. */
export interface RunSpecPreview {
  /** The run's internal ngrok domain, e.g. `r1a2b3c.internal`; previews bind `p<port>.<this>`. */
  internalDomain: string;
}

/** Browser IDE (#241, docs/specs/browser-ide.md §2). Present only when the run's Tape asked for the
 * IDE and previews are on: agentd downloads this code-server release at start and checks it against
 * the SHA-256 for its architecture (the release publishes none; the api pins them). */
export interface RunSpecIde {
  version: string;
  artifacts: { amd64?: string; arm64?: string };
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
  preview?: RunSpecPreview;
  ide?: RunSpecIde;
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
  preview?: RunSpecPreview;
  ide?: RunSpecIde;
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

/** Browser IDE (#242): a person asked to open this Drive in VS Code. Answered with `ide.status`
 * frames carrying the same `reqId`. */
export interface DownIdeOpen {
  t: "ide.open";
  reqId: string;
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

/** A browser capture the api already built as a pi custom entry. agentd assigns the seq by
 * emitting a normal `entry` up-frame; it does not keep a second counter. */
export interface DownBrowserCaptureEntry {
  t: "browser.capture.entry";
  entry: PiSessionEntry;
}

/** The capture asked for by `browser.capture.request` finished or failed. No seq: the transcript
 * row is `browser.capture.entry`. `error` is `no_share`, `skipped`, `permission_denied`,
 * `tab_gone`, or `too_large`. A success carries `captureId`, `title`, and `url`. */
export interface DownBrowserCaptureResult {
  t: "browser.capture.result";
  requestId: string;
  captureId?: string;
  title?: string;
  url?: string;
  error?: string;
}

/** The API's answer to `github.request`. Not seq/ack'd. `error` is passed to the
 * socket unchanged (including "not permitted"). */
export type DownGithubResult =
  | { t: "github.result"; reqId: string; ok: true; data: Record<string, unknown> }
  | { t: "github.result"; reqId: string; ok: false; error: string };

/** A replacement GitHub credential for the git proxy and later checkpoint pushes.
 * Installation tokens expire; the api sends this before they do. Not seq/ack replayed. */
export interface DownGithubCredential {
  t: "github.credential";
  token: string;
  expiresAt?: string;
}

/** The action asked for by `browser.action.request` finished or failed. No transcript seq.
 * Absent `error` means the extension ran it. `error` is `no_share`, `skipped`, `denied`,
 * `rejected`, `not_found`, `permission_denied`, `tab_gone`, `not_editable`, or `not_shared`. */
export interface DownBrowserActionResult {
  t: "browser.action.result";
  requestId: string;
  error?: string;
}

/** The inspect asked for by `browser.inspect.request` finished or failed. No transcript seq.
 * Success carries redacted console lines and a short element description (or null).
 * `error` is `no_share`, `skipped`, `denied`, `rejected`, `not_shared`, `tab_gone`,
 * `permission_denied`, `debugger_attached`. Raw network headers are not on this frame. */
export interface DownBrowserInspectResult {
  t: "browser.inspect.result";
  requestId: string;
  messages?: string[];
  element?: string | null;
  error?: string;
}

/** The answer to `preview.open`: the public URL (and, for a share link, when it expires), or an
 * `error` (`not-configured`, or the api's reason). No transcript seq. */
export interface DownPreviewResult {
  t: "preview.result";
  requestId: string;
  url?: string;
  expiresAt?: string;
  error?: string;
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
  | DownMail
  | DownBrowserCaptureEntry
  | DownBrowserCaptureResult
  | DownGithubResult
  | DownGithubCredential
  | DownBrowserActionResult
  | DownBrowserInspectResult
  | DownPreviewResult
  | DownIdeOpen;

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
