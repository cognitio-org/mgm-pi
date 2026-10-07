// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { isThoughtBubbleEnabled, setThoughtBubbleEnabled } from "../src/lib/thought-bubble.ts";

// The live thought itself (an open "Thinking…" row that follows the words) is covered with the
// rest of the transcript in session-redesign.test.tsx; the toggle lives in the Details pane.

beforeEach(() => {
  localStorage.clear();
});

describe("thought bubble preference", () => {
  it("stays off until turned on", () => {
    expect(isThoughtBubbleEnabled()).toBe(false);
    setThoughtBubbleEnabled(true);
    expect(isThoughtBubbleEnabled()).toBe(true);
    setThoughtBubbleEnabled(false);
    expect(isThoughtBubbleEnabled()).toBe(false);
  });
});
