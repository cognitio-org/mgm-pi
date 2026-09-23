// Map-based Store used for MONGODB_URI=memory (dev and tests). Same interface as MongoStore so
// routes, runs.ts and agentlink.ts are exercised identically either way.

import { isTokenActive, ownerMatches } from "../tokens.ts";
import type {
  Store,
  Session,
  SessionListFilter,
  SessionsCollection,
  Entry,
  EntriesCollection,
  PiEntry,
  Run,
  RunsCollection,
  DownMessage,
  Guru,
  GurusCollection,
  Environment,
  EnvironmentsCollection,
  User,
  UsersCollection,
  ProviderRecord,
  ProvidersCollection,
  ApiToken,
  TokensCollection,
  TokenOwnerMatch,
  Mail,
  MailCollection,
  BrowserShare,
  BrowserSharesCollection,
  BrowserRequest,
  BrowserRequestsCollection,
  BrowserCapture,
  BrowserCaptureFailure,
  BrowserCapturesCollection,
  BrowserCaptureSave,
} from "./types.ts";
import { BROWSER_CAPTURES_PER_SESSION } from "./types.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemorySessions implements SessionsCollection {
  private readonly rows = new Map<string, Session>();

  async insert(session: Session): Promise<void> {
    this.rows.set(session.id, clone(session));
  }

  async findById(id: string): Promise<Session | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async list(filter?: SessionListFilter): Promise<Session[]> {
    let out = [...this.rows.values()];
    if (filter?.status) out = out.filter((s) => s.status === filter.status);
    if (filter?.guruId) out = out.filter((s) => s.guruId === filter.guruId);
    return out.map(clone).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async update(id: string, patch: Partial<Session>): Promise<Session | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return clone(next);
  }
}

class MemoryEntries implements EntriesCollection {
  private readonly bySession = new Map<string, Entry[]>();
  private readonly seenIds = new Map<string, Set<string>>();

  async insertIfNew(sessionId: string, seq: number, entry: PiEntry, blobRef?: string): Promise<boolean> {
    const seen = this.seenIds.get(sessionId) ?? new Set<string>();
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    this.seenIds.set(sessionId, seen);
    const list = this.bySession.get(sessionId) ?? [];
    list.push(clone({ sessionId, seq, entry, blobRef }));
    this.bySession.set(sessionId, list);
    return true;
  }

  async findByEntryId(sessionId: string, entryId: string): Promise<Entry | null> {
    const list = this.bySession.get(sessionId) ?? [];
    const found = list.find((row) => row.entry.id === entryId);
    return found ? clone(found) : null;
  }

  async listForSession(sessionId: string, afterEntryId?: string): Promise<Entry[]> {
    const list = (this.bySession.get(sessionId) ?? []).slice().sort((a, b) => a.seq - b.seq);
    if (!afterEntryId) return list.map(clone);
    const idx = list.findIndex((e) => e.entry.id === afterEntryId);
    return (idx === -1 ? list : list.slice(idx + 1)).map(clone);
  }

  async listRecent(sessionId: string, limit: number): Promise<Entry[]> {
    const list = this.bySession.get(sessionId) ?? []; // push order == insertion order
    return list.slice(Math.max(0, list.length - limit)).map(clone);
  }

  async maxSeq(sessionId: string): Promise<number> {
    const list = this.bySession.get(sessionId) ?? [];
    return list.reduce((max, e) => Math.max(max, e.seq), 0);
  }
}

class MemoryRuns implements RunsCollection {
  private readonly rows = new Map<string, Run>();

  async insert(run: Run): Promise<void> {
    this.rows.set(run.id, clone(run));
  }

  async insertIfNoActive(run: Run): Promise<{ run: Run; inserted: boolean }> {
    // No await between the check and the set: that is what makes this atomic here.
    const active = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
    for (const row of this.rows.values()) {
      if (row.sessionId === run.sessionId && active.has(row.state)) return { run: clone(row), inserted: false };
    }
    this.rows.set(run.id, clone(run));
    return { run: clone(run), inserted: true };
  }

