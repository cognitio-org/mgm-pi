import { describe, expect, it } from "vitest";
import { sessionLamp } from "../src/lib/session-lamp.ts";

const quiet = { phase: "none" as const, pendingQuestion: false, statusLine: null };

describe("sessionLamp", () => {
  it("blinks for a turn in progress, and for a drive that is still waking", () => {
    expect(sessionLamp({ ...quiet, runState: "running" }).tone).toBe("working");
    expect(sessionLamp({ ...quiet, runState: "queued" }).tone).toBe("working");
    expect(sessionLamp({ ...quiet, runState: "provisioning" }).tone).toBe("working");
    expect(sessionLamp({ ...quiet, phase: "sending", runState: "stopped" }).tone).toBe("working");
    expect(sessionLamp({ ...quiet, phase: "waking", runState: "stopped" }).tone).toBe("working");
    expect(sessionLamp({ ...quiet, phase: "working", runState: "idle" }).tone).toBe("working");
    // A long step with agentd still heartbeating (#182) is working, not an error.
    expect(sessionLamp({ ...quiet, phase: "quiet", runState: "running" })).toEqual({ tone: "working", label: "Working", detail: null });
  });

  it("holds a light green for idle — the sandbox is up and the prompt is free", () => {
    expect(sessionLamp({ ...quiet, runState: "idle" })).toEqual({
      tone: "idle",
      label: "Idle — waiting for a prompt",
      detail: null,
    });
  });

  it("holds amber for stopped, for a floppy with no run, and while a run is stopping", () => {
    expect(sessionLamp({ ...quiet, runState: "stopped" }).tone).toBe("stopped");
    expect(sessionLamp({ ...quiet, runState: undefined }).tone).toBe("stopped");
    expect(sessionLamp({ ...quiet, runState: "stopping" })).toMatchObject({ tone: "stopped", label: "Stopping" });
  });

  it("turns blue when a question is waiting, even though the run is still running", () => {
    expect(sessionLamp({ ...quiet, runState: "running", pendingQuestion: true })).toEqual({
      tone: "question",
      label: "Waiting for you",
      detail: null,
    });
  });

  it("turns red for a failed run, a LOAD ERROR line, and a timed-out send", () => {
    expect(sessionLamp({ ...quiet, runState: "failed" })).toMatchObject({ tone: "error", label: "Failed" });
    expect(sessionLamp({ ...quiet, runState: "running", statusLine: "LOAD ERROR — Tape not found" })).toEqual({
      tone: "error",
      label: "LOAD ERROR — Tape not found",
      detail: "LOAD ERROR — Tape not found",
    });
    expect(sessionLamp({ ...quiet, phase: "workTimeout", runState: "running" }).tone).toBe("error");
    expect(sessionLamp({ ...quiet, phase: "wakeTimeout", runState: "queued" }).label).toBe("The drive didn't come up");
    expect(sessionLamp({ ...quiet, phase: "sendFailed", runState: "stopped" }).label).toBe("Message not sent");
  });

  it("lets a pending question win over a work timeout", () => {
    expect(sessionLamp({ ...quiet, phase: "workTimeout", runState: "running", pendingQuestion: true }).tone).toBe(
      "question",
    );
  });

  it("lets an error beat a question, and keeps a BREAK flash as words on top of the lamp", () => {
    expect(sessionLamp({ ...quiet, runState: "failed", pendingQuestion: true }).tone).toBe("error");
    expect(sessionLamp({ ...quiet, runState: "idle", statusLine: "BREAK" })).toEqual({
      tone: "idle",
      label: "Idle — waiting for a prompt",
      detail: "BREAK",
    });
  });
});
