/**
 * The /admin Subagents page's backend: the models pi-subagents uses (settings) and the agent
 * definitions themselves (Markdown files with YAML frontmatter).
 *
 * Nothing about agents is reimplemented here. Discovery, parsing, validation and the file writes are
 * pi-subagents' own code, loaded from the installed package: discoverAgents / discoverAgentsAll for
 * what exists and what wins, parseFrontmatter for reading a file, and the same create / update /
 * eject / delete handlers its `subagent` tool runs. What this file adds is the admin's own rules on
 * top: a name is a file name, so it is checked before the package sees it; only files inside the
 * user or project agents directory are ever written; a file holding a key is never sent to the page;
 * and after every write the package re-discovers the agent and the result is compared with what the
 * page asked for, so a change the package would silently ignore is rolled back and reported instead.
 *
 * Where user agents live: pi-subagents' user scope is $PI_CODING_AGENT_DIR/agents. In a release
 * bundle that is inside the versioned directory, so install.sh links it to ~/.kernal/state/agents and
 * agents survive upgrades like sessions do. In a source checkout it is kernal/.pi/agents, which is
 * git-ignored so personal agents are never committed. kernal ships no agents of its own; if it ever
 * does, they belong in their own directory listed under `subagents.agentScanDirs` in the shipped
 * settings, where this page treats them as read-only (they are outside the user and project dirs).
 */
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readSettings, settingsPath, updateSettings } from "../connect/settings.ts";
import { leaksSecret } from "./lib.ts";
import { env } from "../_shared/env.ts";
import { cliInfo, type CliInfo } from "../kernal-subagents/lib.ts";
import { excludeToolsFor } from "../kernal-github/confirm.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
/** pi's own tools; extension tools come from the running agent and from what agents already name. */
export const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const MAX_PROMPT = 48 * 1024;

type Scope = "user" | "project";
type Source = "builtin" | "package" | "user" | "project" | "runtime";
type AgentConfig = {
  name: string; description: string; source: Source; filePath: string; model?: string; thinking?: string | false;
  tools?: string[]; mcpDirectTools?: string[]; systemPrompt: string; systemPromptMode?: string; inheritProjectContext?: boolean; inheritSkills?: boolean;
  disabled?: boolean; override?: { fields?: string[] }; modelSource?: { type: string }; aliases?: string[];
  runner?: { type: string; adapter?: string; command?: string }; acceptanceRole?: string; machine?: string;
};
type Pkg = {
  agents: { discoverAgents: Function; discoverAgentsAll: Function; clearAgentDiscoveryCache: Function };
  mgmt: { handleManagementAction: (action: string, params: any, ctx: any) => { content: { text: string }[]; isError?: boolean } };
  fm: { parseFrontmatter: (text: string) => { frontmatter: Record<string, string>; body: string }; parseFrontmatterList: (raw?: string) => string[] | undefined };
  /** Whether a command-line agent's program is on PATH (the package's own check; it starts nothing). */
  /** Undefined when a pi-subagents release moved the module: then "installed" is unknown, and nothing else breaks. */
  cli?: { resolveExternalCliBinaryAvailability: (command: string, env: NodeJS.ProcessEnv) => { available: boolean; unavailableReason?: string } };
};

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
/** The installed package, where kernal-codebase-index finds its package too. KERNAL_SUBAGENTS_PKG for tests. */
export const packageDir = () => env("SUBAGENTS_PKG") || join(agentDir(), "npm", "node_modules", "pi-subagents");

let loaded: { dir: string; pkg: Promise<Pkg> } | undefined;
export function loadPackage(): Promise<Pkg> {
  const dir = packageDir();
  if (loaded?.dir === dir) return loaded.pkg;
  const mod = (f: string) => import(pathToFileURL(join(dir, "src", "agents", f)).href);
  const pkg = (async () => {
    if (!existsSync(join(dir, "src", "agents", "agents.js"))) throw new Error(`pi-subagents is not installed (${dir})`);
    const [agents, mgmt, fm, cli] = await Promise.all([mod("agents.js"), mod("agent-management.js"), mod("frontmatter.js"),
      import(pathToFileURL(join(dir, "src", "runs", "shared", "external-cli-preflight.js")).href).catch(() => undefined)]);
    return { agents, mgmt, fm, cli } as Pkg;
  })();
  loaded = { dir, pkg };
  pkg.catch(() => { if (loaded?.pkg === pkg) loaded = undefined; });
  return pkg;
}

