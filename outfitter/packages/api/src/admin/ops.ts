// The admin op registry (Sysop tools, #286): every administration action an agent can take, as a
// named op with a class and a handler that returns compact text (render.ts). Both ways in share
// it -- POST /api/admin/ops for a Dongle on a laptop (routes/admin.ts), and a Drive's admin socket
// through agentd (#287) -- so an op is checked the same way whichever path called it.
//
// Classes: `read` runs directly. `write` runs directly and is audited. `delete` and `operator`
// need `approved` on the caller: the laptop's TUI confirm (a Dongle's holder is the person at the
// keyboard), or the Drive's web approval card (#287). A write to a tape that already has admin
// tools also needs it (gurus-service.ts).

import { randomUUID } from "node:crypto";
import {
  ADMIN_TOOLS_LEVELS,
  THINKING_LEVELS,
  createGuru,
  deleteGuru,
  envDenylist,
  hasAdminTools,
  updateGuru,
  type GuruInput,
} from "../gurus-service.ts";
import type { ModelsService } from "../models.ts";
import type { Environment, Guru, Session, Store } from "../store/types.ts";
import { ago, capText, clip, diffFields, fields, resolveRef, row, shortId } from "./render.ts";
import { searchSessions, sessionTranscript } from "../search/service.ts";

export type AdminOpClass = "read" | "write" | "delete" | "operator";

export interface AdminCaller {
  email: string;
  /** "token": a Dongle (laptop). "drive": a Drive's broker call, acting as the session's owner. */
  via: "token" | "drive";
  /** Effective sysop rights for this call: never for a Dongle; for a Drive, only when the owner is
   * an operator and the session's tape has `adminTools: "operator"`. */
  operator: boolean;
  sessionId?: string;
  runId?: string;
  /** The person approved this call (see the module doc). */
  approved?: boolean;
  approvalId?: string;
}

export interface AdminContext {
  store: Store;
  models: Pick<ModelsService, "list">;
  now?: () => number;
  /** Where a handler's thrown error goes; the caller only sees "internal error". */
  log?: (message: string) => void;
}

export type AdminResult =
  | { ok: true; text: string }
  | { ok: false; error: string; needsApproval?: boolean };

type Args = Record<string, unknown>;

interface AdminOp {
  kind: AdminOpClass;
  /** Whether this call needs approval beyond what `kind` says (a write to an admin tape). */
  guarded?: (ctx: AdminContext, args: Args) => Promise<boolean>;
  run: (ctx: AdminContext, caller: AdminCaller, args: Args) => Promise<AdminResult & { target?: string }>;
}

const TAPE_FIELDS = [
  "name",
  "model",
  "fallbackModel",
  "thinking",
  "systemPrompt",
  "appendSystemPrompt",
  "tools",
  "excludeTools",
  "env",
  "mergeFromCloud",
  "branchPrefix",
  "playwrightBeforeCheckpoint",
  "allowExternalHtmlResources",
  "browserIde",
] as const;

const ENVIRONMENT_FIELDS = ["name", "repo", "baseBranch", "env"] as const;

