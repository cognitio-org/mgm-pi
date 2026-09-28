// @vitest-environment jsdom
// #243: the session page's "Open in VS Code" chip (browser IDE, docs/specs/browser-ide.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IdeChip, IDE_REFRESH_MS, IDE_STALE_START_MS, IDE_STARTING_REFRESH_MS } from "../src/components/IdeChip.tsx";
import type { IdeState } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let calls: Array<{ method: string; path: string }> = [];
let state: IdeState;
let getStatus = 200;
let postAnswer: { status: number; body: unknown } | null = null;
const URL_READY = `https://${"c".repeat(32)}.kernal.run`;
const T0 = Date.parse("2026-09-28T10:00:00Z");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  getStatus = 200;
  postAnswer = null;
  state = { available: true, state: "none" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (method === "POST") {
      if (postAnswer) return json(postAnswer.body, postAnswer.status);
      state = { available: true, state: "requested", updatedAt: new Date(T0).toISOString() };
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

async function render(runState = "idle", now = () => T0) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onError = vi.fn();
  await act(async () => root!.render(<IdeChip sessionId="s1" runState={runState} onError={onError} now={now} />));
  await act(async () => {});
  return onError;
}
const gets = () => calls.filter((c) => c.method === "GET").length;
const openBtn = () => container!.querySelector<HTMLButtonElement>("button.ide-open-btn");
const tick = async (ms: number) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await act(async () => {});
};

describe("IdeChip (#243)", () => {
  it("stays hidden for someone who isn't the owner or a sysop, and stops asking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    getStatus = 403;
    await render();
    expect(container!.textContent).toBe("");
    const after = gets();
    await tick(IDE_REFRESH_MS * 3);
    expect(gets()).toBe(after);
  });

  it("stays hidden on a Drive without the IDE, or one that isn't live", async () => {
    state = { available: false, state: "none" };
    await render();
    expect(container!.textContent).toBe("");
    act(() => root?.unmount());
    state = { available: true, state: "none" };
    await render("stopped");
    expect(container!.textContent).toBe("");
    expect(gets()).toBe(1);
  });

  it("offers Open only while the Drive is running or idle", async () => {
    await render("provisioning");
    expect(openBtn()!.disabled).toBe(true);
    act(() => root?.unmount());
    await render("running");
    expect(openBtn()!.disabled).toBe(false);
  });

  it("opens: one button stays focused and busy through installing, then a link and Close; Close returns focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await render();
    const btn = openBtn()!;
    btn.focus();
    await act(async () => btn.click());
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/sessions/s1/ide")).toBe(true);
    expect(openBtn()).toBe(btn);
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.textContent).toContain("Opening VS Code");

    state = { available: true, state: "installing", updatedAt: new Date(T0).toISOString() };
    await tick(IDE_STARTING_REFRESH_MS);
    expect(openBtn()!.textContent).toContain("Installing VS Code");
    expect(document.activeElement).toBe(btn);

    state = { available: true, state: "ready", url: URL_READY };
    await tick(IDE_STARTING_REFRESH_MS);
    const link = container!.querySelector<HTMLAnchorElement>("a.ide-chip")!;
    expect(link.href).toBe(`${URL_READY}/`);
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.textContent).toContain("opens in a new tab");
    expect(container!.querySelector("[aria-live]")!.textContent).toContain("VS Code is ready");
    expect(container!.textContent).not.toMatch(/share/i);

    const close = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    close.focus();
    await act(async () => close.click());
    await act(async () => {});
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/sessions/s1/ide")).toBe(true);
    expect(container!.querySelector("a.ide-chip")).toBeNull();
    expect(document.activeElement).toBe(openBtn());
  });

  it("a POST answered with a ready IDE shows the link at once", async () => {
    postAnswer = { status: 200, body: { available: true, state: "ready", url: URL_READY } };
    await render();
    await act(async () => openBtn()!.click());
    expect(container!.querySelector<HTMLAnchorElement>("a.ide-chip")!.href).toBe(`${URL_READY}/`);
  });

  it("a start that's been stuck for a while can be tried again", async () => {
    state = { available: true, state: "starting", updatedAt: new Date(T0).toISOString() };
    await render("idle", () => T0 + IDE_STALE_START_MS + 1000);
    const btn = openBtn()!;
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.textContent).toBe("Try again");
    expect(container!.textContent).toContain("taking a while");
  });

  it("says why when VS Code stopped or didn't start, readable without hovering, and offers Open again", async () => {
    state = { available: true, state: "error", detail: "code-server isn't installed: checksum mismatch" };
    await render();
    const note = container!.querySelector(".ide-note")!;
    expect(note.textContent).toContain("checksum mismatch");
    expect(openBtn()!.getAttribute("aria-describedby")).toBe(note.id);
    expect(openBtn()!.textContent).toBe("Open in VS Code");
  });

  it("never renders a non-https URL as a link", async () => {
    state = { available: true, state: "ready", url: "javascript:alert(1)" };
    await render();
    expect(container!.querySelector("a")).toBeNull();
  });

  it("a refused open reports through onError and leaves the button usable", async () => {
    postAnswer = { status: 409, body: { error: "this Drive has no IDE" } };
    const onError = await render();
    await act(async () => openBtn()!.click());
    expect(onError).toHaveBeenCalled();
    expect(openBtn()!.getAttribute("aria-busy")).toBeNull();
    expect(openBtn()!.textContent).toBe("Open in VS Code");
  });
});
