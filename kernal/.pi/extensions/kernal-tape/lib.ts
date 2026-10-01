/**
 * Tapes on a laptop (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §7.1, #354): the cloud is
 * the source of truth, and a laptop plays a tape only in a version the person pinned.
 *
 * Shared by every way in, so they agree: `kernal --tape <id>` (cli.ts, before pi starts), `/tape`
 * in the TUI (index.ts), and the Tapes page of the local web admin (kernal-admin). One pin store:
 *
 *   ~/.kernal/tapes/pins/<id>.json   {tape, hash, pinnedAt, seen?}   (KERNAL_TAPE_DIR overrides the dir)
 *   ~/.kernal/tapes/npm/             the tapes' npm packages (npm install --ignore-scripts)
 *
 * The first play shows what the tape does and asks to pin it. A pinned tape plays offline. When the
 * cloud version differs from the pin, the person sees a field-level diff (prompts line by line) and
 * decides; declining keeps the pinned version. Nobody to ask (print mode, no terminal): the pinned
 * version plays, and an unpinned tape doesn't play at all.
 *
 * What it protects against: a teammate changing a shared tape's prompt, tools or packages, which
 * would otherwise run on this laptop, without a sandbox, the next time it starts. Not against this
 * laptop's own agent, which runs as the same user and could edit the pin files; nothing a tape does
 * on a laptop is more than that agent could do with its own tools anyway.
 *
 * The tape's env values never leave Outfitter: the data form carries names only, and the laptop
 * warns about names it doesn't have set.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapePiArgs, tapeExcludeTools, PI_MEMORY_TOOLS } from "../_shared/tape-args.ts";

export { PI_MEMORY_TOOLS, tapeExcludeTools };

export type MemoryLevel = "off" | "tool" | "auto";

/** A tape as Kernal knows it: what tapes.get `format: "json"` sends, checked field by field. */
export interface Tape {
  id: string;
  name: string;
  model: string;
  fallbackModel?: string;
  thinking?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  excludeTools?: string[];
  packages?: string[];
  /** The env NAMES the tape sets in a Drive. Values never reach a laptop. */
  envNames?: string[];
  /** The repos the tape is meant for, lowercased `owner/name`: a hint that never restricts. A laptop
   * playing it elsewhere warns (repoWarning). */
  repos?: string[];
  adminTools?: "manage" | "operator";
  memory?: "tool" | "auto";
  agentEngine?: true;
  mergeFromCloud?: boolean;
  branchPrefix?: string;
  playwrightBeforeCheckpoint?: boolean;
  allowExternalHtmlResources?: boolean;
  browserIde?: boolean;
  /** The cloud's last change. Shown, never part of the pinned content (hash). */
  updatedAt?: string;
}

/** The fields a pin covers, in display order. */
export const TAPE_FIELDS = [
  "name",
  "model",
  "fallbackModel",
  "thinking",
  "tools",
  "excludeTools",
  "memory",
  "agentEngine",
  "adminTools",
  "packages",
  "envNames",
  "repos",
  "allowExternalHtmlResources",
  "mergeFromCloud",
  "branchPrefix",
  "playwrightBeforeCheckpoint",
  "browserIde",
  "systemPrompt",
  "appendSystemPrompt",
] as const;
export type TapeField = (typeof TAPE_FIELDS)[number];

/** Fields only a Drive acts on; a laptop ignores them, and says so. */
export const CLOUD_ONLY_FIELDS: readonly TapeField[] = ["branchPrefix", "mergeFromCloud", "browserIde", "playwrightBeforeCheckpoint"];
const CLOUD_ONLY_WHY: Record<string, string> = {
  branchPrefix: "a Drive's push rule; on a laptop your own git credentials decide",
  mergeFromCloud: "lets a Drive merge PRs; a laptop is you at the keyboard",
  browserIde: "code-server in a Drive",
  playwrightBeforeCheckpoint: "a Drive's checkpoint check",
};

/** File-name safe, and what Outfitter's tape ids look like (slugs and UUIDs). */
export const TAPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const REPO_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const MAX_PROMPT = 200_000;
const MAX_LIST = 200;
const MAX_SHORT = 300;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ---------- parsing ----------