function pick(args: Args, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

function nowOf(ctx: AdminContext): number {
  return ctx.now?.() ?? Date.now();
}

function tapeLine(g: Guru, now: number): string {
  return row(
    shortId(g.id),
    g.name !== g.id ? clip(g.name, 40) : undefined,
    g.model,
    g.thinking && g.thinking !== "off" ? `thinking=${g.thinking}` : undefined,
    hasAdminTools(g) ? `admin=${g.adminTools}` : undefined,
    ago(g.updatedAt, now),
  );
}

function tapeDetail(g: Guru): string {
  return fields([
    ["id", g.id],
    ["name", g.name],
    ["model", g.model],
    ["fallbackModel", g.fallbackModel],
    ["thinking", g.thinking],
    ["adminTools", hasAdminTools(g) ? g.adminTools : undefined],
    ["tools", g.tools],
    ["excludeTools", g.excludeTools],
    ["env", envKeys(g.env)],
    ["mergeFromCloud", g.mergeFromCloud],
    ["branchPrefix", g.branchPrefix],
    ["playwrightBeforeCheckpoint", g.playwrightBeforeCheckpoint],
    ["allowExternalHtmlResources", g.allowExternalHtmlResources],
    ["browserIde", g.browserIde],
    ["systemPrompt", g.systemPrompt],
    ["appendSystemPrompt", g.appendSystemPrompt],
  ]);
}

function environmentLine(e: Environment, now: number): string {
  return row(
    shortId(e.id),
    e.name !== e.id ? clip(e.name, 40) : undefined,
    e.repo,
    e.baseBranch ? `base=${e.baseBranch}` : undefined,
    ago(e.updatedAt, now),
  );
}

function sessionLine(s: Session, now: number): string {
  return row(
    shortId(s.id),
    clip(s.name ?? s.prompt, 50) || undefined,
    `tape=${shortId(s.guruId)}`,
    s.repo ?? undefined,
    s.archivedAt ? "archived" : s.status,
    ago(s.updatedAt, now),
  );
}

/** Env names only: values often hold keys, and a transcript is no place for them (the web UI shows
 * them to people). */
function envKeys(env: Record<string, string> | undefined): string | undefined {
  const keys = env ? Object.keys(env) : [];
  return keys.length ? `${keys.join(", ")} (values hidden)` : undefined;
}

/** An env change as names: `+NEW, -OLD, ~CHANGED`. Never the values. */
function envDiff(before: Record<string, string> | undefined, after: Record<string, string> | undefined): string | undefined {
  const a = before ?? {};
  const b = after ?? {};
  const out: string[] = [];
  for (const k of Object.keys(b)) out.push(!(k in a) ? `+${k}` : a[k] !== b[k] ? `~${k}` : "");
  for (const k of Object.keys(a)) if (!(k in b)) out.push(`-${k}`);
  const changes = out.filter(Boolean);
  return changes.length ? `env: ${changes.join(", ")}` : undefined;
}

/** A diff of the given fields, with env shown as names only. */
function diffWithEnv(before: { env?: Record<string, string> }, after: { env?: Record<string, string> }, keys: readonly string[]): string {
  const env = envDiff(before.env, after.env);
  const rest = diffFields(before as Record<string, unknown>, after as Record<string, unknown>, keys.filter((k) => k !== "env"));
  if (!env) return rest;
  return rest === "no changes" ? env : `${rest}\n${env}`;
}

/** The service speaks of gurus (its REST routes' word); agents see tapes. */
function asTape(error: string): string {
  return error.replace(/\bguru\.env\b/g, "tape env").replace(/\bguru\b/g, "tape");
}

/** A session by id or a unique prefix of 8+ characters. The error names no other sessions: their
 * ids don't help a retry. */
async function findSession(ctx: AdminContext, ref: unknown): Promise<{ ok: true; item: Session } | { ok: false; error: string }> {
  const id = typeof ref === "string" ? ref.trim() : "";
  if (id.length < 8) return { ok: false, error: "session id needs at least 8 characters" };
  const direct = await ctx.store.sessions.findById(id);
  if (direct) return { ok: true, item: direct };
  const found = resolveRef(await ctx.store.sessions.list({ archived: "all" }), id, "session");
  return found.ok ? found : { ok: false, error: found.error.split(";")[0] };
}

async function resolveTape(ctx: AdminContext, ref: unknown) {
  return resolveRef(await ctx.store.gurus.list(), ref, "tape");
}

/** Warns, without failing, when a model isn't one the router lists (it may still be a laptop model). */
async function modelNote(ctx: AdminContext, models: Array<string | undefined>): Promise<string> {
  const wanted = models.filter((m): m is string => typeof m === "string" && m.length > 0);
  if (!wanted.length) return "";
  let known: Set<string>;
  try {
    known = new Set((await ctx.models.list()).map((m) => m.id));
  } catch {
    return "";
  }
  // An empty list means the router isn't configured here (dev, tests); nothing to compare with.
  if (known.size === 0) return "";
  const unknown = wanted.filter((m) => !known.has(m));
  return unknown.length ? `\nnote: not in the router's model list: ${unknown.join(", ")}` : "";
}

function environmentError(body: Partial<Environment>): string | undefined {
  for (const key of ["name", "repo", "baseBranch"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") return `${key} must be a string`;
  }
  if (body.repo !== undefined && body.repo !== "" && !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) return "repo must look like owner/name";
  const env = body.env as unknown;
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string"))) {
    return "env must map names to string values";
  }
  return undefined;
}

function limitOf(args: Args, fallback: number, max: number): number {
  const n = typeof args.limit === "number" ? Math.floor(args.limit) : fallback;
  return Math.min(Math.max(n, 1), max);
}

async function tapeGuarded(ctx: AdminContext, args: Args): Promise<boolean> {
  const tape = await resolveTape(ctx, args.id);
  return tape.ok && hasAdminTools(tape.item);
}

export const ADMIN_OPS: Record<string, AdminOp> = {
  "tapes.list": {
    kind: "read",
    async run(ctx, _caller, args) {
      const now = nowOf(ctx);
      const tapes = (await ctx.store.gurus.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const hits = q ? tapes.filter((g) => `${g.id} ${g.name} ${g.model}`.toLowerCase().includes(q)) : tapes;
      const limit = limitOf(args, 20, 100);
      const lines = hits.slice(0, limit).map((g) => tapeLine(g, now));
      if (hits.length > limit) lines.push(`… ${hits.length - limit} more; pass limit or query`);
      return { ok: true, text: lines.join("\n") || "no tapes" };
    },
  },

  "tapes.get": {
    kind: "read",
    async run(ctx, _caller, args) {
      const tape = await resolveTape(ctx, args.id);
      if (!tape.ok) return tape;
      return { ok: true, text: capText(tapeDetail(tape.item)), target: tape.item.id };
    },
  },

  "tapes.meta": {
    kind: "read",
    async run(ctx, caller, args) {
      let models: string[] = [];
      try {
        models = (await ctx.models.list()).map((m) => m.id);
      } catch {
        // The router being down shouldn't hide the rest of meta.
      }
      const q = typeof args.models === "string" ? args.models.toLowerCase() : "";
      const shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
      const limit = 40;
      const modelText = shown.length
        ? `${shown.slice(0, limit).join(", ")}${shown.length > limit ? `, … ${shown.length - limit} more (filter with models)` : ""}`
        : models.length
          ? "none match"
          : "unavailable";
      return {
        ok: true,
        text: [
          `models: ${modelText}`,
          `thinking: ${THINKING_LEVELS.join("|")}`,
          `env denylist: ${envDenylist().join(", ")}`,
          `adminTools: ${ADMIN_TOOLS_LEVELS.join("|")} (web UI only)`,
          `you: ${caller.email}${caller.operator ? " (sysop)" : ""}`,
        ].join("\n"),
      };
    },
  },

  "tapes.create": {
    kind: "write",
    async run(ctx, _caller, args) {
      const body = { ...pick(args, TAPE_FIELDS), ...(args.id !== undefined ? { id: args.id } : {}) } as GuruInput;
      if (args.adminTools !== undefined) (body as Partial<Guru>).adminTools = args.adminTools as Guru["adminTools"];
      const result = await createGuru(ctx.store, body, { kind: "agent" });
      if (!result.ok) return { ok: false, error: asTape(result.error), target: typeof body.id === "string" ? body.id : undefined };
      const note = await modelNote(ctx, [result.guru.model, result.guru.fallbackModel]);
      return { ok: true, text: `created ${shortId(result.guru.id)}${note}`, target: result.guru.id };
    },
  },

  "tapes.update": {
    kind: "write",
    guarded: tapeGuarded,
    async run(ctx, caller, args) {
      const tape = await resolveTape(ctx, args.id);
      if (!tape.ok) return tape;
      const patch = pick(args, TAPE_FIELDS) as Partial<GuruInput>;
      if (args.adminTools !== undefined) (patch as Partial<Guru>).adminTools = args.adminTools as Guru["adminTools"];
      if (Object.keys(patch).length === 0) return { ok: false, error: "nothing to update" };
      const result = await updateGuru(ctx.store, tape.item.id, patch, { kind: "agent", approved: caller.approved, operator: caller.operator });
      if (!result.ok) return { ok: false, error: asTape(result.error), target: tape.item.id };
      const diff = diffWithEnv(tape.item, result.guru, TAPE_FIELDS);
      const note = await modelNote(ctx, [patch.model, patch.fallbackModel]);
      return { ok: true, text: capText(`updated ${shortId(tape.item.id)}\n${diff}${note}`), target: tape.item.id };
    },
  },

  "tapes.delete": {
    kind: "delete",
    async run(ctx, caller, args) {
      const tape = await resolveTape(ctx, args.id);
      if (!tape.ok) return tape;
      const result = await deleteGuru(ctx.store, tape.item.id, { kind: "agent", approved: caller.approved, operator: caller.operator });
      if (!result.ok) return { ok: false, error: asTape(result.error), target: tape.item.id };
      return { ok: true, text: `deleted ${shortId(tape.item.id)}`, target: tape.item.id };
    },
  },

  "environments.list": {
    kind: "read",
    async run(ctx, _caller, args) {
      const now = nowOf(ctx);
      const envs = (await ctx.store.environments.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const limit = limitOf(args, 20, 100);
      const lines = envs.slice(0, limit).map((e) => environmentLine(e, now));
      if (envs.length > limit) lines.push(`… ${envs.length - limit} more; pass limit`);
      return { ok: true, text: lines.join("\n") || "no environments" };
    },
  },

  "environments.get": {
    kind: "read",
    async run(ctx, _caller, args) {
      const env = resolveRef(await ctx.store.environments.list(), args.id, "environment");
      if (!env.ok) return env;
      const e = env.item;
      return {
        ok: true,
        text: capText(fields([
          ["id", e.id],
          ["name", e.name],
          ["repo", e.repo],
          ["baseBranch", e.baseBranch],
          ["env", envKeys(e.env)],
        ])),
        target: e.id,
      };
    },
  },

  "environments.create": {
    kind: "write",
    async run(ctx, _caller, args) {
      const body = pick(args, ENVIRONMENT_FIELDS) as Partial<Environment>;
      if (typeof body.name !== "string" || !body.name) return { ok: false, error: "name is required" };
      const invalid = environmentError(body);
      if (invalid) return { ok: false, error: invalid };
      const now = new Date(nowOf(ctx)).toISOString();
      const environment: Environment = { ...(body as Environment), id: randomUUID(), createdAt: now, updatedAt: now };
      await ctx.store.environments.insert(environment);
      return { ok: true, text: `created ${shortId(environment.id)}`, target: environment.id };
    },
  },

  "environments.update": {
    kind: "write",
    async run(ctx, _caller, args) {
      const env = resolveRef(await ctx.store.environments.list(), args.id, "environment");
      if (!env.ok) return env;
      const patch = pick(args, ENVIRONMENT_FIELDS);
      if (Object.keys(patch).length === 0) return { ok: false, error: "nothing to update" };
      const invalid = environmentError(patch as Partial<Environment>);
      if (invalid) return { ok: false, error: invalid, target: env.item.id };
      const updated = await ctx.store.environments.update(env.item.id, { ...patch, updatedAt: new Date(nowOf(ctx)).toISOString() });
      if (!updated) return { ok: false, error: "environment not found" };
      const diff = diffWithEnv(env.item, updated, ENVIRONMENT_FIELDS);
      return { ok: true, text: capText(`updated ${shortId(env.item.id)}\n${diff}`), target: env.item.id };
    },
  },

  "sessions.list": {
    kind: "read",
    async run(ctx, caller, args) {
      const now = nowOf(ctx);
      let guruId: string | undefined;
      if (args.tape !== undefined) {
        const tape = await resolveTape(ctx, args.tape);
        if (!tape.ok) return tape;
        guruId = tape.item.id;
      }
      const archived = args.archived === true ? "only" : "exclude";
      const status = typeof args.status === "string" ? args.status : undefined;
      let sessions = await ctx.store.sessions.list({ guruId, status, archived });
      if (args.owner === "me") sessions = sessions.filter((s) => s.ownerEmail?.toLowerCase() === caller.email.toLowerCase());
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const limit = limitOf(args, 20, 100);
      const lines = sessions.slice(0, limit).map((s) => sessionLine(s, now));
      if (sessions.length > limit) lines.push(`… ${sessions.length - limit} more; pass limit or filters`);
      return { ok: true, text: lines.join("\n") || "no sessions" };
    },
  },

  "sessions.search": {
    kind: "read",
    async run(ctx, caller, args) {
      return searchSessions(ctx.store, caller.email, args, nowOf(ctx));
    },
  },

  "sessions.transcript": {
    kind: "read",
    async run(ctx, _caller, args) {
      const found = await findSession(ctx, args.id);
      if (!found.ok) return found;
      return sessionTranscript(ctx.store, found.item, args, nowOf(ctx));
    },
  },

  "sessions.get": {
    kind: "read",
    async run(ctx, _caller, args) {
      const found = await findSession(ctx, args.id);
      if (!found.ok) return found;
      const s = found.item;
      const run = (await ctx.store.runs.findActiveForSession(s.id)) ?? (await ctx.store.runs.findLatestForSession(s.id));
      return {
        ok: true,
        text: fields([
          ["id", s.id],
          ["name", clip(s.name, 80)],
          ["tape", s.guruId],
          ["owner", s.ownerEmail],
          ["repo", s.repo ?? undefined],
          ["branch", s.branch],
          ["status", s.archivedAt ? `${s.status}, archived` : s.status],
          ["run", run ? row(shortId(run.id), run.state) : undefined],
          ["cost", s.cost ? `$${s.cost.toFixed(2)}` : undefined],
          ["created", s.createdAt.slice(0, 16).replace("T", " ")],
          ["updated", ago(s.updatedAt, nowOf(ctx))],
          ["prompt", clip(s.prompt, 300)],
        ]),
        target: s.id,
      };
    },
  },
};

/** Field names an approval card may show: the ones an op actually reads. Anything else in args is
 * ignored by the op, so naming it would only let the caller write its own words onto the card. */
export const CARD_FIELDS: readonly string[] = [...new Set<string>([...TAPE_FIELDS, ...ENVIRONMENT_FIELDS, "adminTools"])];

/**
 * The record an op would act on, resolved now: its full id and a label for the approval card. A
 * Drive passes the full id back into the op after the owner approves, so a prefix can't come to
 * mean another record during the wait. Undefined for ops without a target.
 */
export async function resolveTarget(ctx: AdminContext, op: unknown, args: unknown): Promise<{ id: string; label: string } | { error: string } | undefined> {
  const a: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
  if (op === "tapes.update" || op === "tapes.delete") {
    const tape = await resolveTape(ctx, a.id);
    if (!tape.ok) return { error: tape.error };
    return { id: tape.item.id, label: `tape "${clip(tape.item.name, 60)}" (${tape.item.id})` };
  }
  if (op === "environments.update") {
    const env = resolveRef(await ctx.store.environments.list(), a.id, "environment");
    if (!env.ok) return { error: env.error };
    return { id: env.item.id, label: `environment "${clip(env.item.name, 60)}" (${env.item.id})` };
  }
  return undefined;
}

/** Whether this call would need the person's approval, without running or auditing it: a Drive asks
 * the owner first (drive.ts), then runs the op once with `approved`. Unknown ops say no; running
 * them reports the error. */
export async function approvalNeeded(ctx: AdminContext, caller: AdminCaller, op: unknown, args: unknown): Promise<boolean> {
  if (typeof op !== "string" || !Object.hasOwn(ADMIN_OPS, op)) return false;
  const def = ADMIN_OPS[op];
  if (def.kind === "operator" && !caller.operator) return false;
  if (def.kind === "delete" || def.kind === "operator") return true;
  const a: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
  try {
    return def.guarded ? await def.guarded(ctx, a) : false;
  } catch {
    return false;
  }
}

/** One line per op, for an unknown-op error: short enough to retry from. */
function knownOps(): string {
  return Object.keys(ADMIN_OPS).join(", ");
}

/**
 * Runs one op for one caller: checks the class against the caller's rights and approval, runs it,
 * and writes the audit row for anything that is not a read. Never throws for a bad call; a thrown
 * handler error becomes a one-line `ok: false` (logged by the caller, not returned verbatim).
 */
export async function runAdminOp(ctx: AdminContext, caller: AdminCaller, op: unknown, args: unknown): Promise<AdminResult> {
  if (typeof op !== "string" || !Object.hasOwn(ADMIN_OPS, op)) {
    return { ok: false, error: `unknown op; ops: ${knownOps()}` };
  }
  const def = ADMIN_OPS[op];
  const a: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};

  let result: AdminResult & { target?: string };
  try {
    if (def.kind === "operator" && !caller.operator) result = { ok: false, error: "sysop rights required" };
    else {
      const needsApproval = def.kind === "delete" || def.kind === "operator" || (def.guarded ? await def.guarded(ctx, a) : false);
      result = needsApproval && !caller.approved ? { ok: false, error: "needs approval", needsApproval: true } : await def.run(ctx, caller, a);
    }
  } catch (err) {
    ctx.log?.(`admin op ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    result = { ok: false, error: "internal error" };
  }
  if (def.kind !== "read") {
    try {
      await ctx.store.adminAudit.insert({
        id: auditId(nowOf(ctx)),
        at: new Date(nowOf(ctx)).toISOString(),
        actor: caller.email,
        via: caller.via,
        sessionId: caller.sessionId,
        runId: caller.runId,
        op,
        target: result.target ?? (typeof a.id === "string" ? a.id : undefined),
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        approved: caller.approved === true,
        approvalId: caller.approvalId,
      });
    } catch (err) {
      // The audit row is best effort; the op already ran.
      ctx.log?.(`admin audit insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { target: _target, ...out } = result;
  return out;
}

let auditSeq = 0;

/** Sorts by time, then by order within this process, so newest-first is an `_id` sort. */
function auditId(now: number): string {
  auditSeq = (auditSeq + 1) % 1_679_616;
  return `${now.toString(36).padStart(9, "0")}-${auditSeq.toString(36).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
}
