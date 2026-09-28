// @vitest-environment jsdom
// #243: the session page's "Open in VS Code" chip (browser IDE, docs/specs/browser-ide.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IdeChip, IDE_STARTING_REFRESH_MS } from "../src/components/IdeChip.tsx";
import type { IdeState } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let calls: Array<{ method: string; path: string }> = [];
let state: IdeState;
let getStatus = 200;
const URL_READY = `https://${"c".repeat(32)}.kernal.run`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  getStatus = 200;
  state = { available: true, state: "none" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (method === "POST") {
      state = { available: true, state: "requested" };
      return json(state, 202);
    }
    if (method === "DELETE") {
      state = { available: true, state: "closed" };
      return new Response(null, { status: 204 });
    }
    if (getStatus !== 200) return json({ error: "only the floppy's owner or a sysop can open its IDE" }, getStatus);
    return json(state);
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(runState = "idle") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onError = vi.fn();
  await act(async () => root!.render(<IdeChip sessionId="s1" runState={runState} onError={onError} />));
  await act(async () => {});
  return onError;
}

const button = (text: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("IdeChip (#243)", () => {
  it("shows nothing for someone who isn't the owner or a sysop", async () => {
    getStatus = 403;
    await render();
    expect(container!.textContent).toBe("");
  });

  it("shows nothing on a Drive without the IDE, or one that isn't live", async () => {
    state = { available: false, state: "none" };
    await render();
    expect(container!.textContent).toBe("");
    act(() => root?.unmount());
    state = { available: true, state: "none" };
    await render("stopped");
    expect(container!.textContent).toBe("");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("opens: POST, then a progress chip that polls quickly, then a link and Close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render();
    const open = button("Open in VS Code")!;
    expect(open).toBeTruthy();
    await act(async () => open.click());
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/sessions/s1/ide")).toBe(true);
    expect(container!.textContent).toContain("Opening VS Code");

    state = { available: true, state: "installing" };
    await act(async () => { vi.advanceTimersByTime(IDE_STARTING_REFRESH_MS); });
    await act(async () => {});
    expect(container!.textContent).toContain("Installing VS Code");

    state = { available: true, state: "ready", url: URL_READY };
    await act(async () => { vi.advanceTimersByTime(IDE_STARTING_REFRESH_MS); });
    await act(async () => {});
    const link = container!.querySelector<HTMLAnchorElement>("a.ide-chip")!;
    expect(link.href).toBe(`${URL_READY}/`);
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(container!.textContent).not.toMatch(/share/i);

    await act(async () => button("Close")!.click());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/sessions/s1/ide")).toBe(true);
    expect(button("Open in VS Code")).toBeTruthy();
  });

  it("says why when VS Code stopped or didn't start, and offers to open it again", async () => {
    state = { available: true, state: "error", detail: "code-server isn't installed: checksum mismatch" };
    await render();
    expect(container!.textContent).toContain("VS Code didn't start");
    expect(container!.querySelector(".ide-note")!.getAttribute("title")).toContain("checksum mismatch");
    expect(button("Open in VS Code")).toBeTruthy();
  });

  it("never renders a non-https URL as a link", async () => {
    state = { available: true, state: "ready", url: "javascript:alert(1)" };
    await render();
    expect(container!.querySelector("a")).toBeNull();
  });

  it("reports a refused open through onError", async () => {
    await render();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "this Drive has no IDE" }, 409)));
    const onError = vi.fn();
    act(() => root!.render(<IdeChip sessionId="s1" runState="idle" onError={onError} />));
    await act(async () => button("Open in VS Code")!.click());
    expect(onError).toHaveBeenCalled();
  });
});
