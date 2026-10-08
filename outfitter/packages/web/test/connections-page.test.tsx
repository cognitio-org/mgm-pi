// @vitest-environment jsdom
// MO-5 (#487, docs/specs/mcp-connections.md §4): the Connections page against the spec's API shapes,
// with fetch mocked: each state's actions, Connect opening the router in a new tab, and Disconnect.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ConnectionsPage } from "../src/pages/ConnectionsPage.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function stubFetch(connections: unknown[]) {
  const calls: Array<{ method: string; url: string }> = [];
  let current = connections;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "DELETE") {
      current = current.map((c: any) => (url.endsWith(`/${c.name}`) ? { name: c.name, label: c.label, state: "not_connected" } : c));
      return new Response(null, { status: 204 });
    }
    return json({ connectUrl: "https://router.test/ui/connect", connections: current });
  });
  return calls;
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <ConnectionsPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {});
  return container;
}

function row(page: HTMLElement, label: string): HTMLTableRowElement {
  const found = [...page.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("td")?.textContent === label);
  if (!found) throw new Error(`no row ${label}`);
  return found as HTMLTableRowElement;
}

describe("ConnectionsPage", () => {
  it("shows each state with the right action, and Connect opens the router in a new tab", async () => {
    stubFetch([
      { name: "sentry", label: "Sentry", state: "not_connected" },
      { name: "gcloud", label: "Google Cloud", state: "reconnect_required", reconnectRequiredAt: "2026-10-08T00:00:00Z" },
    ]);
    const page = await render();

    const sentry = row(page, "Sentry");
    expect(sentry.textContent).toContain("Not connected");
    const connect = sentry.querySelector("a")!;
    expect(connect.textContent).toBe("Connect");
    expect(connect.getAttribute("href")).toBe("https://router.test/ui/connect");
    expect(connect.getAttribute("target")).toBe("_blank");
    expect(sentry.querySelector("button")).toBeNull();

    const gcloud = row(page, "Google Cloud");
    expect(gcloud.textContent).toContain("Reconnect needed");
    expect(gcloud.querySelector("a")!.textContent).toBe("Reconnect");
    expect(gcloud.querySelector("button")!.textContent).toBe("Disconnect");
  });

  it("Disconnect asks first, calls the api and shows the new state", async () => {
    const calls = stubFetch([{ name: "sentry", label: "Sentry", state: "connected", connectedAt: "2026-10-06T16:47:00Z" }]);
    const page = await render();
    expect(row(page, "Sentry").querySelector("a")).toBeNull();

    vi.stubGlobal("confirm", () => false);
    await act(async () => row(page, "Sentry").querySelector("button")!.click());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    vi.stubGlobal("confirm", () => true);
    await act(async () => row(page, "Sentry").querySelector("button")!.click());
    await act(async () => {});
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/me/connections/sentry"]);
    expect(row(page, "Sentry").textContent).toContain("Not connected");
  });
});
