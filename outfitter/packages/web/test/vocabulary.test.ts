import { describe, expect, it } from "vitest";
import { transport, transportLabel, vocabSubtitle, vocabulary } from "../src/lib/vocabulary.ts";

describe("vocabulary", () => {
  it("every entry has one, many and a hint", () => {
    for (const [key, entry] of Object.entries(vocabulary)) {
      expect(entry.one, key).toBeTruthy();
      expect(entry.many, key).toBeTruthy();
      expect(entry.hint, key).toBeTruthy();
    }
  });

  it("vocabSubtitle joins the plural form and hint with a middle dot by default", () => {
    expect(vocabSubtitle("guru")).toBe("Tapes · reusable agent configurations: model, prompt, tools");
  });

  it("vocabSubtitle can use the singular form", () => {
    expect(vocabSubtitle("session", "one")).toBe("Floppy · a conversation with an agent you can continue later");
  });

  it("names the subscription logins", () => {
    expect(vocabulary.subscription.one).toBe("Subscriptions");
    expect(vocabulary.subscription.many).toBe("Subscriptions");
    expect(vocabulary.subscription.hint).toBe("your Claude, Grok, Codex, and Antigravity logins");
    expect(vocabSubtitle("subscription")).toBe("Subscriptions · your Claude, Grok, Codex, and Antigravity logins");
  });

  it("names the laptop/cloud agent Kernal, not mgm", () => {
    expect(vocabulary.kernal.one).toBe("Kernal");
    expect(vocabulary.kernal.hint).toContain("laptop");
  });

  it("eject and token hints reference Kernal, not mgm", () => {
    expect(transport.eject.hint).toContain("Kernal");
    expect(transport.eject.hint.toLowerCase()).not.toContain("mgm");
    expect(vocabulary.token.hint).toContain("Kernal");
  });
});

describe("transportLabel", () => {
  it("prefixes the glyph when one is set", () => {
    expect(transportLabel("wake")).toBe(`${transport.wake.glyph} Play`);
    expect(transportLabel("stop")).toBe(`${transport.stop.glyph} Stop`);
    expect(transportLabel("eject")).toBe(`${transport.eject.glyph} Eject`);
  });

  it("has no glyph for break (interrupt), matching the C64 RUN/STOP key with no discrete symbol", () => {
    expect(transportLabel("abort")).toBe("Break");
  });
});
