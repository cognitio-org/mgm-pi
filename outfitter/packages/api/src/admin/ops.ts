// The admin op registry (Sysop tools, #286): every administration action an agent can take, as a
// named op with a class and a handler that returns compact text (render.ts). Both ways in share
// it -- POST /api/admin/ops for a Dongle on a laptop (routes/admin.ts), and a Drive's admin socket
// through agentd (#287) -- so an op is checked the same way whichever path called it.
//
// Classes: `read` runs directly. `write` runs directly and is audited. `delete` and `operator`
// need `approved` on the caller: the laptop's TUI confirm (a Dongle's holder is the person at the
// keyboard), or the Drive's web approval card (#287). A write to a tape that already has admin
// tools also needs it (gurus-service.ts). `approve` (E9 §4: answering an Agent Engine execution's
// review pause) is audited and always needs `approved`, whoever the caller is. A change to a tape
// with memory or Agent Engine needs it too (an op's `asks`). E9.9: for an op registered with
// `laptop: "web"` a Dongle's `confirmed` counts for nothing; its yes comes from the web app's
// approval widget (laptop-approvals.ts, runAdminOp's laptopGate).
//
// Capabilities (E9 §3.3): every op names the tape capability it needs -- `admin` (the Sysop tools),
// `memory` or `agentEngine` -- and a Drive's call is refused unless its tape has it, so agentd
// opening the socket for memory doesn't hand the model `tapes.*`. From a laptop (a Dongle) `admin`
// ops work, and so do the ops registered with a `laptop` access (E9.9 `memory.*`, for the token's
// owner, bound to the `laptop:<pi session id>` the route validated; E9.10 `ae.*`, for a laptop
// playing a tape with Agent Engine); everything else says "Drive only". Later PRs add their ops
// with registerAdminOp.

import { randomUUID } from "node:crypto";
import {
  ADMIN_TOOLS_LEVELS,
  MEMORY_LEVELS,
  THINKING_LEVELS,
  createGuru,
  deleteGuru,
  envDenylist,
  hasAdminTools,
  tapeCapabilities,
  updateGuru,
  type GuruInput,
  type TapeCapability,
} from "../gurus-service.ts";
import type { ModelsService } from "../models.ts";
import type { AgentEngine } from "../agentengine/index.ts";
import type { AeSessions } from "../ae-sessions.ts";
import type { Environment, Guru, Session, Store } from "../store/types.ts";
import { ago, capText, clip, diffFields, fields, resolveRef, row, shortId } from "./render.ts";
import { searchSessions, sessionTranscript } from "../search/service.ts";
import { consumeLaptopApproval, createLaptopApproval, laptopApprovalStatus, type LaptopApprovalState, type LaptopCard } from "./laptop-approvals.ts";
import type { LaptopContext } from "../agentengine/identity.ts";

export type { LaptopContext };

export type AdminOpClass = "read" | "write" | "delete" | "operator" | "approve";

/** The classes whose every call needs the person's yes, whatever the op's `asks` says. */
const ALWAYS_ASKS: ReadonlySet<AdminOpClass> = new Set(["delete", "operator", "approve"]);

/** E9.9: what a laptop op answers when its Kernal sent no `laptop` context (prefixed with the op). */
export const NO_LAPTOP_SESSION = "from a laptop needs a newer Kernal (no session id was sent)";

/** The tape capability an op needs (see the module doc). */
export type AdminCapability = TapeCapability;

export interface AdminCaller {
  email: string;
  /** "token": a Dongle (laptop). "drive": a Drive's broker call, acting as the session's owner. */
  via: "token" | "drive";
  /** Effective sysop rights for this call: never for a Dongle; for a Drive, only when the owner is
   * an operator and the session's tape has `adminTools: "operator"`. */
  operator: boolean;
  sessionId?: string;
  runId?: string;
  /** For a Drive: what its tape allows now (gurus-service.ts tapeCapabilities). For a Dongle
   * (E9.10): what the tape its `laptop.tape` names allows now, read by the route; only `ae.*` uses
   * it. */
  capabilities?: readonly AdminCapability[];
  /** The person approved this call (see the module doc). */
  approved?: boolean;
  approvalId?: string;
  /** A Dongle's `laptop` context (E9.9); never set for a Drive. */
  laptop?: LaptopContext;
  /** E9.9: the `approvalId` a Dongle's rerun names (POST body). Unchecked as sent: runAdminOp uses
   * it only through consumeLaptopApproval, and only for a `laptop: "web"` op. */
  laptopApprovalId?: unknown;
}

