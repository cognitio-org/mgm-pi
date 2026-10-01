// E9 §5.2 A2A keys: which tapes a remote caller may run, and the scope a key is created with.
// Checked when the key is created and again at every task start, since the web UI can change a
// tape later.

import type { A2AKeyScope, Guru, Store } from "../store/types.ts";
import { hasAdminTools } from "../gurus-service.ts";

export const A2A_DEFAULT_MAX_CONCURRENT = 2;
export const A2A_MAX_CONCURRENT_LIMIT = 10;
export const A2A_MAX_TAPES = 20;
export const A2A_MAX_REPOS = 50;

/** A tape id as a skill id (the PR7 client's own check). */
export const SKILL_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** `owner/name`, GitHub's characters only. */
export const A2A_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * The pi tools an A2A tape may list (E9 security review): file and shell work in the Drive, git,
 * opening a PR, and `memory` (scoped to the key, §5.4). Anything that reaches past the Drive in the
 * owner's name is left out: `subagent`, `subagents_enable` and `subagent_supervisor` (more Drives
 * and tapes), `agent_engine` (the owner's Agent Engine agents), `github_issue` (writes outside the
 * task's branch), and every tool not listed here, including ones added later.
 */
export const A2A_TAPE_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash", "edit", "write", "git", "github_pr", "memory"];

/**
 * Why `guru` can't be reached over A2A, or undefined when it can. A remote caller acts in the
 * owner's name with nobody watching, so:
 * - admin tools: an admin tape runs `tapes.*` writes without approval (admin/ops.ts);
 * - `agentEngine`: it could reach the owner's Agent Engine agents;
 * - `memory: "auto"`: it would record the caller's turns and recall into them (§5.4);
 * - `mergeFromCloud`: it could merge into the base branch, past the forced `outfitter/a2a-*`
 *   branch (§8: a remote caller acts "only on branch outfitter/a2a-*");
 * - `env`: the tape's env goes into pi's environment, where a prompt-injected model can print it
 *   into the result the caller reads (agentlink.ts also strips it from an A2A run's spec);
 * - `tools`: an explicit list, every entry in A2A_TAPE_TOOLS. No list means pi's defaults plus
 *   whatever the Drive adds, which is not something to hand a remote caller.
 */
export function a2aTapeProblem(
  guru: Pick<Guru, "id" | "adminTools" | "agentEngine" | "memory" | "mergeFromCloud" | "env" | "tools">,
): string | undefined {
  if (hasAdminTools(guru)) return `tape "${guru.id}" has admin tools`;
  if (guru.agentEngine === true) return `tape "${guru.id}" can call Agent Engine agents`;
  if (guru.memory === "auto") return `tape "${guru.id}" has automatic memory`;
  if (guru.mergeFromCloud === true) return `tape "${guru.id}" may merge from the cloud`;
  if (guru.env && Object.keys(guru.env).length > 0) return `tape "${guru.id}" sets environment variables`;
  if (!Array.isArray(guru.tools) || guru.tools.length === 0) return `tape "${guru.id}" has no tools list`;
  const outside = guru.tools.filter((t) => !A2A_TAPE_TOOLS.includes(t));
  if (outside.length > 0) {
    return `tape "${guru.id}" has tools not allowed over A2A (${outside.slice(0, 5).join(", ").slice(0, 120)})`;
  }
  return undefined;
}

/** Why the tape's runs would get no LiteLLM key of their own, or undefined when they would. An
 * A2A session never falls back to the org-wide default key (secrets.ts): a remote caller gets a
 * bounded, revocable budget or nothing. */
export type A2ALitellmKeyCheck = (guruId: string) => Promise<string | undefined>;

/** The one-line reason for a tape with no `outfitter-litellm-key-<guruId>` secret. */
export const A2A_NO_DEDICATED_KEY = "tape has no dedicated LiteLLM key";

/** Lowercased `owner/name`, for comparing a task's repo against a key's (GitHub names are
 * case-insensitive). */
export function repoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

/**
 * POST /api/me/tokens' `a2a` body for kind "a2a": tape ids that exist and pass a2aTapeProblem,
 * `owner/name` repos, and maxConcurrent 1..A2A_MAX_CONCURRENT_LIMIT (default 2). Duplicates are
 * dropped, order kept (the first tape is the default skill). An error string for a 400.
 */
export async function parseA2AKeyScope(
  store: Pick<Store, "gurus">,
  raw: unknown,
  litellmKeyCheck?: A2ALitellmKeyCheck,
): Promise<A2AKeyScope | { error: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "a2a must be an object with tapes and repos" };
  const body = raw as { tapes?: unknown; repos?: unknown; maxConcurrent?: unknown };

  if (!Array.isArray(body.tapes) || body.tapes.length === 0) return { error: "a2a.tapes must list at least one tape" };
  if (body.tapes.length > A2A_MAX_TAPES) return { error: `a2a.tapes may list at most ${A2A_MAX_TAPES} tapes` };
  const tapes: string[] = [];
  for (const id of body.tapes) {
    if (typeof id !== "string" || !SKILL_ID_RE.test(id)) return { error: "a2a.tapes must be tape ids" };
    if (tapes.includes(id)) continue;
    const guru = await store.gurus.findById(id);
    if (!guru) return { error: `unknown tape: ${id}` };
    const problem = a2aTapeProblem(guru);
    if (problem) return { error: `${problem}, so it can't be used over A2A` };
    const keyProblem = litellmKeyCheck ? await litellmKeyCheck(id) : undefined;
    if (keyProblem) return { error: `tape "${id}": ${keyProblem}, so it can't be used over A2A` };
    tapes.push(id);
  }

  const rawRepos = body.repos ?? [];
  if (!Array.isArray(rawRepos)) return { error: "a2a.repos must be a list of owner/name" };
  if (rawRepos.length > A2A_MAX_REPOS) return { error: `a2a.repos may list at most ${A2A_MAX_REPOS} repositories` };
  const repos: string[] = [];
  for (const repo of rawRepos) {
    if (typeof repo !== "string") return { error: "a2a.repos must be a list of owner/name" };
    const trimmed = repo.trim();
    if (!A2A_REPO_RE.test(trimmed) || trimmed.split("/").some((part) => part === "." || part === "..")) {
      return { error: `not an owner/name repository: ${trimmed.slice(0, 100)}` };
    }
    if (!repos.some((r) => repoKey(r) === repoKey(trimmed))) repos.push(trimmed);
  }

  let maxConcurrent = A2A_DEFAULT_MAX_CONCURRENT;
  if (body.maxConcurrent !== undefined) {
    if (typeof body.maxConcurrent !== "number" || !Number.isInteger(body.maxConcurrent)) {
      return { error: "a2a.maxConcurrent must be a whole number" };
    }
    if (body.maxConcurrent < 1 || body.maxConcurrent > A2A_MAX_CONCURRENT_LIMIT) {
      return { error: `a2a.maxConcurrent must be 1 to ${A2A_MAX_CONCURRENT_LIMIT}` };
    }
    maxConcurrent = body.maxConcurrent;
  }
  return { tapes, repos, maxConcurrent };
}
