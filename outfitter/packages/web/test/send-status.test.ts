import { describe, expect, it } from "vitest";
import type { PiEntry } from "../src/api/client.ts";
import {
  deriveSessionActivity,
  findEcho,
  isFinalAssistant,
  nextSendAnchor,
  notePendingRunState,
  quietLabel,
  AGENT_SILENT_MS,
  WAKE_TIMEOUT_MS,
  WORK_TIMEOUT_MS,
  type ActivityInput,
  type PendingSend,
} from "../src/lib/send-status.ts";

const T0 = 1_000_000;

function user(id: string, text: string): PiEntry {
  return { id, type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}
function assistant(id: string, text: string): PiEntry {
  return { id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}
/** Gemini thought-only STOP: stopReason stop, a thinking block, no text and no tool call. */
function thoughtOnly(id: string, extra?: Record<string, unknown>): PiEntry {
  return {
    id,
    type: "message",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "still pinging" }], ...extra },
  };
}

const history = [user("u0", "earlier"), assistant("a0", "earlier reply")];

function pending(over: Partial<PendingSend> = {}): PendingSend {
  return {
    localId: "local-1",
    text: "fix the bug",
    sentAt: T0,
    baseline: history.length,
    runStateAtSend: "stopped",
    sawChange: false,
    sawRunning: false,
    ...over,
  };
}

function derive(over: Partial<ActivityInput>) {
  return deriveSessionActivity({ entries: history, pending: null, now: T0, lastProgressAt: T0, ...over });
}

