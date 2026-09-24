// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EntryItem } from "../src/components/EntryItem.tsx";
import { entryToViews } from "../src/lib/entry-view.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import type { PiEntry } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

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

function captureEntry(): PiEntry {
  return {
    id: "browser-capture:req-1",
    parentId: null,
    type: "custom",
    customType: "outfitter.browser.capture",
    data: {
      captureId: "cap-1",
      title: "Docs",
      url: "https://example.test/page",
      requesterEmail: "a@b.c",
    },
  };
}

function groupedCapture() {
  const [view] = groupThinkingBlocks(entryToViews(captureEntry()));
  if (!view || view.kind !== "custom") throw new Error("expected a grouped custom entry");
  return view;
}

describe("browser capture transcript entry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    localStorage.setItem("outfitterDevToken", "secret-token");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:capture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the capture jpeg with the page credentials and renders the title and URL", async () => {
    const view = groupedCapture();
    expect(view).toMatchObject({
      kind: "custom",
      customType: "outfitter.browser.capture",
      captureId: "cap-1",
      title: "Docs",
      url: "https://example.test/page",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container, unmount } = mount(<EntryItem view={view} sessionId="sess-1" />);
    await act(async () => {
      await fetchMock.mock.results[0]?.value;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/sess-1/browser/captures/cap-1", {
      credentials: "same-origin",
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:capture");
    expect(container.textContent).toContain("Docs");
    expect(container.textContent).toContain("https://example.test/page");
    unmount();
  });

  it("shows the retro API error plus the title and URL when the capture image 404s", async () => {
    const view = groupedCapture();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "capture not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container, unmount } = mount(<EntryItem view={view} sessionId="sess-1" />);
    await act(async () => {
      await fetchMock.mock.results[0]?.value;
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("?FILE NOT FOUND ERROR");
    expect(container.textContent).toContain("Docs");
    expect(container.textContent).toContain("https://example.test/page");
    unmount();
  });

  it("still labels any other custom entry with its type", () => {
    const [view] = groupThinkingBlocks(
      entryToViews({ id: "m1", type: "custom", customType: "outfitter.mail", data: { to: "x", text: "hi" } }),
    );
    if (!view) throw new Error("expected a view");
    const { container, unmount } = mount(<EntryItem view={view} sessionId="sess-1" />);
    expect(container.textContent).toContain("custom: outfitter.mail");
    expect(container.querySelector("img")).toBeNull();
    unmount();
  });

  it("shows a Playwright check entry as text", () => {
    const [view] = groupThinkingBlocks(
      entryToViews({
        id: "pw1",
        type: "custom",
        customType: "outfitter.playwright",
        data: { status: "skipped", text: "Playwright: nothing to run\nNo Playwright spec in this workspace." },
      }),
    );
    if (!view) throw new Error("expected a view");
    const { container, unmount } = mount(<EntryItem view={view} sessionId="sess-1" />);
    expect(container.textContent).toContain("Playwright");
    expect(container.textContent).toContain("nothing to run");
    expect(container.querySelector("img")).toBeNull();
    unmount();
  });
});
