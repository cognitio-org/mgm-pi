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
 * Why `guru` can't be reached over A2A, or undefined when it can. A remote caller acts in the
 * owner's name with nobody watching, so:
 * - admin tools: an admin tape runs `tapes.*` writes without approval (admin/ops.ts);
 * - `agentEngine`: it could reach the owner's Agent Engine agents;
 * - `memory: "auto"`: it would record the caller's turns and recall into them (§5.4);
 * - `mergeFromCloud`: it could merge into the base branch, past the forced `outfitter/a2a-*`
 *   branch (§8: a remote caller acts "only on branch outfitter/a2a-*").
 */
export function a2aTapeProblem(guru: Pick<Guru, "id" | "adminTools" | "agentEngine" | "memory" | "mergeFromCloud">): string | undefined {
  if (hasAdminTools(guru)) return `tape "${guru.id}" has admin tools`;
  if (guru.agentEngine === true) return `tape "${guru.id}" can call Agent Engine agents`;
  if (guru.memory === "auto") return `tape "${guru.id}" has automatic memory`;
  if (guru.mergeFromCloud === true) return `tape "${guru.id}" may merge from the cloud`;
  return undefined;
}

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
export async function parseA2AKeyScope(store: Pick<Store, "gurus">, raw: unknown): Promise<A2AKeyScope | { error: string }> {
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
