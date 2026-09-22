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

/** One sentence the model reads before a list that holds command-line agents. */
export const CLI_NOTE =
  "Note from Kernal: agents marked external-cli run another coding tool installed on this machine " +
  "(Claude Code, Codex or Cursor). That tool uses its own login, model and tools, so the model shown by " +
  "pi-subagents does not apply to them. ✓ means the program is installed; it does not prove it is logged in. " +
  "Their runs are asynchronous: start one, then check its status.";

/**
 * Corrects the `subagent` tool's list and get output for command-line agents: the model becomes the
 * tool's own, tools and thinking are the tool's, and a list gains one explanatory note. Lines for
 * normal agents, and any text this does not recognise, pass through unchanged.
 */
export function annotateSubagentText(text: string): string {
  if (typeof text !== "string" || !text.includes("external-cli")) return text;
  const lines = text.split("\n");
  let listed = false;
  // list: "- name (builtin, external-cli:claude ✓): ...; Tools: ...; Model: ...; Thinking: ...[; ...]"
  const LIST = /^(- [^\s(]+ \([^)]*?\bexternal-cli:([^\s),]+)[^)]*\):)(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = LIST.exec(lines[i]);
    if (!m) continue;
    listed = true;
    const tool = toolName(m[2]);
    let rest = m[3];
    if (/; Model: /.test(rest)) {
      rest = rest
        .replace(/; Tools: [^;]*/, `; Tools: ${tool}'s own, as its adapter allows`)
        .replace(/; Model: [^;]*/, `; Model: ${ownModel(tool)}`)
        .replace(/; Thinking: [^;]*/, "");
    } else {
      rest = `${rest} [runs the ${tool} CLI with its own login and model]`;
    }
    lines[i] = m[1] + rest;
  }
  // get: a "Runner: external-cli <command>" line; its "Model:" line is the one to correct.
  const runner = lines.findIndex((l) => /^Runner: external-cli \S+/.test(l));
  if (runner >= 0) {
    const tool = toolName(lines[runner].split(/\s+/)[2]);
    for (let i = 0; i < lines.length && lines[i] !== "System Prompt:"; i++) {
      if (/^Model: /.test(lines[i])) lines[i] = `Model: ${ownModel(tool)}`;
      if (/^Thinking: /.test(lines[i])) lines[i] = `Thinking: ${tool}'s own`;
    }
    lines[runner] = `${lines[runner]} (the ${tool} CLI: its own login, model and tools)`;
  }
  if (listed) {
    const head = lines.findIndex((l) => /^Executable agents/.test(l));
    lines.splice(head >= 0 ? head + 1 : 0, 0, CLI_NOTE);
  }
  return lines.join("\n");
}
