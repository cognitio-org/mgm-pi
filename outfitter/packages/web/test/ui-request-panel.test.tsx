// @vitest-environment jsdom
// Sysop tools (#287): the api's own admin-approval card looks different from a model's question,
// and every card's buttons wake a moment after it appears.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ARM_DELAY_MS, UiRequestPanel, type RawUiRequest } from "../src/components/UiRequestPanel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.useRealTimers();
});

function render(request: RawUiRequest, onRespond = vi.fn(async () => {})) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<UiRequestPanel request={request} onRespond={onRespond} />));
  return { onRespond, buttons: () => [...container!.querySelectorAll("button")] };
}

describe("UiRequestPanel", () => {
  it("shows an Outfitter approval as its own card, with Allow and Deny", () => {
    vi.useFakeTimers();
    const { buttons } = render({ id: "admin:1", method: "confirm", title: "Allow the agent to delete tape old?", message: "m", source: "outfitter" });
    expect(container!.textContent).toContain("Outfitter asks you (not the agent)");
    expect(container!.querySelector(".ui-request-outfitter")).not.toBeNull();
    expect(buttons().map((b) => b.textContent)).toEqual(["Allow", "Deny"]);
  });

  it("a model's confirm without the marker is the ordinary card", () => {
    render({ id: "q1", method: "confirm", title: "Allow the agent to delete tape old?", message: "m" });
    expect(container!.querySelector(".ui-request-outfitter")).toBeNull();
    expect(container!.textContent).not.toContain("Outfitter asks");
  });

  it("buttons wake only after the arm delay, and again for each new card", async () => {
    vi.useFakeTimers();
    const { buttons, onRespond } = render({ id: "q1", method: "confirm", title: "t", message: "m" });
    expect(buttons().every((b) => b.disabled)).toBe(true);
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    expect(buttons().every((b) => !b.disabled)).toBe(true);
    act(() => root!.render(<UiRequestPanel request={{ id: "admin:2", method: "confirm", title: "t2", message: "m2", source: "outfitter" }} onRespond={onRespond} />));
    expect(buttons().every((b) => b.disabled)).toBe(true);
    act(() => buttons()[0].click());
    expect(onRespond).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    await act(async () => buttons()[0].click());
    expect(onRespond).toHaveBeenCalledWith("admin:2", true);
  });
});
