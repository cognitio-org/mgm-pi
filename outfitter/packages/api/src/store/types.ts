// Store: the persistence seam. MongoStore and MemoryStore both implement this so every route,
// runs.ts and agentlink.ts test runs without a real Mongo cluster (MONGODB_URI=memory).
//
// See docs/data-model.md for schema, indexes and the "session == pi JSONL file" rationale.

import type { SandboxProviderName } from "../config.ts";
import type { VoiceEngine, VoicePrefs } from "../voice.ts";
import type { FleetSettings } from "../fleet-settings.ts";
import type { DeviceCodesCollection, DevicesCollection } from "./devices.ts";
import type { SettingsCollection } from "./settings.ts";
import type { ProviderKeysCollection, RouterKeysCollection, SubscriptionSecretsCollection } from "./keys.ts";
import type { LocalHostsCollection } from "./local-hosts.ts";

export type RunState = "queued" | "provisioning" | "running" | "idle" | "stopping" | "stopped" | "failed";

export type ByeReason = "idle" | "stop" | "sigterm" | "error";

export interface Session {
  id: string;
  name?: string;
  /** Email of the caller who created this session (req.identity.email at POST /api/sessions time).
   * Enforced only for archive, restore and format (#207, #208, routes/sessions.ts canManageSession) -- finding #5 in docs/reports/security-review-pr1.md flags that
   * every session route is open to every authenticated domain user today with no ownership check;
   * whether to add one is an open decision, tracked in EPIC.md under E2.2. */
  ownerEmail?: string;
  /** #252: which speech engine the web app's mic uses on this floppy (PUT /api/sessions/:id/voice).
   * Absent means "deepgram", the default (owner decision on #251). */
  voiceEngine?: VoiceEngine;
  /** #255: whether replies on this floppy are read aloud (PUT /api/sessions/:id/voice). Absent: off. */
  voiceSpeak?: boolean;
  guruId: string;
  /** null = non-coding session (protocol.md: `repo` omitted on POST /api/sessions). */
  repo: string | null;
  baseBranch?: string;
  /** Absent for a repo-less session; agentd then works out of a scratch /workspace instead. */
  branch?: string;
  prompt?: string;
  /** The floppy's model: the tape's `model` when it was created (or the one asked for), then
   * whatever PUT /api/sessions/:id/model last set. A later edit of the tape doesn't change it.
   * Absent on floppies from before the pin (and when the tape named none): those keep the last
   * model their transcript records (session-model.ts's transcriptModel), else the tape's. The
   * laptop preflight (E2.8) still applies at each run start. */
  modelOverride?: string;
  parentId?: string;
  status: "open" | "closed";
  /** id of the current leaf entry (tip of the transcript tree), if any. */
  leafId?: string;
  cost: number;
  /** The most recent checkpoint frame's fields, replaced wholesale by each new checkpoint: a
   * repo session reports branch/head (and maybe snapshotUrl); a repo-less session reports
   * workspaceUrl instead (protocol.md's agentd<->api `checkpoint` row). */
  checkpoint?: {
    branch?: string;
    /** The last head that landed (kept by frames that didn't). */
    head?: string;
    snapshotUrl?: string;
    workspaceUrl?: string;
    /** E9 §5.3: when the api stored this frame (agentlink.ts, on the instance holding the run's
     * socket, the same clock that records the turn's settle). Absent on rows from before it. */
    at?: string;
    /** E9 §5.3: the frame said the remote branch is at `head`, whether this checkpoint pushed it
     * (`pushed: true`) or found it there already (`pushed: false` with a head; agentd's push()). */
    landed?: boolean;
    /** When a frame last landed; a later frame that didn't keeps it (and `head`). */
    landedAt?: string;
    /** #501: this frame landed by sending commits (`pushed: true`), not by finding them there. */
    pushed?: boolean;
    /** #501: when a frame last pushed commits; kept by later frames that didn't. What the page shows
     * as "Pushed 1m ago": a turn with nothing new re-lands the same head and moves only landedAt. */
    pushedAt?: string;
  };
  /** E9 §1: when pi last reported the turn settled (`agent_settled`: nothing queued, no retry
   * left), and the last entry agentd had sent by then, when it said. Not run state `idle`, which a
   * run enters before its first prompt. */
  settledAt?: string;
  /** null when the settle carried no lastEntryId (an older agentd, or none sent this run). */
  settledEntryId?: string | null;
  /** The settle's run and seq: a replayed settle (seq not above the last one of the same run) is
   * ignored, and a late-registered waiter only counts settles after it. */
  settledRunId?: string;
  settledSeq?: number;
  /** E9 §5/§5.4: "a2a" on a session an inbound A2A task created (src/a2a/tasks.ts). Such a session
   * runs as its key's owner, but its memory identity is the key's (`a2a:<a2aTokenId>`,
   * agentengine/identity.ts): no recordTurn, no org reads, no shared or taxonomic saves. It may push
   * only its own branch (branch-policy.ts's branchPrefixForSession). Absent: an ordinary Drive. */
  origin?: "a2a";
  /** E9 §5.4: the A2A key (ApiToken.id) whose task created this session. Set with `origin`. */
  a2aTokenId?: string;
  /** #207: when the owner or a sysop archived this floppy. An archived session is hidden from
   * GET /api/sessions by default and read-only: no wakes, no new mail, no teleport import, until
   * POST /restore clears it. Only an archived session can be formatted (deleted). */
  archivedAt?: string;
  /** #208: set by DELETE /api/sessions/:id when it claims the session, just before erasing it.
   * Restore refuses a session that has it, so a restore can't race a format. */
  formattingAt?: string;
  /** #503: Auto-fix CI. On: when a check on the session's open pull request fails, Outfitter sends
   * the agent one message with the failing checks' log tails (autofix.ts). Absent: off. */
  autofixCi?: boolean;
  /** #503: the watcher's bookkeeping, changed only through casAutofix / setAutofixCi. */
  autofix?: AutofixState;
  createdAt: string;
  updatedAt: string;
}

/** #503: Auto-fix CI's state on a session. Every write bumps `rev` and is conditional on the rev it
 * read (SessionsCollection.casAutofix), so of several API instances only one polls or sends. */
export interface AutofixState {
  rev: number;
  /** When an instance last claimed this session's poll. */
  polledAt?: string;
  /** The pull request head the last message was sent for, and when. */
  lastSha?: string;
  lastAt?: string;
  lastPr?: number;
  lastChecks?: string[];
  /** When messages were sent, oldest first; only the last AUTOFIX_MAX_PER_DAY are kept. */
  sends?: string[];
  /** A send was refused for the daily cap: when, and for which head. */
  cappedAt?: string;
  cappedSha?: string;
  /** When the next poll is due (the back-off: longer unless a failure is settling). */
  nextPollAt?: string;
  /** When the watcher first saw this head fail (the settle cutoff for a check with no times). */
  failSeen?: { sha: string; at: string };
  /** A message whose insert failed, kept so the retry doesn't refetch logs. */
  draft?: { sha: string; text: string };
  /** The daily cap's run of consecutive (UTC) days. */
  capDays?: { last: string; count: number };
  /** Set when the watcher turned the switch off itself (the cap on too many days running). */
  offNotice?: string;
}

/** A pi session entry, exactly as pi writes it to JSONL (message, model_change, compaction, custom...). */
export interface PiEntry {
  id: string;
  parentId?: string | null;
  type: string;
  [key: string]: unknown;
}

export interface Entry {
  sessionId: string;
  seq: number;
  entry: PiEntry;
  // TODO(follow-up story): blobs over 100 KB (tool output) are offloaded to GCS and this holds a
  // pointer instead of inline entry data. Not implemented yet; always undefined today.
  blobRef?: string;
  /** #147: the run whose agentd sent this entry (agentlink.ts). Absent for entries the api writes
   * itself (browser captures, session-route writes) and for every entry stored before the field. */
  runId?: string;
}

/** Row fields besides the entry itself, for EntriesCollection.insertIfNew. */
export interface EntryInsertOptions {
  runId?: string;
  blobRef?: string;
}

/** Only the fields that are set, so a store never writes `runId: undefined` (Mongo would keep a
 * null). */
export function entryInsertFields(opts: EntryInsertOptions): Pick<Entry, "runId" | "blobRef"> {
  return {
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.blobRef ? { blobRef: opts.blobRef } : {}),
  };
}

export interface DownMessage {
  t:
    | "prompt"
    | "steer"
    | "follow_up"
    | "abort"
    | "ui_response"
    | "rpc"
    | "checkpoint"
    | "stop"
    | "browser.capture.entry"
    | "browser.capture.result"
    | "browser.action.result"
    | "browser.inspect.result"
    | "github.credential"
    | "ide.open";
  /** Set on `browser.capture.entry`: the pi custom entry agentd must emit with its own seq. */
  entry?: PiEntry;
  /** Set on `browser.capture.result`, `browser.action.result`, and `browser.inspect.result`. Not a transcript seq. */
  requestId?: string;
  captureId?: string;
  title?: string;
  url?: string;
  error?: string;
  /** Redacted console lines on `browser.inspect.result`. No network headers. */
  messages?: string[];
  /** Short element description on `browser.inspect.result`, or null when none is selected. */
  element?: string | null;
  [key: string]: unknown;
}

