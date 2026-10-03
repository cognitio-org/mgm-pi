/** Pure logic for the Sentry extension's event handling; tested without pi or @sentry/node. */
import { redact } from "../_shared/redact.ts";

/** The shape of AgentEndEvent.messages this extension needs — the full AgentMessage union has many
 * more fields and variants, none of which matter here. */
export type AgentEndMessage = { role: string; stopReason?: string; errorMessage?: string };

/** The last assistant error in an agent_end's messages, if the run ended in one. Mirrors
 * kernal-report/lib.ts's lastError, which does the same walk over session entries instead of a
 * single event's message list. */
export function agentRunError(messages: AgentEndMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.stopReason === "error") return m.errorMessage || "(error without message)";
  }
  return undefined;
}

/** Span attributes for a tool_execution span: just the tool name, kept low-cardinality (no raw
 * args/results — those can hold secrets and would blow the attribute size Sentry buffers). */
export function toolSpanAttributes(toolName: string): Record<string, string> {
  return { "kernal.tool": toolName };
}

/**
 * What leaves the laptop, trimmed of who sent it: the machine's hostname (`server_name`, which
 * @sentry/node fills in, and which is usually the person's name) is dropped, and the home directory
 * in any string (stack frames, exception values, breadcrumbs, span data) becomes `~`.
 *
 * A walk, not a JSON round trip: an event carries `sdkProcessingMetadata` (the SDK's own scopes,
 * full of cycles), which is never sent and must reach the SDK untouched. Never throws: a throwing
 * beforeSend makes the SDK drop the event ("callback_error").
 */
export function scrubEvent<E extends object>(event: E, home: string): E {
  const { server_name: _host, ...rest } = event as E & { server_name?: string };
  if (!home || home === "/") return rest as E;
  const seen = new WeakMap<object, unknown>();
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return value.split(home).join("~");
    if (!value || typeof value !== "object" || key === "sdkProcessingMetadata") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(walk(item));
      return out;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return value; // class instances: as they are
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
    return out;
  };
  try {
    return walk(rest) as E;
  } catch {
    return rest as E;
  }
}

/**
 * A failed run's error as it is reported: secret-looking tokens redacted (a provider's message can
 * echo part of a key), and a fingerprint that ignores numbers and ids, so one provider outage is one
 * Sentry issue rather than one per request id, however many laptops hit it.
 */
export function agentRunReport(message: string): { message: string; fingerprint: string[] } {
  const clean = redact(message);
  const shape = clean
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,}\b/g, "<id>")
    .replace(/\d+/g, "<n>")
    .slice(0, 200);
  return { message: clean, fingerprint: ["agent_end", shape] };
}

/** One record from pi's crashes.json (pi core/crash-log.js recordCrash, kept 5 deep). Only these
 * fields are ever sent: never its `cwd` or `sessionFile`. */
export interface CrashRecord {
  timestamp: string;
  version?: string;
  kind?: string;
  message?: string;
  stack?: string;
}

/** pi drops crash records older than this from its own notice; so does this. */
export const CRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The crashes to report now: well-formed, recent, and not already sent (`reported` holds the
 * timestamps of those that were). */
export function crashesToReport(records: unknown, reported: readonly string[], now: number): CrashRecord[] {
  if (!Array.isArray(records)) return [];
  const sent = new Set(reported);
  const out: CrashRecord[] = [];
  for (const r of records) {
    if (!r || typeof r !== "object" || typeof (r as CrashRecord).timestamp !== "string") continue;
    const c = r as Record<string, unknown>;
    const age = now - Date.parse(c.timestamp as string);
    if (!(age >= 0 && age <= CRASH_MAX_AGE_MS) || sent.has(c.timestamp as string)) continue;
    out.push({
      timestamp: c.timestamp as string,
      ...(typeof c.version === "string" ? { version: c.version } : {}),
      ...(typeof c.kind === "string" ? { kind: c.kind } : {}),
      ...(typeof c.message === "string" ? { message: redact(c.message) } : {}),
      ...(typeof c.stack === "string" ? { stack: redact(c.stack) } : {}),
    });
  }
  return out;
}