// ---------- names, paths, secrets ----------

/**
 * An agent name becomes `<name>.md` on disk, so it is held to the package's own sanitised form
 * (lower-case letters, digits, hyphens) and refused, not silently rewritten, when it is anything else.
 */
export function nameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.trim()) return "a name is required";
  if (/[\/\\]/.test(name) || name.includes("..") || name.includes("\0")) return "a name cannot contain slashes or dots: it becomes the file name";
  if (name.length > 64) return "at most 64 characters";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return "lower-case letters, digits and hyphens only, starting with a letter or digit";
  return undefined;
}

/** True when `file` resolves (symlinks followed, as the OS will) to a place inside `dir`. */
export function isInside(dir: string | null | undefined, file: string): boolean {
  if (!dir) return false;
  const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
  const d = real(dir);
  const f = real(file) ?? (real(dirname(file)) ? join(real(dirname(file))!, file.slice(dirname(file).length + 1)) : undefined);
  if (!d || !f) return false;
  const rel = relative(d, f);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

const KEY_SHAPES = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/;
/** A key the agent holds (from the environment) or anything shaped like a well-known key. */
export const carriesSecret = (text: string, secrets: string[]) => leaksSecret(text, secrets) || KEY_SHAPES.test(text);

// ---------- the view ----------

export type AgentRow = {
  name: string; description: string; source: Source; file: string; editable: boolean; active: boolean; shadowedBy?: Source;
  model?: string; modelFrom: "agent file" | "override" | "subagents default" | "parent" | "its own CLI"; thinking?: string; tools?: string[];
  aliases?: string[]; disabled?: boolean; withheld?: boolean;
  /** Set for a command-line agent: it runs this program, which picks its own model, so model, thinking and tools are unset. */
  cli?: Cli;
};
/** A command-line agent's program, and whether it is installed (on PATH; that is not proof it is logged in). */
export type Cli = CliInfo & { installed: boolean; reason?: string; unknown?: boolean; machine?: string };

function cliOf(pkg: Pkg, a: AgentConfig): Cli | undefined {
  const info = cliInfo(a);
  if (!info) return undefined;
  // Placed on another machine (Herdr): it runs there over ssh, so this machine's PATH says nothing about it.
  if (a.machine) return { ...info, installed: false, unknown: true, machine: a.machine, reason: `runs on ${a.machine}; not checked from here` };
  if (!pkg.cli) return { ...info, installed: false, unknown: true, reason: "this pi-subagents version has no installed check" };
  let found: { available: boolean; unavailableReason?: string } = { available: false };
  try { found = pkg.cli.resolveExternalCliBinaryAvailability(info.command, process.env); } catch (e: any) { found = { available: false, unavailableReason: String(e?.message ?? e) }; }
  return { ...info, installed: !!found.available, reason: found.available ? undefined : found.unavailableReason };
}

const SOURCE_RANK: Record<string, number> = { builtin: 0, package: 1, user: 2, project: 3, runtime: 4 };

function modelFrom(a: AgentConfig): AgentRow["modelFrom"] {
  if (cliInfo(a)) return "its own CLI";
  if (a.override?.fields?.includes("model")) return "override";
  if (a.modelSource?.type === "subagents.defaultModel") return "subagents default";
  return a.model ? "agent file" : "parent";
}
const toolsOf = (a: AgentConfig) => (a.tools || a.mcpDirectTools ? [...(a.tools ?? []), ...(a.mcpDirectTools ?? []).map((t) => `mcp:${t}`)] : undefined);

export type Dirs = { user: string; project: string | null };

export type Snapshot = { rows: AgentRow[]; dirs: Dirs; diagnostics: { file: string; error: string }[]; effective: Map<string, AgentConfig>; all: any; cli: (a: AgentConfig) => Cli | undefined };

/** Every definition the package finds, which one wins for each name, and where each comes from. */
export async function snapshot(cwd: string, provider: string | undefined, secrets: string[]): Promise<Snapshot> {
  const pkg = await loadPackage();
  const { agents } = pkg;
  agents.clearAgentDiscoveryCache();
  const all = agents.discoverAgentsAll(cwd, provider);
  const effectiveList: AgentConfig[] = agents.discoverAgents(cwd, "both", provider).agents;
  const effective = new Map(effectiveList.map((a) => [a.name, a]));
  const dirs: Dirs = { user: all.userDir, project: all.projectDir };
  // One file can be both user and project (a checkout: the agent dir is inside the project); keep the higher.
  const byFile = new Map<string, AgentConfig>();
  for (const a of [...all.builtin, ...all.package, ...all.user, ...all.project] as AgentConfig[]) {
    let key = a.filePath; try { key = realpathSync(a.filePath); } catch {}
    const prev = byFile.get(key);
    if (!prev || SOURCE_RANK[a.source] > SOURCE_RANK[prev.source]) byFile.set(key, a);
  }
  const rows: AgentRow[] = [];
  for (const a of byFile.values()) {
    const win = effective.get(a.name);
    const active = !!win && win.filePath === a.filePath;
    const shown = active ? win! : a;
    let withheld = false;
    try { withheld = carriesSecret(readFileSync(a.filePath, "utf8"), secrets); } catch {}
    const cli = cliOf(pkg, shown);
    rows.push({
      name: a.name, description: withheld ? "" : shown.description, source: a.source, file: a.filePath,
      editable: (a.source === "user" && isInside(dirs.user, a.filePath)) || (a.source === "project" && isInside(dirs.project, a.filePath)),
      active, shadowedBy: !active && win ? win.source : undefined,
      model: cli ? undefined : shown.model, modelFrom: modelFrom(shown),
      thinking: cli ? undefined : shown.thinking === false ? "off" : shown.thinking || undefined, tools: cli ? undefined : toolsOf(shown),
      aliases: shown.aliases, disabled: !win || undefined, withheld: withheld || undefined, cli,
    });
  }
  rows.sort((x, y) => x.name.localeCompare(y.name) || SOURCE_RANK[y.source] - SOURCE_RANK[x.source]);
  const diagnostics = (all.agentDiagnostics ?? []).map((d: any) => ({ file: d.filePath, error: String(d.error) }));
  return { rows, dirs, diagnostics, effective, all, cli: (a: AgentConfig) => cliOf(pkg, a) };
}

/** What the page shows about how the package resolves one name now. */
export function resolvedView(snap: Snapshot, name: string) {
  const a = snap.effective.get(name);
  if (!a) return { name, found: false as const };
  const cli = snap.cli(a);
  return {
    name, found: true as const, source: a.source, file: a.filePath, description: a.description, model: cli ? undefined : a.model, modelFrom: modelFrom(a),
    thinking: cli ? undefined : a.thinking === false ? "off" : a.thinking || undefined, tools: cli ? undefined : toolsOf(a), promptChars: (a.systemPrompt ?? "").length,
    systemPromptMode: a.systemPromptMode, inheritProjectContext: a.inheritProjectContext, inheritSkills: a.inheritSkills, cli,
  };
}

/** One definition file, as the editor needs it: the frontmatter as fields, the rest as the prompt. */
export async function readAgent(snap: Snapshot, name: string, source: string, secrets: string[]) {
  const { fm } = await loadPackage();
  const row = snap.rows.find((r) => r.name === name && r.source === source);
  if (!row) return undefined;
  const text = readFileSync(row.file, "utf8");
  if (carriesSecret(text, secrets)) return { row, withheld: true as const };
  const { frontmatter, body } = fm.parseFrontmatter(text);
  const known = ["name", "description", "tools", "model", "thinking", "systemPromptMode", "inheritProjectContext", "inheritSkills", "githubTools"];
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(frontmatter)) if (!known.includes(k)) extra[k] = v;
  const bool = (v: string | undefined) => (v === undefined ? undefined : v.trim() === "true");
  // Missing, or anything other than the three choices, is off. Shipped roles omit the key.
  const githubTools: GithubTools = frontmatter.githubTools === "read" || frontmatter.githubTools === "full" ? frontmatter.githubTools : "off";
  return {
    row, withheld: false as const,
    fields: {
      name: frontmatter.name ?? name, description: frontmatter.description ?? "",
      tools: frontmatter.tools === undefined ? null : fm.parseFrontmatterList(frontmatter.tools) ?? [],
      model: frontmatter.model ?? "", thinking: frontmatter.thinking ?? "",
      systemPromptMode: frontmatter.systemPromptMode ?? "", inheritProjectContext: bool(frontmatter.inheritProjectContext), inheritSkills: bool(frontmatter.inheritSkills),
      githubTools,
    },
    extra, prompt: body.replace(/^\n+/, ""),
  };
}