/** Characters a review can't show: controls (a NUL would also split bin/kernal's argv file), format
 * characters (bidi, zero-width), private use, line separators, variation selectors and tags. A tape
 * with any of them is refused, so what is pinned is only what a person could read (review). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\u2028\u2029\uFE00-\uFE0F]/u;
/** Tab and newline (and CR) are fine in a prompt; nothing else hidden is. */
export function visible(s: string, multiline = false): boolean {
  for (const c of s) if (HIDDEN.test(c) && !(multiline && (c === "\n" || c === "\t" || c === "\r"))) return false;
  return true;
}

function str(v: unknown, max = MAX_SHORT, multiline = false): string | undefined {
  return typeof v === "string" && v.length <= max && visible(v, multiline) ? v : undefined;
}

function list(v: unknown, field: string, check?: (s: string) => boolean): string[] | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > MAX_LIST || v.some((x) => typeof x !== "string" || x.length > MAX_SHORT || !visible(x) || (check && !check(x)))) {
    return { error: `${field} is not a list of names` };
  }
  return v.length ? [...(v as string[])] : undefined;
}

/** A tape from the data form, or why it isn't one. Unknown fields are dropped; a known field of the
 * wrong type refuses the whole tape (a half-read tape would play something nobody reviewed). */
export function parseTape(raw: unknown): { ok: true; tape: Tape } | { ok: false; error: string } {
  let v: any = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Outfitter sent a tape Kernal can't read (needs a newer Outfitter with tapes.get format json)" };
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "not a tape" };
  if (v.kind !== undefined && v.kind !== "tape") return { ok: false, error: "not a tape" };
  const id = str(v.id);
  if (!id || !TAPE_ID.test(id)) return { ok: false, error: "the tape's id is not one Kernal can store" };
  const model = str(v.model);
  if (!model || !/^[^\s/]+\/\S+$/.test(model) || !visible(model)) return { ok: false, error: "the tape has no usable model" };
  if (v.name !== undefined && v.name !== null && str(v.name) === undefined) return { ok: false, error: "the tape's name is not text Kernal can show" };
  const tape: Tape = { id, name: str(v.name) ?? id, model };
  const optional = (k: "fallbackModel" | "branchPrefix" | "updatedAt") => {
    if (v[k] === undefined || v[k] === null || v[k] === "") return undefined;
    const s = str(v[k]);
    if (s === undefined) return `${k} is not text`;
    tape[k] = s;
    return undefined;
  };
  for (const k of ["fallbackModel", "branchPrefix", "updatedAt"] as const) {
    const e = optional(k);
    if (e) return { ok: false, error: e };
  }
  if (v.thinking !== undefined && v.thinking !== null && v.thinking !== "") {
    if (!THINKING.includes(v.thinking)) return { ok: false, error: "thinking is not a level pi knows" };
    tape.thinking = v.thinking;
  }
  for (const k of ["systemPrompt", "appendSystemPrompt"] as const) {
    if (v[k] === undefined || v[k] === null || v[k] === "") continue;
    const s = str(v[k], MAX_PROMPT, true);
    if (s === undefined) return { ok: false, error: `${k} is not text Kernal can show (too long, or has hidden characters)` };
    tape[k] = s;
  }
  for (const k of ["tools", "excludeTools", "packages"] as const) {
    const l = list(v[k], k);
    if (l && !Array.isArray(l)) return { ok: false, error: l.error };
    if (l) tape[k] = l;
  }
  const envNames = list(v.envNames, "envNames", (s) => ENV_NAME.test(s));
  if (envNames && !Array.isArray(envNames)) return { ok: false, error: envNames.error };
  if (envNames) tape.envNames = [...envNames].sort();
  const repos = list(v.repos, "repos", (s) => REPO_NAME.test(s));
  if (repos && !Array.isArray(repos)) return { ok: false, error: repos.error };
  if (repos) tape.repos = repos;
  // A field called `env` would be values: never accepted, whatever sent it.
  if (v.adminTools === "manage" || v.adminTools === "operator") tape.adminTools = v.adminTools;
  if (v.memory === "tool" || v.memory === "auto") tape.memory = v.memory;
  if (v.agentEngine === true) tape.agentEngine = true;
  for (const k of ["mergeFromCloud", "playwrightBeforeCheckpoint", "allowExternalHtmlResources", "browserIde"] as const) {
    if (v[k] === true || v[k] === false) tape[k] = v[k];
  }
  return { ok: true, tape };
}

