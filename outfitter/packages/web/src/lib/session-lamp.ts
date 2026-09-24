// The lamp beside the run pill. The pill keeps the machine's own word (running, queued,
// idle, stopped). The lamp is the handful of states a person actually waits on.
//
// A question wins over "running": Pi blocks mid-turn, so the run stays running while
// Run.pendingUiRequest is set. Waking (queued, provisioning, or a send that has not
// been answered yet) blinks the same way as a turn in progress. Stopping sits with
// stopped, because the sandbox is on its way out.

import type { ActivityPhase } from "./send-status.ts";

export type LampTone = "working" | "idle" | "stopped" | "question" | "error";

export interface SessionLamp {
  tone: LampTone;
  /** Tooltip and accessible name. */
  label: string;
  /** Extra words the pill does not carry: BREAK, or a LOAD ERROR reason. */
  detail: string | null;
}

const WORKING_PHASES = new Set<ActivityPhase>(["sending", "waking", "working"]);
const ERROR_PHASES = new Set<ActivityPhase>(["sendFailed", "wakeTimeout", "workTimeout"]);

export function sessionLamp(input: {
  /** The run state the pill is showing. Absent means no run has been recorded. */
  runState?: string;
  phase: ActivityPhase;
  /** An interactive question (select, confirm, input, editor) is waiting on the person. */
  pendingQuestion: boolean;
  /** Header status line. READY. and "stopped · press Play" add nothing the lamp does not. */
  statusLine: string | null;
}): SessionLamp {
  const loadError = input.statusLine?.startsWith("LOAD ERROR") ? input.statusLine : null;
  const failed = input.runState === "failed" || loadError !== null || ERROR_PHASES.has(input.phase);

  let lamp: SessionLamp;
  if (failed) {
    lamp = { tone: "error", label: errorLabel(input.phase, loadError, input.runState), detail: loadError };
  } else if (input.pendingQuestion) {
    lamp = { tone: "question", label: "Waiting for you", detail: null };
  } else if (isWorking(input.runState, input.phase)) {
    lamp = { tone: "working", label: "Working", detail: null };
  } else if (input.runState === "idle") {
    lamp = { tone: "idle", label: "Idle — waiting for a prompt", detail: null };
  } else if (input.runState === "stopping") {
    lamp = { tone: "stopped", label: "Stopping", detail: null };
  } else {
    lamp = { tone: "stopped", label: "Stopped", detail: null };
  }

  if (input.statusLine === "BREAK") lamp = { ...lamp, detail: "BREAK" };
  return lamp;
}

function isWorking(runState: string | undefined, phase: ActivityPhase): boolean {
  if (WORKING_PHASES.has(phase)) return true;
  return runState === "running" || runState === "queued" || runState === "provisioning";
}

function errorLabel(phase: ActivityPhase, loadError: string | null, runState: string | undefined): string {
  if (loadError) return loadError;
  if (phase === "wakeTimeout") return "The drive didn't come up";
  if (phase === "workTimeout") return "No progress";
  if (phase === "sendFailed") return "Message not sent";
  if (runState === "failed") return "Failed";
  return "Error";
}