describe("deriveSessionActivity", () => {
  it("sending: POST in flight shows the optimistic row, 'Sending…', and disables the composer", () => {
    const a = derive({ runState: "stopped", pending: pending() });
    expect(a.phase).toBe("sending");
    expect(a.label).toBe("Sending…");
    expect(a.showOptimistic).toBe(true);
    expect(a.composerDisabled).toBe(true);
    expect(a.canWake).toBe(false);
  });

  it("send accepted with no live run: waking, and the pill already reads queued, not stopped", () => {
    const a = derive({ runState: "stopped", pending: pending({ acceptedAt: T0 + 100 }), now: T0 + 1000 });
    expect(a.phase).toBe("waking");
    expect(a.label).toBe("Waking a drive, about a minute");
    expect(a.pillState).toBe("queued");
    expect(a.canWake).toBe(false);
    expect(a.composerDisabled).toBe(false);
  });

  it("provisioning: still waking; Stop is available because a run is live", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "provisioning")!;
    const a = derive({ runState: "provisioning", pending: p, now: T0 + 30_000 });
    expect(a.phase).toBe("waking");
    expect(a.pillState).toBe("provisioning");
    expect(a.canStop).toBe(true);
    expect(a.canWake).toBe(false);
  });

  it("running: working; the echoed user entry replaces the optimistic row with no duplicate", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const entries = [...history, user("u1", "fix the bug")];
    const a = derive({ runState: "running", pending: p, entries, now: T0 + 60_000, lastProgressAt: T0 + 50_000 });
    expect(a.phase).toBe("working");
    expect(a.label).toBe("Working…");
    expect(a.showOptimistic).toBe(false);
    expect(a.canAbort).toBe(true);
  });

  it("an older identical message before the baseline doesn't count as the echo", () => {
    const entries = [user("u0", "fix the bug"), assistant("a0", "ok")];
    const a = derive({ runState: "running", entries, pending: pending({ acceptedAt: T0, baseline: 2, runStateAtSend: "idle" }) });
    expect(a.showOptimistic).toBe(true);
  });

  it("reply arrived: done, even if the idle status frame hasn't", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const entries = [...history, user("u1", "fix the bug"), assistant("a1", "done")];
    const a = derive({ runState: "running", pending: p, entries });
    expect(a.phase).toBe("none");
    expect(a.label).toBeNull();
    expect(a.showOptimistic).toBe(false);
  });

  it("a thought-only stop is not the reply while the run is still going", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const entries = [...history, user("u1", "fix the bug"), thoughtOnly("a1")];
    const a = derive({ runState: "running", pending: p, entries });
    expect(a.phase).toBe("working");
    expect(a.label).toBe("Working…");
    // #278: a failed attempt while running is still not the reply, text or not.
    const failed: PiEntry = {
      id: "f1",
      type: "message",
      message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [{ type: "text", text: "Let me write the report." }] },
    };
    expect(derive({ runState: "running", pending: p, entries: [...history, user("u1", "fix the bug"), failed] }).phase).toBe("working");
  });

  it("a thought-only stop answers the send once the run has settled", () => {
    let p = notePendingRunState(pending({ acceptedAt: T0 }), "running");
    p = notePendingRunState(p, "idle")!;
    const entries = [...history, user("u1", "fix the bug"), thoughtOnly("a1")];
    expect(derive({ runState: "idle", pending: p, entries }).phase).toBe("none");
    const failedRun = notePendingRunState(p, "failed")!;
    expect(derive({ runState: "failed", pending: failedRun, entries }).phase).toBe("none");
    expect(derive({ runState: "stopped", pending: notePendingRunState(p, "stopped")!, entries }).phase).toBe("none");
    expect(derive({ runState: undefined, pending: failedRun, entries }).phase).toBe("none");
  });

  it("visible text or a tool call stays final while running; whitespace and a thought do not", () => {
    expect(isFinalAssistant(thoughtOnly("a1"), { runState: "running" })).toBe(false);
    expect(isFinalAssistant(thoughtOnly("a1"), { runState: "idle" })).toBe(true);
    expect(isFinalAssistant(thoughtOnly("a1"), { runState: "failed" })).toBe(true);
    expect(isFinalAssistant(thoughtOnly("a1"), { runState: "stopped" })).toBe(true);
    expect(isFinalAssistant(thoughtOnly("a1"))).toBe(true);
    const blank = thoughtOnly("a2", { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: " \n\t" }] });
    expect(isFinalAssistant(blank, { runState: "running" })).toBe(false);
    expect(isFinalAssistant(thoughtOnly("a3", { content: "   " }), { runState: "running" })).toBe(false);
    expect(isFinalAssistant(assistant("a4", "done"), { runState: "running" })).toBe(true);
    expect(isFinalAssistant(thoughtOnly("a5", { content: "done" }), { runState: "running" })).toBe(true);
    const withCall = thoughtOnly("a6", { content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] });
    expect(isFinalAssistant(withCall, { runState: "running" })).toBe(true);
    expect(isFinalAssistant(thoughtOnly("a7", { stopReason: "toolUse" }), { runState: "idle" })).toBe(false);
    expect(isFinalAssistant(thoughtOnly("a8", { stopReason: "pending" }), { runState: "idle" })).toBe(false);
    const failed: PiEntry = {
      id: "f1",
      type: "message",
      message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "half a reply" }] },
    };
    expect(isFinalAssistant(failed, { runState: "running" })).toBe(false);
    expect(isFinalAssistant(failed, { runState: "failed" })).toBe(true);
  });

  it("an assistant entry that only calls tools is not the reply: still working", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const toolCall: PiEntry = {
      id: "a1",
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], stopReason: "toolUse" },
    };
    const entries = [...history, user("u1", "fix the bug"), toolCall];
    const a = derive({ runState: "running", pending: p, entries });
    expect(a.phase).toBe("working");
    expect(a.label).toBe("Working…");
  });

  it("idle after running: done, even before the reply entry lands", () => {
    let p = notePendingRunState(pending({ acceptedAt: T0 }), "running");
    p = notePendingRunState(p, "idle")!;
    const a = derive({ runState: "idle", pending: p, entries: [...history, user("u1", "fix the bug")] });
    expect(a.phase).toBe("none");
  });

  it("a fresh run reaching idle before its mail is delivered is not 'done'", () => {
    let p = notePendingRunState(pending({ acceptedAt: T0 }), "provisioning");
    p = notePendingRunState(p, "idle")!;
    expect(derive({ runState: "idle", pending: p }).phase).toBe("working");
  });

  it("a stale idle from before the send doesn't end the wait", () => {
    const p = pending({ acceptedAt: T0, runStateAtSend: "idle" });
    expect(derive({ runState: "idle", pending: p }).phase).toBe("working");
  });

  it("failed send: LOAD ERROR on the optimistic row with Retry, composer usable", () => {
    const a = derive({ runState: "idle", pending: pending({ error: "network down" }) });
    expect(a.phase).toBe("sendFailed");
    expect(a.errorHeadline).toBe("LOAD ERROR");
    expect(a.showOptimistic).toBe(true);
    expect(a.composerDisabled).toBe(false);
  });

  it("wake timeout: ?DEVICE NOT PRESENT ERROR after ~3 minutes without a live run, and Play comes back", () => {
    const p = pending({ acceptedAt: T0 });
    expect(derive({ runState: "stopped", pending: p, now: T0 + WAKE_TIMEOUT_MS - 1 }).phase).toBe("waking");
    const a = derive({ runState: "stopped", pending: p, now: T0 + WAKE_TIMEOUT_MS + 1 });
    expect(a.phase).toBe("wakeTimeout");
    expect(a.errorHeadline).toBe("?DEVICE NOT PRESENT ERROR");
    expect(a.canWake).toBe(true);
  });

  it("a run that fails before it ever ran is a wake error; one that fails mid-turn is LOAD ERROR", () => {
    const woke = notePendingRunState(pending({ acceptedAt: T0 }), "provisioning")!;
    expect(derive({ runState: "failed", pending: woke }).phase).toBe("wakeTimeout");
    const ran = notePendingRunState(woke, "running")!;
    expect(derive({ runState: "failed", pending: ran }).phase).toBe("workTimeout");
  });

  it("work timeout: LOAD ERROR after ~2 minutes with no entry or status progress, reset by progress", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const stuck = derive({ runState: "running", pending: p, now: T0 + WORK_TIMEOUT_MS + 1, lastProgressAt: T0 });
    expect(stuck.phase).toBe("workTimeout");
    expect(stuck.errorHeadline).toBe("LOAD ERROR");
    const progressing = derive({ runState: "running", pending: p, now: T0 + WORK_TIMEOUT_MS + 1, lastProgressAt: T0 + 60_000 });
    expect(progressing.phase).toBe("working");
  });

  it("a long step with agentd still heartbeating is quiet, not LOAD ERROR, and says how long (#182)", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const now = T0 + 5 * 60_000 + 30_000;
    const a = derive({ runState: "running", pending: p, now, lastProgressAt: T0, agentSeenAt: now - 10_000 });
    expect(a.phase).toBe("quiet");
    expect(a.errorHeadline).toBeNull();
    expect(a.label).toBe("Working, no output for 5 min");
    expect(a.canAbort).toBe(true);
    // Same without a send of ours (page reloaded mid-turn).
    expect(derive({ runState: "running", now, lastProgressAt: T0, agentSeenAt: now - 10_000 }).phase).toBe("quiet");
  });

  it("quiet turns into LOAD ERROR once agentd has been silent past AGENT_SILENT_MS", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const now = T0 + WORK_TIMEOUT_MS + 1;
    expect(derive({ runState: "running", pending: p, now, agentSeenAt: now - AGENT_SILENT_MS }).phase).toBe("quiet");
    expect(derive({ runState: "running", pending: p, now, agentSeenAt: now - AGENT_SILENT_MS - 1 }).phase).toBe("workTimeout");
  });

  it("an idle run that never picked the message up is still an error, heartbeat or not", () => {
    const p = pending({ acceptedAt: T0, runStateAtSend: "idle" });
    const now = T0 + WORK_TIMEOUT_MS + 1;
    expect(derive({ runState: "idle", pending: p, now, agentSeenAt: now }).phase).toBe("workTimeout");
  });

  it("without liveness from the api, a quiet running turn is LOAD ERROR as before", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    expect(derive({ runState: "running", pending: p, now: T0 + WORK_TIMEOUT_MS + 1 }).phase).toBe("workTimeout");
  });

  it("a stop that isn't finishing is still an error, heartbeat or not", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0 }), "running")!;
    const now = T0 + WORK_TIMEOUT_MS + 1;
    expect(derive({ runState: "stopping", pending: p, now, agentSeenAt: now }).phase).toBe("workTimeout");
  });

  it("after a reload the quiet label counts from pi's last activity, not from page load", () => {
    const loadedAt = T0 + 20 * 60_000;
    const now = loadedAt + WORK_TIMEOUT_MS + 1;
    const a = derive({ runState: "running", now, lastProgressAt: loadedAt, agentSeenAt: now, piActiveAt: T0 });
    expect(a.phase).toBe("quiet");
    expect(a.label).toBe("Working, no output for 22 min");
  });

  it("quietLabel rounds down to whole minutes, never below 1", () => {
    expect(quietLabel(0)).toBe("Working, no output for 1 min");
    expect(quietLabel(2 * 60_000 + 59_000)).toBe("Working, no output for 2 min");
    expect(quietLabel(61 * 60_000)).toBe("Working, no output for 61 min");
  });

  it("reload mid-wait (no pending send): provisioning reads waking, running reads working, with the same timeouts", () => {
    expect(derive({ runState: "provisioning" }).phase).toBe("waking");
    expect(derive({ runState: "queued", now: T0 + WAKE_TIMEOUT_MS + 1 }).phase).toBe("wakeTimeout");
    expect(derive({ runState: "running" }).phase).toBe("working");
    expect(derive({ runState: "running", now: T0 + WORK_TIMEOUT_MS + 1 }).phase).toBe("workTimeout");
    const idle = derive({ runState: "idle" });
    expect(idle.phase).toBe("none");
    expect(idle.showOptimistic).toBe(false);
  });

  it("controls never disagree: nothing live means Play only; a live run means Stop only", () => {
    const stopped = derive({ runState: "stopped" });
    expect([stopped.canWake, stopped.canStop, stopped.canAbort]).toEqual([true, false, false]);
    const idle = derive({ runState: "idle" });
    expect([idle.canWake, idle.canStop, idle.canAbort]).toEqual([false, true, true]);
    const stopping = derive({ runState: "stopping" });
    expect([stopping.canWake, stopping.canStop, stopping.canAbort]).toEqual([false, false, false]);
    const busy = derive({ runState: "idle", pendingAction: "stop" });
    expect([busy.canWake, busy.canStop, busy.composerDisabled]).toEqual([false, false, true]);
  });
});