/** Browser IDE (#242) state on a run. "closed": a person closed the public endpoint; code-server
 * keeps running in the Drive, and the next open makes a new endpoint. */
export type RunIdeState = "requested" | "installing" | "starting" | "ready" | "error" | "stopped" | "closed";
export interface RunIde {
  reqId: string;
  state: RunIdeState;
  url?: string;
  detail?: string;
  updatedAt: string;
}

/** Which GitHub credential a run was actually given (#159). */
export type GithubCredential = "app" | "session" | "default" | "none";

/** A run's Drive-preview identity (#217): the ngrok credential minted for it at its first run.spec,
 * which may bind only `*.<label>.internal`. Kept so a reconnect reuses it and run end deletes it. */
export interface RunPreview {
  label: string;
  credentialId: string;
}

export interface Run {
  id: string;
  sessionId: string;
  state: RunState;
  /** Drive previews (#217): present once the run's preview credential exists. */
  preview?: RunPreview;
  reason?: string;
  /** Last frame of any kind from agentd, heartbeats included (every 15 s while pi is up). */
  lastSeenAt?: string;
  /** Last pi entry or event (a streamed token, a tool starting) -- the model doing something, as
   * opposed to agentd merely being alive. The session page counts it as progress (sse.ts). */
  lastActivityAt?: string;
  /** #285: the open assistant message's thinking text, so a browser on the web role can show it
   * before that message is an entry. Written at most about once a second (the text can be long);
   * null once the message is stored or the run leaves `running`. Absent when this run has not
   * streamed a thought. */
  liveThought?: string | null;
  lastAckedSeq: number;
  pending: DownMessage[];
  /** Opaque provider handle (SandboxProvider.start's return; a plain string per @outfitter/
   * provider-local's SandboxHandle -- a Cloud Run execution name, a docker container id, or a
   * synthetic in-process id). Callers should not parse it. */
  providerHandle?: string;
  /** Which SandboxProvider started this run; providerHandle is only meaningful to that one
   * (gke-sandbox-provider.md §2.4, gap G1). Absent on runs created before this field existed --
   * runs.ts's providerNameFor() falls back to inferring cloudrun from providerHandle's shape, then
   * to the deployment's current default. */
  sandboxProvider?: SandboxProviderName;
  /** sha256 (hex) of the per-run secret RunManager.wake generates and hands to the provider as
   * RUN_TOKEN. AgentLink.handleConnection compares this against sha256(hello.runToken) before
   * registering the socket -- see docs/reports/security-review-pr1.md finding #2. Only the hash is
   * ever stored; the plaintext token exists only in the provider launch env and the hello frame. */
  runTokenHash?: string;
  // Bug 10 (docs/reports/cloud-fixes.md): set true the first time this run's `hello` passes the
  // token AND protocol-version checks (agentlink.ts's handleConnection). Guards mail's chargeWake
  // so a mail-driven wake's attempt is charged once this run proves it can actually speak the
  // protocol -- not merely because a wake was started -- and only once per run even across
  // reconnects. A run that never reaches a validated hello at all (Cloud Run scheduling failure,
  // a version-skewed agentd refused with 4409, a crash before connecting) never sets this and so
  // never counts against the mail's attempt budget.
  protocolAcked?: boolean;
  // Bug 10: set true only when RunManager.wake was called for a mail delivery (MailService.
  // wakeForMail's `{ mailDriven: true }`) -- distinguishes "this run exists specifically to
  // deliver mail" from any other reason a run might start (a browser Start/Wake button) that
  // happens to also have deliverable mail queued for the session; only a mail-driven run's
  // validated hello charges the mail's attempt (agentlink.ts's handleConnection), so mail delivery
  // via a run someone else already started for an unrelated reason isn't double-charged against
  // claimNext's own per-delivery attempt.
  mailWakePending?: boolean;
  // Deviation from protocol.md: extension_ui_request events are "not persisted except
  // extension_ui_request" per the protocol, but it doesn't say where. Stored here so a browser
  // that reconnects (or opens the session fresh) still sees a question the run is waiting on;
  // cleared when a ui_response down-message is sent for this run.
  pendingUiRequest?: unknown;
  // Bug 7 (docs/reports/cloud-fixes.md): the most recent `status` frame's `detail` field
  // (protocol.md), which agentd now also uses to surface a rejected pi RPC response ("pi rejected
  // prompt: <error>") -- prompt/steer/follow_up used to vanish silently when pi's own `response`
  // frame came back `success: false`. Not cleared by an ordinary state-only status frame (see
  // agentlink.ts's "status" case), so it survives until the next notice replaces it; sse.ts tells
  // the browser to drop it when a *new* run is observed, since the note belongs to one run.
  // Also written by the api itself, for a refusal agentd never gets to report: agentlink.ts's
  // refuse() (a run.spec the api won't build, a version-skewed sandbox) and runs.ts's stale-run
  // reconciler. Those cases are the only thing a person sees for a run that never started, so this
  // holds a full sentence with a remedy, not the short `reason` that also goes on the wire.
  statusDetail?: string;
  // Not in protocol.md: set when E2.8's laptop-model preflight (src/laptop.ts) swaps a guru's or
  // session's `litellm/local-qwen-mlx`-style model for the guru's fallbackModel because the laptop
  // tunnel probed offline. Surfaced so the UI can show "running on X instead of Y".
  modelFallback?: { wanted: string; used: string };
  // Issue #132: the guru's allowExternalHtmlResources as it was when this run's first run.spec was
  // built, so the prompt pi was given and the preview a session opened later starts from agree.
  // Written once (agentd only acts on its first run.spec) and reused by later specs on reconnect;
  // a Tape changed mid-run applies to the next run. Absent until that first spec is built.
  allowExternalHtmlResources?: boolean;
  // Browser IDE (#241, docs/specs/browser-ide.md): whether this run's spec carried `ide` (the Tape
  // asked for it and previews were on), so agentd downloaded code-server into this Drive. Settled by
  // the first spec that was actually sent (startup.specSentAt) and reused on reconnect.
  browserIde?: boolean;
  // Browser IDE (#242): the latest `ide.open` a person made for this run, and how it's going. The
  // web role writes `reqId` and state "requested" when it queues the frame; the link role accepts an
  // `ide.status` only for that reqId, and on "ready" creates the owner-only endpoint (`url`).
  ide?: RunIde;
  // #187: the highest sandbox memory agentd's heartbeats reported for this run, and the sandbox's
  // limit, in MiB. An OOM kill takes agentd with it, so this is what lets the reconciler say "ran
  // out of memory" instead of "stopped reporting". Absent from agentd builds before #187 and from
  // runtimes that expose no cgroup or /proc/meminfo.
  sandboxMemPeakMb?: number;
  sandboxMemLimitMb?: number;
  // #187: the latest heartbeat's peak alone (the ~15 s before agentd last reported). The reconciler
  // judges "ran out of memory" on this, not the run-long peak, so an early spike doesn't get the
  // blame for a later, unrelated death.
  sandboxMemLastMb?: number;
  // #193: how the sandbox's agent container ended, as the orchestrator recorded it (GKE: the pod's
  // containerStatuses[agentd].state.terminated). Read shortly after agentd's socket drops without a
  // bye, or by the reconciler; the controller deletes the pod ~2 min after it finishes, so later is
  // too late. Absent while running, on providers that can't tell (Cloud Run), and after a clean bye.
  sandboxExit?: { reason: string; exitCode?: number; finishedAt?: string };
  /** Which GitHub credential this run was actually given (#159): a per-session PAT, a GitHub App
   * installation token, the shared PAT, or none. Absent until buildRunSpec resolves secrets.
   * GET /api/sessions/:id prefers this over the configured-state guess. */
  githubCredential?: GithubCredential;
  // Not in protocol.md: `spend.keySpend` (agentlink.ts) is the LiteLLM *key's* cumulative spend,
  // not this run's own — the key is shared across every run/session using that guru. keySpendStart
  // is set to keySpend on the first spend frame this run sees; cost is then
  // max(0, keySpend - keySpendStart), i.e. only what this run added. session.cost is the sum of
  // its runs' cost fields (kept incrementally; see agentlink.ts's "spend" handler).
  keySpendStart?: number;
  cost?: number;
  // E2.11: `spend.estimate` (agentlink.ts's "spend" handler) is pi's own cumulative cost estimate for
  // this run, from the outfitter-spend pi extension's per-response usage, independent of LiteLLM's
  // key-spend headers -- unlike `cost` above, it's a straight assignment (agentd already sends the
  // running total, not a delta to fold in) and it's populated even for a guru whose route never
  // returns LiteLLM spend headers at all (`cost`/`keySpendStart` would then stay unset).
  costEstimate?: number;
  /** Recent github.request write results, keyed by idempotencyKey, so a retry does not post twice.
   * Not a wire field. The broker caps this at the newest 100 keys. */
  githubIdempotency?: Record<string, GithubIdempotencyRecord>;
  /** How long this run took to start, piece by piece (startup.ts). Absent on runs created before
   * this field existed; partly filled for a run whose agentd predates the timings it reports. */
  startup?: RunStartup;
  createdAt: string;
  updatedAt: string;
}

