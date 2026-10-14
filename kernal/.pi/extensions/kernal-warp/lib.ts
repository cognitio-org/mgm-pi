/**
 * Warp's CLI-agent protocol: `OSC 777 ; notify ; warp://cli-agent ; <json> BEL` written to the
 * terminal. Warp turns these into the tab's agent status (working, blocked, done, failed), a
 * "completed" notification, and its rich input editor. Warp only accepts agents it knows, so we
 * report as "pi" (kernal runs on pi); an unknown agent name is dropped silently.
 *
 * Warp's own emitter is crates/warp_tui/src/cli_agent_osc_event_publisher.rs; the schema is
 * crates/warp_core/src/cli_agent_protocol.rs and the status rules are
 * app/src/terminal/cli_agent_sessions/mod.rs in github.com/warpdotdev/warp.
 */

export const WARP_SENTINEL = "warp://cli-agent";
export const WARP_PROTOCOL_VERSION = 1;
export const WARP_AGENT = "pi";

/** kernal-background emits its running batch-job count on pi.events under this name. */
export const BACKGROUND_COUNT_EVENT = "kernal-background:running";

export type WarpEvent =
  | "session_start"
  | "prompt_submit"
  | "tool_complete"
  | "stop"
  | "stop_failure"
  | "permission_request"
  | "permission_replied"
  | "question_asked";

export interface WarpFields {
  session_id?: string;
  cwd?: string;
  project?: string;
  query?: string;
  response?: string;
  summary?: string;
  tool_name?: string;
  plugin_version?: string;
  error_type?: string;
  /** Non-zero on `stop` keeps the tab "working": the agent wakes itself when the jobs end. */
  background_task_count?: number;
}

type Env = Record<string, string | undefined>;
type Out = { isTTY?: boolean; write(s: string): unknown };

/** Warp sets both in the shells it starts; the same check Warp's own TUI makes before emitting. */
export function warpSupported(env: Env = process.env): boolean {
  return !!env.WARP_CLI_AGENT_PROTOCOL_VERSION && !!env.WARP_CLIENT_VERSION;
}

/**
 * Long prompts and replies only feed a tab label and a notification; keep the escape short.
 * Cut by code point: half a surrogate pair is invalid JSON to Warp, which drops the whole event.
 */
export function clip(text: string, max = 400): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

/** The escape sequence for one event; wrapped for tmux passthrough when inside tmux. */
export function warpSequence(event: WarpEvent, fields: WarpFields = {}, env: Env = process.env): string {
  const body: Record<string, unknown> = { v: WARP_PROTOCOL_VERSION, agent: WARP_AGENT, event };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") body[k] = v;
  const osc = `\x1b]777;notify;${WARP_SENTINEL};${JSON.stringify(body)}\x07`;
  if (!env.TMUX) return osc;
  return `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** Write one event to the terminal. A no-op outside Warp, without a TTY, or in a Drive. */
export function emitWarp(event: WarpEvent, fields: WarpFields = {}, env: Env = process.env, out: Out = process.stdout): void {
  if (!warpSupported(env) || !out.isTTY || env.OUTFITTER_SESSION_ID) return;
  try { out.write(warpSequence(event, fields, env)); } catch { /* the terminal went away; nothing to report to */ }
}