describe("notePendingRunState", () => {
  it("ignores state changes while the POST is still in flight", () => {
    const p = pending();
    expect(notePendingRunState(p, "running")).toBe(p);
  });

  it("records a change from the state at send, and running", () => {
    const p = notePendingRunState(pending({ acceptedAt: T0, runStateAtSend: "idle" }), "running")!;
    expect(p.sawChange).toBe(true);
    expect(p.sawRunning).toBe(true);
  });
});

describe("quick second send", () => {
  const first = pending({ text: "first message", acceptedAt: T0 });

  it("inherits the first send's baseline and skips its echo while that echo hasn't arrived", () => {
    expect(nextSendAnchor(history, first)).toEqual({ baseline: history.length, skipUsers: 1 });
  });

  it("starts fresh once the first send's echo is stored", () => {
    const stored = [...history, user("u1", "first message")];
    expect(nextSendAnchor(stored, first)).toEqual({ baseline: stored.length, skipUsers: 0 });
  });

  it("starts fresh after a failed send (it was never stored)", () => {
    expect(nextSendAnchor(history, { ...first, error: "boom" })).toEqual({ baseline: history.length, skipUsers: 0 });
  });

  it("does not take the first message's echo (or its reply) for the second's", () => {
    const second = pending({ text: "second message", acceptedAt: T0, ...nextSendAnchor(history, first) });
    const onlyFirstStored = [...history, user("u1", "first message"), assistant("a1", "reply to first")];
    expect(findEcho(onlyFirstStored, second)).toBe(-1);
    const bothStored = [...onlyFirstStored, user("u2", "second message")];
    expect(findEcho(bothStored, second)).toBe(bothStored.length - 1);
  });

  it("matches the second echo even when the two texts are identical", () => {
    const again = pending({ text: "same", acceptedAt: T0 });
    const second = pending({ text: "same", acceptedAt: T0, ...nextSendAnchor(history, again) });
    const oneStored = [...history, user("u1", "same")];
    expect(findEcho(oneStored, second)).toBe(-1);
    const twoStored = [...oneStored, user("u2", "same")];
    expect(findEcho(twoStored, second)).toBe(twoStored.length - 1);
  });
});
