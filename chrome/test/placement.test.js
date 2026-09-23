import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GROUP_COLORS,
  GROUP_TITLE_LIMIT,
  SHARED_GROUP_COLOR,
  SHARED_GROUP_TITLE,
  adjacencyMove,
  groupColor,
  groupTitle,
  joinWindow,
  placeAction,
  splitAvailability,
  splitPlan,
} from "../extension/placement.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const record = { sessionId: "sess", tabId: 7, windowId: 3, groupId: 9 };

test("placement.js does not call Chrome", () => {
  const source = read("../extension/placement.js");
  assert.doesNotMatch(source, /\bchrome\./);
});

test("shared groups are titled Floppies, own and window use the Floppy name", () => {
  assert.equal(groupTitle("shared", "Anything"), SHARED_GROUP_TITLE);
  assert.equal(groupTitle("shared", ""), SHARED_GROUP_TITLE);
  assert.equal(groupTitle("own", "Kernel notes"), "Kernel notes");
  assert.equal(groupTitle("window", "Kernel notes"), "Kernel notes");
  assert.equal(groupTitle("own", "   "), "Floppy");
  assert.equal(groupTitle("window", ""), "Floppy");
  assert.equal(SHARED_GROUP_COLOR, "blue");
});

test("a Floppy name is truncated to the group-title limit, on code points", () => {
  const long = "n".repeat(GROUP_TITLE_LIMIT + 20);
  assert.equal(groupTitle("own", long), "n".repeat(GROUP_TITLE_LIMIT));
  assert.equal(groupTitle("window", long).length, GROUP_TITLE_LIMIT);
  const emoji = `${"a".repeat(GROUP_TITLE_LIMIT - 1)}🙂b`;
  const truncated = groupTitle("own", emoji);
  assert.equal([...truncated].length, GROUP_TITLE_LIMIT);
  assert.ok(truncated.endsWith("🙂"));
  assert.equal(truncated.includes("b"), false);
});

test("group color is one of Chrome's colors and stable per session id", () => {
  assert.equal(groupColor("sess-1"), groupColor("sess-1"));
  assert.ok(GROUP_COLORS.includes(groupColor("sess-1")));
  const colors = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => groupColor(id)));
  assert.ok(colors.size > 1);
  for (const color of colors) assert.ok(GROUP_COLORS.includes(color));
});

test("a second place focuses when the session tab is still open", () => {
  assert.deepEqual(placeAction("own", record, true), { action: "focus", moveToShared: false });
  assert.deepEqual(placeAction("window", record, true), { action: "focus", moveToShared: false });
  assert.deepEqual(placeAction("shared", record, true), { action: "focus", moveToShared: true });
});

test("a dragged tab joins the operation window and a second place does not open another tab", () => {
  const dragged = { windowId: 9 };
  const home = { windowId: 3 };
  assert.deepEqual(joinWindow("shared", dragged, 3), { open: false, windowId: 3, move: true });
  assert.deepEqual(joinWindow("split", dragged, 3), { open: false, windowId: 3, move: true });
  assert.deepEqual(joinWindow("shared", home, 3), { open: false, windowId: 3, move: false });
  assert.deepEqual(joinWindow("split", home, 3), { open: false, windowId: 3, move: false });
  assert.deepEqual(joinWindow("own", dragged, 3), { open: false, windowId: 9, move: false });
  assert.deepEqual(joinWindow("window", dragged, 3), { open: false, windowId: 9, move: false });
  assert.deepEqual(joinWindow("split", { windowId: 3.2 }, 3), { open: false, windowId: 3, move: true });
  assert.deepEqual(joinWindow("split", dragged, 3.5), { open: false, windowId: null, move: true });
  assert.deepEqual(joinWindow("shared", null, 3), { open: true, windowId: 3, move: false });
  assert.deepEqual(joinWindow("split", null, 3), { open: true, windowId: 3, move: false });
  const moved = { ...record, windowId: 9 };
  assert.equal(placeAction("shared", moved, true).action, "focus");
  assert.equal(placeAction("own", moved, true).action, "focus");
  assert.equal(placeAction("window", moved, true).action, "focus");
});

test("a missing or dead tab opens one tab in the requested place", () => {
  assert.deepEqual(placeAction("own", record, false), { action: "open", mode: "own" });
  assert.deepEqual(placeAction("own", null, false), { action: "open", mode: "own" });
  assert.deepEqual(placeAction("window", null, true), { action: "open", mode: "window" });
  assert.deepEqual(placeAction("shared", null, false), { action: "open", mode: "shared" });
});

test("split requires createSplit and does not ask for a window when it is missing", () => {
  assert.deepEqual(splitPlan(true), { ok: true });
  assert.deepEqual(splitPlan(false), { ok: false, error: "split_unavailable" });
  assert.deepEqual(splitPlan(undefined), { ok: false, error: "split_unavailable" });
  assert.deepEqual(splitAvailability(false), { ok: false, error: "split_unavailable" });
  assert.deepEqual(splitAvailability(true), { ok: true, split: true });
});

test("adjacency move puts the higher tab just after the lower one", () => {
  assert.equal(adjacencyMove(0, 1), null);
  assert.equal(adjacencyMove(4, 3), null);
  assert.deepEqual(adjacencyMove(0, 2), { tab: "b", index: 1 });
  assert.deepEqual(adjacencyMove(5, 1), { tab: "a", index: 2 });
  assert.equal(adjacencyMove(1, 1), null);
  assert.equal(adjacencyMove(-1, 2), null);
  assert.equal(adjacencyMove(1.5, 3), null);
});
