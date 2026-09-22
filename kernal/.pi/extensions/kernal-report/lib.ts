/** Pure logic for /report (bug reports to Matthew as GitHub issues); tested without pi. */
export const DEFAULT_REPO = "cognitio-org/mgm-pi";
export const DEFAULT_ASSIGNEE = "mgmonteleone";
export const MAX_BODY_CHARS = 60_000;          // GitHub issue bodies cap at 65 536
export const TRANSCRIPT_ENTRIES = 40;
export const TRANSCRIPT_CHARS = 24_000;
const RESULT_CHARS = 600;

const SECRET_PATTERNS = [
  /\b(sk|sk-or-v1|sk-ant|sk-proj)-[A-Za-z0-9_\-]{8,}/g,
  /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\b(Bearer|Token)\s+[A-Za-z0-9._\-]{8,}/gi,
  /\b[0-9a-f]{40,}\b/g,                       // Deepgram / hex API keys
];

/** Values of every *_KEY / *_TOKEN / *_SECRET / *PASSWORD* variable in `env` (non-trivial ones). */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /(_KEY|_TOKEN|_SECRET|PASSWORD|_PASS)$/i.test(k) && !!v && v.length >= 8)
    .map(([, v]) => v as string);
}

/** Replace known secret values and secret-looking tokens with a marker. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m) => (m.match(/^(Bearer|Token)/i) ? `${m.split(/\s+/)[0]} [redacted]` : "[redacted]"));
  return out;
}

type Msg = { role: string; content?: any; stopReason?: string; errorMessage?: string; toolName?: string; isError?: boolean };
type Entry = { type: string; message?: Msg; timestamp?: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);
function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => {
    if (c?.type === "text") return c.text ?? "";
    if (c?.type === "toolCall") return `→ ${c.name}(${clip(JSON.stringify(c.arguments ?? {}), 300)})`;
    if (c?.type === "thinking") return "";
    if (c?.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

/** Last assistant error in the session, if any. */
export function lastError(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].message;
    if (entries[i].type === "message" && m?.role === "assistant" && m.stopReason === "error") return m.errorMessage || "(error without message)";
  }
  return undefined;
}

/** The tail of the conversation as compact plain text: roles, text, tool calls, clipped tool results. */
export function transcriptTail(entries: Entry[], maxEntries = TRANSCRIPT_ENTRIES, maxChars = TRANSCRIPT_CHARS): string {
  const msgs = entries.filter((e) => e.type === "message" && e.message).slice(-maxEntries);
  const lines: string[] = [];
  for (const e of msgs) {
    const m = e.message!;
    if (m.role === "toolResult") lines.push(`[tool ${m.toolName ?? "?"}${m.isError ? " ERROR" : ""}] ${clip(textOf(m.content), RESULT_CHARS)}`);
    else if (m.role === "assistant") lines.push(`[assistant${m.stopReason === "error" ? ` ERROR: ${m.errorMessage ?? ""}` : ""}] ${textOf(m.content)}`);
    else lines.push(`[${m.role}] ${textOf(m.content)}`);
  }
  let out = lines.join("\n\n");
  if (out.length > maxChars) out = `… (earlier ${out.length - maxChars} chars omitted)\n${out.slice(-maxChars)}`;
  return out;
}

export type ReportMeta = {
  id: string; createdAt: string; reporter: string; kernalVersion: string; piVersion: string;
  platform: string; nodeVersion: string; cwd: string; sessionId?: string; sessionFile?: string;
  model?: string; thinkingLevel?: string; packages: string[]; extensions: string[];
  lastError?: string; crashes?: unknown[];
};

export function issueTitle(description: string | undefined, meta: ReportMeta): string {
  const first = (description ?? "").split("\n")[0].trim();
  const base = first || (meta.lastError ? `Error: ${meta.lastError.split("\n")[0]}` : "Problem report");
  return `[kernal ${meta.kernalVersion}] ${clip(base, 90)} (${meta.reporter})`;
}

/** Markdown body for the GitHub issue (already redacted by the caller). */
export function issueBody(description: string | undefined, meta: ReportMeta, transcript: string | undefined): string {
  const row = (k: string, v: string | undefined) => (v ? `| ${k} | ${v.replace(/\|/g, "\\|")} |` : undefined);
  const table = [
    "| | |", "|---|---|",
    row("reporter", meta.reporter), row("kernal", meta.kernalVersion), row("pi", meta.piVersion), row("platform", `${meta.platform} · node ${meta.nodeVersion}`),
    row("model", meta.model), row("thinking", meta.thinkingLevel), row("cwd", meta.cwd), row("session", meta.sessionId), row("session file", meta.sessionFile),
    row("packages", meta.packages.join(", ")), row("extensions", meta.extensions.join(", ")), row("report id", meta.id), row("created", meta.createdAt),
  ].filter(Boolean).join("\n");
  const parts = [
    `## What went wrong\n\n${description?.trim() || "_no description given_"}`,
    meta.lastError ? `## Last error in the session\n\n\`\`\`\n${clip(meta.lastError, 2000)}\n\`\`\`` : undefined,
    meta.crashes?.length ? `## Recorded crashes\n\n\`\`\`json\n${clip(JSON.stringify(meta.crashes, null, 2), 4000)}\n\`\`\`` : undefined,
    `## Environment\n\n${table}`,
    transcript !== undefined ? `<details><summary>Transcript (last ${TRANSCRIPT_ENTRIES} messages, secrets redacted)</summary>\n\n\`\`\`text\n${transcript}\n\`\`\`\n\n</details>` : "_Transcript not included._",
    "_Sent with `/report` from kernal._",
  ].filter(Boolean).join("\n\n");
  return parts.length > MAX_BODY_CHARS ? `${parts.slice(0, MAX_BODY_CHARS - 40)}\n\n… (truncated to fit GitHub)` : parts;
}

/** gh's stdout for `issue create` is the issue URL. */
export function issueUrlFrom(stdout: string): string | undefined {
  return stdout.split("\n").map((l) => l.trim()).find((l) => /^https:\/\/github\.com\/.+\/issues\/\d+$/.test(l));
}