// ---------- writes ----------

/** This agent's GitHub tools. Stored only as frontmatter `githubTools`; missing means off. */
export type GithubTools = "off" | "read" | "full";

export type AgentEdit = {
  mode: "create" | "update"; scope: Scope; name: string; original?: string;
  description: string; tools: string[] | null; model: string; thinking: string;
  systemPromptMode?: string; inheritProjectContext?: boolean; inheritSkills?: boolean; prompt: string;
  githubTools?: GithubTools;
};

const MODEL_RE = /^[A-Za-z0-9._-]+\/[^\s,]+$/;
const TOOL_RE = /^(mcp:)?[A-Za-z0-9_.\/-]+$/;

/** Field-level problems with what the page sent; the package validates again when it writes. */
export function validateEdit(e: any, secrets: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (e?.mode !== "create" && e?.mode !== "update") errors.mode = "create or update";
  if (e?.scope !== "user" && e?.scope !== "project") errors.scope = "user or project";
  const np = nameProblem(e?.name); if (np) errors.name = np;
  if (e?.mode === "update") { const op = nameProblem(e?.original); if (op) errors.original = op; }
  if (typeof e?.description !== "string" || !e.description.trim()) errors.description = "a description is required: it is how the parent agent decides when to delegate";
  else if (/[\r\n]/.test(e.description)) errors.description = "one line";
  else if (e.description.length > 500) errors.description = "at most 500 characters";
  if (e?.tools !== null && e?.tools !== undefined) {
    if (!Array.isArray(e.tools) || !e.tools.every((t: unknown) => typeof t === "string")) errors.tools = "a list of tool names";
    else { const bad = e.tools.filter((t: string) => !TOOL_RE.test(t)); if (bad.length) errors.tools = `not a tool name: ${bad.slice(0, 3).join(", ")}`; else if (!e.tools.length) errors.tools = "pick at least one tool, or use the default tools"; }
  }
  if (e?.githubTools !== undefined && e.githubTools !== "off" && e.githubTools !== "read" && e.githubTools !== "full") errors.githubTools = "off, read, or full";
  if (typeof e?.model !== "string" || (e.model && !MODEL_RE.test(e.model.trim()))) errors.model = "a provider/model id, e.g. litellm/claude-sonnet-5";
  if (typeof e?.thinking !== "string" || (e.thinking && !THINKING_LEVELS.includes(e.thinking))) errors.thinking = `one of ${THINKING_LEVELS.join(", ")}`;
  if (e?.systemPromptMode !== undefined && e.systemPromptMode !== "" && e.systemPromptMode !== "replace" && e.systemPromptMode !== "append") errors.systemPromptMode = "replace or append";
  for (const k of ["inheritProjectContext", "inheritSkills"]) if (e?.[k] !== undefined && typeof e[k] !== "boolean") errors[k] = "on or off";
  if (typeof e?.prompt !== "string") errors.prompt = "the prompt is text";
  else if (e.prompt.length > MAX_PROMPT) errors.prompt = `at most ${MAX_PROMPT / 1024} KB`;
  else if (carriesSecret(e.prompt, secrets)) errors.prompt = "this looks like it contains a key; agent prompts are sent to model providers, so keys never belong in them";
  for (const k of ["name", "description", "model"]) if (!errors[k] && typeof e?.[k] === "string" && carriesSecret(e[k], secrets)) errors[k] = "looks like a key";
  return errors;
}

