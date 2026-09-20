// Store: the persistence seam. MongoStore and MemoryStore both implement this so every route,
// runs.ts and agentlink.ts test runs without a real Mongo cluster (MONGODB_URI=memory).
//
// See docs/data-model.md for schema, indexes and the "session == pi JSONL file" rationale.

export type RunState = "queued" | "provisioning" | "running" | "idle" | "stopped" | "failed";

export type ByeReason = "idle" | "stop" | "sigterm" | "error";

export interface Session {
  id: string;
  name?: string;
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
  providerHandle?: unknown;
  // Deviation from protocol.md: extension_ui_request events are "not persisted except
  // extension_ui_request" per the protocol, but it doesn't say where. Stored here so a browser
  // that reconnects (or opens the session fresh) still sees a question the run is waiting on;
  // cleared when a ui_response down-message is sent for this run.
  pendingUiRequest?: unknown;
  // Not in protocol.md: set when E2.8's laptop-model preflight (src/laptop.ts) swaps a guru's or
  // session's `litellm/local-qwen-mlx`-style model for the guru's fallbackModel because the laptop
  // tunnel probed offline. Surfaced so the UI can show "running on X instead of Y".
  modelFallback?: { wanted: string; used: string };
  createdAt: string;
  updatedAt: string;
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
  maxSeq(sessionId: string): Promise<number>;
}

export interface RunsCollection {
  insert(run: Run): Promise<void>;
  findById(id: string): Promise<Run | null>;
  /** The run currently occupying a session, if state is queued|provisioning|running|idle. */
  findActiveForSession(sessionId: string): Promise<Run | null>;
  update(id: string, patch: Partial<Run>): Promise<Run | null>;
  /** Runs in an active state whose lastSeenAt is older than the cutoff (reconciler input). */
  listStale(cutoffIso: string): Promise<Run[]>;
  enqueueDownMessage(id: string, message: DownMessage): Promise<void>;
  /** Removes and returns all queued down-messages, in FIFO order. */
  drainDownMessages(id: string): Promise<DownMessage[]>;
}

export interface GurusCollection {
  insert(guru: Guru): Promise<void>;
  findById(id: string): Promise<Guru | null>;
  list(): Promise<Guru[]>;
  update(id: string, patch: Partial<Guru>): Promise<Guru | null>;
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
  close(): Promise<void>;
}
