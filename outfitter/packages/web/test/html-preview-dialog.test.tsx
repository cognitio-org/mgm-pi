// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HtmlPreviewDialog } from "../src/components/HtmlPreviewDialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

function open(source: string, onClose = vi.fn()) {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<HtmlPreviewDialog source={source} onClose={onClose} />));
  return { opener, onClose };
}

describe("HtmlPreviewDialog", () => {
  it("renders the source in a sandboxed frame with scripts off and no parent access", () => {
    open('<div id="card">Hello</div>');
    const frame = container!.querySelector("iframe");
    expect(frame).not.toBeNull();
    // An empty sandbox token list is every restriction: no scripts, no same-origin access.
    expect(frame!.getAttribute("sandbox")).toBe("");
    expect(frame!.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcdoc = frame!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('<div id="card">Hello</div>');
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).not.toContain("script-src");
    const allow = container!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(allow!.checked).toBe(false);
  });

  it("reloads the frame with external CSS and JS only after the box is checked", () => {
    open("<p>x</p>");
    const allow = container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => {
      allow.click();
    });
    const frame = container!.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("script-src");
  });

  it("grows to the screen and shrinks back", () => {
    open("<p>x</p>");
    const dialog = container!.querySelector(".html-preview-dialog")!;
    const expand = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Expand")!;
    expect(dialog.classList.contains("is-expanded")).toBe(false);
    act(() => expand.click());
    expect(dialog.classList.contains("is-expanded")).toBe(true);
    expect(expand.textContent).toBe("Shrink");
    expect(expand.getAttribute("aria-pressed")).toBe("true");
    act(() => expand.click());
    expect(dialog.classList.contains("is-expanded")).toBe(false);
  });

  it("closes on Escape and returns focus to the opener", () => {
    const { opener, onClose } = open("<p>x</p>");
    expect(document.activeElement).toBe(Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Close"));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it("handles Escape and Tab in capture so an earlier document listener does not see them", () => {
    const seen: string[] = [];
    function listener(e: Event) {
      seen.push((e as KeyboardEvent).key);
    }
    document.addEventListener("keydown", listener);
    try {
      const { onClose } = open("<p>x</p>");
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(seen).toEqual([]);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("does not take Escape when a later modal is open", () => {
    const seen: string[] = [];
    function listener(e: Event) {
      seen.push((e as KeyboardEvent).key);
    }
    document.addEventListener("keydown", listener);
    try {
      const { onClose } = open("<p>x</p>");
      const later = document.createElement("div");
      later.setAttribute("role", "dialog");
      later.setAttribute("aria-modal", "true");
      document.body.appendChild(later);
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(seen).toEqual(["Escape"]);
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });
});