/** What the package's create/update handlers take, from what the page sent. */
function packageConfig(e: AgentEdit) {
  const tools = e.tools && e.tools.length ? e.tools.join(", ") : false;
  const cfg: Record<string, unknown> = {
    name: e.name, description: e.description.trim(), tools, model: e.model.trim() || false, thinking: e.thinking || false, systemPrompt: e.prompt.replace(/\s+$/, "") + "\n",
  };
  if (e.systemPromptMode) cfg.systemPromptMode = e.systemPromptMode;
  if (e.inheritProjectContext !== undefined) cfg.inheritProjectContext = e.inheritProjectContext;
  if (e.inheritSkills !== undefined) cfg.inheritSkills = e.inheritSkills;
  return cfg;
}

export class AgentError extends Error {
  status: number; errors?: Record<string, string>;
  constructor(status: number, message: string, errors?: Record<string, string>) { super(message); this.status = status; this.errors = errors; }
}

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

/** The editable definition named `name` in `scope`, if there is one; throws when it is outside the agents dirs. */
function editableTarget(snap: Snapshot, name: string, scope: Scope): AgentRow | undefined {
  const row = snap.rows.find((r) => r.name === name && r.source === scope);
  if (row && !row.editable) throw new AgentError(403, `${name} lives outside the ${scope} agents directory (${row.file}); edit it there`);
  return row;
}
const dirFor = (snap: Snapshot, scope: Scope) => (scope === "user" ? snap.dirs.user : snap.dirs.project);

