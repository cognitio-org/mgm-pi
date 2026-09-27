// @vitest-environment jsdom
// #217 phase 3: the session page's preview chips and the public-link confirm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PreviewChips, untilLabel } from "../src/components/PreviewChips.tsx";
import type { PreviewsState } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let state: PreviewsState;

const PRIV = { id: "a".repeat(32), port: 3000, share: false, url: `https://${"a".repeat(32)}.kernal.run`, createdAt: "2026-09-28T10:00:00Z" };
const PUB = { id: "b".repeat(32), port: 3000, share: true, url: `https://${"b".repeat(32)}.kernal.run`, createdAt: "2026-09-28T10:00:00Z", expiresAt: "2026-09-29T10:00:00Z" };

function base(over: Partial<PreviewsState> = {}): PreviewsState {
  return { enabled: true, canShare: true, shareMaxSeconds: 7 * 24 * 3600, shareDefaultSeconds: 24 * 3600, previews: [PRIV], ...over };
}

beforeEach(() => {
  calls = [];
  state = base();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") {
      state = { ...state, previews: [...state.previews, PUB] };
      return new Response(JSON.stringify(PUB), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "DELETE") {
      state = { ...state, previews: state.previews.filter((p) => !path.endsWith(p.id)) };
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

async function mount(runState: string | null, onError = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<PreviewChips sessionId="s1" runState={runState} onError={onError} />));
  await flush();
  return onError;
}

const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("PreviewChips", () => {
  it("renders nothing without previews, when they're off, or when the Drive isn't running", async () => {
    state = base({ previews: [] });
    await mount("running");
    expect(container!.textContent).toBe("");
    act(() => root!.unmount());
    state = base({ enabled: false });
    await mount("running");
    expect(container!.textContent).toBe("");
    act(() => root!.unmount());
    state = base();
    await mount("stopped");
    expect(container!.textContent).toBe("");
    // two GETs for the two running mounts; none while the Drive is stopped
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  it("a private preview is a chip that opens the app in a new tab, without an opener", async () => {
    await mount("running");
    const a = container!.querySelector<HTMLAnchorElement>("a.preview-chip")!;
    expect(a.textContent).toContain("Preview :3000");
    expect(a.href).toBe(`${PRIV.url}/`);
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(calls[0]).toEqual({ method: "GET", path: "/api/sessions/s1/previews", body: undefined });
  });

  it("only someone who may share sees Share…, and the confirm makes the link with the chosen lifetime", async () => {
    state = base({ canShare: false });
    await mount("running");
    expect(button("Share")).toBeUndefined();
    act(() => root!.unmount());

    state = base();
    await mount("running");
    await act(async () => button("Share")!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Anyone with the link can open the app");
    expect((document.activeElement as HTMLElement).textContent).toBe("Cancel");
    const select = dialog.querySelector("select")!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["1 hour", "24 hours", "7 days"]);
    expect(select.value).toBe(String(24 * 3600));
    await act(async () => {
      select.value = "3600";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Make public link")!.click());
    await flush();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/sessions/s1/previews/3000/share");
    expect(post.body).toEqual({ ttlSeconds: 3600 });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container!.querySelector(".preview-chip-public")!.textContent).toContain("Public link");
    expect(button("Share")).toBeUndefined();
  });

  it("the lifetime choices stop at the server's maximum", async () => {
    state = base({ shareMaxSeconds: 24 * 3600, shareDefaultSeconds: 24 * 3600 });
    await mount("running");
    await act(async () => button("Share")!.click());
    expect([...document.querySelector("select")!.options].map((o) => o.textContent)).toEqual(["1 hour", "24 hours"]);
  });

  it("Stop closes the public link", async () => {
    state = base({ previews: [PRIV, PUB] });
    await mount("running");
    await act(async () => button("Stop")!.click());
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/sessions/s1/previews/${PUB.id}`)).toBe(true);
    expect(container!.querySelector(".preview-chip-public")).toBeNull();
  });

  it("a failed share goes to the page's error dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: "the Drive isn't running" }), { status: 409, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify(base()), { status: 200, headers: { "Content-Type": "application/json" } })));
    const onError = await mount("running");
    await act(async () => button("Share")!.click());
    await act(async () => button("Make public link")!.click());
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("untilLabel", () => {
  it("shows a time today and a date otherwise", () => {
    const now = new Date("2026-09-28T09:00:00");
    expect(untilLabel(new Date("2026-09-28T18:30:00").toISOString(), now)).toMatch(/^until \d/);
    expect(untilLabel(new Date("2026-10-02T18:30:00").toISOString(), now)).toMatch(/^until [A-Z][a-z]{2} 2/);
  });
});