// ---------- the pinned content ----------

function content(t: Tape): Record<string, unknown> {
  const out: Record<string, unknown> = { id: t.id };
  for (const k of TAPE_FIELDS) if (t[k] !== undefined) out[k] = t[k];
  return out;
}

/** What a pin pins: sha256 over the tape's fields (not updatedAt), in a fixed order. */
export function tapeHash(t: Tape): string {
  return createHash("sha256").update(JSON.stringify(content(t))).digest("hex");
}

export const shortHash = (h: string) => h.slice(0, 12);

// ---------- the store ----------

export interface Pin {
  tape: Tape;
  hash: string;
  pinnedAt: string;
  /** The last cloud version this laptop saw, when it was not the pinned one (kept or not reviewed). */
  seen?: { hash: string; updatedAt?: string; at: string; kept?: boolean };
}

export function tapeDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.KERNAL_TAPE_DIR?.trim();
  if (own) return own;
  const home = env.KERNAL_HOME?.trim() || join(homedir(), ".kernal");
  return join(home, "tapes");
}

function pinFile(dir: string, id: string): string {
  if (!TAPE_ID.test(id)) throw new Error(`"${id}" is not a tape id`);
  return join(dir, "pins", `${id}.json`);
}

/** The pinned version of tape `id`, or undefined. A file that doesn't parse, or whose content no
 * longer matches its hash, counts as no pin: the person reviews the tape again. */
export function readPin(dir: string, id: string): Pin | undefined {
  if (!TAPE_ID.test(id)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(pinFile(dir, id), "utf8"));
    const parsed = parseTape(raw?.tape);
    if (!parsed.ok || parsed.tape.id !== id) return undefined;
    if (typeof raw.hash !== "string" || tapeHash(parsed.tape) !== raw.hash) return undefined;
    const pin: Pin = { tape: parsed.tape, hash: raw.hash, pinnedAt: typeof raw.pinnedAt === "string" ? raw.pinnedAt : "" };
    if (raw.seen && typeof raw.seen.hash === "string") {
      pin.seen = { hash: raw.seen.hash, at: String(raw.seen.at ?? ""), ...(typeof raw.seen.updatedAt === "string" ? { updatedAt: raw.seen.updatedAt } : {}), ...(raw.seen.kept === true ? { kept: true } : {}) };
    }
    return pin;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {}
}

/** Pins this version of the tape (replacing any older pin). */
export function writePin(dir: string, tape: Tape, now = new Date()): Pin {
  const pin: Pin = { tape, hash: tapeHash(tape), pinnedAt: now.toISOString() };
  writeJson(pinFile(dir, tape.id), pin);
  return pin;
}

/** Notes that the cloud has `cloud` while the pin stays; `kept` when the person said no. */
export function noteSeen(dir: string, pin: Pin, cloud: Tape, kept: boolean, now = new Date()): Pin {
  const next: Pin = { ...pin, seen: { hash: tapeHash(cloud), at: now.toISOString(), ...(cloud.updatedAt ? { updatedAt: cloud.updatedAt } : {}), ...(kept ? { kept: true } : {}) } };
  writeJson(pinFile(dir, pin.tape.id), next);
  return next;
}

export function listPins(dir: string): Pin[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "pins"));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => readPin(dir, n.slice(0, -5)))
    .filter((p): p is Pin => !!p)
    .sort((a, b) => a.tape.id.localeCompare(b.tape.id));
}

// ---------- what a tape does here ----------