/** Boot timings agentd measured on its own clock (hello.boot), all relative, so there is no clock
 * skew between the sandbox and the api. Names follow agentd's "startup: ..." log phases (main.ts). */
export interface AgentdBootTimings {
  /** main entered -> hello sent. On a warm pod this includes the whole idle wait. */
  bootMs?: number;
  /** main entered -> pi version resolved and run-as-user set up (before any assignment wait). */
  setupMs?: number;
  /** GKE warm pod only: how long it idled before being claimed. Not part of anyone's wait. */
  assignmentWaitMs?: number;
  /** Assignment known -> hello sent: agentd's share of the person's wait. */
  sinceAssignedMs?: number;
  /** The first connect attempt's identity-token fetch. */
  identityTokenMs?: number;
  /** Identity token fetched -> socket open (TCP, TLS, WS upgrade). */
  connectMs?: number;
  /** agentd's own hint: it waited over a second for its assignment, so it sat in a warm pool. */
  preBooted?: boolean;
}

/** One milestone agentd logged after run.spec arrived (startup-phases.ts): `ms` since run.spec. */
export interface StartupPhase {
  name: string;
  ms: number;
}

/** Run.startup. Timestamps are ISO strings on the api's clock; each is written once. */
export interface RunStartup {
  /** RunManager.wake created the run (= Run.createdAt). */
  wakeAt?: string;
  /** provider.start() resolved. */
  providerReturnedAt?: string;
  /** The run's first accepted hello (token and protocol checked). Not moved by a reconnect. */
  helloAt?: string;
  /** The first run.spec went out. */
  specSentAt?: string;
  /** The first status that made the run running or idle (pi spawned; pi may still be loading). */
  readyAt?: string;
  /** Which SandboxProvider started the run. */
  provider?: SandboxProviderName;
  /** SandboxStartResult.warm: true adopted a warm sandbox, false cold, absent unknown. The summary
   * derives it from agentd's timings when the provider couldn't tell (startup.ts's deriveWarm). */
  warm?: boolean;
  agentd?: AgentdBootTimings;
  /** agentd's run phases from run.spec through "pi ready" (the `startup` up-frame). */
  phases?: StartupPhase[];
}

/** Steps of a multi-call write that already reached GitHub. Not sent on the socket. */
export interface GithubWriteProgress {
  commented?: boolean;
  patched?: boolean;
  labelsAdded?: boolean;
  labelsRemoved?: string[];
  assigneesAdded?: boolean;
  assigneesRemoved?: boolean;
}

/** Stored result of one github.request write. Same shape the broker returns on the socket. */
export type GithubIdempotencyRecord =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; progress?: GithubWriteProgress };

/** E5.5 mailbox: a message addressed to a session, not to a run, so it outlives a run that dies
 * before it is ready. Delivered at least once: claimed with a lease, acked by agentd once pi has
 * accepted it, re-claimable after the lease expires. */
export type MailStatus = "queued" | "delivered" | "acked" | "dead" | "held";

export interface MailSender {
  kind: "user" | "session" | "system";
  email?: string;
  sessionId?: string;
}

export interface Mail {
  /** Deterministic for agent sends (derived from the sender's session and entry id), so a replayed
   * entry frame can't enqueue the same message twice. Also the Cloud Tasks task name. */
  id: string;
  /** Recipient session. */
  sessionId: string;
  from: MailSender;
  /** The exact text handed to pi (any sender header already applied). */
  text: string;
  /** How pi should take it if the recipient is mid-turn; an idle recipient starts a turn either way. */
  behavior: "followUp" | "steer";
  status: MailStatus;
  attempts: number;
  deliveredRunId?: string;
  lockedUntil?: string;
  createdAt: string;
  deliveredAt?: string;
  ackedAt?: string;
  /** Set when attempts ran out (MailService.sweep); the sender, if a session, gets a bounce. */
  deadAt?: string;
  /** Cloud-fixes 13: mail-driven wakes started for this mail since a run of its session last
   * validated the protocol. Reaching MAIL_MAX_UNVALIDATED_WAKES parks the mail as `held`. */
  unvalidatedWakes?: number;
  /** When the mail was parked as `held` (a deploy mismatch: runs start but never validate; or a
   * run failure no retry fixes, see heldDetail). */
  heldAt?: string;
  /** #172: set when the mail is held because the session's runs are refused for a reason no retry
   * fixes (no usable GitHub credential): that reason, shown as the session's mail notice. Absent
   * for a deploy-mismatch hold. Only Retry, or a run of the session that gets its spec, releases
   * it; a run of some other session validating the protocol doesn't. */
  heldDetail?: string;
}

/** Which held mail `releaseHeld` returns to the queue: all of it, or only deploy-mismatch holds
 * (no heldDetail). */
export type HeldMailScope = "all" | "deploy-mismatch";

