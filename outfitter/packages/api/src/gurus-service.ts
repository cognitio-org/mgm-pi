// Tape (guru) validation and writes, shared by the REST routes (routes/gurus.ts) and the admin op
// registry (admin/ops.ts), so a tape saved by an agent passes exactly the checks a tape saved in
// the web UI does. Moved here from routes/gurus.ts (Sysop tools, #286).

import { randomUUID } from "node:crypto";
import { parseBranchPrefix } from "./branch-policy.ts";
import type { AdminToolsLevel, Guru, Store } from "./store/types.ts";

export type GuruInput = Omit<Guru, "id" | "createdAt" | "updatedAt"> & { id?: string };

// guru.env is merged into the pi child process's environment verbatim (agentd's guru.ts renderGuru).
// Any domain user can create/edit a guru, so these keys are rejected outright here (finding #6,
// docs/reports/security-review-pr1.md) rather than left to agentd's own denylist to silently drop --
// a 400 tells the guru author immediately instead of a run quietly not getting the env var it
// expected. NODE_OPTIONS/LD_PRELOAD/LD_LIBRARY_PATH can load arbitrary code into pi, PATH can shadow
// git/gh with a malicious binary, GIT_* can hijack agentd's own per-invocation auth-header env vars
// (see agentd/src/git.ts), HOME can redirect where pi/git read config/credentials from.
// LITELLM_BASE_URL/LITELLM_API_KEY/LITELLM_AGENT_KEY (finding #1, docs/reports/security-review-pr15.md):
// outfitter-spend.ts's LiteLLM probes read these straight from process.env with no validation. A
// guru-supplied LITELLM_BASE_URL previously survived into the pi child's env (secretEnv only pinned
// the key, not the base URL) and would have made the sandbox send the *real* per-run LiteLLM key as
// a Bearer token to an attacker-controlled host -- credential exfiltration + SSRF. This denylist is
// the actual fix; run.ts also now pins LITELLM_BASE_URL server-side as belt-and-suspenders. Note:
// the pre-existing kernal connect extension (kernal/.pi/extensions/connect) has the same
// LITELLM_BASE_URL-to-Bearer-key exposure pattern, but it isn't guru-configurable, so it isn't a
// vector through this route -- flagged for awareness, not fixed here.
//
// Exported (E3.7) so GET /api/gurus/meta can echo it to the Gurus page's form, which shows it next
// to the env key/value rows so a guru author sees the restriction before hitting the 400 rather
// than after. GIT_* is a prefix match, not a literal key, so it's listed separately in the meta
// response below instead of pretending it belongs in this Set.
export const DENYLISTED_GURU_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_AGENT_KEY",
  // A user Dongle must not be planted into a Drive. The capture tool does not use one.
  "OUTFITTER_TOKEN",
]);

/** guru.env keys denied by prefix rather than exact match -- see DENYLISTED_GURU_ENV_KEYS' doc. */
export const DENYLISTED_GURU_ENV_PREFIXES = ["GIT_"];

/** The whole denylist as the Gurus page and `outfitter_tapes meta` show it. */
export function envDenylist(): string[] {
  return [...DENYLISTED_GURU_ENV_KEYS, ...DENYLISTED_GURU_ENV_PREFIXES.map((p) => `${p}*`)];
}

/** The guru whose id is `default` is presumed to exist in most deployments (the fleet's fallback
 * guru for a session with nothing else configured) and can't be deleted -- DELETE
 * /api/gurus/default always 400s. The id is reserved so an operator who does create one doesn't
 * have to remember a special rule that only starts mattering once they do. */
export const UNDELETABLE_GURU_ID = "default";

/** `provider/id` (pi's --model flag shape, rpc.md): at least one `/`, no whitespace, non-empty
 * segments either side. Deliberately permissive about what's on each side (provider ids and model
 * ids are free-form, and an id itself may contain further `/`s, e.g. openrouter's
 * "anthropic/claude-3-opus") -- this only catches the common mistake of a bare model name with no
 * provider prefix, which pi would otherwise reject deep inside the sandbox instead of at save time. */