export interface NpmSpec {
  spec: string;
  name: string;
  version?: string;
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_VERSION = /^[0-9A-Za-z.^~<>=*+-]{1,64}$/;

/** `npm:<name>[@<version>]`, the form Kernal's own settings.json uses. Nothing else is installed on
 * a laptop: a git URL or a path would run code nobody can review from the tape. packagePlan also
 * refuses a version that isn't exact (review): a range or a tag would install whatever the registry
 * serves later, without a new review. */
export function npmSpec(source: string): NpmSpec | undefined {
  const m = /^npm:(.+)$/.exec(source.trim());
  if (!m) return undefined;
  const body = m[1];
  const at = body.lastIndexOf("@");
  const name = at > 0 ? body.slice(0, at) : body;
  const version = at > 0 ? body.slice(at + 1) : undefined;
  if (!NPM_NAME.test(name) || name.length > 214) return undefined;
  if (version !== undefined && !NPM_VERSION.test(version)) return undefined;
  return { spec: version ? `${name}@${version}` : name, name, ...(version ? { version } : {}) };
}

export interface PackagePlan {
  /** Installable and installed: loaded with `-e`. */
  ready: NpmSpec[];
  /** Installable, not installed yet. */
  missing: NpmSpec[];
  /** Kernal loads these already (its own settings.json). */
  builtin: string[];
  /** Not `npm:` (or malformed): never installed on a laptop. */
  refused: string[];
}

function installedVersion(dir: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "";
  } catch {
    return undefined;
  }
}

/** How each of the tape's packages stands on this laptop. `own` are Kernal's own package sources. */
export function packagePlan(tape: Tape, npmDir: string, own: readonly string[] = []): PackagePlan {
  const plan: PackagePlan = { ready: [], missing: [], builtin: [], refused: [] };
  const ownNames = new Set(own.map((s) => npmSpec(s)?.name).filter(Boolean));
  for (const source of tape.packages ?? []) {
    const spec = npmSpec(source);
    if (spec && ownNames.has(spec.name)) {
      plan.builtin.push(source);
      continue;
    }
    if (!spec || !spec.version || !EXACT_VERSION.test(spec.version)) {
      plan.refused.push(source);
      continue;
    }
    if (installedVersion(npmDir, spec.name) === spec.version) plan.ready.push(spec);
    else plan.missing.push(spec);
  }
  return plan;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Each tape's packages in a directory of their own, so one tape's install never changes what
 * another tape loads (review). */
export function tapeNpmDir(dir: string, id: string): string {
  if (!TAPE_ID.test(id)) throw new Error(`"${id}" is not a tape id`);
  return join(dir, "npm", id);
}

export type Runner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ code: number; output: string }>;

