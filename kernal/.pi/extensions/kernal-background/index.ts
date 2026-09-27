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
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { JobManager, MAX_TIMEOUT_SECONDS, describeJob, type Job, type JobKind } from "./jobs.ts";
import {
  PreviewError, closeDrivePreview, desktopPreview, driveEndpoint, drivePreview, explainPreviewError, inDrive, validPort,
  type PreviewResult,
} from "./preview.ts";

const BATCH_DEFAULT_SECONDS = 30 * 60;
const BATCH_MAX_SECONDS = 24 * 60 * 60;
const NOTICE_TAIL_LINES = 15;
const DEFAULT_LOG_LINES = 40;

const GUIDELINES = [
  "Use `background` (action run) for anything that should keep running while you do other work: dev servers, watchers, long test suites, big data passes. Use plain bash for commands that finish quickly.",
  "kind server: stays up until you stop it (dev server, `tsc --watch`). kind batch: should finish; give timeout_seconds when the default 30 minutes is wrong.",
  "Don't poll. You get one message when a job ends, with its exit status and last lines. Read output with action logs only when you need it (after starting a server, check its log once to confirm it is listening).",
  "Don't put `&`, `nohup` or `setsid` in the command: the job is already in the background, and anything it leaves running when its command exits is stopped.",
  "When a server job should be seen by the person, pass its port to run, then call `preview` with the job id once its log shows it listening, and give the person the URL. Use share: true only when the person asks for a link to send to someone else.",
  "stdin stays open and empty: a command that prompts will wait, so pass its non-interactive flag (--yes, CI=1).",
  "A job runs as you, with your credentials; it is not a sandbox. Stop jobs you no longer need with action kill.",
];

// pi builds a fresh extension instance on every /new, /resume, /fork and /reload; one process-exit
// hook serves them all, so listeners don't pile up.
const liveManagers = new Set<JobManager>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // pi exiting without a session_shutdown (a crash, an uncaught error): SIGKILL every group now.
  // SIGKILL of pi itself runs nothing here; each job's watchdog covers that (jobs.ts).
  process.on("exit", () => { for (const m of liveManagers) m.killAllNow(); });
}

/** Per user and per pi process, private: logs can hold whatever a command printed. */
function logDir(): string {
  let who = "user";
  try { who = String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username); } catch { /* keep default */ }
  return join(tmpdir(), `kernal-background-${who}`, String(process.pid));
}

function serverMaxSeconds(): number {
  const h = Number(process.env.KERNAL_BG_SERVER_MAX_HOURS);
  return Math.min(MAX_TIMEOUT_SECONDS, Math.round((Number.isFinite(h) && h > 0 ? h : 12) * 60 * 60));
}

function hours(seconds: number): string {
  const h = seconds / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], isError };
}

export function endNotice(job: Job, tail: string, closedPreview?: string): string {
  let s = `Background job ${describeJob(job)}.`;
  if (closedPreview) s += ` Its preview (${closedPreview}) was closed.`;
  if (job.leftovers) s += " It left processes running in its group when its command exited; those were stopped (run servers as the job's own command, not with `&`).";
  s += tail.trim() ? `\nLast lines of output:\n${tail}` : "\n(no output)";
  s += `\nFull log: ${job.logPath}`;
  return s;
}

