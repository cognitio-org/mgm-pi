/**
 * Report kernal's run state to Warp, when kernal runs inside it: working while a run is going,
 * blocked while a dialog waits for an answer during that run, and done or failed once pi has
 * settled. Outside Warp the extension registers nothing.
 */
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { kernalVersion } from "../_shared/version.ts";
import { BACKGROUND_COUNT_EVENT } from "../kernal-background/jobs.ts";
import { clip, emitWarp, warpSupported } from "./lib.ts";

type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

export default function (pi: ExtensionAPI) {
  if (!warpSupported()) return;
  let query: string | undefined;
  let pending: string | undefined;
  let last: Message | undefined;
  let running = false;
  let blocked = false;
  let toolsRunning = 0;
  let backgroundJobs = 0;

  pi.events?.on?.(BACKGROUND_COUNT_EVENT, (n: unknown) => { backgroundJobs = typeof n === "number" ? n : 0; });

  pi.on("session_start", (async (_event: unknown, ctx: any) => {
    emitWarp("session_start", {
      session_id: ctx?.sessionManager?.getSessionId?.(),
      cwd: ctx?.cwd,
      project: ctx?.cwd ? basename(ctx.cwd) : undefined,
      plugin_version: `kernal ${kernalVersion(dirname(getAgentDir()))}`,
    });
  }) as any);

  // A typed prompt passes before_agent_start first; a background job's follow-up turn and a
  // retry start at agent_start without one, and keep the last prompt as the query.
  pi.on("before_agent_start", (async (event: any) => {
    pending = typeof event?.prompt === "string" ? clip(event.prompt) : undefined;
  }) as any);

  pi.on("agent_start", (async () => {
    if (pending !== undefined) query = pending;
    pending = undefined;
    last = undefined;
    running = true;
    toolsRunning = 0;
    emitWarp("prompt_submit", { query });
  }) as any);

  pi.on("tool_execution_start", (async () => { toolsRunning++; }) as any);

  pi.on("tool_execution_end", (async (event: any) => {
    toolsRunning = Math.max(0, toolsRunning - 1);
    emitWarp("tool_complete", { tool_name: event?.toolName });
  }) as any);

  // pi wraps every ctx.ui dialog (any extension's approval, select or input) in these, counting
  // nested ones. Only an approval (confirm) or a dialog a tool raised is the agent waiting on the
  // person; a dialog outside a run (/connect) or one the person opened mid-run (the voice
  // overlay) is the person driving.
  pi.on("ui_prompt_start", (async (event: any) => {
    if (!running || (event?.kind !== "confirm" && toolsRunning === 0)) return;
    blocked = true;
    const summary = typeof event?.title === "string" ? clip(event.title, 160) : undefined;
    emitWarp(event?.kind === "confirm" ? "permission_request" : "question_asked", { summary });
  }) as any);

  pi.on("ui_prompt_end", (async () => {
    if (!blocked) return;
    blocked = false;
    emitWarp("permission_replied");
  }) as any);

  // agent_end can be followed by a retry or compaction recovery; only agent_settled is final.
  pi.on("agent_end", (async (event: any) => {
    const messages: Message[] = Array.isArray(event?.messages) ? event.messages : [];
    last = [...messages].reverse().find((m) => m?.role === "assistant") ?? last;
  }) as any);

  pi.on("agent_settled", (async () => {
    const ran = running;
    running = false;
    blocked = false;
    pending = undefined;
    toolsRunning = 0;
    // pi settles after every attempt, including one that failed before the agent started (no API
    // key); that has nothing to report, and `last` would still be the previous run's reply.
    if (!ran) return;
    if (last?.stopReason === "error") {
      emitWarp("stop_failure", { query, error_type: "error", response: clip(last.errorMessage ?? "The run failed") });
      return;
    }
    // Interrupted (Esc) is a stop too: Warp has no event for it, and without one the tab stays "working".
    const response = last?.stopReason === "aborted" ? "Interrupted" : last ? clip(textOf(last.content)) : undefined;
    emitWarp("stop", { query, response, background_task_count: backgroundJobs || undefined });
  }) as any);
}
