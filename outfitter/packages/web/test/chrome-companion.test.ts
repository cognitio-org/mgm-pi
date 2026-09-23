import { describe, expect, it } from "vitest";
import {
  CHROME_EXTENSION_ID,
  pingSucceeded,
  placeMessage,
  placementFailure,
  pollMessage,
  sessionUrl,
  splitAvailableFrom,
  splitMessage,
} from "../src/lib/chrome-companion.ts";

describe("chrome companion page messages", () => {
  it("hardcodes the pinned extension id", () => {
    expect(CHROME_EXTENSION_ID).toBe("iodmmlkefenhggpbpcmhkajencapmcee");
  });

  it("builds only the placement messages from the spec table", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(sessionUrl("http://localhost:5173", id)).toBe(`http://localhost:5173/sessions/${id}`);
    expect(placeMessage(id, "https://app.kernal.one", "Notes", "own")).toEqual({
      t: "place",
      sessionId: id,
      url: `https://app.kernal.one/sessions/${id}`,
      title: "Notes",
      mode: "own",
    });
    expect(Object.keys(placeMessage(id, "https://app.kernal.one", "Notes", "shared")).sort()).toEqual([
      "mode",
      "sessionId",
      "t",
      "title",
      "url",
    ]);
    expect(splitMessage(id, "other")).toEqual({ t: "split", sessionId: id, otherSessionId: "other" });
    expect(pollMessage()).toEqual({ t: "poll" });
    expect(JSON.stringify(placeMessage(id, "https://app.kernal.one", "Notes", "window"))).not.toContain("tabId");
  });

  it("shows controls only after ping, and Split only when the extension can split", () => {
    expect(pingSucceeded(undefined)).toBe(false);
    expect(pingSucceeded({ ok: false, error: "rejected" })).toBe(false);
    expect(pingSucceeded({ ok: true, version: "0.1.0", id: CHROME_EXTENSION_ID })).toBe(true);
    expect(splitAvailableFrom({ ok: true, split: true }, false)).toBe(true);
    expect(splitAvailableFrom({ ok: false, error: "split_unavailable" }, true)).toBe(false);
    expect(splitAvailableFrom({ ok: true }, false)).toBe(false);
    expect(placementFailure({ ok: false, error: "split_failed" })).toBe("split_failed");
    expect(placementFailure({ ok: false, error: "split_unavailable" })).toBe(null);
    expect(placementFailure({ ok: false, error: "place_failed" })).toBe("place_failed");
  });
});