export interface AdminContext {
  store: Store;
  models: Pick<ModelsService, "list">;
  /** E9: the Agent Engine parts configured here; a part is undefined while it's off. A Drive's
   * calls carry it, and since E9.9 the laptop route's too (`memory.*` from a Dongle). */
  agentEngine?: AgentEngine;
  /** E9.10: the process's Agent Engine session stopper (server.ts), for a laptop's `ae.close`. */
  aeSessions?: AeSessions;
  now?: () => number;
  /** Where a handler's thrown error goes; the caller only sees "internal error". */
  log?: (message: string) => void;
}

export type AdminResult =
  | { ok: true; text: string; state?: LaptopApprovalState }
  | { ok: false; error: string; needsApproval?: boolean; approvalId?: string };

type Args = Record<string, unknown>;

/**
 * How a Dongle (a laptop) may call an op, as its owner; checked at registration (registerAdminOp):
 * - "memory" (E9.9): a memory read or write. The op binds the caller's `laptop` context itself.
 * - "tape" (E9.10, #354): while the tape its `laptop.tape` names has the op's capability
 *   (routes/admin.ts reads it on every call). Only reads, and `.close` writes that stop what the
 *   caller itself opened: anything that acts on someone's behalf is "web".
 * - "web" (E9.9): a call that needs the person's yes waits for it in the web app's approval widget
 *   (laptop-approvals.ts), never on `confirmed`, which the laptop's agent could send itself.
 *   `laptopCard` says what the widget shows.
 * - "web-always" (E9.10): "web", and every call from a Dongle waits for that yes, whatever `asks`
 *   says (laptop `ae.invoke`: an outside agent acting on the laptop's words). A Drive is unaffected.
 */
export type LaptopAccess = "memory" | "tape" | "web" | "web-always";

/** True for an op whose Dongle yes is the web widget's. */
const webApproved = (op: AdminOp): boolean => op.laptop === "web" || op.laptop === "web-always";

export interface AdminOp {
  kind: AdminOpClass;
  /** The tape capability a Drive needs to call this op. Anything but `admin` is Drive only, unless
   * `laptop` says otherwise. */
  capability: AdminCapability;
  /** A Dongle may call this op too (see LaptopAccess); absent: Drive only (unless `admin`). */
  laptop?: LaptopAccess;
  /** False: never written to adminAudit, although not a read (E9.9 `memory.record`, a laptop's own
   * turns into its own private memory, many a session; the usage log counts them instead). */
  audit?: false;
  /** The widget's card for a `laptop: "web"` op (required with it): one line of what is asked, the
   * api's facts, and the exact content (redacted as it would be acted on). `{error}` refuses the
   * call before anyone is asked (malformed args, text with hidden characters). E9.10: `target` is
   * the label of the op's resolved target (ae.resume: the pause), when it has one. */
  laptopCard?: (args: Args, target?: string) => LaptopCard | { error: string };
  /** The approval card for this op, when the default (drive.ts approvalText) says too little: an
   * `approve` op shows what it answers. Every word must come from the api or be clipped, escaped
   * and labelled as remote text. */
  card?: (args: Args, target?: string) => { title: string; message: string };
  /** For a class that runs directly (`read`, `write`): whether these args need the person's yes
   * anyway, e.g. a change to a tape with memory or Agent Engine (gurus-service.ts guardError). */
  asks?: (ctx: AdminContext, args: Args) => Promise<boolean>;
  /** A reason this call is refused outright, checked before any approval is asked for (an agent
   * may never change an admin tape, so asking the owner first would only waste their yes). */
  refused?: (ctx: AdminContext, args: Args, caller: AdminCaller) => Promise<string | undefined>;
  /** The record a call that waits for the person would act on, resolved before the card is raised
   * (resolveTarget): its full id and the label the card shows. An error refuses the call without
   * asking. For ops whose target isn't a tape or environment (E9 `ae.resume`: the execution, read
   * from Agent Engine as this caller). */
  target?: (ctx: AdminContext, args: Args, caller: AdminCaller) => Promise<{ id: string; label: string } | { error: string }>;
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
  "repos",
  "env",
  "mergeFromCloud",
  "branchPrefix",
  "playwrightBeforeCheckpoint",
  "allowExternalHtmlResources",
  "browserIde",
] as const;

