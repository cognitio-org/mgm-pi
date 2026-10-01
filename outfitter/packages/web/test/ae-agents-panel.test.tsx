// @vitest-environment jsdom
// E9 PR4: Settings → Agent Engine agents. The panel lists, adds, toggles and removes allowlist
// entries through the sysop routes; the Settings page shows none of it to a non-sysop.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AeAgentsPanel, draftError } from "../src/components/AeAgentsPanel.tsx";
import { SettingsPage } from "../src/pages/SettingsPage.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

type Call = { url: string; method: string; body?: unknown };

function serve(handler: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const { status = 200, body } = handler(call);
      return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle();
  return host;
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

function input(el: HTMLElement, label: string, value: string) {
  const field = el.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

const URL = "/api/operator/agent-engine/agents";
const researcher = { id: "researcher", workspaceId: "ws-1", name: "Researcher", description: "Finds papers", enabled: true, createdAt: "x", updatedAt: "x" };

describe("draftError", () => {
  it("checks the id only when adding", () => {
    const ok = { id: "researcher", workspaceId: "ws-1", name: "R", description: "" };
    expect(draftError(ok, false)).toBeNull();
    expect(draftError({ ...ok, id: "Bad Id" }, false)).toMatch(/lowercase slug/);
    expect(draftError({ ...ok, id: "Bad Id" }, true)).toBeNull();
    expect(draftError({ ...ok, workspaceId: "../x" }, false)).toMatch(/Workspace id/);
    expect(draftError({ ...ok, name: " " }, false)).toMatch(/Name/);
  });
});

describe("AeAgentsPanel", () => {
  it("lists agents and toggles, then removes after a second click", async () => {
    let list = [researcher];
    const calls = serve((c) => {
      if (c.method === "PUT") {
        list = [{ ...researcher, ...(c.body as object) }];
        return { body: { agent: list[0] } };
      }
      if (c.method === "DELETE") {
        list = [];
        return { status: 204 };
      }
      return { body: { agents: list } };
    });
    const el = await render(<AeAgentsPanel />);
    expect(el.textContent).toContain("Researcher");
    expect(el.textContent).toContain("ws-1");
    expect(el.textContent).toContain("enabled");
    await act(async () => button(el, "Disable").click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")).toEqual({ url: `${URL}/researcher`, method: "PUT", body: { enabled: false } });
    expect(el.textContent).toContain("disabled");
    await act(async () => button(el, "Remove").click());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await act(async () => button(el, "Yes, remove").click());
    await settle();
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(`${URL}/researcher`);
    expect(el.textContent).toContain("No agents listed yet.");
  });

  it("adds an agent; a bad id is caught before any request", async () => {
    let list: unknown[] = [];
    const calls = serve((c) => {
      if (c.method === "POST") {
        list = [{ ...researcher, ...(c.body as object) }];
        return { status: 201, body: { agent: list[0] } };
      }
      return { body: { agents: list } };
    });
    const el = await render(<AeAgentsPanel />);
    input(el, "Agent id", "Bad Id");
    input(el, "Workspace id", "ws-1");
    input(el, "Name", "Researcher");
    await act(async () => button(el, "Add agent").click());
    expect(el.textContent).toMatch(/lowercase slug/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    input(el, "Agent id", "researcher");
    input(el, "Description", "Finds papers");
    await act(async () => button(el, "Add agent").click());
    await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ id: "researcher", workspaceId: "ws-1", name: "Researcher", description: "Finds papers", enabled: true });
    expect(el.textContent).toContain("Finds papers");
  });

  it("says so when the list can't load", async () => {
    serve(() => ({ status: 500, body: { error: "boom" } }));
    const el = await render(<AeAgentsPanel />);
    expect(el.textContent).toContain("Couldn't load the Agent Engine agents.");
  });
});

describe("SettingsPage access", () => {
  it("a non-sysop sees only the sysop notice, and the agents list is never asked for", async () => {
    const calls = serve((c) => (c.url.startsWith("/api/operator/") ? { status: 403, body: { error: "operator role required" } } : { body: {} }));
    const el = await render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(el.textContent).toMatch(/only\./);
    expect(el.textContent).not.toContain("Agent Engine agents");
    expect(calls.some((c) => c.url === URL)).toBe(false);
  });
});
