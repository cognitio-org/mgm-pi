// #498: one-line tool rows for the transcript (docs/design/sessions-redesign-demo.html notes 5-6).
// A tool call reads as "● name argument" with a "└ summary" line under it: the command, path or
// pattern it was about, and what came back in a few words (3 matches, 112 lines, ✓ 24 passed).
// Edits carry an inline diff built from the call's own old/new text, so nothing extra is fetched.
//
// Pure: the transcript component only renders what these return.

/** What a tool does, for the row's wording and for folding runs of look-ups into one row. */
export type ToolKind = "read" | "search" | "list" | "edit" | "write" | "bash" | "other";

// pi's own tools (read, grep, find, ls, edit, write, bash), plus the names other agents use for
// the same jobs, so a teleported or extension tool still reads naturally.
const KIND_BY_NAME: Record<string, ToolKind> = {
  read: "read",
  read_file: "read",
  view: "read",
  cat: "read",
  grep: "search",
  search: "search",
  rg: "search",
  find: "list",
  glob: "list",
  ls: "list",
  list: "list",
  list_dir: "list",
  edit: "edit",
  multiedit: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  apply_patch: "edit",
  write: "write",
  write_file: "write",
  create_file: "write",
  bash: "bash",
  shell: "bash",
  exec: "bash",
  run: "bash",
  powershell: "bash",
};

export function toolKind(toolName: string): ToolKind {
  return KIND_BY_NAME[toolName.trim().toLowerCase()] ?? "other";
}

/** Look-ups that fold together when several run back to back. */
export function isLookup(kind: ToolKind): boolean {
  return kind === "read" || kind === "search" || kind === "list";
}

function field(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function numberField(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneLine(text: string, max = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
}

const HINT_KEYS = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "name"];

/** The row's argument: the command, path or pattern, on one line. Never the raw JSON. */
export function toolArgument(toolName: string, input: unknown): string {
  const kind = toolKind(toolName);
  const path = field(input, "path", "file_path", "filePath", "file");
  switch (kind) {
    case "bash":
      return oneLine(field(input, "command", "cmd", "script") ?? "");
    case "read": {
      if (!path) break;
      const offset = numberField(input, "offset");
      const limit = numberField(input, "limit");
      if (offset !== undefined && limit !== undefined) return `${path}:${offset}-${offset + limit - 1}`;
      if (offset !== undefined) return `${path}:${offset}-`;
      return path;
    }
    case "search": {
      const pattern = field(input, "pattern", "query", "regex");
      if (!pattern) break;
      const where = path ?? field(input, "glob");
      return oneLine(`"${pattern}"${where ? ` ${where}` : ""}`);
    }
    case "list": {
      const pattern = field(input, "pattern", "glob");
      if (pattern && path) return oneLine(`${pattern} in ${path}`);
      return oneLine(pattern ?? path ?? ".");
    }
    case "edit":
    case "write":
      if (path) return path;
      break;
    default:
      break;
  }
  if (typeof input === "string") return oneLine(input);
  const key = HINT_KEYS.find((k) => field(input, k));
  if (key) return oneLine(field(input, key)!);
  if (input && typeof input === "object") {
    const first = Object.values(input as Record<string, unknown>).find((v) => typeof v === "string" && v.trim());
    if (typeof first === "string") return oneLine(first);
  }
  return "";
}

// ---------- diffs ----------

export interface DiffLine {
  op: "add" | "del" | "same";
  text: string;
}

export interface ToolDiff {
  path: string;
  add: number;
  del: number;
  /** One hunk per edit, in the call's order. */
  hunks: DiffLine[][];
}

/** Lines beyond this on either side skip the line-by-line match: all old out, all new in. */
const DIFF_LINE_LIMIT = 400;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A line diff of two short texts (longest common subsequence), with unchanged context kept. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) {
    return [...a.map((text): DiffLine => ({ op: "del", text })), ...b.map((text): DiffLine => ({ op: "add", text }))];
  }
  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "del", text: a[i++]! });
    } else {
      out.push({ op: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++]! });
  while (j < b.length) out.push({ op: "add", text: b[j++]! });
  return out;
}

interface EditPair {
  oldText: string;
  newText: string;
}

function editPairs(input: unknown): EditPair[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const pairs: EditPair[] = [];
  const take = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    const oldText = v.oldText ?? v.old_string ?? v.old_str;
    const newText = v.newText ?? v.new_string ?? v.new_str;
    if (typeof oldText === "string" && typeof newText === "string") pairs.push({ oldText, newText });
  };
  // pi's edit takes `edits: [{oldText, newText}]`; older calls (and other agents) put one pair on
  // the call itself.
  if (Array.isArray(record.edits)) record.edits.forEach(take);
  take(record);
  return pairs;
}

/** The inline diff for an edit or write call, from its arguments, or null when they don't say. */
export function toolDiff(toolName: string, input: unknown): ToolDiff | null {
  const kind = toolKind(toolName);
  const path = field(input, "path", "file_path", "filePath", "file") ?? "";
  if (kind === "write") {
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const content = record.content ?? record.text;
    if (typeof content !== "string") return null;
    const hunk = splitLines(content).map((text): DiffLine => ({ op: "add", text }));
    return { path, add: hunk.length, del: 0, hunks: [hunk] };
  }
  if (kind !== "edit") return null;
  const pairs = editPairs(input);
  if (pairs.length === 0) return null;
  const hunks = pairs.map((p) => diffLines(p.oldText, p.newText));
  let add = 0;
  let del = 0;
  for (const hunk of hunks) {
    for (const line of hunk) {
      if (line.op === "add") add++;
      else if (line.op === "del") del++;
    }
  }
  return { path, add, del, hunks };
}

