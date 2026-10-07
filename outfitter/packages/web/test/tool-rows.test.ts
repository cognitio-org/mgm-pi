import { describe, expect, it } from "vitest";
import { diffLines, lookupLabel, testTally, toolArgument, toolDiff, toolKind, toolSummary } from "../src/lib/tool-rows.ts";

const done = { isError: false, running: false };

describe("toolArgument", () => {
  it("names the command, path or pattern, never the raw JSON", () => {
    expect(toolArgument("bash", { command: "npm   test\n -- login" })).toBe("npm test -- login");
    expect(toolArgument("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolArgument("read", { path: "src/a.ts", offset: 10, limit: 20 })).toBe("src/a.ts:10-29");
    expect(toolArgument("grep", { pattern: "onSubmit", path: "src/pages" })).toBe('"onSubmit" src/pages');
    expect(toolArgument("find", { pattern: "*.test.ts", path: "web" })).toBe("*.test.ts in web");
    expect(toolArgument("ls", {})).toBe(".");
    expect(toolArgument("edit", { path: "a.ts", edits: [] })).toBe("a.ts");
    expect(toolArgument("mcp_lookup", { query: "docs" })).toBe("docs");
  });

  it("knows other agents' names for the same jobs", () => {
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("Glob")).toBe("list");
    expect(toolKind("MultiEdit")).toBe("edit");
    expect(toolKind("vscode")).toBe("other");
    expect(toolArgument("Grep", { pattern: "x", glob: "*.ts" })).toBe('"x" *.ts');
  });
});

describe("diffLines and toolDiff", () => {
  it("keeps unchanged lines as context and marks the rest", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" },
    ]);
  });

  it("builds one hunk per edit from pi's edits array, and counts the lines", () => {
    const diff = toolDiff("edit", {
      path: "src/Login.tsx",
      edits: [
        { oldText: "x = 1", newText: "x = 2\ny = 3" },
        { oldText: "gone", newText: "" },
      ],
    });
    expect(diff?.path).toBe("src/Login.tsx");
    expect(diff?.hunks).toHaveLength(2);
    expect([diff?.add, diff?.del]).toEqual([2, 2]);
  });

  it("reads the single-pair shape too, and a write is all additions", () => {
    expect(toolDiff("Edit", { file_path: "a", old_string: "a", new_string: "b" })?.hunks[0]).toEqual([
      { op: "del", text: "a" },
      { op: "add", text: "b" },
    ]);
    const write = toolDiff("write", { path: "n.txt", content: "one\ntwo\n" });
    expect([write?.add, write?.del]).toEqual([2, 0]);
    expect(toolDiff("edit", { path: "a" })).toBeNull();
    expect(toolDiff("bash", { command: "ls" })).toBeNull();
  });

  it("very long texts skip the line match", () => {
    const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const out = diffLines(big, `${big}\nmore`);
    expect(out.filter((l) => l.op === "del")).toHaveLength(500);
    expect(out.filter((l) => l.op === "add")).toHaveLength(501);
  });
});

describe("testTally", () => {
  it("recognises the common runners", () => {
    expect(testTally(" Test Files  3 passed (3)\n      Tests  24 passed (24)\n")).toEqual({ passed: 24, failed: 0 });
    expect(testTally("      Tests  2 failed | 11 passed (13)")).toEqual({ passed: 11, failed: 2 });
    expect(testTally("Tests:       1 failed, 11 passed, 12 total")).toEqual({ passed: 11, failed: 1 });
    expect(testTally("# tests 5\n# pass 5\n# fail 0\n")).toEqual({ passed: 5, failed: 0 });
    expect(testTally("test result: ok. 12 passed; 0 failed; 0 ignored")).toEqual({ passed: 12, failed: 0 });
    expect(testTally("===== 1 failed, 10 passed in 1.23s =====")).toEqual({ passed: 10, failed: 1 });
    expect(testTally("===== 10 passed in 0.5s =====")).toEqual({ passed: 10, failed: 0 });
    expect(testTally("hello world")).toBeNull();
  });
});

describe("toolSummary", () => {
  it("summarises a test run as pass or fail", () => {
    expect(toolSummary({ toolName: "bash", output: "Tests  24 passed (24)", ...done })).toEqual({ text: "✓ 24 passed", tone: "pass" });
    expect(toolSummary({ toolName: "bash", output: "Tests  2 failed | 11 passed (13)\n\nCommand exited with code 1", ...done, isError: true })).toEqual({
      text: "✗ 2 failed, 11 passed",
      tone: "fail",
    });
  });

  it("a failing command shows its exit code; a quiet one says so", () => {
    expect(toolSummary({ toolName: "bash", output: "boom\n\nCommand exited with code 2", ...done, isError: true }).text).toBe("✗ exit 2");
    expect(toolSummary({ toolName: "bash", output: "", ...done }).text).toBe("no output");
    expect(toolSummary({ toolName: "bash", output: "a\nb\n", ...done }).text).toBe("2 lines of output");
  });

  it("counts lines, matches and entries for look-ups", () => {
    expect(toolSummary({ toolName: "read", output: "1\n2\n3", ...done }).text).toBe("3 lines");
    expect(toolSummary({ toolName: "grep", output: "a:1: x\nb:2: y\n", ...done }).text).toBe("2 matches");
    expect(toolSummary({ toolName: "grep", output: "No matches found", ...done }).text).toBe("no matches");
    expect(toolSummary({ toolName: "ls", output: "a\nb/\n", ...done }).text).toBe("2 entries");
  });

  it("edits show their line counts; running and interrupted calls say so", () => {
    expect(toolSummary({ toolName: "edit", input: { path: "a", oldText: "a", newText: "b\nc" }, output: "ok", ...done }).text).toBe("+2 −1");
    expect(toolSummary({ toolName: "bash", isError: false, running: true })).toEqual({ text: "running…", tone: "dim" });
    expect(toolSummary({ toolName: "bash", isError: false, running: false, interrupted: true }).tone).toBe("fail");
    expect(toolSummary({ toolName: "read", output: "ENOENT: no such file\nstack", ...done, isError: true }).text).toBe("✗ ENOENT: no such file");
  });
});

describe("lookupLabel", () => {
  it("counts each kind of look-up in a folded row", () => {
    expect(lookupLabel(["read", "read", "grep"])).toBe("Read 2 files, searched 1 pattern");
    expect(lookupLabel(["ls", "find"])).toBe("Listed 2 directories");
    expect(lookupLabel(["grep", "read"])).toBe("Read 1 file, searched 1 pattern");
  });
});