export interface MailCollection {
  /** false (no-op) if a mail with this id already exists. */
  insertIfNew(mail: Mail): Promise<boolean>;
  /** Atomically claims the oldest deliverable mail for a session (queued, or delivered with an
   * expired lease, and under maxAttempts): marks it delivered to runId until leaseUntil. */
  claimNext(sessionId: string, runId: string, nowIso: string, leaseUntilIso: string, maxAttempts: number): Promise<Mail | null>;
  /** Marks a mail acked, only if it is currently delivered to runId: a run can't ack mail that was
   * never handed to it. Idempotent; anything else is ignored. */
  ack(id: string, runId: string, nowIso: string): Promise<void>;
  /** Counts a mail-driven wake as an attempt on every deliverable mail of the session, so a session
   * whose runs never become ready runs out of attempts instead of being woken forever. */
  chargeWake(sessionId: string, nowIso: string, maxAttempts: number): Promise<void>;
  /** Returns mail delivered to runId but not acked to the queue (the run has ended). */
  releaseRun(runId: string): Promise<void>;
  /** Cloud-fixes 13: counts a mail-driven wake against every deliverable mail of the session
   * (Mail.unvalidatedWakes). Cleared by markValidated once a run of the session validates. */
  noteWake(sessionId: string, nowIso: string, maxAttempts: number): Promise<void>;
  /** A run of the session validated the protocol: its wakes were not wasted, so reset the count. */
  markValidated(sessionId: string): Promise<void>;
  /** Parks the session's deliverable mail as `held` when the session already has held mail, or any
   * of it has reached maxUnvalidatedWakes. Returns how many of the session's mail are held after. */
  /** New mail held this way takes the reason (heldDetail) of the session's mail already held. */
  holdIfStuck(sessionId: string, nowIso: string, maxAttempts: number, maxUnvalidatedWakes: number): Promise<number>;
  /** #172: parks all of the session's idle mail (queued, or delivered with an expired lease) as
   * `held` for a run failure, whatever its attempts, and sets `detail` as the reason on every held
   * mail of the session. Returns how many are held after. */
  holdSession(sessionId: string, nowIso: string, detail: string): Promise<number>;
  /** Returns held mail (of one session, or of every session) to `queued` with a fresh budget: no
   * attempts, no unvalidated wakes. `scope` "deploy-mismatch" leaves run-failure holds
   * (heldDetail) alone. Returns the sessions that had mail released. */
  releaseHeld(sessionId?: string, scope?: HeldMailScope): Promise<string[]>;
  /** How many of a session's mail are held. */
  countHeld(sessionId: string): Promise<number>;
  /** #172: the reason a session's mail is held for a run failure, if it is (see Mail.heldDetail). */
  heldDetail(sessionId: string): Promise<string | undefined>;
  /** Marks mail that ran out of attempts dead and returns it (for bounces). */
  expireExhausted(nowIso: string, maxAttempts: number): Promise<Mail[]>;
  /** Mail a session has sent since the given time (the per-sender rate limit). */
  countSentSince(fromSessionId: string, sinceIso: string): Promise<number>;
  /** Whether one session holds deliverable mail. */
  hasDeliverable(sessionId: string, nowIso: string, maxAttempts: number): Promise<boolean>;
  /** Distinct sessions holding deliverable mail (the /tick sweep's input). */
  sessionsWithDeliverable(nowIso: string, maxAttempts: number): Promise<string[]>;
  findById(id: string): Promise<Mail | null>;
  /** E9 §5.3 CancelTask: marks one mail dead unless pi already took it (acked) or it is dead
   * already, so no later wake delivers it. True when this call marked it. */
  markDead(id: string, nowIso: string): Promise<boolean>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

export interface Guru {
  id: string;
  name: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  model: string;
  /** Model to use instead when `model` is a laptop model and the laptop preflight (E2.8) is offline. */
  fallbackModel?: string;
  thinking?: string;
  tools?: string[];
  excludeTools?: string[];
  packages?: string[];
  env?: Record<string, string>;
  /** When true, this guru's cloud runs may `github_pr.merge`. Absent or false refuses with
   * "not permitted" — a cloud run can be started with nobody watching. */
  mergeFromCloud?: boolean;
  /** Branches under this prefix may be pushed besides the session branch. Absent means `outfitter/`. */
  branchPrefix?: string;
  /** Tape option, default off. Absent on existing gurus. When true, agentd runs a Playwright spec
   * already in the workspace against a fresh headless Chromium before checkpoint. */
  playwrightBeforeCheckpoint?: boolean;
  /** Tape option, default off (issue #132). Absent on existing gurus. Picks which HTML preview
   * paragraph agentd appends to pi's system prompt, and the preview dialog's starting access
   * (external when true, sealed otherwise). Copied onto each run as it starts (Run's field of the
   * same name). */
  allowExternalHtmlResources?: boolean;
  /** Tape option, default off (browser IDE, #241). Absent on existing gurus. When true, the run's
   * spec asks agentd to download code-server so the floppy's owner can open the Drive in VS Code in
   * the browser. Copied onto each run as it starts (Run.browserIde). */
  browserIde?: boolean;
  /** Tape option, default off (Sysop tools, #286). Whether this tape's runs get the admin tools
   * (outfitter_tapes and friends, through agentd's admin socket). "operator" also allows the
   * sysop actions, and only when the session's owner is an operator. Set only by a person in the
   * web UI (gurus-service.ts); an agent can never set or raise it. */
  adminTools?: AdminToolsLevel;
  /** Tape option, default off (E9, docs/specs/atlas-agent-engine-and-a2a.md §3.3). Agent Engine
   * memory for this tape's Drives: "tool" gives the agent a `memory` tool, "auto" also recalls
   * before each prompt and records turns. Set only by a person in the web UI (gurus-service.ts),
   * like adminTools. Absent means off. */
  memory?: MemoryLevel;
  /** Tape option, default off (E9 §4). When true, this tape's Drives may call the listed Agent
   * Engine agents (the `agent_engine` tool). Set only by a person in the web UI, like adminTools. */
  agentEngine?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AdminToolsLevel = "off" | "manage" | "operator";

export type MemoryLevel = "off" | "tool" | "auto";

/** An admin op from a run's agent held for the session owner's decision (Sysop tools, #287;
 * admin/approvals.ts). At most one per run, in its own collection so Run documents -- which several
 * routes return whole -- never carry it. */
export interface AdminApproval {
  id: string;
  runId: string;
  sessionId: string;
  /** Lowercased; only this person, in the web UI, may answer or see it. */
  ownerEmail: string;
  op: string;
  /** Shown on the card: what the agent wants to do, in one line each. */
  title: string;
  message: string;
  requestedAt: string;
  expiresAt: string;
  decision?: "approved" | "denied";
  decidedBy?: string;
  decidedAt?: string;
}

/** E9.9: a laptop op held for its owner's yes in the web app (admin/laptop-approvals.ts). Owner
 * scoped, not per run: a laptop has no Outfitter session or run. The laptop reruns the op with
 * `id` once it is approved; the digest ties the yes to that exact op and args. */
export interface LaptopApproval {
  id: string;
  /** Lowercased; only this person, in the web UI, may see or answer it. */
  ownerEmail: string;
  op: string;
  /** sha256 of the canonical JSON of {op, args}. */
  argsDigest: string;
  /** What is asked, one line ("Share a memory with the team"). */
  title: string;
  /** The api's own facts about the ask (type, label, who sees it), shown apart from the content. */
  facts?: Array<{ label: string; value: string }>;
  /** The exact content the agent sent, redacted and capped. Shown escaped, labelled as the agent's. */
  summary: string;
  origin: { laptopSessionId: string; repo?: string };
  state: "pending" | "approved" | "denied" | "used";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  usedAt?: string;
}

/** One admin op an agent called (Sysop tools, #286): admin/ops.ts writes a row for every op that is
 * not a read, including calls refused for rights or approval. */
export interface AdminAuditEntry {
  id: string;
  at: string;
  /** Email the op ran as: the Dongle's owner, or the Drive session's owner. */
  actor: string;
  /** "token" for a Dongle caller (laptop), "drive" for a Drive's broker call, "web" for a sysop's
   * change in the web UI (E9 §8: the Agent Engine agents allowlist). */
  via: "token" | "drive" | "web";
  sessionId?: string;
  runId?: string;
  op: string;
  /** The object the op named (a tape or environment id), when it has one. */
  target?: string;
  ok: boolean;
  /** The one-line error, when `ok` is false. */
  error?: string;
  /** E9.9: for a laptop approval's decision, what was decided (`<op> <argsDigest>`), since the
   * approval itself is gone a day later. */
  detail?: string;
  /** Whether the caller came with the person's approval (laptop TUI confirm, or a Drive's web
   * approval card, then `approvalId`). */
  approved: boolean;
  approvalId?: string;
}

/** One searchable piece of a session (Sysop tools, #289; search/chunker.ts): the words of one entry,
 * redacted and cut short, or the session's own name and prompt. */
export interface SessionChunk {
  /** `<sessionId>:<entryId>`, or `<sessionId>:session`. */
  id: string;
  sessionId: string;
  entryId: string;
  /** Lowercased. */
  ownerEmail?: string;
  guruId: string;
  repo?: string;
  role: "user" | "assistant" | "tool" | "summary" | "session";
  tool?: string;
  isError?: boolean;
  createdAt: string;
  text: string;
}

export type ChunkSearchMode = "text" | "semantic" | "hybrid";

export interface ChunkQuery {
  text: string;
  mode: ChunkSearchMode;
  filter: { ownerEmail?: string; guruId?: string; repo?: string; role?: SessionChunk["role"]; sessionId?: string; since?: string; until?: string };
  limit: number;
}

export interface ChunkHit {
  chunk: SessionChunk;
  score?: number;
}

/** Thrown by a store that can't run the asked-for search mode (the memory store: no Atlas). */
export class SearchUnavailableError extends Error {}

export interface SessionChunksCollection {
  /** Inserts or replaces by id. */
  upsertMany(chunks: SessionChunk[]): Promise<void>;
  deleteForSession(sessionId: string): Promise<number>;
  search(query: ChunkQuery): Promise<ChunkHit[]>;
}

export interface AdminApprovalsCollection {
  /** The run's approval, pending or answered, or null. */
  get(runId: string): Promise<AdminApproval | null>;
  /** Stores `approval` for its run unless one is still pending there (undecided and unexpired).
   * False when one is. */
  claim(approval: AdminApproval, nowIso: string): Promise<boolean>;
  /** Records the decision on the run's approval if it is this one, undecided and unexpired. */
  decide(runId: string, approvalId: string, decision: "approved" | "denied", by: string, nowIso: string): Promise<boolean>;
  /** Removes the run's approval only if it is still this one. */
  clear(runId: string, approvalId: string): Promise<void>;
}

export interface LaptopApprovalsCollection {
  insert(approval: LaptopApproval): Promise<void>;
  get(id: string): Promise<LaptopApproval | null>;
  /** The owner's pending, unexpired approvals, oldest first. */
  listPending(ownerEmail: string, nowIso: string, limit: number): Promise<LaptopApproval[]>;
  /** The owner's pending, unexpired approval for this exact op, digest and laptop session, if any. */
  findPending(match: LaptopApprovalMatch, nowIso: string): Promise<LaptopApproval | null>;
  /** pending -> approved/denied, if it is the owner's, still pending and unexpired; `expiresAt`
   * becomes `useBy` (a yes near expiry still leaves the laptop time to rerun). The owner decides,
   * so `decidedBy` is `ownerEmail`. */
  decide(id: string, ownerEmail: string, decision: "approved" | "denied", nowIso: string, useBy: string): Promise<boolean>;
  /** approved -> used, once: only if owner, op, digest and origin match and it is unexpired. */
  consume(id: string, match: LaptopApprovalMatch, nowIso: string): Promise<boolean>;
}

/** What an approval must match to be found or used: whose, which op and args, from where. */
export interface LaptopApprovalMatch {
  ownerEmail: string;
  op: string;
  argsDigest: string;
  laptopSessionId: string;
  repo?: string;
}

export interface AdminAuditCollection {
  insert(entry: AdminAuditEntry): Promise<void>;
  /** Newest first. */
  listRecent(limit: number): Promise<AdminAuditEntry[]>;
}

export interface Environment {
  id: string;
  name: string;
  repo?: string;
  baseBranch?: string;
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  email: string;
  createdAt: string;
  lastSeenAt?: string;
  /** Display name for commit attribution (run.spec.author.name). Optional and operator-set for now
   * (no UI writes it); agentlink.ts falls back to the email's local part. */
  name?: string;
  /** GitHub login, for run.spec.author.login. Optional and operator-set for now. */
  githubLogin?: string;
  /** The address `Co-authored-by` credits -- ideally the person's GitHub noreply address
   * (`<id>+<login>@users.noreply.github.com`), so GitHub links the commit to them without
   * exposing their work email. Optional and operator-set for now; without it run.spec carries no
   * author, and cloud commits are the bot's alone. */
  githubEmail?: string;
  /** #252: voice preferences the person set in the web app (PUT /api/me/voice). Absent means
   * DEFAULT_VOICE_PREFS (src/voice.ts). */
  voice?: VoicePrefs;
}

/** Personal API token (E4.1b): the only auth the "link" role (no IAP) accepts, and also accepted
 * on "web"/"all" alongside IAP. Plaintext is `outf_` + 32 random bytes (base64url), generated once
 * at creation time and never stored or logged -- only `hash` (sha256 hex of the plaintext) and
 * `prefix` (the plaintext's first 8 chars, for display) persist. See src/tokens.ts. */
export interface ApiToken {
  id: string;
  /** The signed-in email that created this token (req.identity.email at creation time); routes
   * only let a caller list/revoke their own tokens. */
  ownerEmail: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: string;
  /** Updated at most once per minute per token (src/auth.ts's identityFromApiToken), so a busy
   * teleport session doesn't hammer the store with a write per request. */
  lastUsedAt?: string;
  /** Set (never cleared) when the owner revokes the token; a revoked token's hash still resolves
   * to a row so the auth check can tell "revoked" apart from "never existed" internally, but both
   * cases return the same generic 401 to the caller. */
  revokedAt?: string;
  /** When the token stops authenticating (src/auth.ts's identityFromApiToken). Set at creation to
   * createdAt + TOKEN_TTL_MS (src/tokens.ts); tokens minted before this field existed have none,
   * and tokenExpiresAt() falls back to the same TTL from their createdAt. */
  expiresAt?: string;
  /** E9 §5.2: what the token is for. Absent (every token minted before the field) means
   * "dongle". A Dongle works on /api/* only; an A2A key on the link role's /a2a only (auth.ts's
   * verifyApiToken enforces both). */
  kind?: ApiTokenKind;
  /** Set exactly when `kind` is "a2a": what the key's tasks may use. Fixed at creation. */
  a2a?: A2AKeyScope;
}

export type ApiTokenKind = "dongle" | "a2a";

/** E9 §5.2: an A2A key's scope. Tapes and repos are re-checked at every task start. */
export interface A2AKeyScope {
  /** Tape (guru) ids, in the owner's order; the first is the default skill. Never empty. */
  tapes: string[];
  /** `owner/name` repos a task may name. Empty: repo-less tasks only. */
  repos: string[];
  /** Non-terminal tasks the key may hold at once (default 2). */
  maxConcurrent: number;
}

/** Whose tokens POST /api/operator/tokens/revoke targets: one owner's exact email, or every owner
 * whose email ends in `@domain`. Both match case-insensitively (IAP emails are lowercase, but an
 * ownerEmail is whatever identity string minted the token). */
export type TokenOwnerMatch = { email: string } | { domain: string };

export interface TokensCollection {
  insert(token: ApiToken): Promise<void>;
  findById(id: string): Promise<ApiToken | null>;
  findByHash(hash: string): Promise<ApiToken | null>;
  /** Active (not revoked, not expired -- tokens.ts's isTokenActive) tokens for an owner, newest
   * first -- GET /api/me/tokens. An expired token is dead weight, so it neither shows nor counts. */
  listActiveForOwner(ownerEmail: string): Promise<ApiToken[]>;
  /** Active token count for an owner -- enforces the 10-active-tokens cap. */
  countActiveForOwner(ownerEmail: string): Promise<number>;
  update(id: string, patch: Partial<ApiToken>): Promise<ApiToken | null>;
  /** Sets `revokedAt` on every active token whose owner matches, and returns the tokens it revoked
   * (already-revoked and expired ones are left alone, so a repeat is a no-op). */
  revokeAllForOwners(match: TokenOwnerMatch, revokedAt: string): Promise<ApiToken[]>;
}

export type ProviderKind = "ngrok" | "laptop" | "litellm" | "cloudrun" | "gke";

/** "up"/"degraded"/"down" are real probe outcomes; "unknown" is a missing credential or an
 * inapplicable probe (e.g. cloudrun kind when SANDBOX_PROVIDER isn't cloudrun) -- never a crash,
 * per E2.10's "a probe must never throw" rule (see src/providers-status.ts). */
export type ProviderHealth = "up" | "degraded" | "down" | "unknown";

export interface ProviderTransition {
  status: ProviderHealth;
  at: string;
}

/** One row of current provider state, as returned by GET /api/providers (E2.10/E3.6). */
export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  status: ProviderHealth;
  detail?: string;
  checkedAt: string;
  meta?: Record<string, unknown>;
  /** Sandbox rows only: true on the provider new runs launch on (SANDBOX_PROVIDER). Every other
   * registered sandbox provider still gets a row (#169), without this. */
  isDefault?: boolean;
}

/** Stored form: the current row plus a bounded (last 7 days) history of status transitions, for
 * the E3.6 dashboard's uptime sparkline. */
export interface ProviderRecord extends ProviderRow {
  history: ProviderTransition[];
}

export interface ProvidersCollection {
  findById(id: string): Promise<ProviderRecord | null>;
  list(): Promise<ProviderRecord[]>;
  /** Replaces the stored record wholesale. The service (not the store) computes `history`, since
   * there's exactly one writer (the poller) and no concurrent-update race to resolve here. */
  upsert(record: ProviderRecord): Promise<void>;
}

export interface SessionListFilter {
  status?: string;
  guruId?: string;
  /** #207: "exclude" hides archived sessions, "only" returns just them. Omitted (or "all") returns
   * both -- what internal callers such as the Tape and secret reference guards need. */
  archived?: "exclude" | "only" | "all";
}

export interface SessionsCollection {
  insert(session: Session): Promise<void>;
  findById(id: string): Promise<Session | null>;
  /** #501: only what sse.ts's SsePoller reads every poll (checkpoint, ownerEmail), projected. */
  findStreamFacts(id: string): Promise<Pick<Session, "checkpoint" | "ownerEmail"> | null>;
  list(filter?: SessionListFilter): Promise<Session[]>;
  update(id: string, patch: Partial<Session>): Promise<Session | null>;
  /** #207: sets archivedAt, or clears it for `null`. Returns the updated session, or null if it
   * doesn't exist -- or, when clearing, if it is being formatted (formattingAt). */
  setArchivedAt(id: string, archivedAt: string | null): Promise<Session | null>;
  /** Sets the floppy's modelOverride, or clears it for `null`.
   * Returns the updated session, or null if it doesn't exist. */
  setModelOverride(id: string, model: string | null, nowIso: string): Promise<Session | null>;
  /** #208: atomically sets formattingAt on an archived session that isn't already being formatted.
   * null if there is no such session (missing, restored, or claimed by another format). */
  claimForFormat(id: string, nowIso: string): Promise<Session | null>;
  /** Clears formattingAt again, for a format that gave up before erasing anything. */
  releaseFormatClaim(id: string): Promise<void>;
  /** #208: removes the session document itself. false if there was none. */
  delete(id: string): Promise<boolean>;
  /** #503: turns Auto-fix CI on or off. Bumps autofix.rev (so a watcher mid-poll can't send after
   * an off). Turning it on clears the daily cap, its day streak, the turned-off notice and the poll
   * back-off, and with `nowIso` also moves updatedAt (so the 7-day activity filter includes it).
   * null if the session doesn't exist. */
  setAutofixCi(id: string, on: boolean, nowIso?: string): Promise<Session | null>;
  /** #503: how many sessions of this owner have Auto-fix on and aren't archived. */
  countAutofixForOwner(ownerEmail: string): Promise<number>;
  /** #503: replaces `autofix` with `next` (whose rev must be `expectedRev + 1`) only if the stored
   * rev is still `expectedRev` (0: none stored yet), Auto-fix is on and the session isn't archived.
   * false when another writer got there first. */
  casAutofix(id: string, expectedRev: number, next: AutofixState): Promise<boolean>;
  /** #503: sessions with Auto-fix on, not archived, with a repository and branch, updated since. */
  listAutofix(updatedSinceIso: string): Promise<Session[]>;
}

/** #208: a formatted (deleted) session's id, kept so teleport import can't bring it back. */
export interface FormattedSession {
  id: string;
  formattedAt: string;
  /** Email of the owner or sysop who formatted it. */
  formattedBy: string;
}

/** One public preview URL for a port in a run's sandbox (#217, docs/specs/drive-previews.md): an
 * ngrok cloud endpoint `https://<id>.<PREVIEW_DOMAIN>` forwarding to the run's internal endpoint. */
export interface Preview {
  /** The host label: 128 random bits, hex. Also the record id. */
  id: string;
  runId: string;
  sessionId: string;
  port: number;
  /** A public, time-limited link (true), or signed-in session viewers only (false). */
  share: boolean;
  url: string;
  endpointId: string;
  internalUrl: string;
  createdAt: string;
  /** Share links only: when the sweeper deletes the endpoint. */
  expiresAt?: string;
  /** Browser IDE (#242): "ide" for the IDE's endpoint (port 0, never shared, owner and sysops
   * only, not counted toward the per-run cap). Absent: a dev-server preview. */
  kind?: "ide";
  closedAt?: string;
  closedReason?: string;
}

export interface PreviewsCollection {
  insert(preview: Preview): Promise<void>;
  /** The open preview of `port` in `runId` with this `share` mode, if any. */
  findOpen(runId: string, port: number, share: boolean): Promise<Preview | null>;
  listOpenForRun(runId: string): Promise<Preview[]>;
  listOpenForSession(sessionId: string): Promise<Preview[]>;
  listOpen(): Promise<Preview[]>;
  /** Marks an open preview closed; null if it was already closed or doesn't exist. */
  markClosed(id: string, closedAt: string, reason: string): Promise<Preview | null>;
}

export interface FormattedSessionsCollection {
  /** Idempotent: a second insert for the same id keeps the first record. */
  insert(record: FormattedSession): Promise<void>;
  findById(id: string): Promise<FormattedSession | null>;
}

export interface EntriesCollection {
  /** Idempotent on entry.id within a session; returns false (no-op) if it already existed. */
  insertIfNew(sessionId: string, seq: number, entry: PiEntry, opts?: EntryInsertOptions): Promise<boolean>;
  /** The row whose `entry.id` is `entryId`, if this session has one. */
  findByEntryId(sessionId: string, entryId: string): Promise<Entry | null>;
  /** Entries in insertion order, optionally after a given entry id. Not by seq: seq restarts in
   * every run (see listRecent), so sorting on it interleaved one run's entries with the next's --
   * on the page and in the transcript a woken run restores (session-jsonl.ts). */
  listForSession(sessionId: string, afterEntryId?: string): Promise<Entry[]>;
  /** The `limit` most recently *inserted* entries of a session, oldest first. Insertion order, not
   * seq: agentd's seq restarts at 1 in every run and is shared with (far more numerous) `event`
   * frames, so a later run's new entries routinely carry a lower seq than an earlier run's last
   * one. SsePoller uses this as its cursor-free "what's new" window. */
  listRecent(sessionId: string, limit: number): Promise<Entry[]>;
  maxSeq(sessionId: string): Promise<number>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

export interface RunsCollection {
  insert(run: Run): Promise<void>;
  /** Inserts `run` unless its session already has an active run, in which case that run is
   * returned instead and nothing is inserted. Atomic across processes (Mongo: partial unique index
   * on active runs per session), so two concurrent wakes can't both start a sandbox. */
  insertIfNoActive(run: Run): Promise<{ run: Run; inserted: boolean }>;
  findById(id: string): Promise<Run | null>;
  /** Removes the run's pendingUiRequest only while it is the request `uiRequestId` (atomic). */
  clearPendingUiRequest(id: string, uiRequestId: string, nowIso: string): Promise<boolean>;
  /** The run currently occupying a session, if state is queued|provisioning|running|idle. */
  findActiveForSession(sessionId: string): Promise<Run | null>;
  /** The most recently updated run for a session regardless of state, including a terminal one
   * (stopped/failed). Bug 3 (docs/reports/cloud-fixes.md): findActiveForSession alone can't tell a
   * cleanly stopped run from a failed one once it's terminal -- both just look like "no active
   * run" -- so the UI has nothing to distinguish READY. from "stopped" from "LOAD ERROR". */
  findLatestForSession(sessionId: string): Promise<Run | null>;
  /** Every run of a session, oldest first (by createdAt). #147: GET /api/sessions/:id's per-run
   * HTML preview access. */
  listForSession(sessionId: string): Promise<Run[]>;
  update(id: string, patch: Partial<Run>): Promise<Run | null>;
  /**
   * Sets `fields` inside Run.startup without rewriting the rest of it, so writers on different
   * processes (wake on web, hello/status on link) can't clobber each other. With `unlessSet`, writes
   * only while `startup[unlessSet]` is still absent: that is how each stamp is written once.
   * Returns the updated run, or null when nothing was written (no such run, or already set).
   */
  mergeStartup(id: string, fields: Partial<RunStartup>, unlessSet?: keyof RunStartup): Promise<Run | null>;
  /**
   * Insert `pending` at `githubIdempotency[key]` only when that key is absent.
   * `claimed` means this caller owns the write. `existing` is the record already stored.
   * `missing` means the run does not exist.
   */
  claimGithubIdempotency(id: string, key: string, pending: GithubIdempotencyRecord): Promise<
    { status: "claimed" } | { status: "existing"; record: GithubIdempotencyRecord } | { status: "missing" }
  >;
  /** Replace one idempotency key. Does not rewrite the rest of the map. */
  finishGithubIdempotency(id: string, key: string, result: GithubIdempotencyRecord): Promise<void>;
  /** Runs in an active state whose lastSeenAt is older than the cutoff (reconciler input). */
  listStale(cutoffIso: string): Promise<Run[]>;
  /** Runs still `stopping` whose updatedAt (the moment they entered `stopping`) is older than the
   * cutoff -- RunManager.reconcileStoppingOnce's input for cancelling a run whose graceful stop
   * never got an agentd `bye` within STOP_GRACE_MS. */
  listStopping(cutoffIso: string): Promise<Run[]>;
  enqueueDownMessage(id: string, message: DownMessage): Promise<void>;
  /** Removes and returns all queued down-messages, in FIFO order. */
  drainDownMessages(id: string): Promise<DownMessage[]>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

export interface GurusCollection {
  insert(guru: Guru): Promise<void>;
  findById(id: string): Promise<Guru | null>;
  list(): Promise<Guru[]>;
  update(id: string, patch: Partial<Guru>): Promise<Guru | null>;
  /** E3.7: DELETE /api/gurus/:id. Returns false if the guru didn't exist (routes/gurus.ts checks
   * findById first and 404s before calling this, so false here would only mean a race). */
  delete(id: string): Promise<boolean>;
}

export interface EnvironmentsCollection {
  insert(environment: Environment): Promise<void>;
  findById(id: string): Promise<Environment | null>;
  list(): Promise<Environment[]>;
  update(id: string, patch: Partial<Environment>): Promise<Environment | null>;
}

export interface UsersCollection {
  upsertSeen(email: string): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  /** #252: replaces the person's voice preferences, creating the user row if needed. */
  setVoicePrefs(email: string, prefs: VoicePrefs): Promise<User>;
  /** #257: every user row, for naming voice usage tags on the sysop spend table. */
  list(): Promise<User[]>;
}

/** One shared browser tab per session (chrome companion, docs/specs/chrome-companion.md §9.2).
 * Replaced only by the same ownerEmail; a different email is a conflict. */
export interface BrowserShare {
  sessionId: string;
  tabTitle: string;
  tabUrl: string;
  ownerEmail: string;
  createdAt: string;
}

export type BrowserRequestStatus = "pending" | "done" | "skipped" | "failed";

/** Chrome outcomes the extension reports after its retry. Not a transcript row. */
export type BrowserCaptureFailure = "permission_denied" | "tab_gone" | "too_large";

export type BrowserActionKind = "click" | "type";

/** Owner-reported DevTools failures. `skipped` and `no_share` are statuses the API sends, not this list. */
export type BrowserInspectFailure = "denied" | "not_shared" | "tab_gone" | "permission_denied" | "debugger_attached";

/** Owner-reported action failures, plus `skipped` when the share is revoked before the action runs. */
export type BrowserActionResultError =
  | "denied"
  | "not_found"
  | "permission_denied"
  | "tab_gone"
  | "not_editable"
  | "not_shared"
  | "skipped"
  | "rejected"
  | "no_share";

/** A capture ask, a click/type ask, or a DevTools inspect. requesterEmail is the authenticated caller, never a body field.
 * `kind` absent means capture. `click` and `type` carry a CSS selector, never JavaScript.
 * `inspect` carries no selector and no tab id. Console text is stored only after redaction. */
export interface BrowserRequest {
  id: string;
  sessionId: string;
  requesterEmail: string;
  status: BrowserRequestStatus;
  /** Set when a capture is stored and the request is marked done. */
  captureId?: string;
  /** Set when the extension reports a terminal error and the request is `failed`. */
  error?: BrowserCaptureFailure | BrowserActionResultError | BrowserInspectFailure;
  kind?: BrowserActionKind | "inspect";
  selector?: string;
  /** Set on `kind: "type"`. */
  text?: string;
  /** Redacted console lines for a done inspect. Not a transcript. */
  inspectMessages?: string[];
  /** Short description of the selected element, or null. Not the DOM. */
  inspectElement?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How many browserCaptures a session keeps. Older ones are deleted in the same insert. */
export const BROWSER_CAPTURES_PER_SESSION = 20;

/** Jpeg bytes for one fulfilled capture request. `id` is the captureId returned to clients. */
export interface BrowserCapture {
  id: string;
  sessionId: string;
  requestId: string;
  ownerEmail: string;
  requesterEmail: string;
  title: string;
  url: string;
  bytes: Buffer;
  createdAt: string;
}

export interface BrowserSharesCollection {
  findBySession(sessionId: string): Promise<BrowserShare | null>;
  /** Inserts, or replaces tabTitle/tabUrl/createdAt when ownerEmail matches.
   * `conflict` is the share already stored when a different email owns it. */
  put(share: BrowserShare): Promise<{ conflict: false; share: BrowserShare } | { conflict: true; share: BrowserShare }>;
  /** Deletes the share and marks this session's pending requests skipped.
   * `skippedIds` are the requests that were pending and are now skipped (empty unless deleted). */
  deleteIfOwner(
    sessionId: string,
    ownerEmail: string,
    nowIso: string,
  ): Promise<{ outcome: "deleted" | "missing" | "forbidden"; skippedIds: string[] }>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

export interface BrowserRequestsCollection {
  insert(request: BrowserRequest): Promise<void>;
  /**
   * Inserts `request` only when `sessionId` still has a share. The share read and the insert
   * commit together with `BrowserSharesCollection.deleteIfOwner`, so a revoke that has finished
   * cannot be followed by a new pending row, and a row this call has finished inserting is
   * skipped by a revoke that runs after it. `"no_share"` inserts nothing.
   */
  insertPendingIfShared(sessionId: string, request: BrowserRequest): Promise<BrowserRequest | "no_share">;
  findById(sessionId: string, id: string): Promise<BrowserRequest | null>;
  /** Oldest pending first. */
  listPending(sessionId: string): Promise<BrowserRequest[]>;
  /** Pending or already-skipped becomes skipped. A done or failed request is left as it is. */
  markSkipped(sessionId: string, id: string, nowIso: string): Promise<BrowserRequest | null>;
  /**
   * Pending becomes `failed` with `error`. `transitioned` is true only for that change, so a
   * repeat report of the same requestId does not send a second result or insert a row.
   * A done or skipped request is returned unchanged (`transitioned` false).
   */
  markFailed(
    sessionId: string,
    id: string,
    error: BrowserCaptureFailure,
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null>;
  /**
   * A pending click or type becomes `done` or `failed`. `transitioned` is true only for that
   * change. A capture row, or a request that is already finished, is returned unchanged.
   */
  markActionResult(
    sessionId: string,
    id: string,
    outcome: { ok: true } | { ok: false; error: BrowserActionResultError },
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null>;
  /**
   * A pending inspect becomes `done` (redacted console lines and an optional element) or `failed`.
   * `transitioned` is true only for that change. A capture or action row is left unchanged.
   */
  markInspectResult(
    sessionId: string,
    id: string,
    outcome: { ok: true; messages: string[]; element: string | null } | { ok: false; error: BrowserInspectFailure },
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

export type BrowserCaptureSave =
  | { ok: true; capture: BrowserCapture; inserted: boolean }
  | { ok: false; reason: "missing" | "not_pending" };

export interface BrowserCapturesCollection {
  /** Stores `capture` and marks its request done, or returns the capture already stored for
   * that requestId (inserted: false). Trims the session to BROWSER_CAPTURES_PER_SESSION in the
   * same call. `not_pending` means the request is missing a done capture and is not pending
   * (skipped, or done with the bytes already gone). */
  save(capture: BrowserCapture, nowIso: string): Promise<BrowserCaptureSave>;
  findById(sessionId: string, id: string): Promise<BrowserCapture | null>;
  findByRequestId(sessionId: string, requestId: string): Promise<BrowserCapture | null>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

/** E9 §1: how a turn waiter finished. `settled`: the first settle after its mail was accepted.
 * `ended`: anything else, with `endReason`. */
export type TurnWaiterStatus = "open" | "settled" | "ended";
/** `run_stopped`/`run_failed`: the run that accepted the mail ended before settling (layer 2).
 * `mail_dead`/`mail_held`: the mail can't reach a run (attempts ran out, or held). `deadline`:
 * layer 3. `canceled`: the caller gave up (TurnWaiters.cancel). */
export type TurnWaiterEndReason = "run_stopped" | "run_failed" | "mail_dead" | "mail_held" | "deadline" | "canceled";

/** E9 §1 (docs/specs/atlas-agent-engine-and-a2a.md, EPIC.md E5.2's completion layers): something
 * waiting for the turn one mail starts to finish -- an A2A task, a delegation. Durable, because
 * the settle can arrive on another api instance than the one that registered it; see turns.ts. */
export interface TurnWaiter {
  id: string;
  sessionId: string;
  /** The mail whose turn this waits for. Only its acceptance is matched by id: a settle never is
   * (other mail can settle the same turn), so the first settle after acceptance completes it. */
  mailId: string;
  /** Who registered it ("a2a", "delegate", ...). Opaque here; for the caller's own lookups. */
  owner?: string;
  status: TurnWaiterStatus;
  createdAt: string;
  updatedAt: string;
  /** Layer 3. The tick sweep pushes it forward while the run works, never past `capAt`. */
  deadlineAt: string;
  /** Hard cap: createdAt + 4 h. */
  capAt: string;
  /** Set when pi accepted the mail: the run, and the seq of pi's `response` event for it. agentd's
   * seq restarts every run, so a settle completes the waiter only on this run, at a higher seq. */
  ackRunId?: string;
  ackSeq?: number;
  ackedAt?: string;
  /** The acceptance was taken from the mail's acked state, not pi's `response` (TurnWaiters'
   * adoptMailAck): provisional, so the real `response`, if it still arrives, replaces it. */
  ackFromMail?: boolean;
  /** On `settled`: the settle's `lastEntryId`, when agentd sent one. */
  settledEntryId?: string;
  /** On `ended`. */
  endReason?: TurnWaiterEndReason;
  /** On `ended`: a sentence for a person (the run's reason, the mail's hold note). */
  detail?: string;
  finishedAt?: string;
}

/** The fields `finish` writes. */
export type TurnWaiterFinish =
  | { status: "settled"; settledEntryId?: string }
  | { status: "ended"; endReason: TurnWaiterEndReason; detail?: string };

export interface TurnWaitersCollection {
  insert(waiter: TurnWaiter): Promise<void>;
  findById(id: string): Promise<TurnWaiter | null>;
  /** Records pi's acceptance of `mailId` on the session's open waiters for it that have none yet,
   * or only a provisional one (`ackFromMail`); a replayed `response` event is a no-op. With
   * `fromMail`, marks only waiters with no acceptance at all, provisionally. Returns how many. */
  markAcked(sessionId: string, mailId: string, runId: string, seq: number, nowIso: string, fromMail?: boolean): Promise<number>;
  /** Finishes one waiter, only if it is still open: a finished waiter is never overwritten. Null
   * when it wasn't open (or doesn't exist). */
  finish(id: string, outcome: TurnWaiterFinish, nowIso: string): Promise<TurnWaiter | null>;
  /** Moves an open waiter's deadlineAt later; false if it is no longer open or the deadline is
   * already at or past `deadlineAt` (two sweeps can't move it back). */
  extendDeadline(id: string, deadlineAt: string, nowIso: string): Promise<boolean>;
  listOpenForSession(sessionId: string): Promise<TurnWaiter[]>;
  /** Open waiters, earliest deadline first, at most `limit` (the tick sweep). */
  listOpen(limit: number): Promise<TurnWaiter[]>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(sessionId: string): Promise<number>;
}

/** E9 §4: one Agent Engine agent Drives may call, set by a sysop (Settings → Agent Engine agents).
 * Agents call only listed, enabled entries; nothing is discovered from Agent Engine. */
export interface AeAgent {
  /** Slug: what the `agent_engine` tool names, and part of the Agent Engine session id. */
  id: string;
  /** The agents project's workspace that hosts it. One entry per workspace. */
  workspaceId: string;
  name: string;
  /** What the agent does, for the model choosing one (ae.list). */
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The sysop who last changed it. */
  updatedBy?: string;
}

export interface AeAgentsCollection {
  list(): Promise<AeAgent[]>;
  findById(id: string): Promise<AeAgent | null>;
  /** False when the id or the workspace is already listed. */
  insert(agent: AeAgent): Promise<boolean>;
  /** Null when there is no such agent; "duplicate" when the new workspace is another entry's. */
  update(id: string, patch: Partial<Omit<AeAgent, "id" | "createdAt">>): Promise<AeAgent | null | "duplicate">;
  delete(id: string): Promise<boolean>;
}

/** E9 §4: the Agent Engine runtime session one Outfitter session opened with one agent, so the api
 * can stop it when the Outfitter session closes, and so `ae.get`/`ae.resume` reach only executions
 * this Outfitter session started. */
export interface AeSession {
  /** `<outfitterSessionId>:<agentId>`. */
  id: string;
  outfitterSessionId: string;
  agentId: string;
  /** The workspace the calls went to (an allowlist edit later doesn't move them). */
  workspaceId: string;
  /** The Agent Engine session id sent as X-Session-ID (`outf-<session8>-<agent>`). */
  aeSessionId: string;
  /** Executions started from this session, oldest first, at most AE_SESSION_EXECUTIONS. */
  executions: string[];
  openedAt: string;
  lastUsedAt: string;
  /** Set once the stop was accepted or given up on; the next invoke clears it. */
  stoppedAt?: string;
  stopAttempts?: number;
  /** Why the last stop failed (one line). */
  stopError?: string;
}

export const AE_SESSION_EXECUTIONS = 50;

export interface AeSessionsCollection {
  /** Upserts the row for this session and agent, appends `executionId` (when there is one), and
   * reopens it (clears stoppedAt and the stop attempts). */
  recordInvoke(
    row: Pick<AeSession, "outfitterSessionId" | "agentId" | "workspaceId" | "aeSessionId">,
    executionId: string | undefined,
    nowIso: string,
  ): Promise<AeSession>;
  /** The row of this Outfitter session that started `executionId`, if any. */
  findByExecution(outfitterSessionId: string, executionId: string): Promise<AeSession | null>;
  /** Rows not yet stopped, least recently used first; with `usedBefore`, only rows last used
   * before it (the sweep skips fresh ones in the query, so they can't crowd out closed ones). */
  listOpen(limit: number, usedBefore?: string): Promise<AeSession[]>;
  listOpenForSession(outfitterSessionId: string): Promise<AeSession[]>;
  /** Marks it stopped, only if it is still open and unused since `lastUsedAt` (an invoke that
   * raced the stop keeps its session). */
  markStopped(id: string, lastUsedAt: string, nowIso: string, error?: string): Promise<boolean>;
  /** Counts one failed stop on an open row unused since `lastUsedAt`; the new count, or null. */
  recordStopFailure(id: string, lastUsedAt: string, error: string): Promise<number | null>;
  /** #208: removes every row of this session (format). Returns how many were removed. */
  deleteForSession(outfitterSessionId: string): Promise<number>;
}

/** E9 §5.3: an A2A task's state, the v1.0 TaskState names lowercased. The first four after
 * `working` are terminal (A2A_TERMINAL_STATES). */
export type A2ATaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected";

export const A2A_TERMINAL_STATES: readonly A2ATaskState[] = ["completed", "failed", "canceled", "rejected"];
export const A2A_OPEN_STATES: readonly A2ATaskState[] = ["submitted", "working", "input-required"];

/** E9 §5.3: one A2A task (docs/specs/atlas-agent-engine-and-a2a.md). Every lookup filters on
 * `tokenId`. `contextId` is server-issued and opaque, never a session id. */
export interface A2ATask {
  id: string;
  contextId: string;
  /** The A2A key (ApiToken.id) that created it. */
  tokenId: string;
  /** The key's owner, who the session runs as. */
  ownerEmail: string;
  /** The caller's messageId. */
  messageId?: string;
  /** Store-managed: `messageId` while the task is open, removed when it becomes terminal. The
   * dedupe (one open task per key and messageId) is on this, so a retried SendMessage returns the
   * task its first send made while that task runs, and a messageId reused after it finished (the
   * TCK reuses one per test session) starts a new one. */
  openMessageId?: string;
  /** Absent on a task rejected before it had a session, and briefly while one is created. */
  sessionId?: string;
  /** The mail this task's turn starts, and the turn waiter on it (turns.ts). */
  mailId?: string;
  waiterId?: string;
  /** The tape and repo the task was started with (also on the session). */
  guruId?: string;
  repo?: string | null;
  state: A2ATaskState;
  /** One line for `status.message` (why it was rejected, what it is waiting for). */
  statusText?: string;
  /** The caller's message as A2A JSON (Message.toJSON), for `history`. Bounded by the 64 KB body. */
  message?: unknown;
  /** On `completed`: the final assistant text, and for a repo task the pushed branch. */
  result?: A2ATaskResult;
  /** E9 §5.3 completion: when the settled turn's checkpoint was asked for (the `{t: "checkpoint"}`
   * down-frame). COMPLETED waits for a landed checkpoint; FAILED after A2A_CHECKPOINT_TIMEOUT_MS. */
  checkpointRequestedAt?: string;
  /** The caller's answers to INPUT_REQUIRED as `<messageId>#<hash of the text>`, newest last
   * (capped): a retried answer (same id, same text) is never applied to the next question. */
  answerKeys?: string[];
  /** Those answers as A2A JSON (text capped like `message`), for `history` after `message`. */
  replies?: unknown[];
  /** The id of the pi UI request last shown to the caller as INPUT_REQUIRED: an answer applies only
   * to that question, never to one that replaced it. */
  questionId?: string;
  /** The id of the pi UI request the caller answered: until pi drops it, it no longer reads as
   * INPUT_REQUIRED (no flap back while the answer is on its way). */
  answeredQuestionId?: string;
  /** The nonce marker of this task's own prompt (wrapA2APrompt): its turn starts at the user entry
   * that carries it and ends at the next user entry (an owner's message in the same session). */
  promptMarker?: string;
  createdAt: string;
  updatedAt: string;
  /** The turn waiter's deadline when the task started (turns.ts layer 3). */
  deadlineAt?: string;
}

export interface A2ATaskResult {
  text?: string;
  branch?: string;
  head?: string;
  compareUrl?: string;
  prUrl?: string;
}

export interface A2ATaskListQuery {
  contextId?: string;
  state?: A2ATaskState;
  /** Only tasks updated after this ISO time. */
  updatedAfter?: string;
  /** Exclusive cursor: tasks strictly older (createdAt desc, then id desc) than this one. */
  before?: { createdAt: string; id: string };
  limit: number;
}

export interface A2ATasksCollection {
  /** false (no-op) when the key already has an open task with this messageId (the dedupe). Sets
   * `openMessageId` on an open task with a messageId. */
  insert(task: A2ATask): Promise<boolean>;
  /** The key's own task, or null: another key's task id reads as missing. */
  findForToken(tokenId: string, id: string): Promise<A2ATask | null>;
  /** The key's open task with this messageId (the dedupe), or null. */
  findByMessageId(tokenId: string, messageId: string): Promise<A2ATask | null>;
  /** The newest task in the key's context, or null for a context the key doesn't have. */
  latestInContext(tokenId: string, contextId: string): Promise<A2ATask | null>;
  /** The session a key's context runs on (any of its tasks that has one), or undefined. */
  sessionForContext(tokenId: string, contextId: string): Promise<string | undefined>;
  /** Newest first (createdAt, then id). `total` counts every match, ignoring `before`/`limit`. */
  list(tokenId: string, query: A2ATaskListQuery): Promise<{ tasks: A2ATask[]; total: number }>;
  /** Non-terminal tasks: one key's, or everyone's (the tick sweep), oldest first, at most `limit`. */
  listOpen(limit: number, tokenId?: string): Promise<A2ATask[]>;
  /** Applies `patch` only while the task is in one of `from` (a terminal state is never left);
   * null when it wasn't. Moving to a terminal state removes `openMessageId`. */
  transition(id: string, from: readonly A2ATaskState[], patch: Partial<A2ATask>, opts?: { unlessSet?: "checkpointRequestedAt" }): Promise<A2ATask | null>;
  /** §5.2 maxConcurrent, atomic across instances: adds `taskId` to the key's slots unless it
   * already holds `max`. True when claimed (or already held). */
  claimSlot(tokenId: string, taskId: string, max: number): Promise<boolean>;
  releaseSlot(tokenId: string, taskId: string): Promise<void>;
  /** The task ids holding the key's slots (to free ones whose task is gone or finished). */
  listSlots(tokenId: string): Promise<string[]>;
  /** §5.2 rate limit, atomic across instances: counts one request in the key's fixed window
   * `windowId` and returns the count after it. */
  countRequest(tokenId: string, windowId: string, expireAtIso: string): Promise<number>;
}

/** Fleet settings (fleet-settings.ts): one document, written only by an operator. */
export interface FleetSettingsCollection {
  /** The stored document, or null before an operator ever saved one. */
  get(): Promise<FleetSettings | null>;
  /** Replaces the document wholesale. */
  put(settings: FleetSettings): Promise<void>;
  /** Stores `settings` only if there is no document yet (atomic across instances). True when it did. */
  insertIfAbsent(settings: FleetSettings): Promise<boolean>;
  /** #392: replaces the document only if its stored `version` (absent = 0, no document = 0) is
   * `expectedVersion` (atomic across instances). True when it did. */
  replaceAtVersion(settings: FleetSettings, expectedVersion: number): Promise<boolean>;
}

export interface Store {
  sessions: SessionsCollection;
  entries: EntriesCollection;
  runs: RunsCollection;
  gurus: GurusCollection;
  environments: EnvironmentsCollection;
  users: UsersCollection;
  providers: ProvidersCollection;
  tokens: TokensCollection;
  mail: MailCollection;
  browserShares: BrowserSharesCollection;
  browserRequests: BrowserRequestsCollection;
  browserCaptures: BrowserCapturesCollection;
  formattedSessions: FormattedSessionsCollection;
  previews: PreviewsCollection;
  adminAudit: AdminAuditCollection;
  adminApprovals: AdminApprovalsCollection;
  laptopApprovals: LaptopApprovalsCollection;
  sessionChunks: SessionChunksCollection;
  turnWaiters: TurnWaitersCollection;
  aeAgents: AeAgentsCollection;
  aeSessions: AeSessionsCollection;
  a2aTasks: A2ATasksCollection;
  fleetSettings: FleetSettingsCollection;
  // Central sign-in and settings (#389, docs/specs/central-auth.md §9): each collection lives in
  // its own store module, owned by the task that builds it.
  deviceCodes: DeviceCodesCollection;
  devices: DevicesCollection;
  settings: SettingsCollection;
  routerKeys: RouterKeysCollection;
  providerKeys: ProviderKeysCollection;
  subscriptionSecrets: SubscriptionSecretsCollection;
  // Local Host (#378, docs/specs/local-host.md §1.5): owned by task A.
  localHosts: LocalHostsCollection;
  close(): Promise<void>;
}