  async findById(id: string): Promise<Run | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async findActiveForSession(sessionId: string): Promise<Run | null> {
    const active = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId && active.has(row.state)) return clone(row);
    }
    return null;
  }

  async findLatestForSession(sessionId: string): Promise<Run | null> {
    let latest: Run | undefined;
    for (const row of this.rows.values()) {
      if (row.sessionId !== sessionId) continue;
      if (!latest || row.updatedAt > latest.updatedAt) latest = row;
    }
    return latest ? clone(latest) : null;
  }

  async update(id: string, patch: Partial<Run>): Promise<Run | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return clone(next);
  }

  async listStale(cutoffIso: string): Promise<Run[]> {
    const active = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
    return [...this.rows.values()]
      .filter((r) => active.has(r.state) && (r.lastSeenAt ?? r.createdAt) < cutoffIso)
      .map(clone);
  }

  async listStopping(cutoffIso: string): Promise<Run[]> {
    return [...this.rows.values()].filter((r) => r.state === "stopping" && r.updatedAt < cutoffIso).map(clone);
  }

  async enqueueDownMessage(id: string, message: DownMessage): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.pending.push(clone(message));
  }

  async drainDownMessages(id: string): Promise<DownMessage[]> {
    const row = this.rows.get(id);
    if (!row) return [];
    const drained = row.pending;
    row.pending = [];
    return drained.map(clone);
  }
}

class MemoryGurus implements GurusCollection {
  private readonly rows = new Map<string, Guru>();

  async insert(guru: Guru): Promise<void> {
    this.rows.set(guru.id, clone(guru));
  }

  async findById(id: string): Promise<Guru | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async list(): Promise<Guru[]> {
    return [...this.rows.values()].map(clone);
  }

  async update(id: string, patch: Partial<Guru>): Promise<Guru | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return clone(next);
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

class MemoryEnvironments implements EnvironmentsCollection {
  private readonly rows = new Map<string, Environment>();

  async insert(environment: Environment): Promise<void> {
    this.rows.set(environment.id, clone(environment));
  }

  async findById(id: string): Promise<Environment | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async list(): Promise<Environment[]> {
    return [...this.rows.values()].map(clone);
  }

  async update(id: string, patch: Partial<Environment>): Promise<Environment | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return clone(next);
  }
}

class MemoryUsers implements UsersCollection {
  private readonly rows = new Map<string, User>();

  async upsertSeen(email: string): Promise<User> {
    const now = new Date().toISOString();
    const existing = this.rows.get(email);
    const next: User = existing ? { ...existing, lastSeenAt: now } : { email, createdAt: now, lastSeenAt: now };
    this.rows.set(email, next);
    return clone(next);
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = this.rows.get(email);
    return row ? clone(row) : null;
  }
}

class MemoryProviders implements ProvidersCollection {
  private readonly rows = new Map<string, ProviderRecord>();

  async findById(id: string): Promise<ProviderRecord | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async list(): Promise<ProviderRecord[]> {
    return [...this.rows.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id));
  }

  async upsert(record: ProviderRecord): Promise<void> {
    this.rows.set(record.id, clone(record));
  }
}

class MemoryTokens implements TokensCollection {
  private readonly rows = new Map<string, ApiToken>();

  async insert(token: ApiToken): Promise<void> {
    this.rows.set(token.id, clone(token));
  }

  async findById(id: string): Promise<ApiToken | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async findByHash(hash: string): Promise<ApiToken | null> {
    for (const row of this.rows.values()) {
      if (row.hash === hash) return clone(row);
    }
    return null;
  }

  async listActiveForOwner(ownerEmail: string): Promise<ApiToken[]> {
    return [...this.rows.values()]
      .filter((t) => t.ownerEmail === ownerEmail && isTokenActive(t))
      .map(clone)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async countActiveForOwner(ownerEmail: string): Promise<number> {
    return (await this.listActiveForOwner(ownerEmail)).length;
  }

  async update(id: string, patch: Partial<ApiToken>): Promise<ApiToken | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return clone(next);
  }

  async revokeAllForOwners(match: TokenOwnerMatch, revokedAt: string): Promise<ApiToken[]> {
    const revoked: ApiToken[] = [];
    for (const row of this.rows.values()) {
      if (!isTokenActive(row) || !ownerMatches(row.ownerEmail, match)) continue;
      row.revokedAt = revokedAt;
      revoked.push(clone(row));
    }
    return revoked;
  }
}

class MemoryMail implements MailCollection {
  private readonly rows = new Map<string, Mail>();

