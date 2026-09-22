import { describe, expect, it } from "vitest";
import { act } from "react";
import { createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { useModalFocus, useRestoreFocus } from "../src/easter/shared/modalFocus.ts";

// Drives real createRoot renders in jsdom (same reasoning as test/error-boundary.test.tsx: focus
// and Tab handling need a real DOM, not react-dom/server's static markup).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(children: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(children);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function tab(target: Element, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** A minimal stand-in for FloppyRescue/DreadnoughtRun's `.easter-overlay` dialog: a titlebar close
 * button, a body button, and a footer button -- three focusable elements for the Tab trap to wrap
 * between. */
function Dialog() {
  const ref = createRef<HTMLDivElement>();
  useModalFocus(ref, true);
  return createElement(
    "div",
    { ref, tabIndex: -1 },
    createElement("button", { key: "close" }, "close"),
    createElement("button", { key: "mid" }, "mid"),
    createElement("button", { key: "last" }, "last"),
  );
}

describe("useModalFocus", () => {
  it("focuses the first focusable element on mount", () => {
    const { container, unmount } = mount(createElement(Dialog));
    const buttons = container.querySelectorAll("button");
    expect(document.activeElement).toBe(buttons[0]);
    unmount();
  });

  it("wraps Tab from the last element back to the first, and Shift+Tab from the first to the last", () => {
    const { container, unmount } = mount(createElement(Dialog));
    const buttons = container.querySelectorAll("button");
    const [first, , last] = buttons;

    (last as HTMLElement).focus();
    const forwardEvent = tab(last!);
    expect(forwardEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const backEvent = tab(first!, true);
    expect(backEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    unmount();
  });

  it("does not intercept Tab between two elements in the middle of the list", () => {
    const { container, unmount } = mount(createElement(Dialog));
    const buttons = container.querySelectorAll("button");
    const [, mid] = buttons;

    (mid as HTMLElement).focus();
    const event = tab(mid!);
    // Not first-forward-from-last or last-backward-from-first: the trap leaves it alone (a real
    // browser would move focus to the next element in document order on its own).
    expect(event.defaultPrevented).toBe(false);

    unmount();
  });

  it("restores focus to the element that was focused before the dialog mounted", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open games";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = mount(createElement(Dialog));
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});

describe("useRestoreFocus", () => {
  function Menu() {
    useRestoreFocus(true);
    return createElement("button", null, "tile");
  }

  it("restores focus to the previously focused element once it unmounts", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = mount(createElement(Menu));
    unmount();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
