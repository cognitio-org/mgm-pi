// Page side of the Chrome companion channel. The id is the contents of chrome/extension-id,
// pinned by the extension's manifest key. Do not fetch it at runtime.

export const CHROME_EXTENSION_ID = "iodmmlkefenhggpbpcmhkajencapmcee";

export type PlaceMode = "own" | "shared" | "window";

export interface PlaceMessage {
  t: "place";
  sessionId: string;
  url: string;
  title: string;
  mode: PlaceMode;
}

export interface SplitMessage {
  t: "split";
  sessionId: string;
  otherSessionId: string;
}

export interface PollMessage {
  t: "poll";
}

/** The Floppy's own URL on this page's origin. No query and no hash, so the extension's allowlist accepts it. */
export function sessionUrl(origin: string, sessionId: string): string {
  return `${origin}/sessions/${sessionId}`;
}

export function placeMessage(sessionId: string, origin: string, title: string, mode: PlaceMode): PlaceMessage {
  return { t: "place", sessionId, url: sessionUrl(origin, sessionId), title, mode };
}

export function splitMessage(sessionId: string, otherSessionId: string): SplitMessage {
  return { t: "split", sessionId, otherSessionId };
}

export function pollMessage(): PollMessage {
  return { t: "poll" };
}

/** Controls render only after a ping reply of `{ok:true, version, id}`. */
export function pingSucceeded(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const reply = message as { ok?: unknown; version?: unknown; id?: unknown };
  return reply.ok === true && typeof reply.version === "string" && typeof reply.id === "string";
}

/** Split stays hidden until the extension says it can split, and hides again on split_unavailable. */
export function splitAvailableFrom(message: unknown, current: boolean): boolean {
  if (message === null || typeof message !== "object") return current;
  const reply = message as { ok?: unknown; error?: unknown; split?: unknown };
  if (reply.ok === true && reply.split === true) return true;
  if (reply.ok === false && reply.error === "split_unavailable") return false;
  return current;
}

export function placementFailure(message: unknown): "place_failed" | "split_failed" | null {
  if (message === null || typeof message !== "object") return null;
  const reply = message as { ok?: unknown; error?: unknown };
  if (reply.ok !== false) return null;
  if (reply.error === "place_failed") return "place_failed";
  if (reply.error === "split_failed") return "split_failed";
  return null;
}
