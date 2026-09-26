import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { linkedEntries, sessionJsonl, SESSION_VERSION } from "../src/session-jsonl.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { PiEntry, Session } from "../src/store/types.ts";

const e = (id: string, parentId: string | null, type = "message"): PiEntry => ({ id, parentId, type });
const pairs = (entries: PiEntry[]) => entries.map((x) => [x.id, x.parentId]);

describe("linkedEntries", () => {
  test("a single well-formed chain is unchanged", () => {
    const chain = [e("a", null), e("b", "a"), e("c", "b")];
    assert.deepEqual(linkedEntries(chain), chain);
  });

  test("a later root (a run that started pi empty) hangs off the entry before it", () => {
    assert.deepEqual(pairs(linkedEntries([e("a", null), e("b", "a"), e("c", null), e("d", "c")])), [
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
    ]);
  });

  test("agentd's parentless custom entry as the last line doesn't cut the model's context", () => {
    const out = linkedEntries([e("a", null), e("b", "a"), e("pw", null, "custom")]);
    assert.deepEqual(out.at(-1), { id: "pw", parentId: "b", type: "custom" });
  });

  test("a real branch (parent earlier in the transcript) is left alone", () => {
    const branch = [e("a", null), e("b", "a"), e("c", "a")];
    assert.deepEqual(linkedEntries(branch), branch);
  });

  test("a parent missing from the transcript, or an absent parentId, is linked like a root", () => {
    assert.deepEqual(pairs(linkedEntries([e("a", null), e("b", "gone"), { id: "c", type: "custom" }])), [
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
  });

  test("a child stored before its parent (same-second writes from two processes) moves after it, not off the thread", () => {
    // e6 from a reconnected link instance sorted before e1..e3 from the first one.
    const stored = [e("e6", "e3"), e("e1", null), e("e2", "e1"), e("e3", "e2"), e("e7", "e6")];
    assert.deepEqual(pairs(linkedEntries(stored)), [
      ["e1", null],
      ["e2", "e1"],
      ["e3", "e2"],
      ["e6", "e3"],
      ["e7", "e6"],
    ]);
  });

  test("a parent cycle in bad data doesn't hang or drop entries", () => {
    const out = linkedEntries([e("a", "b"), e("b", "a")]);
    assert.equal(out.length, 2);
  });

  test("does not mutate the stored entries", () => {
    const input = [e("a", null), e("b", null)];
    linkedEntries(input);
    assert.equal(input[1].parentId, null);
  });
});

describe("sessionJsonl", () => {
  const session = { id: "s1", createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "x" } as Session;

  test("a pi session header, then the entries, newline-terminated", () => {
    const text = sessionJsonl(session, [e("a", null)]);
    assert.ok(text.endsWith("\n"));
    const [header, first] = text.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(header, { type: "session", version: SESSION_VERSION, id: "s1", timestamp: session.createdAt, cwd: "/workspace" });
    assert.deepEqual(first, e("a", null));
  });

  test("a forked session names its parent", () => {
    const header = JSON.parse(sessionJsonl({ ...session, parentId: "p" }, []).split("\n")[0]);
    assert.equal(header.parentSession, "p");
  });
});

describe("EntriesCollection.listForSession (memory)", () => {
  test("insertion order, not seq: a second run's low seqs come after the first run's", async () => {
    const store = new MemoryStore();
    await store.entries.insertIfNew("s", 5, e("r1-late", null));
    await store.entries.insertIfNew("s", 1, e("r2-first", null));
    await store.entries.insertIfNew("s", 2, e("r2-second", "r2-first"));
    assert.deepEqual((await store.entries.listForSession("s")).map((r) => r.entry.id), ["r1-late", "r2-first", "r2-second"]);
    assert.deepEqual((await store.entries.listForSession("s", "r1-late")).map((r) => r.entry.id), ["r2-first", "r2-second"]);
  });
});