/** npm, run for real. */
export const npmRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (e) => resolve({ code: 1, output: `${output}${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });

/** Installs `specs` into `npmDir` with lifecycle scripts off (a package's postinstall would run as
 * you, before anyone saw it). Saved to that dir's own package.json, so a later install keeps them. */
export async function installPackages(specs: NpmSpec[], npmDir: string, run: Runner): Promise<{ ok: boolean; output: string }> {
  if (!specs.length) return { ok: true, output: "" };
  mkdirSync(npmDir, { recursive: true, mode: 0o700 });
  const manifest = join(npmDir, "package.json");
  if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: "kernal-tape-packages", private: true }, null, 2)}\n`);
  const res = await run("npm", ["install", ...specs.map((s) => s.spec), "--prefix", npmDir, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"], { cwd: npmDir });
  return { ok: res.code === 0, output: res.output.slice(-2000) };
}

/** Env names the tape expects that aren't set here (never their values: there are none here). */
export function missingEnv(tape: Tape, env: NodeJS.ProcessEnv = process.env): string[] {
  return (tape.envNames ?? []).filter((n) => !env[n]);
}

export interface LaunchPlan {
  /** pi flags, before the person's own (so theirs win). */
  args: string[];
  /** Kernal's own markers for the extensions (no tape env: values never reach a laptop). */
  env: Record<string, string>;
  notes: string[];
}

/** What playing `tape` means for pi here: the shared translation (tape-args.ts) plus the laptop's
 * frame. The append text goes in only when the tape has some, so pi still finds APPEND_SYSTEM.md
 * otherwise; the HTML preview paragraph is kernal-html-preview's, from KERNAL_TAPE_HTML. */
export function launchPlan(tape: Tape, packages: PackagePlan, npmDir: string, env: NodeJS.ProcessEnv = process.env, promptDir?: string): LaunchPlan {
  // pi reads a prompt argument that names an existing file as that file (resource-loader's
  // resolvePromptInput), so a teammate's prompt of ".env" would send the file to the model (review).
  // With `promptDir` the reviewed text is written to private files and their paths passed: pi reads
  // exactly what was pinned, and the prompt stays out of `ps`.
  const files = promptDir ? promptFiles(tape, promptDir) : {};
  const args = tapePiArgs(
    { ...tape, ...(files.systemPrompt ? { systemPrompt: files.systemPrompt } : {}) },
    { appendSystemPrompt: files.appendSystemPrompt ?? (tape.appendSystemPrompt || undefined) },
  );
  if (tape.fallbackModel) args.push("--models", [tape.model, tape.fallbackModel].join(","));
  for (const p of packages.ready) args.push("--extension", join(npmDir, "node_modules", p.name));
  const out: Record<string, string> = {
    KERNAL_TAPE: tape.id,
    KERNAL_TAPE_HASH: tapeHash(tape),
    KERNAL_TAPE_MEMORY: tape.memory ?? "off",
    KERNAL_TAPE_AGENT_ENGINE: tape.agentEngine ? "1" : "0",
    KERNAL_TAPE_HTML: tape.allowExternalHtmlResources === true ? "external" : "sealed",
  };
  const notes: string[] = [];
  const missing = missingEnv(tape, env);
  if (missing.length) notes.push(`env the tape expects is not set here: ${missing.join(", ")} (set it in your .env; Outfitter never sends values)`);
  if (packages.missing.length) notes.push(`not installed, so not loaded: ${packages.missing.map((p) => p.spec).join(", ")}`);
  if (packages.refused.length) notes.push(`never installed on a laptop (only npm: packages with an exact version are): ${packages.refused.join(", ")}`);
  const ignored = CLOUD_ONLY_FIELDS.filter((k) => tape[k] !== undefined && tape[k] !== false);
  if (ignored.length) notes.push(`cloud only, ignored here: ${ignored.join(", ")}`);
  return { args, env: out, notes };
}

/** The warning for playing `tape` in `repo` (the working directory's, or none), when its `repos`
 * hint names others. Never a refusal. */
export function repoWarning(tape: Pick<Tape, "id" | "repos">, repo: string | undefined): string | undefined {
  if (!tape.repos?.length) return undefined;
  if (!repo) return `tape ${tape.id} is meant for ${tape.repos.join(", ")}; this directory has no GitHub repo`;
  return tape.repos.includes(repo) ? undefined : `tape ${tape.id} is meant for ${tape.repos.join(", ")}, not ${repo}`;
}

/** The tape's prompts as 0600 files under `dir`/<hash>/, written once per version. */
export function promptFiles(tape: Tape, dir: string): { systemPrompt?: string; appendSystemPrompt?: string } {
  const out: { systemPrompt?: string; appendSystemPrompt?: string } = {};
  const base = join(dir, tapeHash(tape).slice(0, 32));
  for (const [k, name] of [["systemPrompt", "system.md"], ["appendSystemPrompt", "append.md"]] as const) {
    const text = tape[k];
    if (!text) continue;
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const file = join(base, name);
    writeFileSync(file, text, { mode: 0o600 });
    out[k] = file;
  }
  return out;
}

// ---------- showing a tape ----------

function firstLine(text: string | undefined, max = 100): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const lines = (text: string | undefined) => (text ? text.split("\n").length : 0);

/** One line per thing the tape does here, for the TUI and the terminal. */
export function summaryLines(tape: Tape, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  out.push(`tape ${tape.id}${tape.name !== tape.id ? ` "${tape.name}"` : ""}${tape.updatedAt ? `, changed in the cloud ${tape.updatedAt.slice(0, 16).replace("T", " ")}` : ""}`);
  out.push(`model: ${tape.model}${tape.thinking ? `, thinking ${tape.thinking}` : ""}${tape.fallbackModel ? ` (fallback ${tape.fallbackModel}, on Ctrl+P)` : ""}`);
  out.push(`tools: ${tape.tools?.length ? tape.tools.join(", ") : "all of Kernal's"}`);
  const excluded = tapeExcludeTools(tape);
  if (excluded.length) out.push(`excluded tools: ${excluded.join(", ")}`);
  out.push(`memory: ${tape.memory ?? "off"}${tape.memory ? " (Agent Engine memory, shared with your Drives, for this session)" : " (Agent Engine memory off for this session)"}`);
  if (tape.agentEngine) out.push("agentEngine: on (the agent_engine tool; every invoke and resume waits for your yes on the Outfitter web page)");
  if (tape.adminTools) out.push(`adminTools: ${tape.adminTools} (nothing extra: your Dongle's admin tools, checked by Outfitter)`);
  if (tape.packages?.length) out.push(`packages: ${tape.packages.join(", ")} (npm, exact versions only, installed on your yes, scripts off)`);
  if (tape.envNames?.length) {
    const missing = missingEnv(tape, env);
    out.push(`env it expects: ${tape.envNames.join(", ")}${missing.length ? ` (not set here: ${missing.join(", ")})` : ""}`);
  }
  if (tape.repos?.length) out.push(`meant for: ${tape.repos.join(", ")} (a hint; it plays anywhere)`);
  if (tape.allowExternalHtmlResources) out.push("HTML previews: external CSS and JS allowed");
  out.push(tape.systemPrompt ? `system prompt (replaces Kernal's): ${lines(tape.systemPrompt)} lines, "${firstLine(tape.systemPrompt)}"` : "system prompt: Kernal's own");
  if (tape.appendSystemPrompt) out.push(`appended prompt: ${lines(tape.appendSystemPrompt)} lines, "${firstLine(tape.appendSystemPrompt)}"`);
  const ignored = CLOUD_ONLY_FIELDS.filter((k) => tape[k] !== undefined && tape[k] !== false);
  if (ignored.length) out.push(`ignored here (cloud only): ${ignored.map((k) => `${k} (${CLOUD_ONLY_WHY[k]})`).join("; ")}`);
  return out;
}

/** The full prompts, for "show me". */
export function promptText(tape: Tape): string {
  const parts: string[] = [];
  parts.push(tape.systemPrompt ? `--- system prompt ---\n${tape.systemPrompt}` : "--- system prompt: Kernal's own ---");
  if (tape.appendSystemPrompt) parts.push(`--- appended prompt ---\n${tape.appendSystemPrompt}`);
  return parts.join("\n\n");
}

// ---------- the diff ----------

export type LineOp = { op: " " | "+" | "-"; text: string };

/** A line diff (LCS), capped: past ~4M cells it falls back to all-removed, all-added. */
export function lineDiff(before: string | undefined, after: string | undefined): LineOp[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

export interface FieldChange {
  field: TapeField;
  before?: unknown;
  after?: unknown;
  /** For the prompts: line by line. */
  lines?: LineOp[];
  /** Names added and removed, for the lists. */
  added?: string[];
  removed?: string[];
  cloudOnly?: boolean;
}

const PROMPTS: readonly TapeField[] = ["systemPrompt", "appendSystemPrompt"];
const LISTS: readonly TapeField[] = ["tools", "excludeTools", "packages", "envNames", "repos"];

/** What changed from the pinned tape to the cloud's, field by field. */
export function diffTapes(pinned: Tape, cloud: Tape): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of TAPE_FIELDS) {
    const a = pinned[field];
    const b = cloud[field];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const change: FieldChange = { field, before: a, after: b, ...(CLOUD_ONLY_FIELDS.includes(field) ? { cloudOnly: true } : {}) };
    if (PROMPTS.includes(field)) change.lines = lineDiff(a as string | undefined, b as string | undefined);
    if (LISTS.includes(field)) {
      const x = (a as string[] | undefined) ?? [];
      const y = (b as string[] | undefined) ?? [];
      change.added = y.filter((s) => !x.includes(s));
      change.removed = x.filter((s) => !y.includes(s));
    }
    out.push(change);
  }
  return out;
}

const show = (v: unknown) => (v === undefined ? "(unset)" : Array.isArray(v) ? (v.length ? v.join(", ") : "(none)") : String(v));

/** The diff as text: a line per field, the prompts as +/- lines (unchanged ones folded). */
export function formatDiff(changes: FieldChange[], context = 2): string {
  if (!changes.length) return "no changes";
  const out: string[] = [];
  for (const c of changes) {
    const tag = c.cloudOnly ? " (cloud only, ignored here)" : "";
    if (c.lines) {
      out.push(`${c.field}:${tag}`);
      c.lines.forEach((l, i) => {
        if (l.op !== " ") return out.push(`  ${l.op} ${l.text}`);
        const near = c.lines!.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== " ");
        if (near) out.push(`    ${l.text}`);
        else if (out[out.length - 1] !== "    …") out.push("    …");
      });
    } else if (c.added || c.removed) {
      const parts = [...(c.added ?? []).map((s) => `+${s}`), ...(c.removed ?? []).map((s) => `-${s}`)];
      out.push(`${c.field}: ${parts.join(", ")}${tag}`);
    } else out.push(`${c.field}: ${show(c.before)} → ${show(c.after)}${tag}`);
  }
  return out.join("\n");
}

