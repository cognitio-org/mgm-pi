/**
 * Command-line agents: subagents whose runner is `external-cli`. They do not run a model through
 * Kernal. pi-subagents hands the task (with the agent's prompt) to another coding tool installed on
 * this machine, such as Claude Code, Codex or Cursor, and that tool answers with its own login, its
 * own model and the tools its adapter allows. Kernal's model settings never reach it.
 *
 * pi-subagents still attaches `subagents.defaultModel` to these agents and prints it, which reads as
 * if the router model ran them. This file is the one place that knows better: the admin uses
 * `cliInfo` to show them as what they are, and the `kernal-subagents` extension uses
 * `annotateSubagentText` to correct what the `subagent` tool tells the model.
 */

export type CliTool = { command: string; tool: string; install: string; docs: string };

/** The tools pi-subagents ships adapters for, keyed by the command it runs. */
export const CLI_TOOLS: Record<string, CliTool> = {
  claude: { command: "claude", tool: "Claude Code", install: "npm install -g @anthropic-ai/claude-code", docs: "https://docs.anthropic.com/en/docs/claude-code" },
  codex: { command: "codex", tool: "Codex", install: "npm install -g @openai/codex", docs: "https://github.com/openai/codex" },
  "cursor-agent": { command: "cursor-agent", tool: "Cursor", install: "curl https://cursor.com/install -fsS | bash", docs: "https://docs.cursor.com/en/cli/overview" },
};

/** The display name for a command: a known tool's name, or the command itself. */
export const toolName = (command: string) => CLI_TOOLS[command]?.tool ?? command;

export type CliInfo = { command: string; tool: string; adapter?: string; writes: boolean; install?: string; docs?: string };

/** What a discovered agent runs, when it runs another command-line tool; undefined for a normal pi agent. */
export function cliInfo(agent: { runner?: any; acceptanceRole?: string; name?: string }): CliInfo | undefined {
  const r = agent?.runner;
  if (!r || r.type !== "external-cli" || typeof r.command !== "string" || !r.command.trim()) return undefined;
  const command = r.command.trim();
  const known = CLI_TOOLS[command];
  return {
    command, tool: known?.tool ?? command, adapter: typeof r.adapter === "string" ? r.adapter : undefined,
    writes: agent.acceptanceRole === "writer" || /-writer$/.test(String(r.adapter ?? agent.name ?? "")),
    install: known?.install, docs: known?.docs,
  };
}

const ownModel = (tool: string) => `${tool}'s own (set in ${tool}; Kernal's model settings do not apply)`;
const PLAIN_SUFFIX = (tool: string) => ` [runs the ${tool} CLI with its own login and model]`;

/** One sentence the model reads before a list that holds command-line agents. */
export const CLI_NOTE =
  "Note from Kernal: agents marked external-cli run another coding tool installed on this machine " +
  "(Claude Code, Codex or Cursor). That tool uses its own login, model and tools, so the model shown by " +
  "pi-subagents does not apply to them. ✓ means the program is installed; it does not prove it is logged in. " +
  "Their runs are asynchronous: start one, then check its status.";

/** Name -> command for the command-line agents, for output that does not say which agents they are (`models`). */
export type CliNames = Map<string, string>;

/** A capabilities line, rewritten from the right so a description holding "; Model: " cannot be mistaken for the field. */
function rewriteFields(rest: string, tool: string): string {
  const m = rest.lastIndexOf("; Model: ");
  if (m < 0) return rest;
  const valueEnd = rest.indexOf(";", m + 2);
  let after = valueEnd < 0 ? "" : rest.slice(valueEnd);
  after = after.replace(/^; Thinking: [^;]*/, "");
  let before = rest.slice(0, m);
  const t = before.lastIndexOf("; Tools: ");   // Tools runs up to Model, including any "; excludes: ..."
  if (t >= 0) before = `${before.slice(0, t)}; Tools: ${tool}'s own, as its adapter allows`;
  return `${before}; Model: ${ownModel(tool)}${after}`;
}

/**
 * Corrects the `subagent` tool's list, get and models output for command-line agents: the model becomes
 * the tool's own, tools and thinking are the tool's, and a list gains one explanatory note. Lines for
 * normal agents, and any text this does not recognise, pass through unchanged. Running it twice changes
 * nothing the second time. `cli` (name -> command) is needed only for `models`, whose text never says
 * which agents run another tool.
 */
