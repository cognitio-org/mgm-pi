// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  diagramContent,
  FIT_PADDING,
  fitTransform,
  MermaidEnlargeDialog,
  mermaidSvgBlob,
  type Transform,
} from "../src/components/MermaidEnlargeDialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>`;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
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

function buttonNamed(name: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes(name));
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function readTransform(canvas: HTMLElement): Transform {
  const m = canvas.style.transform.match(/translate\(([-\d.eE]+)px,\s*([-\d.eE]+)px\)\s*scale\(([-\d.eE]+)\)/);
  if (!m) throw new Error(`unparsed transform ${canvas.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

// This jsdom build has no PointerEvent. React still listens for pointerdown/move/up, and a
// MouseEvent of that type carries clientX; pointerId is what the dialog's pointer map keys on.
function pointer(type: string, clientX: number, clientY: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1 });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  return ev;
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("MermaidEnlargeDialog", () => {
  it("focuses Close, closes on Escape, and keeps Tab inside the dialog", () => {
    const { onClose } = open();
    const buttons = Array.from(container!.querySelectorAll("button"));
    const close = buttons.find((b) => b.getAttribute("aria-label") === "Close");
    const first = buttons[0];
    expect(buttons.map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Fit", "Reset", "Download", "✕ Close"]);
    for (const button of buttons) expect(button.className).toContain("mermaid-toolbar-btn");
    expect(document.activeElement).toBe(close);
    // Tab from the last button wraps to the first (Fit). jsdom does not move focus on Tab
    // itself; the trap only intercepts the ends, and a real browser tabs through the middle.
    key("Tab");
    expect(document.activeElement).toBe(first);
    expect(first.textContent?.trim()).toBe("Fit");
    key("Tab", true);
    expect(document.activeElement).toBe(close);
    buttonNamed("Download").focus();
    const throughMiddle = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => document.dispatchEvent(throughMiddle));
    expect(throughMiddle.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(buttonNamed("Download"));
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

  it("Fit scales the measured svg into the surface and Reset returns to identity", () => {
    open();
    const surface = container!.querySelector(".mermaid-enlarge-surface")!;
    const svg = container!.querySelector("svg")!;
    const surfaceRect = new DOMRect(10, 20, 800, 600);
    const svgRect = new DOMRect(42, 52, 400, 200);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(surfaceRect);
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(svgRect);
    act(() => buttonNamed("Fit").click());
    const expected = fitTransform(
      { width: surfaceRect.width, height: surfaceRect.height },
      diagramContent(surfaceRect, svgRect, { scale: 1, x: 0, y: 0 }),
    );
    const canvas = container!.querySelector<HTMLElement>(".mermaid-enlarge-canvas")!;
    expect(canvas.style.transform).toBe(`translate(${expected.x}px, ${expected.y}px) scale(${expected.scale})`);
    expect(container!.querySelector("svg text")!.textContent).toBe("ok");
    act(() => buttonNamed("Reset").click());
    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("Fit after a wheel zoom, and again after a pan, returns to the same fitted view", () => {
    open();
    const surface = container!.querySelector(".mermaid-enlarge-surface")!;
    const svg = container!.querySelector("svg")!;
    const surfaceRect = new DOMRect(0, 0, 900, 500);
    const local = { width: 600, height: 200, x: 16, y: 16 };
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(surfaceRect);
    const svgSpy = vi.spyOn(svg, "getBoundingClientRect");
    const show = (t: Transform) => {
      svgSpy.mockReturnValue(
        new DOMRect(
          surfaceRect.left + t.x + local.x * t.scale,
          surfaceRect.top + t.y + local.y * t.scale,
          local.width * t.scale,
          local.height * t.scale,
        ),
      );
    };
    show({ scale: 1, x: 0, y: 0 });
    act(() => {
      surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true, cancelable: true }));
    });
    const canvas = container!.querySelector<HTMLElement>(".mermaid-enlarge-canvas")!;
    show(readTransform(canvas));
    act(() => buttonNamed("Fit").click());
    const expected = fitTransform({ width: surfaceRect.width, height: surfaceRect.height }, local);
    const fitted = `translate(${expected.x}px, ${expected.y}px) scale(${expected.scale})`;
    expect(canvas.style.transform).toBe(fitted);

    show(readTransform(canvas));
    // One event per act: React flushes the move's setState before pointerup clears the drag ref,
    // which is also how a real browser delivers these events.
    act(() => surface.dispatchEvent(pointer("pointerdown", 0, 0)));
    act(() => surface.dispatchEvent(pointer("pointermove", 70, -25)));
    act(() => surface.dispatchEvent(pointer("pointerup", 70, -25)));
    expect(canvas.style.transform).not.toBe(fitted);
    show(readTransform(canvas));
    act(() => buttonNamed("Fit").click());
    expect(canvas.style.transform).toBe(fitted);
  });

  it("downloads the sanitized svg string as diagram.svg", async () => {
    // jsdom's URL has no createObjectURL; install one for this test only.
    const urlApi = URL as unknown as {
      createObjectURL?: (obj: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    const prevCreate = urlApi.createObjectURL;
    const prevRevoke = urlApi.revokeObjectURL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:diagram");
    const revokeObjectURL = vi.fn();
    urlApi.createObjectURL = createObjectURL;
    urlApi.revokeObjectURL = revokeObjectURL;
    let saved: { href: string | null; download: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved = { href: this.getAttribute("href"), download: this.download };
    });
    // FileReader (used to read the blob below) needs real timers. Only hold the
    // download's delayed revoke; forward every other timer.
    const realSetTimeout = globalThis.setTimeout;
    const revokeLater: Array<() => void> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 1000 && typeof handler === "function") {
        revokeLater.push(() => handler(...(args as [])));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, timeout, ...(args as []));
    }) as typeof setTimeout);
    try {
      open();
      act(() => buttonNamed("Download").click());
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(blob.type).toBe("image/svg+xml");
      await expect(blobText(blob)).resolves.toBe(SVG);
      expect(saved).toEqual({ href: "blob:diagram", download: "diagram.svg" });
      // The object URL has to stay alive past click; revoke is only scheduled.
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(revokeLater).toHaveLength(1);
      expect(document.body.querySelector("a[download]")).toBeNull();
      revokeLater[0]!();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagram");
    } finally {
      if (prevCreate) urlApi.createObjectURL = prevCreate;
      else delete urlApi.createObjectURL;
      if (prevRevoke) urlApi.revokeObjectURL = prevRevoke;
      else delete urlApi.revokeObjectURL;
    }
  });
});

describe("fitTransform", () => {
  it("fits a wide diagram to the surface width and centers the slack vertically", () => {
    const surface = { width: 800, height: 600 };
    const content = { width: 400, height: 100 };
    const fitted = fitTransform(surface, content);
    expect(fitted.x).toBeCloseTo(FIT_PADDING);
    expect(fitted.x + content.width * fitted.scale).toBeCloseTo(surface.width - FIT_PADDING);
    expect(fitted.y).toBeGreaterThan(FIT_PADDING);
    expect(fitted.y + content.height * fitted.scale).toBeLessThan(surface.height - FIT_PADDING);
  });

  it("fits a tall diagram to the surface height and centers the slack horizontally", () => {
    const surface = { width: 800, height: 600 };
    const content = { width: 100, height: 400 };
    const fitted = fitTransform(surface, content);
    expect(fitted.y).toBeCloseTo(FIT_PADDING);
    expect(fitted.y + content.height * fitted.scale).toBeCloseTo(surface.height - FIT_PADDING);
    expect(fitted.x).toBeGreaterThan(FIT_PADDING);
  });

  it("centers the svg itself when canvas padding offsets it from the transform origin", () => {
    const surface = { width: 500, height: 400 };
    const content = { width: 200, height: 100, x: 32, y: 32 };
    const fitted = fitTransform(surface, content);
    const left = fitted.x + content.x * fitted.scale;
    const top = fitted.y + content.y * fitted.scale;
    expect(left).toBeCloseTo((surface.width - content.width * fitted.scale) / 2);
    expect(top).toBeCloseTo((surface.height - content.height * fitted.scale) / 2);
    expect(left).toBeGreaterThanOrEqual(FIT_PADDING - 0.01);
    expect(top).toBeGreaterThanOrEqual(FIT_PADDING - 0.01);
  });

  it("returns identity when there is nothing to measure", () => {
    expect(fitTransform({ width: 800, height: 600 }, { width: 0, height: 100 })).toEqual({ scale: 1, x: 0, y: 0 });
    expect(fitTransform({ width: 0, height: 600 }, { width: 100, height: 100 })).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("will not enlarge past the zoom ceiling, and still centers", () => {
    const fitted = fitTransform({ width: 800, height: 600 }, { width: 10, height: 10, x: 5, y: 5 });
    expect(fitted.scale).toBe(8);
    expect(fitted.x + 5 * fitted.scale).toBeCloseTo((800 - 80) / 2);
    expect(fitted.y + 5 * fitted.scale).toBeCloseTo((600 - 80) / 2);
  });

  it("shrinks below the wheel-zoom floor so a huge diagram stays fully visible", () => {
    const surface = { width: 200, height: 100 };
    const content = { width: 4000, height: 1000 };
    const fitted = fitTransform(surface, content);
    expect(fitted.scale).toBeLessThan(0.25);
    expect(fitted.x).toBeCloseTo(FIT_PADDING);
    expect(content.width * fitted.scale).toBeLessThanOrEqual(surface.width - FIT_PADDING * 2 + 0.01);
    expect(content.height * fitted.scale).toBeLessThanOrEqual(surface.height - FIT_PADDING * 2 + 0.01);
  });

  it("returns the same fit when the diagram is measured again after a pan and zoom", () => {
    const surface = { left: 40, top: 80, width: 800, height: 600 };
    const local = { width: 400, height: 180, x: 32, y: 32 };
    const svgRect = (t: Transform) => ({
      left: surface.left + t.x + local.x * t.scale,
      top: surface.top + t.y + local.y * t.scale,
      width: local.width * t.scale,
      height: local.height * t.scale,
    });
    const atRest: Transform = { scale: 1, x: 0, y: 0 };
    const panned: Transform = { scale: 1.5, x: -80, y: 120 };
    const first = fitTransform({ width: surface.width, height: surface.height }, diagramContent(surface, svgRect(atRest), atRest));
    const again = fitTransform({ width: surface.width, height: surface.height }, diagramContent(surface, svgRect(panned), panned));
    expect(diagramContent(surface, svgRect(panned), panned)).toEqual(local);
    expect(again.scale).toBeCloseTo(first.scale);
    expect(again.x).toBeCloseTo(first.x);
    expect(again.y).toBeCloseTo(first.y);
  });

  it("builds an image/svg+xml blob of the sanitized string", async () => {
    const blob = mermaidSvgBlob(SVG);
    expect(blob.type).toBe("image/svg+xml");
    await expect(blobText(blob)).resolves.toBe(SVG);
  });
});