export default function (pi: ExtensionAPI) {
  let manager: JobManager | undefined;
  let statusCtx: any;
  /** Open previews by port (#217). A preview lives no longer than the job whose server it shows. */
  const previews = new Map<number, PreviewResult & { jobId?: string; share?: boolean }>();

  /** Closes the preview for `port`, if one is open; returns its URL. A Drive's tunnel goes too. */
  const closePreview = async (port: number | undefined): Promise<string | undefined> => {
    if (port === undefined) return undefined;
    const open = previews.get(port);
    if (!open) return undefined;
    previews.delete(port);
    const ep = driveEndpoint();
    if (ep) {
      try { await closeDrivePreview(ep, port); } catch { /* agentd reaps previews with the run anyway */ }
    }
    return open.url;
  };

  const refreshStatus = () => {
    const n = manager?.list().filter((j) => j.status === "running").length ?? 0;
    try { statusCtx?.ui?.setStatus?.("kernal-background", n > 0 ? `${n} background job${n === 1 ? "" : "s"}` : undefined); } catch { /* no UI */ }
  };

  const jobs = (): JobManager => {
    if (manager) return manager;
    installExitHook();
    manager = new JobManager({
      dir: logDir(),
      onEnd: (job) => {
        let tail = "";
        try { tail = manager!.tail(job.id, NOTICE_TAIL_LINES); } catch { /* log gone */ }
        refreshStatus();
        void closePreview(job.port).then((closed) => {
          pi.sendMessage(
            { customType: "kernal-background", content: endNotice(job, tail, closed), display: true, details: { job } },
            { deliverAs: "followUp", triggerTurn: true },
          );
        });
      },
    });
    liveManagers.add(manager);
    return manager;
  };

  pi.on("session_start", async (_event: any, ctx: any) => { statusCtx = ctx; });

  pi.on("session_shutdown", async () => {
    await Promise.all([...previews.keys()].map((port) => closePreview(port)));
    if (!manager) return;
    const m = manager;
    const reaped = await m.reapAll();
    m.cleanup();
    liveManagers.delete(m);
    manager = undefined;
    refreshStatus();
    if (reaped.length > 0) {
      try { statusCtx?.ui?.notify?.(`Stopped ${reaped.length} background job${reaped.length === 1 ? "" : "s"} with the session.`, "info"); } catch { /* no UI */ }
    }
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
        port: { type: "number", description: "run, server: the port the server listens on, so `preview` can open it and close it with the job." },
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
            // print and json modes end with the prompt, and the session's jobs with them: a job
            // started there would be stopped silently, never reporting.
            if (ctx?.mode === "print" || ctx?.mode === "json") {
              return text("background jobs need an interactive or RPC session: in print mode they would be stopped as soon as this prompt finishes. Run the command in the foreground instead.", true);
            }
            const kind: JobKind = params?.kind === "server" ? "server" : "batch";
            const asked = Number(params?.timeout_seconds);
            const timeoutSeconds = kind === "server"
              ? serverMaxSeconds()
              : Math.min(BATCH_MAX_SECONDS, Number.isFinite(asked) && asked > 0 ? asked : BATCH_DEFAULT_SECONDS);
            const port = params?.port === undefined ? undefined : Number(params.port);
            if (port !== undefined && !validPort(port)) return text(`port must be a whole number 1-65535, got ${params.port}.`, true);
            const job = jobs().start({
              command: String(params?.command ?? ""), kind, name: params?.name,
              cwd: resolve(String(ctx?.cwd || process.cwd()), String(params?.cwd || ".")), timeoutSeconds, port,
            });
            refreshStatus();
            const limit = kind === "server" ? `runs until stopped (hard cap ${hours(timeoutSeconds)})` : `deadline ${timeoutSeconds} s`;
            const next = kind !== "server" ? "" : port !== undefined
              ? ` Check its log once to confirm it's listening on ${port}, then call preview with job_id ${job.id} if the person should see it.`
              : " Check its log once to confirm it's listening.";
            return text(`Started ${job.id} (${kind}, pid ${job.pid}, ${limit}). Log: ${job.logPath}\nYou'll get a message when it ends.${next}`);
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
            const closed = await closePreview(job.port);
            return text(`${describeJob(job)}.${closed ? ` Its preview (${closed}) was closed.` : ""}\n${manager.tail(id, 5) || "(no output)"}`);
          }
          default:
            return text(`Unknown action "${action}". Use run, list, logs or kill.`, true);
        }
      } catch (err: any) {
        return text(`background ${action}: ${err?.message ?? String(err)}`, true);
      }
    },
  } as any);

  pi.registerTool({
    name: "preview",
    label: "Preview",
    description:
      "Give the person a URL for a web server running here (a background server job, or a port). On a desktop it is http://localhost:<port>; in a Drive it is a private https link on kernal.run that only people with access to this session can open, or with share: true a time-limited public link. close: true removes a preview.",
    promptSnippet: "preview: a URL for the person to open a server running here (job_id or port); share: true for a public time-limited link.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The background server job whose port to open (it must have been started with port)." },
        port: { type: "number", description: "The port to open, when there is no job id." },
        share: { type: "boolean", description: "Drive only: a public link anyone can open, until it expires or the job ends. Only when the person asks for one." },
        close: { type: "boolean", description: "Remove the preview instead of opening it." },
      },
    } as any,
    execute: async (_id: string, params: any, _signal: unknown, _update: unknown, ctx: any) => {
      statusCtx = ctx ?? statusCtx;
      const jobId = params?.job_id ? String(params.job_id) : undefined;
      let port = params?.port === undefined ? undefined : Number(params.port);
      if (jobId) {
        const job = manager?.get(jobId);
        if (!job) return text(`No background job ${jobId}.`, true);
        if (job.status !== "running") return text(`${describeJob(job)}: a preview needs a running server.`, true);
        if (job.port === undefined && port === undefined) return text(`${jobId} was started without a port. Pass port, or restart it with background run port: <n>.`, true);
        port ??= job.port;
      }
      if (!validPort(port)) return text("Give job_id (a server started with port) or port (1-65535).", true);
      if (params?.close) {
        const closed = await closePreview(port);
        return text(closed ? `Closed the preview of port ${port} (${closed}).` : `No preview is open for port ${port}.`);
      }
      const existing = previews.get(port);
      if (existing && Boolean(existing.share) === Boolean(params?.share)) return text(`Already open: ${existing.url}`);
      try {
        const ep = driveEndpoint();
        let result: PreviewResult;
        if (ep) {
          result = await drivePreview(ep, port, { jobId, share: Boolean(params?.share) });
        } else if (inDrive()) {
          return text("Previews aren't enabled for this Drive yet, so the person can't open its servers. Test it here with curl instead.", true);
        } else {
          if (params?.share) return text("Share links are only for Drives. On this machine the person opens it at http://localhost:" + port + ".", true);
          result = await desktopPreview(port);
        }
        if (existing) await closePreview(port);
        previews.set(port, { ...result, ...(jobId ? { jobId } : {}), ...(params?.share ? { share: true } : {}) });
        const until = result.expiresAt ? ` It expires ${result.expiresAt}, or sooner if the server stops.` : jobId ? " It closes when the job ends." : "";
        const who = ep ? (params?.share ? "Anyone with this link can open it." : "Only people with access to this session can open it (they sign in with Google).") : "";
        return text(`Preview of port ${port}: ${result.url}\n${who}${until}`.trim());
      } catch (err: any) {
        if (err instanceof PreviewError) return text(`preview: ${explainPreviewError(err)}`, true);
        return text(`preview: ${err?.message ?? String(err)}`, true);
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
