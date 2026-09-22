import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, GLOSSARY_TERMS, TYPICAL_TASK_STEPS } from "../src/lib/glossary.ts";

describe("glossary completeness", () => {
  it("every term has a label, meaning and code name", () => {
    expect(GLOSSARY_TERMS.length).toBeGreaterThan(0);
    for (const term of GLOSSARY_TERMS) {
      expect(term.id.length).toBeGreaterThan(0);
      expect(term.label.length).toBeGreaterThan(0);
      expect(term.meaning.length).toBeGreaterThan(0);
      expect(term.codeName.length).toBeGreaterThan(0);
      expect(term.glyph.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate ids", () => {
    const ids = GLOSSARY_TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all the required terms from the brief", () => {
    const ids = GLOSSARY_TERMS.map((t) => t.id);
    for (const id of [
      "kernal",
      "tape",
      "floppy",
      "disk-box",
      "drive",
      "play",
      "stop",
      "break",
      "eject",
      "peripherals",
      "dongles",
      "control-panel",
      "sysop",
      "manual",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("every error message has a message and a meaning", () => {
    expect(ERROR_MESSAGES.length).toBeGreaterThan(0);
    for (const err of ERROR_MESSAGES) {
      expect(err.message.length).toBeGreaterThan(0);
      expect(err.meaning.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate error ids", () => {
    const ids = ERROR_MESSAGES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has five typical-task steps, each with a title and detail", () => {
    expect(TYPICAL_TASK_STEPS.length).toBe(5);
    for (const step of TYPICAL_TASK_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });
});
