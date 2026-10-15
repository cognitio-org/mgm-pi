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

import { execFileSync } from "node:child_process";

export const WARP_SENTINEL = "warp://cli-agent";
export const WARP_PROTOCOL_VERSION = 1;
export const WARP_AGENT = "pi";

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

/**
 * JSON.stringify leaves C1 controls (U+0080-U+009F) raw, and Warp's parser reads U+009C (ST) as the
 * end of the OSC: the event is lost and the rest of the JSON lands on screen. Escape them.
 */
function escapeC1(json: string): string {
  return json.replace(/[\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The escape sequence for one event; wrapped for tmux passthrough when inside tmux. */
export function warpSequence(event: WarpEvent, fields: WarpFields = {}, env: Env = process.env): string {
  const body: Record<string, unknown> = { v: WARP_PROTOCOL_VERSION, agent: WARP_AGENT, event };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") body[k] = v;
  const osc = `\x1b]777;notify;${WARP_SENTINEL};${escapeC1(JSON.stringify(body))}\x07`;
  if (!env.TMUX) return osc;
  return `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Inside tmux the WARP_* variables are the tmux server's, from whichever terminal started it; the
 * session may now be attached from Ghostty or iTerm2, which would show the events as notifications.
 * tmux records the attached terminal's XTVERSION reply (`Warp(<version>)` for Warp) as
 * #{client_termtype}; send only when that is Warp. Re-checked every 10 s, since clients re-attach.
 */
const TMUX_CHECK_MS = 10_000;
let tmuxChecked: { at: number; warp: boolean } | undefined;

function queryTmuxClient(): string {
  return execFileSync("tmux", ["display-message", "-p", "#{client_termtype}"], { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] });
}

export function tmuxClientIsWarp(query: () => string = queryTmuxClient, now = Date.now()): boolean {
  if (tmuxChecked && now - tmuxChecked.at < TMUX_CHECK_MS) return tmuxChecked.warp;
  let warp = false;
  try { warp = /^warp\b/i.test(query().trim()); } catch { /* no tmux, or too old for client_termtype */ }
  tmuxChecked = { at: now, warp };
  return warp;
}

export function _resetTmuxCheck(): void { tmuxChecked = undefined; }

/** Write one event to the terminal. A no-op outside Warp, without a TTY, or in a Drive. */
export function emitWarp(
  event: WarpEvent,
  fields: WarpFields = {},
  env: Env = process.env,
  out: Out = process.stdout,
  inTmuxWarp: () => boolean = tmuxClientIsWarp,
): void {
  if (!warpSupported(env) || !out.isTTY || env.OUTFITTER_SESSION_ID) return;
  if (env.TMUX && !inTmuxWarp()) return;
  try { out.write(warpSequence(event, fields, env)); } catch { /* the terminal went away; nothing to report to */ }
}