/**
 * Create or update an agent through pi-subagents' own handlers, then re-discover it and check the
 * package now holds exactly what was asked for. Anything else is undone and reported.
 */
export async function saveAgent(ctx: { cwd: string; modelRegistry: any; model?: any }, e: AgentEdit, secrets: string[]) {
  const { mgmt, fm } = await loadPackage();
  const provider = ctx.model?.provider;
  const before = await snapshot(ctx.cwd, provider, secrets);
  const target = e.mode === "update" ? editableTarget(before, e.original!, e.scope) : undefined;
  if (e.mode === "update" && !target) throw new AgentError(404, `no ${e.scope} agent named ${e.original}`);
  if (e.mode === "create" && before.rows.some((r) => r.name === e.name && r.source === e.scope)) throw new AgentError(409, `a ${e.scope} agent named ${e.name} already exists`, { name: "already exists in this scope" });
  if (e.mode === "update" && e.name !== e.original && before.rows.some((r) => r.name === e.name && r.source === e.scope)) throw new AgentError(409, `a ${e.scope} agent named ${e.name} already exists`, { name: "already exists in this scope" });
  const dir = dirFor(before, e.scope) ?? join(ctx.cwd, ".pi", "agents");
  const expectedFile = join(dir, `${e.name}.md`);
  if (dirFor(before, e.scope) && !isInside(dir, expectedFile) && existsSync(dir)) throw new AgentError(400, "that name would write outside the agents directory", { name: "not a safe file name" });
  const undo = target ? { file: target.file, content: readFileSync(target.file, "utf8") } : undefined;

  const cfg = packageConfig(e);
  const r = e.mode === "create"
    ? mgmt.handleManagementAction("create", { config: { ...cfg, scope: e.scope } }, ctx)
    : mgmt.handleManagementAction("update", { agent: e.original, agentScope: e.scope, config: cfg }, ctx);
  if (r.isError) throw new AgentError(422, text(r));
  const message = text(r);

  const after = await snapshot(ctx.cwd, provider, secrets);
  const saved = after.rows.find((x) => x.name === e.name && x.source === e.scope);
  const problems: string[] = [];
  if (!saved) {
    const written = join(dirFor(after, e.scope) ?? dir, `${e.name}.md`);
    const diag = after.diagnostics.find((d) => d.file === written);
    problems.push(`pi-subagents does not find a ${e.scope} agent named ${e.name} after saving${diag ? ` (${diag.error})` : ", so it would be ignored"}`);
    if (existsSync(written) && written !== undo?.file) try { unlinkSync(written); } catch {}
  }
  else {
    if (!isInside(dirFor(after, e.scope), saved.file)) problems.push(`it was written outside the ${e.scope} agents directory`);
    const diag = after.diagnostics.find((d) => d.file === saved.file);
    if (diag) problems.push(`pi-subagents rejects the file: ${diag.error}`);
    const parsed = fm.parseFrontmatter(readFileSync(saved.file, "utf8"));
    const f = parsed.frontmatter;
    const listed = (fm.parseFrontmatterList(f.tools) ?? []).slice().sort().join(",");
    if ((f.description ?? "").trim() !== e.description.trim()) problems.push("the description did not stick");
    if ((f.model ?? "") !== e.model.trim()) problems.push(`the model reads back as "${f.model ?? ""}"`);
    if ((f.thinking ?? "") !== e.thinking) problems.push(`thinking reads back as "${f.thinking ?? ""}"`);
    if (listed !== (e.tools ?? []).slice().sort().join(",")) problems.push(`the tools read back as "${f.tools ?? "(default)"}"`);
    const all = [...after.all.user, ...after.all.project] as AgentConfig[];
    const config = all.find((a) => a.filePath === saved.file);
    if (!config || config.systemPrompt.trim() !== e.prompt.trim()) problems.push("the prompt the package reads differs from what was sent");
  }
  if (problems.length) {
    // Undo: put the old file back, or remove the new one.
    try {
      if (saved && (!undo || saved.file !== undo.file)) unlinkSync(saved.file);
      if (undo) writeFileSync(undo.file, undo.content);
    } catch {}
    (await loadPackage()).agents.clearAgentDiscoveryCache();
    throw new AgentError(422, `Not saved: ${problems.join("; ")}.`);
  }
  // pi-subagents only rewrites a frontmatter key it already knows. githubTools is ours, so it is
  // stamped after the package's write, once that write has been checked. A command-line agent does
  // not get these tools, and stamping excludeTools onto its file drops the user copy.
  if (saved && e.githubTools && !saved.cli) {
    try { stampGithubTools(saved.file, e.githubTools); }
    catch (err) {
      try {
        if (!undo || saved.file !== undo.file) unlinkSync(saved.file);
        if (undo) writeFileSync(undo.file, undo.content);
      } catch {}
      (await loadPackage()).agents.clearAgentDiscoveryCache();
      throw new AgentError(500, err instanceof Error ? err.message : String(err));
    }
  }
  return { message, resolved: resolvedView(after, e.name), row: saved, warnings: message.split("\n").filter((l) => /^(Warning|Note):/.test(l)) };
}

