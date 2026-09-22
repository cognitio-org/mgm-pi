import { describe, expect, it } from "vitest";
import {
  composerKeyAction,
  defaultEnterMode,
  ENTER_MODE_STORAGE_KEY,
  loadEnterMode,
  saveEnterMode,
} from "../src/lib/composer-keys.ts";

describe("composerKeyAction", () => {
  it("send mode: Enter sends, Shift+Enter is a newline", () => {
    expect(composerKeyAction({ key: "Enter" }, "send")).toBe("send");
    expect(composerKeyAction({ key: "Enter", shiftKey: true }, "send")).toBe("newline");
  });

  it("newline mode: Enter is a newline, Shift+Enter sends", () => {
    expect(composerKeyAction({ key: "Enter" }, "newline")).toBe("newline");
    expect(composerKeyAction({ key: "Enter", shiftKey: true }, "newline")).toBe("send");
  });

  it("Cmd/Ctrl+Enter always sends, in both modes", () => {
    for (const mode of ["send", "newline"] as const) {
      expect(composerKeyAction({ key: "Enter", metaKey: true }, mode)).toBe("send");
      expect(composerKeyAction({ key: "Enter", ctrlKey: true }, mode)).toBe("send");
      expect(composerKeyAction({ key: "Enter", ctrlKey: true, shiftKey: true }, mode)).toBe("send");
    }
  });

  it("never acts during IME composition (isComposing or keyCode 229)", () => {
    for (const mode of ["send", "newline"] as const) {
      expect(composerKeyAction({ key: "Enter", isComposing: true }, mode)).toBe("ignore");
      expect(composerKeyAction({ key: "Enter", keyCode: 229 }, mode)).toBe("ignore");
      expect(composerKeyAction({ key: "Enter", metaKey: true, isComposing: true }, mode)).toBe("ignore");
    }
  });

  it("ignores every other key", () => {
    expect(composerKeyAction({ key: "a" }, "send")).toBe("ignore");
    expect(composerKeyAction({ key: "Tab", shiftKey: true }, "newline")).toBe("ignore");
  });

  it("Alt+Enter is a newline even in send mode", () => {
    expect(composerKeyAction({ key: "Enter", altKey: true }, "send")).toBe("newline");
  });
});

describe("enter mode persistence", () => {
  it("defaults to newline on touch devices and send on desktop", () => {
    expect(defaultEnterMode(true)).toBe("newline");
    expect(defaultEnterMode(false)).toBe("send");
    expect(loadEnterMode({ getItem: () => null }, true)).toBe("newline");
    expect(loadEnterMode({ getItem: () => null }, false)).toBe("send");
  });

  it("a saved choice wins over the device default; junk is ignored", () => {
    expect(loadEnterMode({ getItem: () => "send" }, true)).toBe("send");
    expect(loadEnterMode({ getItem: () => "newline" }, false)).toBe("newline");
    expect(loadEnterMode({ getItem: () => "sideways" }, false)).toBe("send");
  });

  it("storage that throws falls back to the default, and saving doesn't throw", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(loadEnterMode(broken, true)).toBe("newline");
    expect(() => saveEnterMode("send", broken)).not.toThrow();
  });

  it("saves under the storage key", () => {
    const saved = new Map<string, string>();
    saveEnterMode("newline", { setItem: (k, v) => void saved.set(k, v) });
    expect(saved.get(ENTER_MODE_STORAGE_KEY)).toBe("newline");
  });
});
