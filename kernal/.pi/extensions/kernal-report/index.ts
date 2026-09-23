/**
 * /report — send a problem report to Matthew instead of the pi developers. pi's own /bug is
 * handled by the TUI before extensions see the input and uploads to Earendil, so this is a
 * separate command. It gathers what pi's report has (versions, platform, model, extensions, the
 * last provider error, recorded crashes) plus an optional redacted transcript tail, writes a local
 * copy, and files a GitHub issue in the kernal repo (collaborators only) via the gh CLI, assigned to
 * Matthew. Env: KERNAL_REPORT_REPO, KERNAL_REPORT_ASSIGNEE, KERNAL_REPORT_OFF=1 (no error hint).
 */
import { execFile } from "node:child_process";
import { ghPath } from "../kernal-github/gh.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform, arch, release } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ASSIGNEE, DEFAULT_REPO, issueBody, issueTitle, issueUrlFrom, lastError, redact, secretValues, transcriptTail, type ReportMeta } from "./lib.ts";
import { env } from "../_shared/env.ts";

export type Deps = {
  /** File the issue; resolves with its URL or rejects with the tool's error text. */
  deliver: (title: string, bodyFile: string) => Promise<string>;
  now?: () => Date;
};

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const root = () => dirname(agentDir());
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const repo = () => env("REPORT_REPO") || DEFAULT_REPO;

function ghCreate(title: string, bodyFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["issue", "create", "--repo", repo(), "--title", title, "--body-file", bodyFile, "--label", "bug", "--assignee", env("REPORT_ASSIGNEE") || DEFAULT_ASSIGNEE];
    // `ghPath()`, not a bare "gh": /github setup may have installed one in kernal's own bin.
    execFile(ghPath(), args, { timeout: 30_000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join(" ")));
      const url = issueUrlFrom(stdout);
      url ? resolve(url) : reject(new Error(`gh gave no issue URL: ${stdout.trim()}`));
    });
  });
}

export function collectMeta(ctx: any, now: Date): ReportMeta {
  const versionFile = join(root(), "VERSION");
  const kernalVersion = existsSync(versionFile) ? readFileSync(versionFile, "utf8").split("\n")[0].trim() : "source checkout";
  const settings = readJson(join(agentDir(), "settings.json")) ?? {};
  let extensions: string[] = []; try { extensions = readdirSync(join(agentDir(), "extensions")).filter((n) => !n.startsWith(".")).sort(); } catch {}
  const entries: any[] = (() => { try { return ctx.sessionManager?.getEntries?.() ?? []; } catch { return []; } })();
  const crashes = readJson(join(agentDir(), "crashes.json"));
  const m = ctx.model;
  return {
    id: randomUUID(), createdAt: now.toISOString(),
    reporter: env("USER") || process.env.USER || "unknown",
    kernalVersion, piVersion: PI_VERSION,
    platform: `${platform()} ${release()} ${arch()}`, nodeVersion: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
    cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId?.(), sessionFile: ctx.sessionManager?.getSessionFile?.(),
    model: m ? `${m.provider}/${m.id}` : undefined, thinkingLevel: ctx.thinkingLevel,
    packages: Array.isArray(settings.packages) ? settings.packages.map((p: any) => (typeof p === "string" ? p : p?.source ?? String(p))) : [],
    extensions, lastError: lastError(entries), crashes: Array.isArray(crashes) ? crashes : crashes?.crashes,
  };
}

export default function (pi: ExtensionAPI, deps: Partial<Deps> = {}) {
  const d: Deps = { deliver: ghCreate, now: () => new Date(), ...deps };
  let hinted = false;

  pi.registerCommand("report", {
    description: "Send a problem report to Matthew (GitHub issue; optional redacted transcript)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/report needs the interactive UI", "warning"); return; }
      const consent = `This goes to Matthew as an issue in ${repo()} (visible to that repo's collaborators only). It includes kernal/pi versions, OS, model, loaded extensions, the last error and any recorded crash. API keys are redacted.`;
      let description: string | undefined = args.trim() || undefined;
      if (!description) {
        const typed = ctx.ui.editor ? await ctx.ui.editor(`Report a problem to Matthew\n\n${consent}\n\nWhat went wrong?`, "") : await ctx.ui.input(`Report a problem to Matthew — what went wrong? (${consent})`, "");
        if (typed === undefined) { ctx.ui.notify("Report cancelled", "info"); return; }
        description = typed.trim() || undefined;
      }
      const t = await ctx.ui.select("Include the session transcript? (last 40 messages: your prompts, replies, tool calls and clipped tool output, secrets redacted)", ["Yes, include the transcript", "No"]);
      if (t === undefined) { ctx.ui.notify("Report cancelled", "info"); return; }
      const secrets = secretValues(process.env);
      const meta = collectMeta(ctx, d.now!());
      if (meta.lastError) meta.lastError = redact(meta.lastError, secrets);
      const entries = (() => { try { return ctx.sessionManager?.getEntries?.() ?? []; } catch { return []; } })();
      const transcript = t.startsWith("Yes") ? redact(transcriptTail(entries), secrets) : undefined;
      const title = redact(issueTitle(description, meta), secrets);
      const body = redact(issueBody(description, meta, transcript), secrets);
      const dir = join(agentDir(), "bug-reports"); mkdirSync(dir, { recursive: true });
      const file = join(dir, `${meta.id}.md`); writeFileSync(file, `# ${title}\n\n${body}\n`);
      ctx.ui.setStatus("report", "⇪ sending report…");
      try {
        const url = await d.deliver(title, file);
        ctx.ui.setStatus("report", undefined);
        pi.appendEntry("kernal.report", { id: meta.id, url, createdAt: meta.createdAt, transcriptIncluded: transcript !== undefined });
        ctx.ui.notify(`Report sent to Matthew: ${url}\nLocal copy: ${file}`, "info");
      } catch (e: any) {
        ctx.ui.setStatus("report", undefined);
        ctx.ui.notify(`Could not file the issue (${e?.message ?? e}). The report is saved at ${file} — send that file to Matthew. (Is the gh CLI logged in? gh auth login)`, "error");
      }
    },
  });

  // After a failed model turn, point at /report once per session (pi's own hint points at /bug).
  pi.on("agent_end", async (ev: any, ctx) => {
    if (hinted || !ctx.hasUI || env("REPORT_OFF")) return;
    const last = [...(ev.messages ?? [])].reverse().find((m: any) => m.role === "assistant");
    if (last?.stopReason === "error") { hinted = true; ctx.ui.notify("If this looks like a kernal problem, /report sends the details to Matthew.", "info"); }
  });
}
