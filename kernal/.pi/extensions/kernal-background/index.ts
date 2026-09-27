/**
 * kernal-background: shell jobs that outlive the turn (#121).
 *
 * pi's `bash` tool holds the turn until the command exits, and pi's own advice ("use tmux") doesn't
 * fit a Drive or the web transcript. The `background` tool starts a command and returns at once with
 * an id; the job's end (exit, failure, deadline, stop) comes back exactly once as a message, with a
 * short tail of its output. Nothing streams into the turn while it runs: the model reads the log
 * when it wants to. See jobs.ts for how a job is started, watched and stopped.
 *
 * Two kinds, one id space:
 * - server: a dev server or watcher. Healthy while quiet; runs until stopped, the session ends, or a
 *   hard cap (KERNAL_BG_SERVER_MAX_HOURS, default 12 h; on a Drive the sandbox's own life is shorter).
 * - batch: tests, a migration, a pass over a big file. Has a deadline (timeout_seconds, default 30
 *   min); crossing it stops the job and says so.
 *
 * Same tool on the desktop and in a Drive. On a Drive a job doesn't keep the Drive awake (it produces
 * no pi activity) and dies with the sandbox; the end-of-job notice is the one thing that can start a
 * turn. Every job is stopped when the session ends or pi exits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager, describeJob, type Job, type JobKind } from "./jobs.ts";

const BATCH_DEFAULT_SECONDS = 30 * 60;
const BATCH_MAX_SECONDS = 24 * 60 * 60;
const NOTICE_TAIL_LINES = 15;
const DEFAULT_LOG_LINES = 40;

const GUIDELINES = [
  "Use `background` (action run) for anything that should keep running while you do other work: dev servers, watchers, long test suites, big data passes. Use plain bash for commands that finish quickly.",
  "kind server: stays up until you stop it (dev server, `tsc --watch`). kind batch: should finish; give timeout_seconds when the default 30 minutes is wrong.",
  "Don't poll. You get one message when a job ends, with its exit status and last lines. Read output with action logs only when you need it (after starting a server, check its log once to confirm it is listening).",
  "Don't put `&`, `nohup` or `setsid` in the command: the job is already in the background, and anything it leaves running when its command exits is stopped.",
  "A job runs as you, with your credentials; it is not a sandbox. Stop jobs you no longer need with action kill.",
];

function serverMaxSeconds(): number {
  const h = Number(process.env.KERNAL_BG_SERVER_MAX_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 60 * 60;
}

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], isError };
}

export function endNotice(job: Job, tail: string): string {
  let s = `Background job ${describeJob(job)}.`;
  if (job.leftovers) s += " It left processes running in its group when its command exited; those were stopped (run servers as the job's own command, not with `&`).";
  s += tail.trim() ? `\nLast lines of output:\n${tail}` : "\n(no output)";
  s += `\nFull log: ${job.logPath}`;
  return s;
}

export default function (pi: ExtensionAPI) {
  let manager: JobManager | undefined;
  let statusCtx: any;

  const refreshStatus = () => {
    const n = manager?.list().filter((j) => j.status === "running").length ?? 0;
    try { statusCtx?.ui?.setStatus?.("kernal-background", n > 0 ? `${n} background job${n === 1 ? "" : "s"}` : undefined); } catch { /* no UI */ }
  };

  const jobs = (): JobManager => {
    manager ??= new JobManager({
      dir: join(tmpdir(), "kernal-background", String(process.pid)),
      onEnd: (job) => {
        let tail = "";
        try { tail = manager!.tail(job.id, NOTICE_TAIL_LINES); } catch { /* log gone */ }
        refreshStatus();
        pi.sendMessage(
          { customType: "kernal-background", content: endNotice(job, tail), display: true, details: { job } },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    });
    return manager;
  };

  // pi exiting without a session_shutdown (a crash, an uncaught error): SIGKILL every group now.
  // SIGKILL of pi itself runs nothing here; each job's watchdog covers that (jobs.ts).
  process.on("exit", () => manager?.killAllNow());

  pi.on("session_start", async (_event: any, ctx: any) => { statusCtx = ctx; });

  pi.on("session_shutdown", async () => {
    if (!manager) return;
    await manager.reapAll();
    manager.cleanup();
    manager = undefined;
    refreshStatus();
  });

  pi.registerTool({
    name: "background",
    label: "Background",
    description:
      "Run shell commands in the background, beyond this turn: start one (run), list jobs (list), read a job's output (logs), stop one (kill). A job's end comes back once as a message with its exit status and last lines, so there is no need to poll.",
    promptSnippet: "background: run a dev server, watcher or long command without blocking the turn; list, logs, kill.",
    promptGuidelines: GUIDELINES,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["run", "list", "logs", "kill"], description: "What to do" },
        command: { type: "string", description: "run: the shell command (bash)." },
        kind: { type: "string", enum: ["server", "batch"], description: "run: server (runs until stopped) or batch (should finish; has a deadline). Default batch." },
        name: { type: "string", description: "run: a short label for the job." },
        timeout_seconds: { type: "number", description: `run, batch: stop the job as timed out after this long (default ${BATCH_DEFAULT_SECONDS}, max ${BATCH_MAX_SECONDS}).` },
        cwd: { type: "string", description: "run: working directory (default: the session's)." },
        id: { type: "string", description: "logs, kill: the job id, e.g. bg1." },
        lines: { type: "number", description: `logs: how many lines from the end (default ${DEFAULT_LOG_LINES}).` },
        grep: { type: "string", description: "logs: only lines containing this text." },
      },
    } as any,
    execute: async (_id: string, params: any, _signal: unknown, _update: unknown, ctx: any) => {
      statusCtx = ctx ?? statusCtx;
      const action = String(params?.action ?? "");
      try {
        switch (action) {
          case "run": {
            const kind: JobKind = params?.kind === "server" ? "server" : "batch";
            const asked = Number(params?.timeout_seconds);
            const timeoutSeconds = kind === "server"
              ? serverMaxSeconds()
              : Math.min(BATCH_MAX_SECONDS, Number.isFinite(asked) && asked > 0 ? asked : BATCH_DEFAULT_SECONDS);
            const job = jobs().start({
              command: String(params?.command ?? ""), kind, name: params?.name,
              cwd: String(params?.cwd || ctx?.cwd || process.cwd()), timeoutSeconds,
            });
            refreshStatus();
            const limit = kind === "server" ? `runs until stopped (hard cap ${Math.round(timeoutSeconds / 3600)} h)` : `deadline ${timeoutSeconds} s`;
            return text(`Started ${job.id} (${kind}, pid ${job.pid}, ${limit}). Log: ${job.logPath}\nYou'll get a message when it ends.${kind === "server" ? " Check its log once to confirm it's listening." : ""}`);
          }
          case "list": {
            const all = manager?.list() ?? [];
            if (all.length === 0) return text("No background jobs in this session.");
            return text(all.map((j) => describeJob(j)).join("\n"));
          }
          case "logs": {
            const id = String(params?.id ?? "");
            const lines = Number(params?.lines) > 0 ? Number(params.lines) : DEFAULT_LOG_LINES;
            const job = manager?.get(id);
            if (!job) return text(`No background job ${id || "(missing id)"}.`, true);
            const out = manager!.tail(id, lines, params?.grep ? String(params.grep) : undefined);
            return text(`${describeJob(job)}\n${out || "(no output yet)"}`);
          }
          case "kill": {
            const id = String(params?.id ?? "");
            if (!manager?.get(id)) return text(`No background job ${id || "(missing id)"}.`, true);
            const before = manager.get(id)!;
            if (before.status !== "running") return text(`${describeJob(before)} (already ended).`);
            const job = await manager.kill(id);
            refreshStatus();
            return text(`${describeJob(job)}.\n${manager.tail(id, 5) || "(no output)"}`);
          }
          default:
            return text(`Unknown action "${action}". Use run, list, logs or kill.`, true);
        }
      } catch (err: any) {
        return text(`background ${action}: ${err?.message ?? String(err)}`, true);
      }
    },
  } as any);

  pi.registerCommand("jobs", {
    description: "Background jobs: list them, or `/jobs kill <id>` to stop one",
    handler: async (args: string, ctx: any) => {
      statusCtx = ctx ?? statusCtx;
      const [verb, id] = (args ?? "").trim().split(/\s+/);
      if (verb === "kill" && id) {
        if (!manager?.get(id)) { ctx.ui.notify(`No background job ${id}.`, "warning"); return; }
        // Stopped by the person: the model hears about it through the usual end-of-job message.
        const job = await manager.kill(id, false);
        ctx.ui.notify(describeJob(job), "info");
        return;
      }
      const all = manager?.list() ?? [];
      ctx.ui.notify(all.length ? all.map((j) => describeJob(j)).join("\n") : "No background jobs in this session.", "info");
    },
  });
}