const MODEL_REF_PATTERN = /^[^\s/]+\/[^\s]+$/;

export function isValidModelRef(model: string): boolean {
  return MODEL_REF_PATTERN.test(model);
}

/** Thinking levels pi's --model `:thinking` suffix and RPC set_thinking_level accept (pi's own
 * thinking-selector.js LEVEL_DESCRIPTIONS, mirrored here since pi has no --help flag enumerating
 * them and mgm's connect extension only ever maps *into* this set, never validates against it). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(thinking: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(thinking);
}

export const ADMIN_TOOLS_LEVELS: readonly AdminToolsLevel[] = ["off", "manage", "operator"];

/** True when the tape's runs get the admin tools at all (absent means off). */
export function hasAdminTools(guru: Pick<Guru, "adminTools">): boolean {
  return guru.adminTools === "manage" || guru.adminTools === "operator";
}

/**
 * Who is writing. Only a person in the web UI (IAP, or dev mode) may set `adminTools`, and only an
 * operator may set it to `operator`. An agent -- a Drive's broker call or anything holding a
 * Dongle -- can never raise a tape's rights, so it cannot build itself a stronger tape. Changing or
 * deleting a tape that already has admin tools needs `approved` from an agent: the Drive's web
 * approval card, or the laptop's TUI confirm.
 */
export type GuruWriter =
  | { kind: "human"; operator: boolean }
  | { kind: "agent"; approved?: boolean };

export type GuruWriteResult =
  | { ok: true; guru: Guru }
  | { ok: false; status: number; error: string; count?: number };

function denylistedGuruEnvKeys(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).filter(
    (key) => DENYLISTED_GURU_ENV_KEYS.has(key) || DENYLISTED_GURU_ENV_PREFIXES.some((p) => key.startsWith(p)),
  );
}

/** Shared create/update validation beyond "name and model are required" (that check stays with
 * create since update bodies are partial). Returns an error message, or undefined if the input is
 * fine. Checks fields only when present. Normalises `branchPrefix` in place. */
export function guruValidationError(body: Partial<GuruInput>): string | undefined {
  const denied = denylistedGuruEnvKeys(body.env);
  if (denied.length > 0) return `guru.env may not set: ${denied.join(", ")}`;
  if (body.model !== undefined && !isValidModelRef(body.model)) {
    return `model must look like provider/id, got: ${body.model}`;
  }
  if (body.fallbackModel !== undefined && body.fallbackModel !== "" && !isValidModelRef(body.fallbackModel)) {
    return `fallbackModel must look like provider/id, got: ${body.fallbackModel}`;
  }
  if (body.thinking !== undefined && body.thinking !== "" && !isValidThinkingLevel(body.thinking)) {
    return `thinking must be one of: ${THINKING_LEVELS.join(", ")}`;
  }
  if (body.mergeFromCloud !== undefined && typeof body.mergeFromCloud !== "boolean") {
    return "mergeFromCloud must be a boolean";
  }
  // Absent stays absent (existing gurus are off). Only a real boolean is stored; anything else
  // would be easy to mistake for "on" later.
  if (body.playwrightBeforeCheckpoint !== undefined && typeof body.playwrightBeforeCheckpoint !== "boolean") {
    return "playwrightBeforeCheckpoint must be a boolean";
  }
  if (body.allowExternalHtmlResources !== undefined && typeof body.allowExternalHtmlResources !== "boolean") {
    return "allowExternalHtmlResources must be a boolean";
  }
  if (body.browserIde !== undefined && typeof body.browserIde !== "boolean") {
    return "browserIde must be a boolean";
  }
  if (body.adminTools !== undefined && !(ADMIN_TOOLS_LEVELS as readonly unknown[]).includes(body.adminTools)) {
    return `adminTools must be one of: ${ADMIN_TOOLS_LEVELS.join(", ")}`;
  }
  if (body.branchPrefix !== undefined) {
    const parsed = parseBranchPrefix(body.branchPrefix);
    if (!parsed.ok) return "branchPrefix must be a branch name prefix such as outfitter/";
    if (parsed.prefix) body.branchPrefix = parsed.prefix;
    else delete body.branchPrefix;
  }
  return undefined;
}

