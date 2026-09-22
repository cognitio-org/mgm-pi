import { describe, expect, it } from "vitest";
import {
  contextMeterMessage,
  contextMeterState,
  deriveTransportStatusLine,
  systemErrorContent,
  systemErrorId,
  transportStatusLine,
} from "../src/lib/retro-errors.ts";

describe("systemErrorContent", () => {
  it("uses the fixed bomb-dialog headline and the API's message", () => {
    expect(systemErrorContent("guru not found")).toEqual({
      headline: "Sorry, a system error occurred.",
      message: "guru not found",
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

describe("deriveTransportStatusLine", () => {
  it("shows READY. once nothing is running and no outcome is flashed", () => {
    expect(deriveTransportStatusLine(false, null)).toBe("READY.");
  });

  it("shows nothing while a run is active and no outcome is flashed", () => {
    expect(deriveTransportStatusLine(true, null)).toBeNull();
  });

  it("prefers a flashed outcome over READY.", () => {
    expect(deriveTransportStatusLine(false, "break")).toBe("BREAK");
    expect(deriveTransportStatusLine(false, "loadError")).toBe("LOAD ERROR");
  });

  it("prefers a flashed outcome even while technically still active", () => {
    expect(deriveTransportStatusLine(true, "loadError")).toBe("LOAD ERROR");
  });
});