// ---------- results ----------

export interface TestTally {
  passed: number;
  failed: number;
}

/** Pass/fail counts from a test runner's output, when it's one this recognises. */
export function testTally(output: string): TestTally | null {
  const num = (s: string | undefined) => (s ? Number(s) : 0);
  // vitest: "Tests  2 failed | 11 passed (13)"
  let m = /^\s*Tests\s+(?:(\d+) failed\s*\|\s*)?(?:(\d+) passed)?.*\(\d+\)\s*$/m.exec(output);
  if (m && (m[1] || m[2])) return { passed: num(m[2]), failed: num(m[1]) };
  // jest: "Tests:       1 failed, 11 passed, 12 total"
  m = /^Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(?:(\d+) passed,\s*)?\d+ total/m.exec(output);
  if (m) return { passed: num(m[2]), failed: num(m[1]) };
  // node --test (TAP summary): "# pass 12" / "# fail 1"; also its spec reporter's "ℹ pass 12"
  const pass = /^(?:#|ℹ) pass (\d+)$/m.exec(output);
  const fail = /^(?:#|ℹ) fail (\d+)$/m.exec(output);
  if (pass || fail) return { passed: num(pass?.[1]), failed: num(fail?.[1]) };
  // cargo: "test result: ok. 12 passed; 0 failed"
  m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(output);
  if (m) return { passed: num(m[1]), failed: num(m[2]) };
  // pytest: "==== 1 failed, 10 passed in 1.23s ====" (either half may be missing)
  m = /=+ (?:(\d+) failed)?(?:, )?(?:(\d+) passed)?[^=\n]* in [\d.]+s/.exec(output);
  if (m && (m[1] || m[2])) return { passed: num(m[2]), failed: num(m[1]) };
  return null;
}

/** pi's bash tool ends a failing command's output with this line. */
const EXIT_CODE = /Command exited with code (\d+)/;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return oneLine(line, 80);
}

function countLines(text: string): number {
  return text.split("\n").filter((l) => l.trim()).length;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type SummaryTone = "pass" | "fail" | "dim";

export interface ToolSummary {
  text: string;
  tone: SummaryTone;
}

export interface ToolRowInput {
  toolName: string;
  input?: unknown;
  output?: string;
  isError: boolean;
  running: boolean;
  interrupted?: boolean;
}

/** The "└" line under a tool row. */
export function toolSummary(tool: ToolRowInput, diff: ToolDiff | null = toolDiff(tool.toolName, tool.input)): ToolSummary {
  if (tool.interrupted) return { text: "interrupted: this call never ran", tone: "fail" };
  if (tool.running) return { text: "running…", tone: "dim" };
  const output = tool.output ?? "";
  const kind = toolKind(tool.toolName);
  if (kind === "bash") {
    const tally = testTally(output);
    const code = EXIT_CODE.exec(output)?.[1];
    if (tally) {
      if (tally.failed > 0) return { text: `✗ ${tally.failed} failed${tally.passed ? `, ${tally.passed} passed` : ""}`, tone: "fail" };
      return { text: `✓ ${tally.passed} passed`, tone: "pass" };
    }
    if (tool.isError || code) return { text: code ? `✗ exit ${code}` : `✗ ${firstLine(output) || "failed"}`, tone: "fail" };
    const lines = countLines(output);
    return { text: lines === 0 ? "no output" : plural(lines, "line") + " of output", tone: "dim" };
  }
  if (tool.isError) return { text: `✗ ${firstLine(output) || "failed"}`, tone: "fail" };
  switch (kind) {
    case "read":
      return { text: plural(output.split("\n").length, "line"), tone: "dim" };
    case "search": {
      if (/^no (matches|results)/i.test(output.trim())) return { text: "no matches", tone: "dim" };
      return { text: plural(countLines(output), "match", "matches"), tone: "dim" };
    }
    case "list": {
      if (/^no (files|matches|results)/i.test(output.trim())) return { text: "nothing found", tone: "dim" };
      return { text: plural(countLines(output), "entry", "entries"), tone: "dim" };
    }
    case "edit":
    case "write":
      if (diff) return { text: `+${diff.add} −${diff.del}`, tone: "dim" };
      return { text: firstLine(output) || "done", tone: "dim" };
    default:
      return { text: firstLine(output) || "done", tone: "dim" };
  }
}

/** The folded row's label for a run of look-ups: "Read 3 files, searched 2 patterns". */
export function lookupLabel(toolNames: string[]): string {
  let reads = 0;
  let searches = 0;
  let lists = 0;
  for (const name of toolNames) {
    const kind = toolKind(name);
    if (kind === "read") reads++;
    else if (kind === "search") searches++;
    else if (kind === "list") lists++;
  }
  const parts: string[] = [];
  if (reads) parts.push(`read ${plural(reads, "file")}`);
  if (searches) parts.push(`searched ${plural(searches, "pattern")}`);
  if (lists) parts.push(`listed ${plural(lists, "directory", "directories")}`);
  const label = parts.join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