  async insertIfNew(mail: Mail): Promise<boolean> {
    if (this.rows.has(mail.id)) return false;
    this.rows.set(mail.id, clone(mail));
    return true;
  }

  async claimNext(
    sessionId: string,
    runId: string,
    nowIso: string,
    leaseUntilIso: string,
    maxAttempts: number,
  ): Promise<Mail | null> {
    const next = [...this.rows.values()]
      .filter((m) => m.sessionId === sessionId && isDeliverable(m, nowIso, maxAttempts))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    Object.assign(next, {
      status: "delivered",
      deliveredRunId: runId,
      deliveredAt: nowIso,
      lockedUntil: leaseUntilIso,
      attempts: next.attempts + 1,
    });
    return clone(next);
  }

  async ack(id: string, runId: string, nowIso: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.status !== "delivered" || row.deliveredRunId !== runId) return;
    row.status = "acked";
    row.ackedAt = nowIso;
  }

  async chargeWake(sessionId: string, nowIso: string, maxAttempts: number): Promise<void> {
    for (const m of this.rows.values()) {
      if (m.sessionId === sessionId && isDeliverable(m, nowIso, maxAttempts)) m.attempts += 1;
    }
  }

  async releaseRun(runId: string): Promise<void> {
    for (const m of this.rows.values()) {
      if (m.status === "delivered" && m.deliveredRunId === runId) {
        m.status = "queued";
        delete m.lockedUntil;
      }
    }
  }

  async noteWake(sessionId: string, nowIso: string, maxAttempts: number): Promise<void> {
    for (const m of this.rows.values()) {
      if (m.sessionId === sessionId && isDeliverable(m, nowIso, maxAttempts)) m.unvalidatedWakes = (m.unvalidatedWakes ?? 0) + 1;
    }
  }

  async markValidated(sessionId: string): Promise<void> {
    for (const m of this.rows.values()) {
      if (m.sessionId === sessionId && m.status !== "held") delete m.unvalidatedWakes;
    }
  }

  async holdIfStuck(sessionId: string, nowIso: string, maxAttempts: number, maxUnvalidatedWakes: number): Promise<number> {
    const mine = [...this.rows.values()].filter((m) => m.sessionId === sessionId);
    const deliverable = mine.filter((m) => isDeliverable(m, nowIso, maxAttempts));
    const stuck = mine.some((m) => m.status === "held") || deliverable.some((m) => (m.unvalidatedWakes ?? 0) >= maxUnvalidatedWakes);
    if (stuck) {
      for (const m of deliverable) {
        m.status = "held";
        m.heldAt = nowIso;
        delete m.lockedUntil;
      }
    }
    return mine.filter((m) => m.status === "held").length;
  }

  async releaseHeld(sessionId?: string): Promise<string[]> {
    const released = new Set<string>();
    for (const m of this.rows.values()) {
      if (m.status !== "held" || (sessionId && m.sessionId !== sessionId)) continue;
      m.status = "queued";
      delete m.heldAt;
      delete m.unvalidatedWakes;
      released.add(m.sessionId);
    }
    return [...released];
  }

  async countHeld(sessionId: string): Promise<number> {
    let n = 0;
    for (const m of this.rows.values()) if (m.sessionId === sessionId && m.status === "held") n++;
    return n;
  }

  async expireExhausted(nowIso: string, maxAttempts: number): Promise<Mail[]> {
    const dead: Mail[] = [];
    for (const m of this.rows.values()) {
      const idle = m.status === "queued" || (m.status === "delivered" && (m.lockedUntil ?? "") < nowIso);
      if (idle && m.attempts >= maxAttempts) {
        m.status = "dead";
        m.deadAt = nowIso;
        dead.push(clone(m));
      }
    }
    return dead;
  }

  async countSentSince(fromSessionId: string, sinceIso: string): Promise<number> {
    let n = 0;
    for (const m of this.rows.values()) if (m.from.sessionId === fromSessionId && m.createdAt >= sinceIso) n++;
    return n;
  }

  async hasDeliverable(sessionId: string, nowIso: string, maxAttempts: number): Promise<boolean> {
    for (const m of this.rows.values()) if (m.sessionId === sessionId && isDeliverable(m, nowIso, maxAttempts)) return true;
    return false;
  }

  async sessionsWithDeliverable(nowIso: string, maxAttempts: number): Promise<string[]> {
    const ids = new Set<string>();
    for (const m of this.rows.values()) if (isDeliverable(m, nowIso, maxAttempts)) ids.add(m.sessionId);
    return [...ids];
  }

  async findById(id: string): Promise<Mail | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }
}

