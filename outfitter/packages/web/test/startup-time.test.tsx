// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StartupTime, formatSeconds, panelPosition, showStartupTime, startupSource } from "../src/components/StartupTime.tsx";
import { nextStartup } from "../src/hooks/useSessionStream.ts";
import type { StartupSummary } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary: StartupSummary = {
  runId: "r1",
  provider: "gke",
  warm: true,
  totalMs: 4230,
  complete: true,
  segments: [
    { id: "request", label: "Requesting a sandbox", ms: 300 },
    {
      id: "sandbox",
      label: "Sandbox starting",
      ms: 1000,
      details: [
        { label: "Handing over the warm sandbox", ms: 400 },
        { label: "Identity token", ms: 350 },
      ],
    },
    { id: "workspace", label: "Preparing the workspace", ms: 930 },
    { id: "pi", label: "Loading pi", ms: 2000 },
  ],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom lays nothing out, so every rect is zeros: give the chip's button a real box. */
function giveButtonsABox(): () => void {
  const orig = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("startup-time-toggle") && !this.dataset.hidden) {
      return { x: 100, y: 4, left: 100, top: 4, right: 300, bottom: 36, width: 200, height: 32, toJSON() {} } as DOMRect;
    }
    return orig.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = orig;
  };
}

let restoreRect: (() => void) | null = null;