/** The `adminTools` rules for this writer, or undefined when the write may go ahead. */
function adminToolsError(body: Partial<GuruInput>, writer: GuruWriter): GuruWriteResult | undefined {
  if (body.adminTools === undefined) return undefined;
  if (writer.kind === "agent") {
    return { ok: false, status: 403, error: "adminTools can only be set in the web UI" };
  }
  if (body.adminTools === "operator" && !writer.operator) {
    return { ok: false, status: 403, error: "only a sysop can give a tape operator admin tools" };
  }
  return undefined;
}

function needsApproval(existing: Guru, writer: GuruWriter): GuruWriteResult | undefined {
  if (writer.kind !== "agent" || writer.approved || !hasAdminTools(existing)) return undefined;
  return { ok: false, status: 403, error: `tape ${existing.id} has admin tools; changing it needs approval` };
}

export async function createGuru(store: Store, body: GuruInput, writer: GuruWriter): Promise<GuruWriteResult> {
  if (!body?.name || !body?.model) return { ok: false, status: 400, error: "name and model are required" };
  const invalid = guruValidationError(body);
  if (invalid) return { ok: false, status: 400, error: invalid };
  const denied = adminToolsError(body, writer);
  if (denied) return denied;
  // Agents name tapes with a slug so later calls stay short; the web UI's ids are left as they were.
  if (writer.kind === "agent" && body.id !== undefined && (typeof body.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.id))) {
    return { ok: false, status: 400, error: "id must be lowercase letters, digits and dashes" };
  }
  if (body.id && (await store.gurus.findById(body.id))) {
    return { ok: false, status: 409, error: `tape ${body.id} already exists` };
  }
  const now = new Date().toISOString();
  const guru: Guru = { ...body, id: body.id ?? randomUUID(), createdAt: now, updatedAt: now };
  await store.gurus.insert(guru);
  return { ok: true, guru };
}

export async function updateGuru(
  store: Store,
  id: string,
  body: Partial<GuruInput>,
  writer: GuruWriter,
): Promise<GuruWriteResult> {
  const patch: Partial<GuruInput> = { ...body };
  delete patch.id;
  const invalid = guruValidationError(patch);
  if (invalid) return { ok: false, status: 400, error: invalid };
  const denied = adminToolsError(patch, writer);
  if (denied) return denied;
  const existing = await store.gurus.findById(id);
  if (!existing) return { ok: false, status: 404, error: "guru not found" };
  const approval = needsApproval(existing, writer);
  if (approval) return approval;
  const updated = await store.gurus.update(id, { ...patch, updatedAt: new Date().toISOString() });
  if (!updated) return { ok: false, status: 404, error: "guru not found" };
  return { ok: true, guru: updated };
}

// E3.7: only deletable when nothing references it. Sessions keep guruId as a plain string (no
// foreign-key enforcement in the store), so a deleted guru would otherwise silently orphan every
// session that used it -- routes/sessions.ts resolves guruId to a guru again on every wake
// (agentlink.ts's buildRunSpec), which would then 404 deep inside a run instead of at delete time.
export async function deleteGuru(store: Store, id: string, writer: GuruWriter): Promise<GuruWriteResult> {
  const guru = await store.gurus.findById(id);
  if (!guru) return { ok: false, status: 404, error: "guru not found" };
  if (id === UNDELETABLE_GURU_ID) return { ok: false, status: 400, error: "the default guru cannot be deleted" };
  const approval = needsApproval(guru, writer);
  if (approval) return approval;
  const referencing = await store.sessions.list({ guruId: id });
  if (referencing.length > 0) {
    return {
      ok: false,
      status: 409,
      error: `guru is referenced by ${referencing.length} session${referencing.length === 1 ? "" : "s"}`,
      count: referencing.length,
    };
  }
  await store.gurus.delete(id);
  return { ok: true, guru };
}
