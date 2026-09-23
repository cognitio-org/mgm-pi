import { describe, expect, it } from "vitest";
import {
  contextMeterMessage,
  contextMeterState,
  deriveTransportStatusLine,
  systemErrorContent,
  apiErrorKind,
  noticeContent,
  runStateNote,
  inVocabulary,
  systemErrorId,
  transportStatusLine,
} from "../src/lib/retro-errors.ts";

describe("systemErrorContent", () => {
  it("uses the fixed bomb-dialog headline and the API's message, in the UI's vocabulary", () => {
    expect(systemErrorContent("guru not found")).toEqual({
      headline: "Sorry, a system error occurred.",
      message: "Tape not found",
    });
  });

  it("falls back to a plain sentence when there is no API message", () => {
    expect(systemErrorContent(undefined).message).toBe("An unexpected error occurred.");
    expect(systemErrorContent("   ").message).toBe("An unexpected error occurred.");
  });
});

describe("systemErrorId", () => {
  it("stringifies an HTTP status", () => {
    expect(systemErrorId(404)).toBe("404");
    expect(systemErrorId(500)).toBe("500");
  });

  it("falls back to ERR when there is no status (a non-ApiError thrown value)", () => {
    expect(systemErrorId(undefined)).toBe("ERR");
  });
});

describe("contextMeterState", () => {
  it("is ok below 50%", () => {
    expect(contextMeterState(0)).toBe("ok");
    expect(contextMeterState(49)).toBe("ok");
  });

  it("is warn from 50% to just under 80%", () => {
    expect(contextMeterState(50)).toBe("warn");
    expect(contextMeterState(79)).toBe("warn");
  });

  it("is danger from 80% to just under 95%", () => {
    expect(contextMeterState(80)).toBe("danger");
    expect(contextMeterState(94)).toBe("danger");
  });

  it("is outOfMemory at 95% and above", () => {
    expect(contextMeterState(95)).toBe("outOfMemory");
    expect(contextMeterState(100)).toBe("outOfMemory");
  });
});

describe("contextMeterMessage", () => {
  it("is null below 95%", () => {
    expect(contextMeterMessage(94)).toBeNull();
  });

  it("reads ?OUT OF MEMORY ERROR at 95%+", () => {
    expect(contextMeterMessage(95)).toContain("?OUT OF MEMORY ERROR");
    expect(contextMeterMessage(95)).toContain("compact soon");
  });
});

describe("transportStatusLine", () => {
  it("maps each outcome to its retro text", () => {
    expect(transportStatusLine("ready")).toBe("READY.");
    expect(transportStatusLine("break")).toBe("BREAK");
    expect(transportStatusLine("loadError")).toBe("LOAD ERROR");
  });
});

describe("deriveTransportStatusLine (bug 3: READY. shown when nothing is running)", () => {
  it("shows READY. only for an idle live run", () => {
    expect(deriveTransportStatusLine("idle", null)).toBe("READY.");
  });

  it("shows nothing while a run is actively working -- <Working> covers it", () => {
    expect(deriveTransportStatusLine("running", null)).toBeNull();
    expect(deriveTransportStatusLine("queued", null)).toBeNull();
    expect(deriveTransportStatusLine("provisioning", null)).toBeNull();
    expect(deriveTransportStatusLine("stopping", null)).toBeNull();
  });

  it("a cleanly stopped run reads 'stopped - press Play', not READY.", () => {
    expect(deriveTransportStatusLine("stopped", null)).toBe("stopped · press Play");
  });

  it("no run recorded at all also reads 'stopped - press Play'", () => {
    expect(deriveTransportStatusLine(undefined, null)).toBe("stopped · press Play");
  });

  it("a failed run reads LOAD ERROR with its reason, in the UI's vocabulary", () => {
    expect(deriveTransportStatusLine("failed", null)).toBe("LOAD ERROR");
    expect(deriveTransportStatusLine("failed", null, "guru not found")).toBe("LOAD ERROR — Tape not found");
  });

  it("prefers a flashed outcome over any run-state line", () => {
    expect(deriveTransportStatusLine("idle", "break")).toBe("BREAK");
    expect(deriveTransportStatusLine("stopped", "loadError")).toBe("LOAD ERROR");
    expect(deriveTransportStatusLine("running", "loadError")).toBe("LOAD ERROR");
  });
});

describe("apiErrorKind: only real failures get the bomb", () => {
  it("5xx, network errors and unknown statuses are system errors", () => {
    expect(apiErrorKind(500)).toBe("system");
    expect(apiErrorKind(503)).toBe("system");
    expect(apiErrorKind(undefined)).toBe("system");
  });
  it("deliberate refusals and auth are calm notices", () => {
    expect(apiErrorKind(400)).toBe("refused");
    expect(apiErrorKind(409)).toBe("refused");
    expect(apiErrorKind(422)).toBe("refused");
    expect(apiErrorKind(401)).toBe("signedOut");
    expect(apiErrorKind(403)).toBe("sysopOnly");
    expect(apiErrorKind(404)).toBe("notFound");
  });
});

describe("noticeContent and inVocabulary", () => {
  it("translates the API's code names into the UI's words", () => {
    expect(inVocabulary("guru is referenced by 2 sessions")).toBe("Tape is referenced by 2 floppies");
    expect(inVocabulary("unknown guruId: x")).toBe("Unknown guruId: x");
    expect(inVocabulary("Session not found")).toBe("Floppy not found");
  });
  it("a 409 reads as a plain refusal with the API's reason", () => {
    expect(noticeContent("refused", "guru is referenced by 1 session")).toEqual({ headline: "Can't do that", message: "Tape is referenced by 1 floppy" });
  });
  it("404 keeps the retro headline", () => {
    expect(noticeContent("notFound", undefined).headline).toBe("?FILE NOT FOUND ERROR");
  });
});


// The note the api writes when it refuses a run's agent connection (api agentlink.ts's refuse()) or
// gives up on its sandbox (runs.ts's reconciler). Before, the session page showed a provisioning
// spinner and the Disk Box list a bare pill, with the reason only in Cloud Logging.
describe("runStateNote", () => {
  it("shows a refusal in the UI's own words, since the api writes it in the api's", () => {
    expect(runStateNote("this session's guru (t1) no longer exists, so the api can't build its run spec.")).toBe(
      "This floppy's tape (t1) no longer exists, so the api can't build its run spec.",
    );
  });
  it("keeps a note that needs no translation, capitalised as a sentence", () => {
    expect(runStateNote("no GitHub token is stored for this session, so its sandbox can't clone the repo.")).toBe(
      "No GitHub token is stored for this floppy, so its sandbox can't clone the repo.",
    );
  });
  it("is null when there is nothing to say, so a caller can render it conditionally", () => {
    expect(runStateNote(undefined)).toBeNull();
    expect(runStateNote("   ")).toBeNull();
  });
  it("passes an agentd-authored detail (bug 7) through unchanged", () => {
    expect(runStateNote("pi rejected prompt: model not found")).toBe("Pi rejected prompt: model not found");
  });
});