function isDeliverable(m: Mail, nowIso: string, maxAttempts: number): boolean {
  if (m.attempts >= maxAttempts) return false;
  return m.status === "queued" || (m.status === "delivered" && (m.lockedUntil ?? "") < nowIso);
}

/** Chains critical sections. The function passed to `run` must not await: `deleteIfOwner` and
 * `insertPendingIfShared` share this so a revoke and a pending insert cannot interleave. */
class ShareSection {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface BrowserTables {
  shares: Map<string, BrowserShare>;
  requests: Map<string, BrowserRequest>;
  captures: Map<string, BrowserCapture>;
  shareSection: ShareSection;
}

function copyCapture(capture: BrowserCapture): BrowserCapture {
  // structuredClone turns a Buffer into a Uint8Array; keep a real Buffer so the jpeg route
  // can send the stored bytes without a type surprise.
  return { ...capture, bytes: Buffer.from(capture.bytes) };
}

class MemoryBrowserShares implements BrowserSharesCollection {
  private readonly tables: BrowserTables;

  constructor(tables: BrowserTables) {
    this.tables = tables;
  }

  async findBySession(sessionId: string): Promise<BrowserShare | null> {
    const row = this.tables.shares.get(sessionId);
    return row ? clone(row) : null;
  }

  async put(share: BrowserShare): Promise<{ conflict: false; share: BrowserShare } | { conflict: true; share: BrowserShare }> {
    const existing = this.tables.shares.get(share.sessionId);
    if (existing && existing.ownerEmail !== share.ownerEmail) return { conflict: true, share: clone(existing) };
    const next = clone(share);
    this.tables.shares.set(share.sessionId, next);
    return { conflict: false, share: clone(next) };
  }

  async deleteIfOwner(
    sessionId: string,
    ownerEmail: string,
    nowIso: string,
  ): Promise<{ outcome: "deleted" | "missing" | "forbidden"; skippedIds: string[] }> {
    // Same section as insertPendingIfShared. No await inside: a revoke that has finished
    // is visible to the next insert, and an insert that has finished is skipped here.
    return this.tables.shareSection.run(() => {
      const existing = this.tables.shares.get(sessionId);
      if (!existing) return { outcome: "missing" as const, skippedIds: [] };
      if (existing.ownerEmail !== ownerEmail) return { outcome: "forbidden" as const, skippedIds: [] };
      this.tables.shares.delete(sessionId);
      const skippedIds: string[] = [];
      for (const row of this.tables.requests.values()) {
        if (row.sessionId === sessionId && row.status === "pending") {
          row.status = "skipped";
          row.updatedAt = nowIso;
          skippedIds.push(row.id);
        }
      }
      return { outcome: "deleted" as const, skippedIds };
    });
  }
}

class MemoryBrowserRequests implements BrowserRequestsCollection {
  private readonly tables: BrowserTables;

  constructor(tables: BrowserTables) {
    this.tables = tables;
  }

  async insert(request: BrowserRequest): Promise<void> {
    this.tables.requests.set(request.id, clone(request));
  }

  async insertPendingIfShared(sessionId: string, request: BrowserRequest): Promise<BrowserRequest | "no_share"> {
    return this.tables.shareSection.run(() => {
      // Same id is the same row, including after the share is gone. A repeat must not reset a
      // skipped or done request back to pending, and must not insert a second row.
      const existing = this.tables.requests.get(request.id);
      if (existing) return existing.sessionId === sessionId ? clone(existing) : "no_share";
      if (!this.tables.shares.get(sessionId)) return "no_share";
      const row = clone(request);
      this.tables.requests.set(request.id, row);
      return clone(row);
    });
  }

  async findById(sessionId: string, id: string): Promise<BrowserRequest | null> {
    const row = this.tables.requests.get(id);
    if (!row || row.sessionId !== sessionId) return null;
    return clone(row);
  }

