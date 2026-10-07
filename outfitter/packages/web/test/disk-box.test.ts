import { describe, expect, it } from "vitest";
import { diskLamp, groupDiskBox, matchesQuery, rowMeta, shortWhen } from "../src/lib/disk-box.ts";
import type { SessionSummary } from "../src/api/client.ts";

const NOW = new Date(2026, 9, 7, 15, 0, 0);

function floppy(id: string, runState: string | undefined, updatedAt: Date, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, status: "open", runState, guru: "g", repo: null, cost: 0, updatedAt: updatedAt.toISOString(), ...extra };
}

describe("diskLamp", () => {
  it("maps run states to the lamps a person waits on", () => {
    expect(diskLamp({ runState: "running" })).toBe("running");
    expect(diskLamp({ runState: "provisioning" })).toBe("running");
    expect(diskLamp({ runState: "idle" })).toBe("ready");
    expect(diskLamp({ runState: "failed" })).toBe("error");
    expect(diskLamp({ runState: "stopped" })).toBe("stopped");
    expect(diskLamp({ runState: undefined })).toBe("stopped");
    expect(diskLamp({ runState: "running" }, true)).toBe("needsYou");
    expect(diskLamp({ runState: "failed" }, true)).toBe("error");
  });
});

describe("groupDiskBox", () => {
  const today = new Date(2026, 9, 7, 9, 0, 0);
  const later = new Date(2026, 9, 7, 14, 0, 0);
  const lastWeek = new Date(2026, 8, 30, 9, 0, 0);
  const rows = [
    floppy("a", "idle", today),
    floppy("b", "running", lastWeek),
    floppy("c", "stopped", lastWeek),
    floppy("d", "stopped", later, { name: "Fix login", repo: "cognitio-org/mgm-pi", branch: "claude/login" }),
    floppy("e", "idle", today),
  ];

  it("groups by spinning drive, then by day, newest first", () => {
    const groups = groupDiskBox(rows, { now: NOW });
    expect(groups.Running.map((r) => r.summary.id)).toEqual(["b"]);
    expect(groups.Today.map((r) => r.summary.id)).toEqual(["d", "a", "e"]);
    expect(groups.Earlier.map((r) => r.summary.id)).toEqual(["c"]);
  });

  it("a floppy waiting on a question sits with Running", () => {
    const groups = groupDiskBox(rows, { now: NOW, needsYouId: "a" });
    expect(groups.Running.map((r) => [r.summary.id, r.lamp])).toEqual([["a", "needsYou"], ["b", "running"]]);
  });

  it("search matches the title, repository and branch, every word", () => {
    expect(groupDiskBox(rows, { now: NOW, query: "login mgm" }).Today.map((r) => r.summary.id)).toEqual(["d"]);
    expect(matchesQuery(rows[0]!, "floppy a")).toBe(true);
    expect(matchesQuery(rows[0]!, "zzz")).toBe(false);
  });
});

describe("row text", () => {
  it("shortWhen reads like a sidebar timestamp", () => {
    expect(shortWhen(new Date(2026, 9, 7, 14, 59, 40).toISOString(), NOW)).toBe("now");
    expect(shortWhen(new Date(2026, 9, 7, 14, 40).toISOString(), NOW)).toBe("20m");
    expect(shortWhen(new Date(2026, 9, 7, 9, 0).toISOString(), NOW)).toBe("6h");
    expect(shortWhen(new Date(2026, 9, 5, 9, 0).toISOString(), NOW)).toBe("Mon");
    expect(shortWhen(new Date(2026, 8, 3, 9, 0).toISOString(), NOW)).toBe("Sep 3");
  });

  it("rowMeta names the repository and branch", () => {
    expect(rowMeta({ repo: null })).toBe("no repository");
    expect(rowMeta({ repo: "cognitio-org/mgm-pi", branch: "claude/x" })).toBe("mgm-pi · claude/x");
    expect(rowMeta({ repo: "cognitio-org/mgm-pi" })).toBe("mgm-pi");
  });
});
