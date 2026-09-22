// Map-based Store used for MONGODB_URI=memory (dev and tests). Same interface as MongoStore so
// routes, runs.ts and agentlink.ts are exercised identically either way.

import { ownerMatches } from "../tokens.ts";
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
} from "./types.ts";

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

  async listForSession(sessionId: string, afterEntryId?: string): Promise<Entry[]> {
    const list = (this.bySession.get(sessionId) ?? []).slice().sort((a, b) => a.seq - b.seq);
    if (!afterEntryId) return list.map(clone);
    const idx = list.findIndex((e) => e.entry.id === afterEntryId);
    return (idx === -1 ? list : list.slice(idx + 1)).map(clone);
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
      .filter((t) => t.ownerEmail === ownerEmail && !t.revokedAt)
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
      if (row.revokedAt || !ownerMatches(row.ownerEmail, match)) continue;
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

  async close(): Promise<void> {
    // nothing to release
  }
}