/** Put `githubTools` on the agent's frontmatter without touching the prompt or any other key. */
function stampGithubTools(file: string, value: GithubTools) {
  const text = readFileSync(file, "utf8");
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
  if (end < 0) throw new AgentError(500, "the agent file has no frontmatter to record GitHub access in");
  let block = text.slice(4, end);
  const line = `githubTools: ${value}`;
  block = /^githubTools:/m.test(block) ? block.replace(/^githubTools:[^\n]*$/gm, line) : `${block}\n${line}`;
  block = stampExcludeTools(block, value);
  writeFileSync(file, `---\n${block}${text.slice(end)}`);
}

/** A comma line (`a, b`) or a block list (`- a`), the same two shapes `parseFrontmatterList` accepts. */
function frontmatterList(raw: string): string[] {
  return raw.split("\n").flatMap((line) => {
    const value = line.trim();
    if (!value) return [];
    const item = /^-\s+(.+)$/.exec(value);
    return (item?.[1] ?? value).split(",");
  }).map((value) => value.trim()).filter(Boolean);
}

/**
 * Where `excludeTools` sits in a frontmatter block, including the indented lines of a block list.
 * A single-line value does not swallow the next key.
 */
function excludeToolsSpan(lines: string[]): { start: number; end: number; listed: string[] } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const match = /^excludeTools:[ \t]*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const inline = match[1] ?? "";
    let end = i + 1;
    const block: string[] = [];
    if (!inline.trim()) {
      while (end < lines.length) {
        const line = lines[end] ?? "";
        if (line.trim() === "") {
          const ahead = lines.slice(end + 1).find((next) => next.trim() !== "");
          if (ahead === undefined || !/^[ \t]/.test(ahead)) break;
        } else if (!/^[ \t]/.test(line)) break;
        block.push(line);
        end++;
      }
    }
    return { start: i, end, listed: frontmatterList(inline.trim() ? inline : block.join("\n")) };
  }
  return undefined;
}