export function annotateSubagentText(text: string, cli?: CliNames): string {
  if (typeof text !== "string" || text.includes(CLI_NOTE)) return text;
  const lines = text.split("\n");
  let listed = false, changed = false;

  // list: "- name (builtin, external-cli:claude ✓): ...; Tools: ...; Model: ...; Thinking: ...[; ...]"
  const LIST = /^(- [^\s(]+ \([^)]*?\bexternal-cli:([^\s),]+)[^)]*\):)(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = LIST.exec(lines[i]);
    if (!m) continue;
    listed = true;
    const tool = toolName(m[2]);
    const rest = m[3].includes("; Model: ") ? rewriteFields(m[3], tool) : m[3].endsWith(PLAIN_SUFFIX(tool)) ? m[3] : m[3] + PLAIN_SUFFIX(tool);
    if (rest !== m[3]) { lines[i] = m[1] + rest; changed = true; }
  }

  // get: the header, up to "System Prompt:", holds "Runner: external-cli <command>" and the Model line to correct.
  const promptAt = lines.indexOf("System Prompt:");
  const header = promptAt < 0 ? lines.length : promptAt;
  const runner = lines.slice(0, header).findIndex((l) => /^Runner: external-cli \S+/.test(l));
  if (runner >= 0 && !lines[runner].includes(" CLI: its own ")) {
    const tool = toolName(lines[runner].split(/\s+/)[2]);
    for (let i = 0; i < header; i++) {
      if (/^Model: /.test(lines[i])) lines[i] = `Model: ${ownModel(tool)}`;
      if (/^Thinking: /.test(lines[i])) lines[i] = `Thinking: ${tool}'s own`;
    }
    lines[runner] = `${lines[runner]} (the ${tool} CLI: its own login, model and tools)`;
    changed = true;
  }

  // models: "Agent: <name>\nEffective model:\n  <model>\nSource: ...\nThinking: ..." for one agent, or
  // "<name>\n  model:\n    <model>\n  source: ...\n  thinking: ..." per agent.
  if (cli?.size && /^Subagent models?$/.test(lines[0] ?? "")) {
    const one = /^Agent: (\S+)$/.exec(lines.find((l) => l.startsWith("Agent: ")) ?? "");
    if (one && cli.has(one[1])) {
      const tool = toolName(cli.get(one[1])!);
      const at = lines.indexOf("Effective model:");
      if (at >= 0 && lines[at + 1]?.startsWith("  ") && !lines[at + 1].includes("do not apply")) {
        lines[at + 1] = `  ${ownModel(tool)}`;
        for (let i = at + 2; i < lines.length && lines[i] !== "Current session model:"; i++) {
          if (/^Source: /.test(lines[i])) lines[i] = `Source: the ${tool} CLI (${cli.get(one[1])})`;
          if (/^Thinking: /.test(lines[i])) lines[i] = `Thinking: ${tool}'s own`;
        }
        changed = true;
      }
    } else if (!one) {
      for (let i = 0; i < lines.length; i++) {
        const cmd = cli.get(lines[i]);
        if (!cmd || lines[i + 1] !== "  model:" || !lines[i + 2]?.startsWith("    ") || lines[i + 2].includes("do not apply")) continue;
        const tool = toolName(cmd);
        lines[i + 2] = `    ${ownModel(tool)}`;
        for (let j = i + 3; j < lines.length && lines[j].startsWith("  "); j++) {
          if (/^  source: /.test(lines[j])) lines[j] = `  source: the ${tool} CLI (${cmd})`;
          if (/^  thinking: /.test(lines[j])) lines[j] = `  thinking: ${tool}'s own`;
        }
        changed = true;
      }
    }
  }

  if (listed) {
    const head = lines.findIndex((l) => /^Executable agents/.test(l));
    lines.splice(head >= 0 ? head + 1 : 0, 0, CLI_NOTE);
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}

/**
 * The command-line agents pi-subagents resolves in `cwd`, from the package's own discovery (name and
 * alias -> command). Undefined when the package cannot be loaded; callers then leave the text alone.
 */
export async function discoverCliNames(cwd: string): Promise<CliNames | undefined> {
  try {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const pkg = process.env.KERNAL_SUBAGENTS_PKG || process.env.MGM_SUBAGENTS_PKG || join(agentDir, "npm", "node_modules", "pi-subagents");
    const agents = await import(pathToFileURL(join(pkg, "src", "agents", "agents.js")).href);
    const names: CliNames = new Map();
    for (const a of agents.discoverAgents(cwd, "both").agents ?? []) {
      const info = cliInfo(a);
      if (!info) continue;
      names.set(a.name, info.command);
      for (const alias of a.aliases ?? []) names.set(alias, info.command);
    }
    return names;
  } catch { return undefined; }
}