// ---------- the review ----------

/** `offline`: Outfitter wasn't reached, so the pinned version may play. Anything else (the tape is
 * gone, the Dongle refused, a tape Kernal can't read) is said as it is and nothing plays (review). */
export type FetchTape = (id: string) => Promise<{ ok: true; tape: Tape } | { ok: false; error: string; offline?: boolean }>;

const OFFLINE = /unreachable|did not answer in time|cancelled|no Dongle/;

/** Asks the person. Undefined: nobody to ask (print mode, no terminal). */
export interface Reviewer {
  /** First play: pin this tape? */
  pin(tape: Tape, summary: string[]): Promise<boolean>;
  /** The cloud version differs from the pin: use it (and pin it)? */
  change(pinned: Pin, cloud: Tape, changes: FieldChange[]): Promise<boolean>;
}

export interface Review {
  ok: boolean;
  /** The version to play. */
  tape?: Tape;
  pin?: Pin;
  /** Played from the pin without reaching Outfitter. */
  offline?: boolean;
  /** The cloud has a newer version that isn't played. */
  behind?: boolean;
  notes: string[];
  error?: string;
}

/** The pin for `ref` when Outfitter can't be asked: the exact id only (review). */
function pinFor(dir: string, ref: string): Pin | undefined {
  return readPin(dir, ref);
}

