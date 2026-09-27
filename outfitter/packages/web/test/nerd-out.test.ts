import { describe, expect, it } from "vitest";
import { ApiError, type SandboxLogLine } from "../src/api/client.ts";
import {
  chartGeometry,
  detailMessage,
  exitSummary,
  filterLines,
  formatMb,
  linesToText,
  displayMessage,
  mergeLines,
  pageReaches,
  severityTag,
  shortImage,
  telemetryMessage,
} from "../src/lib/nerd-out.ts";

const line = (time: string, message: string, severity = "INFO"): SandboxLogLine => ({ time, message, severity });

describe("formatting", () => {
  it("formats MiB and GiB", () => {
    expect(formatMb(812.4)).toBe("812 MiB");
    expect(formatMb(4096)).toBe("4.0 GiB");
    expect(formatMb(3277)).toBe("3.2 GiB");
  });

  it("shortens an image to its name and a 12-character digest", () => {
    expect(shortImage("europe-docker.pkg.dev/p/r/outfitter-agent@sha256:0123456789abcdef0123")).toBe("outfitter-agent@0123456789ab");
    expect(shortImage("europe-docker.pkg.dev/p/r/outfitter-agent:2026.09.27")).toBe("outfitter-agent:2026.09.27");
    expect(shortImage("busybox")).toBe("busybox");
  });

  it("summarizes an exit, clean only for Completed with exit 0", () => {
    expect(exitSummary({ reason: "OOMKilled", exitCode: 137 })).toEqual({ text: "OOMKilled · exit 137", tone: "danger" });
    expect(exitSummary({ reason: "Completed", exitCode: 0 }).tone).toBe("ok");
    expect(exitSummary({ reason: "Completed", exitCode: 1 }).tone).toBe("danger");
    expect(exitSummary({ reason: "Error", finishedAt: "2026-09-27T05:04:12Z" }).text).toMatch(/^Error · \d\d:\d\d:\d\d$/);
  });

  it("explains each api status without a backend body", () => {
    expect(telemetryMessage(new ApiError(503, "x"), "Logs")).toMatch(/access isn't granted yet/);
    expect(telemetryMessage(new ApiError(501, "x"), "Stats history")).toMatch(/GKE drives only/);
    expect(telemetryMessage(new ApiError(501, "x"), "Logs")).toMatch(/aren't available/);
    expect(telemetryMessage(new ApiError(502, "google said no"), "Logs")).toBe("Logs couldn't be loaded (502). Try again in a moment.");
    expect(telemetryMessage(new Error("offline"), "Logs")).toBe("Logs couldn't be loaded. Try again in a moment.");
    expect(detailMessage(new ApiError(404, "x"), true)).toMatch(/No run yet/);
    expect(detailMessage(new ApiError(404, "x"), false)).toMatch(/isn't part of this floppy/);
  });
});

describe("chartGeometry", () => {
  it("draws a stepped line by time, holding the last sample to the edge", () => {
    const geo = chartGeometry(
      [
        ["2026-09-27T05:00:00Z", 0],
        ["2026-09-27T05:01:00Z", 50],
        ["2026-09-27T05:03:00Z", 100],
      ],
      300,
      100,
    );
    // 05:01 is a third of the way along, 05:03 the end.
    expect(geo.path).toBe("M0 100 H100 V50 H300 V0 H300");
    expect(geo.area).toBe("M0 100 H100 V50 H300 V0 H300 V100 H0 Z");
    expect(geo.max).toBe(100);
    expect(geo.last).toBe(100);
    expect(geo.limitY).toBeUndefined();
  });

  it("scales to the limit when it's above the peak, and places the limit line", () => {
    const geo = chartGeometry([["2026-09-27T05:00:00Z", 1024]], 200, 80, 4096);
    expect(geo.max).toBe(4096);
    expect(geo.limitY).toBe(0);
    expect(geo.path).toBe("M0 60 H200");
  });

  it("is empty with no usable samples", () => {
    const geo = chartGeometry([["not a time", 5]], 200, 80, 100);
    expect(geo.path).toBe("");
    expect(geo.last).toBeUndefined();
    expect(geo.limitY).toBe(0);
  });
});

describe("log lines", () => {
  it("tags severities", () => {
    expect(severityTag("ERROR").tag).toBe("ERR");
    expect(severityTag("CRITICAL").tone).toBe("error");
    expect(severityTag("WARNING").tag).toBe("WRN");
    expect(severityTag("DEBUG").tag).toBe("DBG");
    expect(severityTag("DEFAULT").tag).toBe("INF");
    expect(severityTag("whatever").tag).toBe("INF");
  });

  it("filters by level and text", () => {
    const lines = [line("t1", "booting"), line("t2", "Disk low", "WARNING"), line("t3", "pi crashed", "ERROR")];
    expect(filterLines(lines, "", "all")).toHaveLength(3);
    expect(filterLines(lines, "", "warn").map((l) => l.message)).toEqual(["Disk low", "pi crashed"]);
    expect(filterLines(lines, "", "error").map((l) => l.message)).toEqual(["pi crashed"]);
    expect(filterLines(lines, "  DISK ", "all").map((l) => l.message)).toEqual(["Disk low"]);
  });

  it("merges as a union in time order: overlaps once, late lines in place", () => {
    const held = [line("2026-09-27T05:00:00.100Z", "a"), line("2026-09-27T05:00:03.000Z", "d")];
    const page = [
      line("2026-09-27T05:00:00.1Z", "a"),
      line("2026-09-27T05:00:02Z", "late"),
      line("2026-09-27T05:00:03.000Z", "d"),
      line("2026-09-27T05:00:03.000Z", "d2"),
      line("2026-09-27T05:00:04.5Z", "e"),
    ];
    expect(mergeLines(held, page).map((l) => l.message)).toEqual(["a", "late", "d", "d2", "e"]);
    // Load earlier after the log grew: the older page overlaps what's held.
    expect(mergeLines(held, [line("2026-09-27T04:59:59Z", "z"), held[0]!]).map((l) => l.message)).toEqual(["z", "a", "d"]);
  });

  it("returns the same array when nothing is new", () => {
    const held = [line("2026-09-27T05:00:00Z", "a")];
    expect(mergeLines(held, [line("2026-09-27T05:00:00.000Z", "a")])).toBe(held);
    expect(mergeLines([], [line("2026-09-27T05:00:00Z", "a")])).toHaveLength(1);
  });

  it("knows whether a page reaches back to the lines held", () => {
    const held = [line("2026-09-27T05:00:10Z", "a")];
    expect(pageReaches(held, [line("2026-09-27T05:00:10Z", "a"), line("2026-09-27T05:00:11Z", "b")])).toBe(true);
    expect(pageReaches(held, [line("2026-09-27T05:00:12Z", "c")])).toBe(false);
    expect(pageReaches([], [line("2026-09-27T05:00:12Z", "c")])).toBe(true);
  });

  it("shows a message on one line, with controls and bidi characters made visible", () => {
    expect(displayMessage("ok\n2026-09-27T05:04:12Z INFO deploy approved")).toBe("ok ⏎ 2026-09-27T05:04:12Z INFO deploy approved");
    expect(displayMessage("a\r\nb\rc\td")).toBe("a ⏎ b ⏎ c  d");
    expect(displayMessage("\u001b[31mred")).toBe("<U+001B>[31mred");
    expect(displayMessage("abc\u202Efdp.exe")).toBe("abc<U+202E>fdp.exe");
    expect(displayMessage("plain ünïcode ✓")).toBe("plain ünïcode ✓");
  });

  it("copies as plain text", () => {
    expect(linesToText([line("t1", "<b>hi</b>", "WARNING")])).toBe("t1 WARNING <b>hi</b>");
    expect(linesToText([line("t1", "x\nt2 INFO forged")])).toBe("t1 INFO x ⏎ t2 INFO forged");
  });
});
