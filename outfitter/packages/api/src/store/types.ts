// Store: the persistence seam. MongoStore and MemoryStore both implement this so every route,
// runs.ts and agentlink.ts test runs without a real Mongo cluster (MONGODB_URI=memory).
//
// See docs/data-model.md for schema, indexes and the "session == pi JSONL file" rationale.

export type RunState = "queued" | "provisioning" | "running" | "idle" | "stopping" | "stopped" | "failed";

export type ByeReason = "idle" | "stop" | "sigterm" | "error";

export interface Session {
  id: string;
  name?: string;
  /** Email of the caller who created this session (req.identity.email at POST /api/sessions time).
   * Recorded but not yet enforced -- finding #5 in docs/reports/security-review-pr1.md flags that
   * every session route is open to every authenticated domain user today with no ownership check;
   * whether to add one is an open decision, tracked in EPIC.md under E2.2. */
  ownerEmail?: string;
  guruId: string;
  /** null = non-coding session (protocol.md: `repo` omitted on POST /api/sessions). */
  repo: string | null;
  baseBranch?: string;
  /** Absent for a repo-less session; agentd then works out of a scratch /workspace instead. */
  branch?: string;
  prompt?: string;
  /** Per-session model override, taking priority over the guru's own `model` (E2.8 laptop preflight). */
  modelOverride?: string;
  parentId?: string;
  status: "open" | "closed";
  /** id of the current leaf entry (tip of the transcript tree), if any. */
  leafId?: string;
  cost: number;
  /** The most recent checkpoint frame's fields, replaced wholesale by each new checkpoint: a
   * repo session reports branch/head (and maybe snapshotUrl); a repo-less session reports
   * workspaceUrl instead (protocol.md's agentd<->api `checkpoint` row). */
  checkpoint?: { branch?: string; head?: string; snapshotUrl?: string; workspaceUrl?: string };
  createdAt: string;
  updatedAt: string;
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
}

export interface DownMessage {
  t: "prompt" | "steer" | "follow_up" | "abort" | "ui_response" | "rpc" | "checkpoint" | "stop";
  [key: string]: unknown;
}

export interface Run {
  id: string;
  sessionId: string;
  state: RunState;
  reason?: string;
  lastSeenAt?: string;
  lastAckedSeq: number;
  pending: DownMessage[];
  /** Opaque provider handle (SandboxProvider.start's return; a plain string per @outfitter/
   * provider-local's SandboxHandle -- a Cloud Run execution name, a docker container id, or a
   * synthetic in-process id). Callers should not parse it. */
  providerHandle?: string;
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
  // agentlink.ts's "status" case), so it survives until the next notice replaces it.
  statusDetail?: string;
  // Not in protocol.md: set when E2.8's laptop-model preflight (src/laptop.ts) swaps a guru's or
  // session's `litellm/local-qwen-mlx`-style model for the guru's fallbackModel because the laptop
  // tunnel probed offline. Surfaced so the UI can show "running on X instead of Y".
  modelFallback?: { wanted: string; used: string };
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
  createdAt: string;
  updatedAt: string;
}

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
  /** When the mail was parked as `held` (a deploy mismatch: runs start but never validate). */
  heldAt?: string;
}

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
  holdIfStuck(sessionId: string, nowIso: string, maxAttempts: number, maxUnvalidatedWakes: number): Promise<number>;
  /** Returns held mail (of one session, or of every session) to `queued` with a fresh wake count.
   * Returns the sessions that had mail released. */
  releaseHeld(sessionId?: string): Promise<string[]>;
  /** How many of a session's mail are held. */
  countHeld(sessionId: string): Promise<number>;
  /** Marks mail that ran out of attempts dead and returns it (for bounces). */
  expireExhausted(nowIso: string, maxAttempts: number): Promise<Mail[]>;
  /** Mail a session has sent since the given time (the per-sender rate limit). */
  countSentSince(fromSessionId: string, sinceIso: string): Promise<number>;
  /** Whether one session holds deliverable mail. */
  hasDeliverable(sessionId: string, nowIso: string, maxAttempts: number): Promise<boolean>;
  /** Distinct sessions holding deliverable mail (the /tick sweep's input). */
  sessionsWithDeliverable(nowIso: string, maxAttempts: number): Promise<string[]>;
  findById(id: string): Promise<Mail | null>;
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
  createdAt: string;
  updatedAt: string;
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

export type ProviderKind = "ngrok" | "laptop" | "litellm" | "cloudrun";

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
}

export interface SessionsCollection {
  insert(session: Session): Promise<void>;
  findById(id: string): Promise<Session | null>;
  list(filter?: SessionListFilter): Promise<Session[]>;
  update(id: string, patch: Partial<Session>): Promise<Session | null>;
}

export interface EntriesCollection {
  /** Idempotent on entry.id within a session; returns false (no-op) if it already existed. */
  insertIfNew(sessionId: string, seq: number, entry: PiEntry, blobRef?: string): Promise<boolean>;
  /** Entries in tree order (by seq), optionally after a given entry id. */
  listForSession(sessionId: string, afterEntryId?: string): Promise<Entry[]>;
  /** The `limit` most recently *inserted* entries of a session, oldest first. Insertion order, not
   * seq: agentd's seq restarts at 1 in every run and is shared with (far more numerous) `event`
   * frames, so a later run's new entries routinely carry a lower seq than an earlier run's last
   * one. SsePoller uses this as its cursor-free "what's new" window. */
  listRecent(sessionId: string, limit: number): Promise<Entry[]>;
  maxSeq(sessionId: string): Promise<number>;
}

export interface RunsCollection {
  insert(run: Run): Promise<void>;
  /** Inserts `run` unless its session already has an active run, in which case that run is
   * returned instead and nothing is inserted. Atomic across processes (Mongo: partial unique index
   * on active runs per session), so two concurrent wakes can't both start a sandbox. */
  insertIfNoActive(run: Run): Promise<{ run: Run; inserted: boolean }>;
  findById(id: string): Promise<Run | null>;
  /** The run currently occupying a session, if state is queued|provisioning|running|idle. */
  findActiveForSession(sessionId: string): Promise<Run | null>;
  /** The most recently updated run for a session regardless of state, including a terminal one
   * (stopped/failed). Bug 3 (docs/reports/cloud-fixes.md): findActiveForSession alone can't tell a
   * cleanly stopped run from a failed one once it's terminal -- both just look like "no active
   * run" -- so the UI has nothing to distinguish READY. from "stopped" from "LOAD ERROR". */
  findLatestForSession(sessionId: string): Promise<Run | null>;
  update(id: string, patch: Partial<Run>): Promise<Run | null>;
  /** Runs in an active state whose lastSeenAt is older than the cutoff (reconciler input). */
  listStale(cutoffIso: string): Promise<Run[]>;
  /** Runs still `stopping` whose updatedAt (the moment they entered `stopping`) is older than the
   * cutoff -- RunManager.reconcileStoppingOnce's input for cancelling a run whose graceful stop
   * never got an agentd `bye` within STOP_GRACE_MS. */
  listStopping(cutoffIso: string): Promise<Run[]>;
  enqueueDownMessage(id: string, message: DownMessage): Promise<void>;
  /** Removes and returns all queued down-messages, in FIFO order. */
  drainDownMessages(id: string): Promise<DownMessage[]>;
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
  close(): Promise<void>;
}
