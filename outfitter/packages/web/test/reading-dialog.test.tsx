// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/components/Markdown.tsx";
import { ReadingDialog } from "../src/components/ReadingDialog.tsx";
import { isLongDocument, readingOpening, readingTitle } from "../src/lib/reading.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function key(k: string, shiftKey = false) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
  });
}

describe("isLongDocument", () => {
  it("is true at 1200 trimmed characters or at two ATX headings", () => {
    expect(isLongDocument("a".repeat(1199))).toBe(false);
    expect(isLongDocument(`\n${"a".repeat(1200)}\n`)).toBe(true);
    expect(isLongDocument("# Only\n\nshort")).toBe(false);
    expect(isLongDocument("# Alpha\n\n# Beta")).toBe(true);
    expect(isLongDocument("## Alpha\r\n## Beta")).toBe(true);
    expect(isLongDocument("#NoSpace\n\n#AlsoNo")).toBe(false);
    expect(isLongDocument("  ## indented\n\n# Real")).toBe(false);
  });
});

describe("readingOpening and readingTitle", () => {
  it("uses the first heading with marks stripped, else Reading", () => {
    expect(readingTitle("no heading\n\nbody")).toBe("Reading");
    expect(readingTitle("# Title\n\nbody")).toBe("Title");
    expect(readingTitle("##  Title ##\n")).toBe("Title");
    expect(readingTitle("# \n\nbody")).toBe("Reading");
    expect(readingTitle("### Deep\n\n## Later")).toBe("Deep");
  });

  it("takes the first prose paragraph and clips it to 320 characters plus an ellipsis", () => {
    expect(readingOpening("# Title\n\nHello world\n\n# Next\n\nHidden")).toBe("Hello world");
    expect(readingOpening("# Title\nThe intro continues")).toBe("The intro continues");
    expect(readingOpening("# Alpha\n\n# Beta")).toBe("Alpha");
    expect(readingOpening("a".repeat(320))).toBe("a".repeat(320));
    expect(readingOpening("a".repeat(321))).toBe(`${"a".repeat(320)}…`);
    expect(readingOpening(`hello\nworld\n\nnext`)).toBe("hello world");
    expect(readingOpening("   ")).toBe("");
  });
});

describe("ReadingDialog", () => {
  const text = `# Fleet notes\n\n${"word ".repeat(250)}\n\n## Later\n\nTAILMARKER [docs](https://example.com/docs)`;

  it("shows the full markdown under the heading title and does not collapse again", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    mount(<ReadingDialog text={text} onClose={vi.fn()} />);
    const dialog = container!.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Fleet notes");
    expect(dialog.className).toContain("html-preview-dialog");
    expect(dialog.textContent).toContain("TAILMARKER");
    expect(dialog.querySelector("h2")?.textContent).toBe("Later");
    expect(dialog.textContent).not.toContain("Read");
    expect(dialog.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("traps focus, closes on Escape, and returns focus to the opener", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    mount(<ReadingDialog text={text} onClose={onClose} />);
    const dialog = container!.querySelector('[role="dialog"]')!;
    const close = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Close")!;
    const link = dialog.querySelector("a")!;
    expect(document.activeElement).toBe(close);
    key("Tab");
    expect(document.activeElement).toBe(link);
    key("Tab");
    expect(document.activeElement).toBe(close);
    key("Tab", true);
    expect(document.activeElement).toBe(link);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });
});

describe("Markdown Read", () => {
  it("opens the reading dialog on the full text and restores focus", () => {
    const text = `# Fleet notes\n\n${"word ".repeat(250)}\n\n## Later\n\nTAILMARKER`;
    mount(<Markdown text={text} />);
    const read = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Read")!;
    expect(container!.textContent).not.toContain("TAILMARKER");
    act(() => {
      read.focus();
      read.click();
    });
    const dialog = container!.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("TAILMARKER");
    expect(dialog.querySelectorAll("button").length).toBe(1);
    const close = dialog.querySelector("button")!;
    expect(document.activeElement).toBe(close);
    act(() => close.click());
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(read);
  });
});