/**
 * Decides which version of tape `ref` plays, asking the person where a decision is theirs: the
 * cloud's when it is the pinned one (or they pin it now), the pinned one when they keep it or
 * Outfitter can't be reached, nothing when an unpinned tape can't be reviewed.
 */
export async function reviewTape(ref: string, deps: { dir: string; fetch?: FetchTape; reviewer?: Reviewer; env?: NodeJS.ProcessEnv; now?: () => Date; reaskKept?: boolean }): Promise<Review> {
  const now = deps.now ?? (() => new Date());
  const cloud: { ok: true; tape: Tape } | { ok: false; error: string; offline?: boolean } = deps.fetch
    ? await deps.fetch(ref).catch((e) => ({ ok: false as const, error: String(e?.message ?? e), offline: true }))
    : { ok: false as const, error: "no Dongle (OUTFITTER_API and OUTFITTER_TOKEN)", offline: true };
  if (!cloud.ok) {
    const pin = pinFor(deps.dir, ref);
    if (!cloud.offline) return { ok: false, notes: [], error: `tape ${ref}: ${cloud.error}${pin ? "; the pinned version doesn't play while Outfitter says so" : ""}` };
    if (!pin) return { ok: false, notes: [], error: `tape ${ref}: ${cloud.error}; and it isn't pinned on this laptop, so there is nothing to play` };
    return { ok: true, tape: pin.tape, pin, offline: true, notes: [`Outfitter not reached (${cloud.error}); playing the pinned version ${shortHash(pin.hash)} from ${pin.pinnedAt.slice(0, 10)}`] };
  }
  const tape = cloud.tape;
  const hash = tapeHash(tape);
  const pin = readPin(deps.dir, tape.id);
  if (pin && pin.hash === hash) return { ok: true, tape: pin.tape, pin, notes: [] };
  if (!pin) {
    if (!deps.reviewer) return { ok: false, notes: [], error: `tape ${tape.id} isn't pinned on this laptop yet; review it first (kernal --tape ${tape.id} in a terminal, /tape ${tape.id}, or /admin tapes)` };
    if (!(await deps.reviewer.pin(tape, summaryLines(tape, deps.env)))) return { ok: false, notes: [], error: `tape ${tape.id} not pinned; nothing played` };
    const fresh = writePin(deps.dir, tape, now());
    return { ok: true, tape, pin: fresh, notes: [`pinned tape ${tape.id} at ${shortHash(fresh.hash)}`] };
  }
  const changes = diffTapes(pin.tape, tape);
  // Kept already, for this very version: not asked again at every start (/tape <id> re-asks).
  if (pin.seen?.kept && pin.seen.hash === hash && !deps.reaskKept) {
    return { ok: true, tape: pin.tape, pin, behind: true, notes: [`tape ${tape.id} changed in the cloud and you kept the pinned version ${shortHash(pin.hash)}; /tape ${tape.id} reviews it again`] };
  }
  if (deps.reviewer && (await deps.reviewer.change(pin, tape, changes))) {
    const fresh = writePin(deps.dir, tape, now());
    return { ok: true, tape, pin: fresh, notes: [`pinned the new version of tape ${tape.id} (${shortHash(fresh.hash)})`] };
  }
  const kept = noteSeen(deps.dir, pin, tape, !!deps.reviewer, now());
  return {
    ok: true,
    tape: pin.tape,
    pin: kept,
    behind: true,
    notes: [
      deps.reviewer
        ? `kept the pinned version ${shortHash(pin.hash)} of tape ${tape.id}`
        : `tape ${tape.id} changed in the cloud; playing the pinned version ${shortHash(pin.hash)} (review the change with /tape ${tape.id} or /admin tapes)`,
    ],
  };
}

