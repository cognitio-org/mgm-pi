// E9 §5.2: which tapes an A2A key may name, as the api decides (packages/api/src/a2a/keys.ts's
// a2aTapeProblem). The page uses it to disable a tape with the reason; the api checks again.

import type { Guru } from "../api/client.ts";

export function a2aTapeProblem(guru: Pick<Guru, "adminTools" | "agentEngine" | "memory" | "mergeFromCloud">): string | undefined {
  if (guru.adminTools === "manage" || guru.adminTools === "operator") return "has admin tools";
  if (guru.agentEngine === true) return "can call Agent Engine agents";
  if (guru.memory === "auto") return "has automatic memory";
  if (guru.mergeFromCloud === true) return "may merge from the cloud";
  return undefined;
}

/** `owner/name` with GitHub's characters, as the api accepts it; undefined otherwise. */
export function normalizeA2ARepo(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(trimmed)) return undefined;
  if (trimmed.split("/").some((part) => part === "." || part === "..")) return undefined;
  return trimmed;
}

/** "expires in 12 days", "expires today", "expired". */
export function expiresIn(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "expires today";
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}
