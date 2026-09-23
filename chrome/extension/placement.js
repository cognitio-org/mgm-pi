// Placement decisions for the Chrome companion. No Chrome APIs: node:test imports this file.
// The service worker performs the tab and window calls these decisions name.

/** Character cap for a tab-group title. Tab-group owners picked 250 so a name cannot grow
 * without bound (crbug.com/40711397); the chip fades earlier, but the stored title is what we set. */
export const GROUP_TITLE_LIMIT = 250;

export const SHARED_GROUP_TITLE = "Floppies";

/** Stable color for the one shared group. Own groups pick from GROUP_COLORS instead. */
export const SHARED_GROUP_COLOR = "blue";

export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function codePoints(value) {
  return [...value];
}

/** Group title for a placement mode. `shared` is always "Floppies". `own` and `window` use the
 * Floppy name, truncated to GROUP_TITLE_LIMIT code points. A blank name becomes "Floppy". */
export function groupTitle(mode, floppyName) {
  if (mode === "shared") return SHARED_GROUP_TITLE;
  const name = typeof floppyName === "string" ? floppyName.trim() : "";
  const title = name === "" ? "Floppy" : name;
  return codePoints(title).slice(0, GROUP_TITLE_LIMIT).join("");
}

/** A group color that does not change for a given session id. */
export function groupColor(sessionId) {
  let hash = 2166136261;
  const text = typeof sessionId === "string" ? sessionId : "";
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}

/** Second place focuses when this session already has a live tab. Shared focus also moves that
 * tab into the current window's Floppies group. A missing or dead tab opens one tab, in the
 * mode's place. `record` is the stored `{sessionId, tabId, windowId, groupId}` or null. */
export function placeAction(mode, record, tabLive) {
  if (record && tabLive) return { action: "focus", moveToShared: mode === "shared" };
  return { action: "open", mode };
}

/** Window a session tab must join before `tabs.group` or `createSplit`.
 *
 * `shared` and `split` require `targetWindowId`. Those calls reject a tab that
 * sits in another window, so a tab the user dragged elsewhere moves into the
 * target and still ends up beside the other Floppy. `own` and `window` keep
 * the tab's real window. `open` is true only when `tab` is null: a live tab is
 * focused or moved, never opened a second time. `tab` is the live `{windowId}`,
 * or null when this session has no tab. */
export function joinWindow(mode, tab, targetWindowId) {
  const target = Number.isInteger(targetWindowId) ? targetWindowId : null;
  if (tab == null) return { open: true, windowId: target, move: false };
  const tabWindow = Number.isInteger(tab.windowId) ? tab.windowId : null;
  if (mode !== "shared" && mode !== "split") return { open: false, windowId: tabWindow, move: false };
  if (tabWindow !== null && tabWindow === target) return { open: false, windowId: target, move: false };
  return { open: false, windowId: target, move: true };
}

/** Split requires createSplit to be a function. When it is not, the caller replies
 * `split_unavailable` and must not open a window, let alone two. */
export function splitPlan(createSplitIsFunction) {
  if (createSplitIsFunction === true) return { ok: true };
  return { ok: false, error: "split_unavailable" };
}

/** Reply posted after a ping so the page can hide Split before the user clicks it. */
export function splitAvailability(createSplitIsFunction) {
  const plan = splitPlan(createSplitIsFunction);
  if (!plan.ok) return plan;
  return { ok: true, split: true };
}

/** How to make two tabs in the same window adjacent. Null when they already are, or the indexes
 * are unusable. The higher tab moves to `left + 1`: moving downward leaves the lower index in
 * place, so the two end up next to each other. */
export function adjacencyMove(indexA, indexB) {
  if (!Number.isInteger(indexA) || !Number.isInteger(indexB) || indexA < 0 || indexB < 0) return null;
  if (indexA === indexB) return null;
  const left = Math.min(indexA, indexB);
  const right = Math.max(indexA, indexB);
  if (right === left + 1) return null;
  return { tab: indexA > indexB ? "a" : "b", index: left + 1 };
}
