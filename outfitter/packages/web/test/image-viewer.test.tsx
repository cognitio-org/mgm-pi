// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/components/Markdown.tsx";
import {
  ImageViewer,
  clampImageScale,
  dataUrlToBlob,
  imageDownloadFilename,
  imageTransformStyle,
  panBy,
  pinchZoom,
  pointerDistance,
  wheelZoom,
} from "../src/components/ImageViewer.tsx";
import { UserAttachments } from "../src/components/UserAttachments.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has MouseEvent but no PointerEvent. The viewer's listeners only read pointerId and client coordinates.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(globalThis, "PointerEvent", { value: PointerEventPolyfill, configurable: true });
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function mockObjectUrls() {
  const created: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return "blob:http://localhost/saved";
  });
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return created;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
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

describe("image view math", () => {
  it("zooms, pans, and pinches without measuring the element", () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(panBy({ x: 1, y: 2 }, { x: 5, y: 5 }, { x: 8, y: 4 })).toEqual({ x: 4, y: 1 });
    expect(wheelZoom(1, -100)).toBeCloseTo(Math.exp(0.15));
    expect(wheelZoom(1, 10000)).toBe(0.25);
    expect(wheelZoom(1, -10000)).toBe(8);
    expect(pinchZoom(2, 10, 20)).toBe(4);
    expect(pinchZoom(2, 0, 20)).toBe(8);
    expect(clampImageScale(100)).toBe(8);
    expect(imageTransformStyle({ scale: 2, x: 3, y: -4 })).toBe("translate(3px, -4px) scale(2)");
  });

  it("names a download image unless a filename is given, and decodes data URL bytes", async () => {
    expect(imageDownloadFilename()).toBe("image");
    expect(imageDownloadFilename("  ")).toBe("image");
    expect(imageDownloadFilename(" shot.png ")).toBe("shot.png");
    const blob = dataUrlToBlob(`data:image/png;base64,${btoa("hello")}`);
    expect(blob?.type).toBe("image/png");
    await expect(readBlob(blob!)).resolves.toBe("hello");
    const plain = dataUrlToBlob("data:text/plain,hello%20there");
    expect(plain?.type).toBe("text/plain");
    await expect(readBlob(plain!)).resolves.toBe("hello there");
    expect(dataUrlToBlob("https://example.com/a.png")).toBeNull();
  });
});

describe("ImageViewer", () => {
  function open(props: { src: string; filename?: string; alt?: string }, onClose = vi.fn()) {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    mount(<ImageViewer src={props.src} filename={props.filename} alt={props.alt} onClose={onClose} />);
    return { opener, onClose };
  }

  it("focuses Close, traps Tab, and closes on Escape", () => {
    const { onClose, opener } = open({ src: "data:image/png;base64,aaaa", alt: "shot" });
    const dialog = container!.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("shot");
    const [reset, download, close] = Array.from(dialog.querySelectorAll("button"));
    expect(reset!.textContent).toBe("Reset");
    expect(download!.textContent).toBe("Download");
    expect(document.activeElement).toBe(close);
    key("Tab");
    expect(document.activeElement).toBe(reset);
    key("Tab", true);
    expect(document.activeElement).toBe(close);
    key("Escape");
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
      const { onClose } = open({ src: "data:image/png;base64,aaaa" });
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
      const { onClose } = open({ src: "data:image/png;base64,aaaa" });
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

  it("zooms on wheel with a non-passive listener and resets", () => {
    open({ src: "data:image/png;base64,aaaa" });
    const surface = container!.querySelector(".image-viewer-surface")!;
    const ev = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    act(() => {
      surface.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    const canvas = container!.querySelector<HTMLElement>(".image-viewer-canvas")!;
    expect(canvas.style.transform).toBe(imageTransformStyle({ scale: wheelZoom(1, -100), x: 0, y: 0 }));
    const reset = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Reset")!;
    act(() => reset.click());
    expect(canvas.style.transform).toBe(imageTransformStyle({ scale: 1, x: 0, y: 0 }));
  });

  it("pans from pointer movement", () => {
    open({ src: "data:image/png;base64,aaaa" });
    const surface = container!.querySelector(".image-viewer-surface")!;
    act(() => {
      surface.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 10, clientY: 20, bubbles: true }));
      surface.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 22, clientY: 16, bubbles: true }));
    });
    const canvas = container!.querySelector<HTMLElement>(".image-viewer-canvas")!;
    expect(canvas.style.transform).toBe(imageTransformStyle({ scale: 1, x: 12, y: -4 }));
  });

  it("downloads data URL bytes under the default name, without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const created = mockObjectUrls();
    let download = "";
    let href = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      download = this.download;
      href = this.href;
    });
    open({ src: `data:image/png;base64,${btoa("hello")}` });
    const button = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Download")!;
    act(() => button.click());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(download).toBe("image");
    expect(href).toContain("blob:http://localhost/saved");
    expect(created[0]?.type).toBe("image/png");
    await expect(readBlob(created[0]!)).resolves.toBe("hello");
  });

  it("downloads a blob URL as the jpeg it already points at", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let download = "";
    let href = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      download = this.download;
      href = this.href;
    });
    open({ src: "blob:http://localhost/capture", filename: "capture.jpg" });
    const button = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Download")!;
    act(() => button.click());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(download).toBe("capture.jpg");
    expect(href).toContain("blob:http://localhost/capture");
  });
});

describe("UserAttachments", () => {
  it("renders each image as a button and opens that image", () => {
    mount(
      <UserAttachments
        images={[
          { mimeType: "image/png", data: "aaaa" },
          { mimeType: "image/jpeg", data: "bbbb" },
        ]}
      />,
    );
    const buttons = Array.from(container!.querySelectorAll<HTMLButtonElement>("button.user-attachment"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aaaa");
    expect(buttons[1]!.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bbbb");
    act(() => buttons[1]!.click());
    const viewer = document.querySelector(".image-viewer-canvas img");
    expect(viewer?.getAttribute("src")).toBe("data:image/jpeg;base64,bbbb");
  });
});

describe("Markdown data images", () => {
  it("opens ImageViewer when a data image is clicked", () => {
    mount(<Markdown text={"![shot](data:image/png;base64,aaaa)"} />);
    const button = container!.querySelector("button.md-image")!;
    expect(button.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aaaa");
    act(() => (button as HTMLButtonElement).click());
    expect(document.querySelector(".image-viewer-dialog")).not.toBeNull();
    expect(document.querySelector(".image-viewer-canvas img")?.getAttribute("alt")).toBe("shot");
  });
});
