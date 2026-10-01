/**
 * Sentry: error reporting and low-volume agent tracing, so a crash or a stuck tool shows up in a
 * dashboard instead of only in a transcript nobody reads.
 *
 * Two kinds of events, two sample rates (config.ts):
 *   - errors: an agent run that ends with an assistant stopReason of "error", plus any
 *     uncaughtException/unhandledRejection this process sees, always captured (ERROR_SAMPLE_RATE =
 *     100%: an error is rare enough and worth enough to always keep).
 *   - traces: one span per agent run (agent_start → agent_end) and one child span per tool call
 *     (tool_execution_start → tool_execution_end), sampled at SENTRY_TRACES_SAMPLE_RATE (default
 *     5%) by @sentry/node's own OpenTelemetry-based sampler — this extension always starts a span,
 *     Sentry's SDK decides whether it is kept.
 *
 * Config: SENTRY_DSN (default: this project's Sentry; set to "" to disable entirely),
 * SENTRY_ENVIRONMENT (default "development" in a source checkout, "production" in a release
 * bundle), SENTRY_TRACES_SAMPLE_RATE (default 0.05). See config.ts.
 *
 * `@sentry/node`'s `init()` wires up OpenTelemetry instrumentation at the process level, so this
 * only ever runs once (client.ts's `initSentryOnce` guards it) and never tears down except at
 * process exit, where `close()` flushes whatever is still buffered. pi builds a fresh extension
 * instance on every /new, /resume, /fork and /reload (the same lifetime kernal-background's exit
 * hook documents), so the uncaughtException/unhandledRejection listeners below are installed once
 * per process too, not once per instance — otherwise each reload would pile up another pair.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sentryConfig, type SentryConfig } from "./config.ts";
import { initSentryOnce, realSentry, type SentryLike, type SentrySpan } from "./client.ts";
import { agentRunError, toolSpanAttributes, type AgentEndMessage } from "./lib.ts";
import { installedVersion } from "../kernal-update/index.ts";

export type Deps = { sentry?: SentryLike; env?: Record<string, string | undefined> };

function reportableEnv(deps: Deps): Record<string, string | undefined> {
  // SENTRY_* is read directly (not through _shared/env's KERNAL_ prefix): every Sentry SDK and every
  // Sentry dashboard guide uses the plain name, so this follows that convention rather than kernal's.
  return deps.env ?? process.env;
}

export default function (pi: ExtensionAPI, deps: Deps = {}) {
  const config: SentryConfig = sentryConfig(reportableEnv(deps), installedVersion() !== undefined);
  const sentry = deps.sentry ?? realSentry;
  const started = initSentryOnce(config, installedVersion(), sentry);
  if (!started) return;

  let runSpan: SentrySpan | undefined;
  const toolSpans = new Map<string, SentrySpan>();

  pi.on("agent_start", async () => {
    runSpan = sentry.startInactiveSpan({ name: "agent.run", op: "agent.run" });
  });

  pi.on("agent_end", async (event: { messages: AgentEndMessage[] }) => {
    const error = agentRunError(event.messages ?? []);
    if (error) {
      sentry.captureException(new Error(error), { tags: { source: "agent_end" } });
      runSpan?.setStatus("error");
    } else {
      runSpan?.setStatus("ok");
    }
    runSpan?.end();
    runSpan = undefined;
  });

  pi.on("tool_execution_start", async (event: { toolCallId: string; toolName: string }) => {
    toolSpans.set(event.toolCallId, sentry.startInactiveSpan({
      name: `tool.${event.toolName}`,
      op: "tool.execute",
      attributes: toolSpanAttributes(event.toolName),
    }));
  });

  pi.on("tool_execution_end", async (event: { toolCallId: string; toolName: string; isError: boolean }) => {
    const span = toolSpans.get(event.toolCallId);
    toolSpans.delete(event.toolCallId);
    if (!span) return;
    span.setStatus(event.isError ? "error" : "ok");
    span.end();
  });

  installProcessErrorCapture(sentry);
}

let processHooksInstalled = false;

/** Crashes pi's own uncaughtExceptionHandler is about to report and exit on (interactive-mode.js);
 * this only adds a Sentry copy, it never calls process.exit or swallows the error. Guarded so a
 * second extension instance (see the module comment) does not add a second pair of listeners. */
function installProcessErrorCapture(sentry: SentryLike): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on("uncaughtException", (error) => { sentry.captureException(error, { tags: { source: "uncaughtException" } }); });
  process.on("unhandledRejection", (reason) => { sentry.captureException(reason, { tags: { source: "unhandledRejection" } }); });
}

/** Test-only: forget that the process-level hooks ran, so a fresh fake sentry can be wired in. */
export function _resetProcessErrorCaptureState(): void {
  processHooksInstalled = false;
}

export { sentryConfig, type SentryConfig } from "./config.ts";
export { initSentryOnce, type SentryLike } from "./client.ts";