  async listPending(sessionId: string): Promise<BrowserRequest[]> {
    return [...this.tables.requests.values()]
      .filter((row) => row.sessionId === sessionId && row.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async markSkipped(sessionId: string, id: string, nowIso: string): Promise<BrowserRequest | null> {
    const row = this.tables.requests.get(id);
    if (!row || row.sessionId !== sessionId) return null;
    if (row.status === "pending") {
      row.status = "skipped";
      row.updatedAt = nowIso;
    } else if (row.status === "skipped") {
      row.updatedAt = nowIso;
    }
    return clone(row);
  }

  async markFailed(
    sessionId: string,
    id: string,
    error: BrowserCaptureFailure,
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null> {
    const row = this.tables.requests.get(id);
    if (!row || row.sessionId !== sessionId) return null;
    if (row.status !== "pending") return { request: clone(row), transitioned: false };
    row.status = "failed";
    row.error = error;
    row.updatedAt = nowIso;
    return { request: clone(row), transitioned: true };
  }
}

class MemoryBrowserCaptures implements BrowserCapturesCollection {
  private readonly tables: BrowserTables;

  constructor(tables: BrowserTables) {
    this.tables = tables;
  }

  async save(capture: BrowserCapture, nowIso: string): Promise<BrowserCaptureSave> {
    const request = this.tables.requests.get(capture.requestId);
    if (!request || request.sessionId !== capture.sessionId) return { ok: false, reason: "missing" };
    const existing = this.findStored(capture.sessionId, capture.requestId);
    if (existing) {
      if (request.status === "skipped") {
        this.tables.captures.delete(existing.id);
        return { ok: false, reason: "not_pending" };
      }
      if (request.status === "pending") {
        request.status = "done";
        request.captureId = existing.id;
        request.updatedAt = nowIso;
      }
      return { ok: true, capture: copyCapture(existing), inserted: false };
    }
    if (request.status !== "pending") return { ok: false, reason: "not_pending" };
    this.tables.captures.set(capture.id, copyCapture(capture));
    this.trim(capture.sessionId);
    request.status = "done";
    request.captureId = capture.id;
    request.updatedAt = nowIso;
    const stored = this.tables.captures.get(capture.id);
    // Trim keeps the newest BROWSER_CAPTURES_PER_SESSION, and this insert is the newest, so the
    // row is still there. If it is not, the cap was zero and the write was dropped.
    if (!stored) return { ok: false, reason: "not_pending" };
    return { ok: true, capture: copyCapture(stored), inserted: true };
  }

  async findById(sessionId: string, id: string): Promise<BrowserCapture | null> {
    const row = this.tables.captures.get(id);
    if (!row || row.sessionId !== sessionId) return null;
    return copyCapture(row);
  }

  async findByRequestId(sessionId: string, requestId: string): Promise<BrowserCapture | null> {
    const row = this.findStored(sessionId, requestId);
    return row ? copyCapture(row) : null;
  }

  private findStored(sessionId: string, requestId: string): BrowserCapture | undefined {
    for (const row of this.tables.captures.values()) {
      if (row.sessionId === sessionId && row.requestId === requestId) return row;
    }
    return undefined;
  }

  private trim(sessionId: string): void {
    const mine = [...this.tables.captures.values()]
      .filter((row) => row.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    for (const old of mine.slice(BROWSER_CAPTURES_PER_SESSION)) this.tables.captures.delete(old.id);
  }
}

export class MemoryStore implements Store {
  readonly sessions = new MemorySessions();
  readonly entries = new MemoryEntries();
  readonly runs = new MemoryRuns();
  readonly gurus = new MemoryGurus();
  readonly environments = new MemoryEnvironments();
  readonly users = new MemoryUsers();
  readonly providers = new MemoryProviders();
  readonly tokens = new MemoryTokens();
  readonly mail = new MemoryMail();
  readonly browserShares: BrowserSharesCollection;
  readonly browserRequests: BrowserRequestsCollection;
  readonly browserCaptures: BrowserCapturesCollection;

  constructor() {
    const tables: BrowserTables = {
      shares: new Map(),
      requests: new Map(),
      captures: new Map(),
      shareSection: new ShareSection(),
    };
    this.browserShares = new MemoryBrowserShares(tables);
    this.browserRequests = new MemoryBrowserRequests(tables);
    this.browserCaptures = new MemoryBrowserCaptures(tables);
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