function render(ui: React.ReactElement): HTMLDivElement {
  restoreRect ??= giveButtonsABox();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

afterEach(() => {
  restoreRect?.();
  restoreRect = null;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("StartupTime", () => {
  it("shows the total with provider and warmth, and opens the breakdown from the button", () => {
    const el = render(<StartupTime startup={summary} runState="idle" />);
    const button = el.querySelector("button.startup-time-toggle") as HTMLButtonElement;
    expect(button.textContent).toBe("Started in 4.2 sGKE warm");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Started in 4.2 s, GKE warm. Start-up breakdown");
    expect(button.title).toContain("Loading pi 2.0 s");
    expect(el.querySelector(".startup-time-panel")).toBeNull();

    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = el.querySelector(".startup-time-panel") as HTMLElement;
    expect(panel.id).toBe(button.getAttribute("aria-controls"));
    const rows = [...panel.querySelectorAll(".startup-step > .startup-step-row")].map((r) => r.textContent);
    expect(rows).toEqual([
      "Requesting a sandbox0.3 s",
      "Sandbox starting1.0 s",
      "Preparing the workspace0.9 s",
      "Loading pi2.0 s",
    ]);
    const details = [...panel.querySelectorAll(".startup-details li")].map((r) => r.textContent);
    expect(details).toEqual(["Handing over the warm sandbox0.4 s", "Identity token0.3 s"]);
    expect(panel.querySelector(".startup-total")?.textContent).toBe("Total (GKE warm)4.2 s");
    expect(panel.querySelectorAll(".startup-bar-part")).toHaveLength(4);
  });

  it("closes with Escape and returns focus to the button", () => {
    const el = render(<StartupTime startup={summary} runState="running" />);
    const button = el.querySelector("button.startup-time-toggle") as HTMLButtonElement;
    act(() => button.click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(el.querySelector(".startup-time-panel")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("closes on a click outside", () => {
    const el = render(<StartupTime startup={summary} runState="idle" />);
    act(() => (el.querySelector("button.startup-time-toggle") as HTMLButtonElement).click());
    // A tap inside the panel keeps it open; one outside closes it (pointerdown, which iOS fires).
    act(() => {
      el.querySelector(".startup-total")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(el.querySelector(".startup-time-panel")).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(el.querySelector(".startup-time-panel")).toBeNull();
  });

  it("the open panel sits under the button", () => {
    const el = render(<StartupTime startup={summary} runState="idle" />);
    act(() => (el.querySelector("button.startup-time-toggle") as HTMLButtonElement).click());
    const panel = el.querySelector(".startup-time-panel") as HTMLElement;
    expect(panel.style.top).toBe("40px");
    expect(panel.style.left).toBe("100px");
  });

  it("closes instead of jumping to the corner when its anchor loses its box (compact status bar)", () => {
    const el = render(<StartupTime startup={summary} runState="idle" />);
    const button = el.querySelector("button.startup-time-toggle") as HTMLButtonElement;
    act(() => button.click());
    expect(el.querySelector(".startup-time-panel")).not.toBeNull();
    button.dataset.hidden = "1"; // display:none -> a zero rect
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(el.querySelector(".startup-time-panel")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the status bar is collapsed, and when the chip hides because the run stopped", () => {
    const el = render(<StartupTime startup={summary} runState="idle" />);
    act(() => (el.querySelector("button.startup-time-toggle") as HTMLButtonElement).click());
    act(() => root!.render(<StartupTime startup={summary} runState="idle" collapsed />));
    expect(el.querySelector(".startup-time-panel")).toBeNull();

    act(() => root!.render(<StartupTime startup={summary} runState="idle" />));
    act(() => (el.querySelector("button.startup-time-toggle") as HTMLButtonElement).click());
    expect(el.querySelector(".startup-time-panel")).not.toBeNull();
    act(() => root!.render(<StartupTime startup={summary} runState="stopped" />));
    expect(el.innerHTML).toBe("");
    // Back to live: it comes back closed, not reopened with stale listeners.
    act(() => root!.render(<StartupTime startup={summary} runState="idle" />));
    expect(el.querySelector(".startup-time-panel")).toBeNull();
    expect(el.querySelector("button.startup-time-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders nothing without data, before the start is complete, or once the run is no longer live", () => {
    expect(render(<StartupTime startup={null} runState="idle" />).innerHTML).toBe("");
    act(() => root!.unmount());
    expect(render(<StartupTime startup={undefined} runState="idle" />).innerHTML).toBe("");
    act(() => root!.unmount());
    expect(render(<StartupTime startup={{ ...summary, complete: false }} runState="idle" />).innerHTML).toBe("");
    act(() => root!.unmount());
    expect(render(<StartupTime startup={summary} runState="stopped" />).innerHTML).toBe("");
    act(() => root!.unmount());
    expect(render(<StartupTime startup={summary} runState="provisioning" />).innerHTML).toBe("");
  });

  it("a partial breakdown (older agentd: no pi step, no details) still renders", () => {
    const partial: StartupSummary = { runId: "r2", totalMs: 9000, complete: true, segments: summary.segments.slice(0, 3).map(({ details: _d, ...s }) => s) };
    const el = render(<StartupTime startup={partial} runState="idle" />);
    const button = el.querySelector("button.startup-time-toggle") as HTMLButtonElement;
    expect(button.textContent).toBe("Started in 9.0 s");
    act(() => button.click());
    expect(el.querySelectorAll(".startup-step")).toHaveLength(3);
    expect(el.querySelector(".startup-details")).toBeNull();
    expect(el.querySelector(".startup-total")?.textContent).toBe("Total9.0 s");
  });
});

describe("startup helpers", () => {
  it("formatSeconds: one decimal, and a floor for tiny steps", () => {
    expect(formatSeconds(4230)).toBe("4.2 s");
    expect(formatSeconds(0)).toBe("0.0 s");
    expect(formatSeconds(40)).toBe("<0.1 s");
    expect(formatSeconds(61_000)).toBe("61.0 s");
  });

  it("startupSource names the provider and warmth when known", () => {
    expect(startupSource({ provider: "gke", warm: false })).toBe("GKE cold");
    expect(startupSource({ provider: "cloudrun" })).toBe("Cloud Run");
    expect(startupSource({ warm: true })).toBe("warm");
    expect(startupSource({})).toBe("");
  });

  it("showStartupTime: complete and live only", () => {
    expect(showStartupTime(summary, "stopping")).toBe(true);
    expect(showStartupTime(summary, undefined)).toBe(false);
    expect(showStartupTime(null, "idle")).toBe(false);
  });

  it("panelPosition keeps the panel inside the viewport", () => {
    expect(panelPosition({ left: 100, bottom: 50 }, 1200)).toEqual({ top: 54, left: 100 });
    expect(panelPosition({ left: 300, bottom: 50 }, 390)).toEqual({ top: 54, left: 26 });
    expect(panelPosition({ left: 300, bottom: 50 }, 320)).toEqual({ top: 54, left: 12 });
  });

  it("nextStartup: absent keeps, null drops, an object replaces", () => {
    expect(nextStartup(summary, { })).toBe(summary);
    expect(nextStartup(summary, { startup: null })).toBeNull();
    const other = { ...summary, runId: "r9" };
    expect(nextStartup(undefined, { startup: other })).toBe(other);
  });
});
