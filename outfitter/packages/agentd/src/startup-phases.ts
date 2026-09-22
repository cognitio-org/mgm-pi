/**
 * Start-up phase timing for a run (docs/reports/startup-trim.md): one structured `phase` log line per
 * milestone between `run.spec` arriving and the first answer, on a monotonic clock, so a cloud wake's
 * own share of the delay can be read straight out of Cloud Logging:
 *
 *   {"severity":"INFO","message":"phase","phase":"pi ready","ms":5123,"sinceLastMs":4870,...}
 *
 * `ms` counts from the moment this timer was created (RunController creates it when `run.spec`
 * arrives); `sinceLastMs` is the gap from the previous milestone. Each phase is logged once; later
 * marks of the same name are ignored, so "first ..." milestones can be marked from every event.
 *
 * pi prints nothing when it finishes loading its extensions, so readiness is measured by a probe: a
 * `get_state` RPC sent right after spawning, which pi only answers once every extension has loaded
 * and every `session_start` handler has returned. Its response is recognised by id and swallowed
 * (`observe` returns true), never forwarded to the api.
 */
import type { LogFields } from "./logger.js";
import type { PiRpcCommand, PiRpcEvent } from "./protocol.js";

export const STARTUP_PROBE_ID = "agentd:startup-probe";

export interface StartupPhasesOptions {
  log: (message: string, fields: LogFields) => void;
  /** Monotonic milliseconds; injectable for tests. */
  now?: () => number;
}

export class StartupPhases {
  private readonly now: () => number;
  private readonly origin: number;
  private last: number;
  private readonly seen = new Set<string>();

  constructor(private readonly opts: StartupPhasesOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.origin = this.now();
    this.last = this.origin;
  }

  /** Logs `phase` once, with the time since the timer started and since the previous phase. */
  mark(phase: string, fields: LogFields = {}): void {
    if (this.seen.has(phase)) return;
    this.seen.add(phase);
    const t = this.now();
    this.opts.log("phase", { phase, ms: Math.round(t - this.origin), sinceLastMs: Math.round(t - this.last), ...fields });
    this.last = t;
  }

  /** Sends the readiness probe (see the module doc). */
  probe(pi: { send(command: PiRpcCommand): void }): void {
    pi.send({ id: STARTUP_PROBE_ID, type: "get_state" });
  }

  /** Marks the first-prompt milestones from pi's own events. Returns true only for the probe's
   * response, which the caller must drop rather than forward. */
  observe(event: PiRpcEvent): boolean {
    if (event.type === "response" && event.id === STARTUP_PROBE_ID) {
      this.mark("pi ready");
      return true;
    }
    if (event.type === "response" && event.command === "prompt") {
      this.mark("first prompt accepted", event.success === false ? { error: String(event.error ?? "") } : {});
    } else if (event.type === "message_update") {
      const delta = (event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent?.type;
      if (typeof delta === "string" && delta.endsWith("_delta")) this.mark("first model token");
    } else if (event.type === "agent_end") {
      this.mark("first answer done");
    }
    return false;
  }
}