/** Off adds the GitHub tool names to `excludeTools`, which pi-subagents already applies.
 *  Read and full take those names back off the list and leave every other denial in place.
 *  A block list is rewritten whole, so its indented names are not left behind. */
export function stampExcludeTools(block: string, mode: GithubTools): string {
  const lines = block.split("\n");
  const span = excludeToolsSpan(lines);
  const next = excludeToolsFor(mode, span?.listed ?? []);
  const line = next.length ? `excludeTools: ${next.join(", ")}` : "";
  if (!span) return line ? `${block.replace(/\n$/, "")}\n${line}` : block;
  const replacement = line ? [line] : [];
  lines.splice(span.start, span.end - span.start, ...replacement);
  return lines.join("\n");
}

/** Customise a builtin or package agent: the package's eject, a same-name copy in user or project scope. */
export async function customiseAgent(ctx: { cwd: string; modelRegistry: any; model?: any }, name: string, scope: Scope, secrets: string[]) {
  const np = nameProblem(name); if (np) throw new AgentError(400, np, { name: np });
  const { mgmt } = await loadPackage();
  const before = await snapshot(ctx.cwd, ctx.model?.provider, secrets);
  if (!before.rows.some((r) => r.name === name && (r.source === "builtin" || r.source === "package"))) throw new AgentError(404, `${name} is not a builtin or package agent`);
  if (before.rows.some((r) => r.name === name && r.source === scope)) throw new AgentError(409, `there is already a ${scope} copy of ${name}; edit that one`);
  const r = mgmt.handleManagementAction("eject", { agent: name, agentScope: scope }, ctx);
  if (r.isError) throw new AgentError(422, text(r));
  const after = await snapshot(ctx.cwd, ctx.model?.provider, secrets);
  const copy = after.rows.find((x) => x.name === name && x.source === scope);
  if (!copy || !copy.editable) throw new AgentError(500, "the copy is not where pi-subagents reads user agents");
  return { message: text(r), row: copy, resolved: resolvedView(after, name) };
}

/** Delete a user or project agent (the package's delete), and say what the name resolves to now. */
export async function deleteAgent(ctx: { cwd: string; modelRegistry: any; model?: any }, name: string, scope: Scope, secrets: string[]) {
  const np = nameProblem(name); if (np) throw new AgentError(400, np, { name: np });
  const { mgmt } = await loadPackage();
  const before = await snapshot(ctx.cwd, ctx.model?.provider, secrets);
  const target = editableTarget(before, name, scope);
  if (!target) throw new AgentError(404, `no ${scope} agent named ${name}`);
  const r = mgmt.handleManagementAction("delete", { agent: name, agentScope: scope }, ctx);
  if (r.isError) throw new AgentError(422, text(r));
  if (existsSync(target.file)) throw new AgentError(500, "the file is still there");
  const after = await snapshot(ctx.cwd, ctx.model?.provider, secrets);
  return { message: text(r), resolved: resolvedView(after, name) };
}

// ---------- settings: subagents.defaultModel and agentOverrides.<name>.{model,thinking} ----------

export type ModelSettingsEdit = { defaultModel?: string; overrides?: Record<string, { model?: string; thinking?: string }> };

