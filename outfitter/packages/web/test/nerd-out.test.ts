import { describe, expect, it } from "vitest";
import { ApiError, type SandboxLogLine } from "../src/api/client.ts";
import {
  chartGeometry,
  detailMessage,
  exitSummary,
  filterLines,
  formatMb,
  linesToText,
  mergeNewer,
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

  it("merges only newer lines, telling apart lines in the same instant", () => {
    const held = [line("2026-09-27T05:00:00.100Z", "a"), line("2026-09-27T05:00:01.000Z", "b")];
    const fresh = [
      line("2026-09-27T05:00:00.100Z", "a"),
      line("2026-09-27T05:00:01Z", "b"),
      line("2026-09-27T05:00:01.000Z", "b2"),
      line("2026-09-27T05:00:02.5Z", "c"),
    ];
    expect(mergeNewer(held, fresh).map((l) => l.message)).toEqual(["a", "b", "b2", "c"]);
  });

  it("returns the same array when nothing is new", () => {
    const held = [line("2026-09-27T05:00:00Z", "a")];
    expect(mergeNewer(held, [line("2026-09-27T05:00:00Z", "a")])).toBe(held);
    expect(mergeNewer([], [line("2026-09-27T05:00:00Z", "a")])).toHaveLength(1);
  });

  it("copies as plain text", () => {
    expect(linesToText([line("t1", "<b>hi</b>", "WARNING")])).toBe("t1 WARNING <b>hi</b>");
  });
});