const ENVIRONMENT_FIELDS = ["name", "repo", "baseBranch", "env"] as const;

/** Tape fields only a person sets (gurus-service.ts). Passed through to the service so an agent
 * that names one gets its refusal, rather than having the field quietly dropped. */
const WEB_ONLY_FIELDS = ["adminTools", "memory", "agentEngine"] as const;

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
    g.memory && g.memory !== "off" ? `memory=${g.memory}` : undefined,
    g.agentEngine === true ? "agentEngine" : undefined,
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
    ["memory", g.memory && g.memory !== "off" ? g.memory : undefined],
    ["agentEngine", g.agentEngine === true ? true : undefined],
    ["tools", g.tools],
    ["excludeTools", g.excludeTools],
    ["repos", g.repos],
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

/** E9.10 (#354): a tape as data, for a laptop that plays it (Kernal's kernal-tape). Every field a
 * Drive reads, plus `updatedAt`, so Kernal can pin a version and diff the next one. Env as NAMES
 * only, sorted: the values often hold keys and never leave the server (a laptop only warns about
 * names it doesn't have set). Prompts are whole, not clipped: Kernal shows and pins them. */
export function tapeJson(g: Guru): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: "tape",
    format: 1,
    id: g.id,
    name: g.name,
    model: g.model,
    fallbackModel: g.fallbackModel,
    thinking: g.thinking,
    systemPrompt: g.systemPrompt,
    appendSystemPrompt: g.appendSystemPrompt,
    tools: g.tools,
    excludeTools: g.excludeTools,
    // A URL-form package source may carry credentials (`https://user:token@…`); never to a laptop.
    packages: g.packages?.map((p) => p.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1***@")),
    envNames: g.env ? Object.keys(g.env).sort() : undefined,
    repos: g.repos?.length ? g.repos : undefined,
    adminTools: hasAdminTools(g) ? g.adminTools : undefined,
    memory: g.memory && g.memory !== "off" ? g.memory : undefined,
    agentEngine: g.agentEngine === true ? true : undefined,
    mergeFromCloud: g.mergeFromCloud,
    branchPrefix: g.branchPrefix,
    playwrightBeforeCheckpoint: g.playwrightBeforeCheckpoint,
    allowExternalHtmlResources: g.allowExternalHtmlResources,
    browserIde: g.browserIde,
    updatedAt: g.updatedAt,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** `format: "json"` on tapes.get/tapes.list: the data form above instead of text. */
function wantsJson(args: Args): boolean {
  return args.format === "json";
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

/** A change to a tape with memory or Agent Engine waits for the person (gurus-service.ts). */
async function capabilityTapeAsks(ctx: AdminContext, args: Args): Promise<boolean> {
  const tape = await resolveTape(ctx, args.id);
  return tape.ok && !hasAdminTools(tape.item) && tapeCapabilities(tape.item).length > 0;
}

async function adminTapeRefusal(ctx: AdminContext, args: Args): Promise<string | undefined> {
  const tape = await resolveTape(ctx, args.id);
  return tape.ok && hasAdminTools(tape.item) ? `tape ${tape.item.id} has admin tools; a sysop changes it in the web UI` : undefined;
}

export const ADMIN_OPS: Record<string, AdminOp> = {
  "tapes.list": {
    kind: "read",
    capability: "admin",
    async run(ctx, _caller, args) {
      const now = nowOf(ctx);
      const tapes = (await ctx.store.gurus.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const hits = q ? tapes.filter((g) => `${g.id} ${g.name} ${g.model}`.toLowerCase().includes(q)) : tapes;
      const limit = limitOf(args, 20, 100);
      if (wantsJson(args)) {
        // tapeJson's rules for the flags (unset when off); JSON.stringify drops what is undefined.
        const rows = hits.slice(0, limit).map((g) => ({
          id: g.id,
          name: g.name,
          model: g.model,
          thinking: g.thinking,
          adminTools: hasAdminTools(g) ? g.adminTools : undefined,
          memory: g.memory && g.memory !== "off" ? g.memory : undefined,
          agentEngine: g.agentEngine === true ? true : undefined,
          updatedAt: g.updatedAt,
        }));
        return { ok: true, text: JSON.stringify({ kind: "tapes", format: 1, tapes: rows, more: Math.max(0, hits.length - limit) }) };
      }
      const lines = hits.slice(0, limit).map((g) => tapeLine(g, now));
      if (hits.length > limit) lines.push(`… ${hits.length - limit} more; pass limit or query`);
      return { ok: true, text: lines.join("\n") || "no tapes" };
    },
  },

  "tapes.get": {
    kind: "read",
    capability: "admin",
    async run(ctx, _caller, args) {
      const tape = await resolveTape(ctx, args.id);
      if (!tape.ok) return tape;
      if (wantsJson(args)) return { ok: true, text: JSON.stringify(tapeJson(tape.item)), target: tape.item.id };
      return { ok: true, text: capText(tapeDetail(tape.item)), target: tape.item.id };
    },
  },

  "tapes.meta": {
    kind: "read",
    capability: "admin",
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
          `memory: ${MEMORY_LEVELS.join("|")}, agentEngine: true|false (web UI only)`,
          `you: ${caller.email}${caller.operator ? " (sysop)" : ""}`,
        ].join("\n"),
      };
    },
  },

  "tapes.create": {
    kind: "write",
    capability: "admin",
    async run(ctx, _caller, args) {
      const body = { ...pick(args, TAPE_FIELDS), ...(args.id !== undefined ? { id: args.id } : {}) } as GuruInput;
      Object.assign(body, pick(args, WEB_ONLY_FIELDS));
      const result = await createGuru(ctx.store, body, { kind: "agent" });
      if (!result.ok) return { ok: false, error: asTape(result.error), target: typeof body.id === "string" ? body.id : undefined };
      const note = await modelNote(ctx, [result.guru.model, result.guru.fallbackModel]);
      return { ok: true, text: `created ${shortId(result.guru.id)}${note}`, target: result.guru.id };
    },
  },

  "tapes.update": {
    kind: "write",
    capability: "admin",
    refused: adminTapeRefusal,
    asks: capabilityTapeAsks,
    async run(ctx, caller, args) {
      const tape = await resolveTape(ctx, args.id);
      if (!tape.ok) return tape;
      const patch = pick(args, TAPE_FIELDS) as Partial<GuruInput>;
      Object.assign(patch, pick(args, WEB_ONLY_FIELDS));
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
    capability: "admin",
    refused: adminTapeRefusal,
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
    capability: "admin",
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
    capability: "admin",
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
    capability: "admin",
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
    capability: "admin",
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
    capability: "admin",
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
    capability: "admin",
    async run(ctx, caller, args) {
      const a = { ...args };
      // Printed ids are prefixes; the store filters on full ones.
      if (a.session !== undefined) {
        const s = await findSession(ctx, a.session);
        if (!s.ok) return s;
        a.session = s.item.id;
      }
      if (a.tape !== undefined) {
        const t = await resolveTape(ctx, a.tape);
        if (!t.ok) return t;
        a.tape = t.item.id;
      }
      // A Drive reads its owner's sessions only: a prompt-injected agent shouldn't pull other people's.
      if (caller.via === "drive") a.owner = "me";
      return searchSessions(ctx.store, caller.email, a, nowOf(ctx));
    },
  },

  "sessions.transcript": {
    kind: "read",
    capability: "admin",
    async run(ctx, caller, args) {
      const found = await findSession(ctx, args.id);
      if (!found.ok) return found;
      if (caller.via === "drive" && found.item.ownerEmail?.toLowerCase() !== caller.email.toLowerCase()) {
        return { ok: false, error: "a Drive can read only its owner's sessions" };
      }
      return sessionTranscript(ctx.store, found.item, args, nowOf(ctx));
    },
  },

  "sessions.get": {
    kind: "read",
    capability: "admin",
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
export const CARD_FIELDS: readonly string[] = [...new Set<string>([...TAPE_FIELDS, ...ENVIRONMENT_FIELDS, ...WEB_ONLY_FIELDS])];

const OP_NAME = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;
/** Kernal's transport treats these names as reads (no idempotency key, resent once after a link
 * drop: outfitter-admin/transport.ts READ_ACTIONS), so an op's class must agree with its name. */
const READ_NAME = /\.(list|get|meta|search|transcript|context)$/;

/**
 * Adds an op to the registry (E9 PR3/PR4: `memory.*`, `ae.*`). Returns a function that removes it
 * again, for tests. Refuses a duplicate or malformed name, or a capability or class it doesn't know,
 * so a typo can't register an op that skips its gate.
 */
export function registerAdminOp(name: string, op: AdminOp): () => void {
  if (!OP_NAME.test(name)) throw new Error(`admin op name must look like area.action: ${name}`);
  if (Object.hasOwn(ADMIN_OPS, name)) throw new Error(`admin op ${name} is already registered`);
  if (!(["admin", "memory", "agentEngine"] as const).includes(op.capability)) throw new Error(`admin op ${name}: unknown capability ${String(op.capability)}`);
  if (!(["read", "write", "delete", "operator", "approve"] as const).includes(op.kind)) throw new Error(`admin op ${name}: unknown class ${String(op.kind)}`);
  if ((op.kind === "read") !== READ_NAME.test(name)) {
    throw new Error(`admin op ${name}: a read must end in .list|.get|.meta|.search|.transcript|.context, and nothing else may (Kernal resends those)`);
  }
  // An approve op answers something remote on the owner's behalf: it must say on the card what it
  // answers, and it must never be reachable from a laptop, where `confirmed` is the caller's own word.
  // E9.9: unless its yes comes from the web approval widget (`laptop: "web"`), which it can't answer.
  if (op.kind === "approve" && (!op.card || op.capability === "admin" || (op.laptop && !webApproved(op)))) {
    throw new Error(`admin op ${name}: an approve op needs its own card and a Drive-only capability`);
  }
  switch (op.laptop) {
    case undefined:
      break;
    case "memory":
      if (op.capability !== "memory" || (op.kind !== "read" && op.kind !== "write")) throw new Error(`admin op ${name}: only a memory read or write may be laptop "memory"`);
      break;
    case "tape":
      // E9.10: a tape-gated laptop op (ae.list, ae.get, ae.close) acts for nobody: a read, or a
      // `.close` that stops what the caller opened. Its capability is the tape's, checked per call.
      if (op.capability === "admin" || op.capability === "memory" || !(op.kind === "read" || (op.kind === "write" && /\.close$/.test(name)))) {
        throw new Error(`admin op ${name}: laptop "tape" is for reads and .close writes of a tape capability`);
      }
      break;
    case "web":
    case "web-always":
      // A web op lifts the memory-only rule, so it must actually ask (review): a class that always
      // asks, `asks`, or "web-always"; and say on its card what it asks.
      if (!op.laptopCard || (op.laptop === "web" && !op.asks && !ALWAYS_ASKS.has(op.kind))) {
        throw new Error(`admin op ${name}: a laptop "web" op needs a laptopCard, and asks (or a class that always asks)`);
      }
      break;
    default:
      throw new Error(`admin op ${name}: unknown laptop access ${String(op.laptop)}`);
  }
  // Skipping the audit is for a laptop's own memory writes (memory.record) only.
  if (op.audit === false && (op.kind !== "write" || !op.laptop)) throw new Error(`admin op ${name}: only a laptop memory write may skip the audit`);
  ADMIN_OPS[name] = op;
  return () => {
    if (ADMIN_OPS[name] === op) delete ADMIN_OPS[name];
  };
}

/** The op's definition, if `op` names one (own keys only). */
export function adminOp(op: unknown): AdminOp | undefined {
  return typeof op === "string" && Object.hasOwn(ADMIN_OPS, op) ? ADMIN_OPS[op] : undefined;
}

const CAPABILITY_OFF: Record<AdminCapability, string> = {
  admin: "admin tools are off for this tape",
  memory: "memory is off for this tape",
  agentEngine: "Agent Engine is off for this tape",
};

/** The refusal for `op` on a Drive whose tape lacks what it needs. */
export function capabilityOff(op: unknown): string {
  const def = adminOp(op);
  return def ? CAPABILITY_OFF[def.capability] : CAPABILITY_OFF.admin;
}

/** Why this caller may not reach this op's capability, or undefined when it may. */
function capabilityRefusal(def: AdminOp, caller: AdminCaller, op: string): string | undefined {
  if (caller.via === "token") {
    if (def.capability === "admin") return undefined;
    if (!def.laptop) return `${op} works only in a Drive`;
    if (def.capability === "memory") return undefined;
    // E9.10 (#354): anything else (Agent Engine agents) only for a laptop playing a tape that has
    // the capability now, as the route read it.
    if (caller.capabilities?.includes(def.capability)) return undefined;
    // A `.close` (the only tape-gated write) stops only what the caller opened: it still works after
    // the tape lost the capability, so the laptop can clean up (review).
    if (def.laptop === "tape" && def.kind === "write" && caller.laptop?.tape) return undefined;
    const needs = `${op} from a laptop needs a tape with ${def.capability === "agentEngine" ? "Agent Engine" : def.capability} on`;
    return caller.laptop?.tape ? `${needs}; tape ${caller.laptop.tape} doesn't have it` : `${needs} (kernal --tape <id>)`;
  }
  return caller.capabilities?.includes(def.capability) ? undefined : CAPABILITY_OFF[def.capability];
}

/** True when this call waits for the person's yes: its class, or its args (`asks`). */
async function needsYes(ctx: AdminContext, def: AdminOp, args: Args): Promise<boolean> {
  if (ALWAYS_ASKS.has(def.kind)) return true;
  return def.asks ? await def.asks(ctx, args) : false;
}

/**
 * The record an op would act on, resolved now: its full id and a label for the approval card. A
 * Drive passes the full id back into the op after the owner approves, so a prefix can't come to
 * mean another record during the wait. Undefined for ops without a target.
 */
export async function resolveTarget(
  ctx: AdminContext,
  op: unknown,
  args: unknown,
  caller?: AdminCaller,
): Promise<{ id: string; label: string } | { error: string } | undefined> {
  const a: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
  const def = adminOp(op);
  if (def?.target) {
    if (!caller) return { error: `${String(op)} needs its caller` };
    try {
      return await def.target(ctx, a, caller);
    } catch (err) {
      ctx.log?.(`admin op ${String(op)} target failed: ${err instanceof Error ? err.message : String(err)}`);
      return { error: "internal error" };
    }
  }
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
  const def = adminOp(op);
  if (!def) return false;
  // Refused anyway: don't ask the owner first.
  if (capabilityRefusal(def, caller, op as string)) return false;
  if (def.kind === "operator" && !caller.operator) return false;
  const a: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
  try {
    if (def.refused && (await def.refused(ctx, a, caller))) return false;
    return await needsYes(ctx, def, a);
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

  // The tape lacks what the op needs: refused before anything, and not audited (a model probing
  // tools it was never given shouldn't fill the audit log).
  const gated = capabilityRefusal(def, caller, op);
  if (gated) return { ok: false, error: gated };

  // E9.9: a Dongle's yes for a `laptop: "web"` op is only ever the web widget's (laptopGate below);
  // its own `confirmed` and any approval id it names count for nothing until consumed.
  const webGated = caller.via === "token" && webApproved(def);
  if (webGated) caller = { ...caller, approved: false, approvalId: undefined };

  let result: AdminResult & { target?: string };
  try {
    if (def.kind === "operator" && !caller.operator) result = { ok: false, error: "sysop rights required" };
    else {
      const refusal = def.refused ? await def.refused(ctx, a, caller) : undefined;
      if (refusal) result = { ok: false, error: refusal };
      else if (webGated && (def.laptop === "web-always" || (await needsYes(ctx, def, a)))) {
        const gate = await laptopGate(ctx, def, caller, op, a);
        if (gate.ok) {
          caller = { ...caller, approved: true, approvalId: gate.approvalId };
          result = await def.run(ctx, caller, gate.args);
        } else result = gate.result;
      } else result = !caller.approved && (await needsYes(ctx, def, a)) ? { ok: false, error: "needs approval", needsApproval: true } : await def.run(ctx, caller, a);
    }
  } catch (err) {
    ctx.log?.(`admin op ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    result = { ok: false, error: "internal error" };
  }
  if (def.kind !== "read" && def.audit !== false) {
    try {
      await ctx.store.adminAudit.insert({
        id: auditId(nowOf(ctx)),
        at: new Date(nowOf(ctx)).toISOString(),
        actor: caller.email,
        via: caller.via,
        sessionId: caller.sessionId ?? caller.laptop?.sessionId,
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

/**
 * E9.9: a Dongle's call to a `laptop: "web"` op that needs a yes. With an `approvalId`: consume it (the
 * one check, consumeLaptopApproval) and run. Without: ask in the web widget, and say so.
 */
async function laptopGate(
  ctx: AdminContext,
  def: AdminOp,
  caller: AdminCaller,
  op: string,
  args: Args,
): Promise<{ ok: true; approvalId: string; args: Args } | { ok: false; result: AdminResult & { target?: string } }> {
  if (!caller.laptop) return { ok: false, result: { ok: false, error: `${op} ${NO_LAPTOP_SESSION}` } };
  const now = nowOf(ctx);
  // E9.10: an op with a `target` (ae.resume: the execution and its pause's fingerprint) is resolved
  // now, on the ask and again on the rerun, and the yes is bound to it: a pause that changed in
  // between digests differently, so the yes can't answer a pause the card didn't show.
  let bound = args;
  let label: string | undefined;
  if (def.target) {
    const target = await def.target(ctx, args, caller);
    if ("error" in target) return { ok: false, result: { ok: false, error: target.error } };
    bound = { ...args, id: target.id };
    label = target.label;
  }
  if (caller.laptopApprovalId !== undefined) {
    const used = await consumeLaptopApproval(ctx.store, { ownerEmail: caller.email, op, args: bound, approvalId: caller.laptopApprovalId, laptop: caller.laptop, now });
    return used.ok ? { ...used, args: bound } : { ok: false, result: { ok: false, error: used.error } };
  }
  const card = def.laptopCard?.(bound, label) ?? { error: `${op} has no approval card` };
  if ("error" in card) return { ok: false, result: { ok: false, error: card.error } };
  const made = await createLaptopApproval(ctx.store, { ownerEmail: caller.email, op, args: bound, laptop: caller.laptop, ...card, now });
  if (!made.ok) return { ok: false, result: { ok: false, error: made.error } };
  return {
    ok: false,
    result: { ok: false, error: "needs your approval in the Outfitter web app", needsApproval: true, approvalId: made.approval.id, target: made.approval.id },
  };
}

// E9.9: a laptop polls its web approval here (laptop-approvals.ts). Owner only; another owner's id
// reads as not found. Registered as an `admin` read, which a Dongle may always call.
registerAdminOp("approvals.get", {
  kind: "read",
  capability: "admin",
  async run(ctx, caller, args) {
    if (caller.via !== "token") return { ok: false, error: "approvals.get is for a laptop; a Drive's approvals are its session's cards" };
    const r = await laptopApprovalStatus(ctx.store, caller.email, args.id, nowOf(ctx));
    return r.ok ? { ok: true, text: `approval ${String(args.id)}: ${r.state}`, state: r.state } : r;
  },
});

let auditSeq = 0;

/** Sorts by time, then by order within this process, so newest-first is an `_id` sort. */
export function auditId(now: number): string {
  auditSeq = (auditSeq + 1) % 1_679_616;
  return `${now.toString(36).padStart(9, "0")}-${auditSeq.toString(36).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
}