export function validateModelSettings(body: any): Record<string, string> {
  const errors: Record<string, string> = {};
  if (body?.defaultModel !== undefined && (typeof body.defaultModel !== "string" || (body.defaultModel && !MODEL_RE.test(body.defaultModel)))) errors.defaultModel = "a provider/model id, or empty for the parent's model";
  const ov = body?.overrides;
  if (ov !== undefined && (!ov || typeof ov !== "object" || Array.isArray(ov))) errors.overrides = "an object of agent names";
  else for (const [name, o] of Object.entries<any>(ov ?? {})) {
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(name) || name.includes("..")) { errors[`${name}.model`] = "not an agent name"; continue; }
    if (!o || typeof o !== "object") { errors[`${name}.model`] = "expected model and thinking"; continue; }
    if (o.model !== undefined && (typeof o.model !== "string" || (o.model && !MODEL_RE.test(o.model)))) errors[`${name}.model`] = "a provider/model id, or empty for the default";
    if (o.thinking !== undefined && (typeof o.thinking !== "string" || (o.thinking && !THINKING_LEVELS.includes(o.thinking)))) errors[`${name}.thinking`] = `one of ${THINKING_LEVELS.join(", ")}, or empty`;
  }
  return errors;
}

/** The subagents block of the agent's settings, which is the user settings file pi-subagents reads. */
export function modelSettings() {
  const s = readSettings().subagents as any;
  return { file: settingsPath(), defaultModel: typeof s?.defaultModel === "string" ? s.defaultModel : "", overrides: (s?.agentOverrides && typeof s.agentOverrides === "object" ? s.agentOverrides : {}) as Record<string, any> };
}

/**
 * Write the models, then ask the package what each agent now resolves to. The write goes to the one
 * settings.json the upgrade merge carries forward (connect/settings.ts). If the package cannot read
 * the result, the file is put back.
 */
export async function saveModelSettings(ctx: { cwd: string; model?: any }, body: ModelSettingsEdit, secrets: string[]) {
  const file = settingsPath();
  // A command-line agent runs another tool with that tool's own model: an override would be saved and
  // then silently never used, so it is refused. Clearing one (an empty value) is always allowed.
  const before = await snapshot(ctx.cwd, ctx.model?.provider, secrets);
  const refused: Record<string, string> = {};
  for (const [name, o] of Object.entries(body.overrides ?? {})) {
    const a = before.effective.get(name), cli = a && before.cli(a);
    if (!cli) continue;
    for (const k of ["model", "thinking"] as const) if (o?.[k]) refused[`${name}.${k}`] = `${name} runs the ${cli.tool} CLI, which uses its own ${k === "model" ? "model" : "settings"}; set it in ${cli.tool}`;
  }
  if (Object.keys(refused).length) throw new AgentError(422, "Not saved: command-line agents choose their own model", refused);
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  updateSettings((s: any) => {
    const sub = (s.subagents && typeof s.subagents === "object" ? s.subagents : (s.subagents = {}));
    if (body.defaultModel !== undefined) { if (body.defaultModel) sub.defaultModel = body.defaultModel; else delete sub.defaultModel; }
    for (const [name, o] of Object.entries(body.overrides ?? {})) {
      const ov = (sub.agentOverrides && typeof sub.agentOverrides === "object" ? sub.agentOverrides : (sub.agentOverrides = {}));
      const entry = ov[name] && typeof ov[name] === "object" ? ov[name] : (ov[name] = {});
      for (const k of ["model", "thinking"] as const) if (o[k] !== undefined) { if (o[k]) entry[k] = o[k]; else delete entry[k]; }
      if (!Object.keys(entry).length) delete ov[name];
      if (!Object.keys(ov).length) delete sub.agentOverrides;
    }
    if (!Object.keys(sub).length) delete s.subagents;
  });
  try {
    const snap = await snapshot(ctx.cwd, ctx.model?.provider, secrets);
    const problems: string[] = [];
    const current = modelSettings();
    for (const [name, o] of Object.entries(body.overrides ?? {})) {
      const a = snap.effective.get(name);
      if (!a) continue;   // an override for an agent that is not here (another project's) is still kept
      const wanted = o.model || current.overrides[name]?.model;
      if (wanted && a.model !== wanted) problems.push(`${name} resolves to ${a.model ?? "the parent's model"}, not ${wanted}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
    return { snap, file };
  } catch (e: any) {
    if (previous !== undefined) writeFileSync(file, previous);
    throw new AgentError(422, `Not saved: ${e?.message ?? e}`);
  }
}
