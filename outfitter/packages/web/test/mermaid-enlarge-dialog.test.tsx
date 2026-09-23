// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MermaidEnlargeDialog } from "../src/components/MermaidEnlargeDialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>`;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

function open(onClose = vi.fn()) {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<MermaidEnlargeDialog svg={SVG} onClose={onClose} />));
  return { opener, onClose };
}

function key(k: string, shiftKey = false) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
  });
}

describe("MermaidEnlargeDialog", () => {
  it("focuses Close, closes on Escape, and keeps Tab inside the dialog", () => {
    const { onClose } = open();
    const [reset, close] = Array.from(container!.querySelectorAll("button"));
    expect(document.activeElement).toBe(close);
    key("Tab");
    expect(document.activeElement).toBe(reset);
    key("Tab", true);
    expect(document.activeElement).toBe(close);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the opener when it closes", () => {
    const { opener } = open();
    act(() => root!.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it("zooms on wheel with a non-passive listener (preventDefault takes effect)", () => {
    open();
    const surface = container!.querySelector(".mermaid-enlarge-surface")!;
    const ev = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    act(() => {
      surface.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    const canvas = container!.querySelector<HTMLElement>(".mermaid-enlarge-canvas")!;
    expect(canvas.style.transform).not.toContain("scale(1)");
  });
});