/** A FetchTape over the admin transport (outfitter-admin/transport.ts). */
export function transportFetch(transport: { call(op: string, args: Record<string, unknown>, opts?: any): Promise<{ ok: true; text: string } | { ok: false; error: string }> }): FetchTape {
  return async (id) => {
    const reply = await transport.call("tapes.get", { id, format: "json" });
    if (!reply.ok) return { ok: false, error: reply.error, ...(OFFLINE.test(reply.error) ? { offline: true } : {}) };
    return parseTape(reply.text);
  };
}

export interface CloudRow {
  id: string;
  name: string;
  model: string;
  updatedAt?: string;
  memory?: string;
  agentEngine?: boolean;
  adminTools?: string;
}

/** tapes.list `format: "json"`. */
export async function listCloudTapes(transport: { call(op: string, args: Record<string, unknown>, opts?: any): Promise<{ ok: true; text: string } | { ok: false; error: string }> }): Promise<{ ok: true; tapes: CloudRow[] } | { ok: false; error: string }> {
  const reply = await transport.call("tapes.list", { format: "json", limit: 100 });
  if (!reply.ok) return reply;
  try {
    const v = JSON.parse(reply.text);
    if (v?.kind !== "tapes" || !Array.isArray(v.tapes)) throw new Error();
    const tapes = v.tapes
      .filter((t: any) => typeof t?.id === "string" && TAPE_ID.test(t.id) && typeof t.model === "string")
      .map((t: any) => ({ id: t.id, name: typeof t.name === "string" ? t.name : t.id, model: t.model, ...(typeof t.updatedAt === "string" ? { updatedAt: t.updatedAt } : {}), ...(typeof t.memory === "string" ? { memory: t.memory } : {}), ...(t.agentEngine === true ? { agentEngine: true } : {}), ...(typeof t.adminTools === "string" ? { adminTools: t.adminTools } : {}) }));
    return { ok: true, tapes };
  } catch {
    return { ok: false, error: "this Outfitter can't list tapes for a laptop yet (needs a newer release)" };
  }
}

// ---------- the active tape setting ----------

/** `kernal.tape` in settings.json: the tape new sessions play. Undefined: none. */
export function activeTape(settings: Record<string, unknown>): string | undefined {
  const k = settings.kernal as Record<string, unknown> | undefined;
  const t = k?.tape;
  return typeof t === "string" && TAPE_ID.test(t) ? t : undefined;
}

/** The tape this pi process plays (bin/kernal sets KERNAL_TAPE*), if any. */
export function playing(env: NodeJS.ProcessEnv = process.env): { id: string; hash: string; memory: MemoryLevel; agentEngine: boolean } | undefined {
  const id = env.KERNAL_TAPE?.trim();
  if (!id || !TAPE_ID.test(id)) return undefined;
  const memory = env.KERNAL_TAPE_MEMORY === "tool" || env.KERNAL_TAPE_MEMORY === "auto" ? env.KERNAL_TAPE_MEMORY : "off";
  return { id, hash: env.KERNAL_TAPE_HASH ?? "", memory, agentEngine: env.KERNAL_TAPE_AGENT_ENGINE === "1" };
}
