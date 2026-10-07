// @vitest-environment jsdom
// #388 Modems and #385 the operator remove list: GET /api/local-hosts, grouped, with DELETE only
// from Account and the Control Panel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DeskPage } from "../src/pages/DeskPage.tsx";
import { LocalModelsPage } from "../src/pages/LocalModelsPage.tsx";
import { SettingsPage } from "../src/pages/SettingsPage.tsx";

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

function host(over: Record<string, unknown> = {}) {
  return {
    id: "h1",
    hostName: "mbp",
    owner: { email: "dev@localhost", mine: true },
    status: "online",
    shareModels: true,
    accessGroup: "everyone",
    routerPrefix: "dev-mbp",
    lastSeenAt: new Date().toISOString(),
    tunnel: { provider: "ngrok", managed: true, state: "up" },
    servers: [],
    models: [],
    ...over,
  };
}

const qwen = {
  id: "qwen",
  routerModel: "local/dev-mbp/qwen",
  kind: "llm",
  loaded: true,
  contextLength: 131072,
  vision: true,
  toolUse: true,
  shared: true,
};
const gemma = {
  id: "gemma",
  routerModel: "local/dev-mbp/gemma",
  kind: "llm",
  loaded: false,
  contextLength: 8192,
  vision: false,
  toolUse: false,
  shared: true,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      return handler(url, init) ?? json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

async function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter>{ui}</MemoryRouter>));
  for (let i = 0; i < 6; i++) await act(async () => {});
}

function text(): string {
  return container!.textContent ?? "";
}

describe("LocalModelsPage", () => {
  it("groups by owner, splits loaded models, and copies the router name", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    stubFetch((url) =>
      url === "/api/local-hosts"
        ? json({
            hosts: [
              host({ models: [qwen, gemma, { id: "embed", kind: "embedding", shared: false }] }),
              host({
                id: "h2",
                hostName: "air",
                owner: { email: "other@example.com", mine: false },
                status: "stale",
                accessGroup: "everyone",
                tunnel: { provider: "cloudflare", managed: false, state: "up" },
                models: [],
              }),
              host({
                id: "h3",
                hostName: "mini",
                owner: { email: "dev@localhost", mine: true },
                status: "offline",
                models: [],
              }),
            ],
          })
        : undefined,
    );
    await render(<LocalModelsPage />);
    const owners = [...container!.querySelectorAll(".local-host-owner h3")].map((el) => el.textContent);
    expect(owners).toEqual(["dev@localhost (you)", "other@example.com"]);
    const mine = container!.querySelector(".local-host-owner")!;
    expect(mine.textContent).toContain("mbp");
    expect(mine.textContent).toContain("mini");
    expect(mine.textContent).toContain("online");
    expect(mine.textContent).toContain("offline");
    expect(text()).toContain("stale");
    expect(text()).toContain("ngrok");
    expect(text()).toContain("cloudflare (interim)");
    expect(container!.querySelector("code")?.textContent).toBe("everyone");
    expect(text()).toContain("131,072");
    expect(text()).toContain("vision yes");
    expect(text()).toContain("tools no");
    const loaded = [...container!.querySelectorAll(".local-model-block")].find((el) => el.querySelector("h4")?.textContent === "Loaded");
    const notLoaded = [...container!.querySelectorAll(".local-model-block")].find((el) => el.querySelector("h4")?.textContent === "Not loaded");
    expect(loaded?.textContent).toContain("local/dev-mbp/qwen");
    expect(loaded?.textContent).not.toContain("can take a long time");
    expect(notLoaded?.textContent).toContain("local/dev-mbp/gemma");
    expect(notLoaded?.textContent).toContain("The first request loads the model, which can take a long time.");
    expect(text()).toContain("not on the shared server");
    const copy = container!.querySelector('button[aria-label="Copy local/dev-mbp/qwen"]') as HTMLButtonElement;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("local/dev-mbp/qwen");
    expect(copy.textContent).toBe("Copied");
  });

  it("says when nobody is sharing", async () => {
    stubFetch((url) => (url === "/api/local-hosts" ? json({ hosts: [] }) : undefined));
    await render(<LocalModelsPage />);
    expect(text()).toContain("No one is sharing local models yet.");
  });

  it("a failed load is an error, not an empty fleet", async () => {
    stubFetch((url) => (url === "/api/local-hosts" ? json({ error: "nope" }, 500) : undefined));
    await render(<LocalModelsPage />);
    expect(text()).not.toContain("No one is sharing local models yet.");
    expect(container!.querySelector(".syntax-error")).not.toBeNull();
  });
});

describe("Desk modem LED", () => {
  function desk(hosts: unknown[]) {
    return stubFetch((url) => {
      if (url === "/api/local-hosts") return json({ hosts });
      if (url === "/api/sessions") return json([]);
      if (url === "/api/gurus") return json([]);
      if (url === "/api/providers") return json({ providers: [] });
      if (url === "/api/me") return json({ email: "dev@localhost", operator: false });
      return undefined;
    });
  }

  it("lights the LEDs when any listed host is online, for a person who is not a Sysop", async () => {
    desk([host({ status: "online" })]);
    await render(<DeskPage />);
    const btn = container!.querySelector('button[title^="Modems"]')!;
    expect(btn).toBeTruthy();
    expect([...btn.querySelectorAll("rect")].some((r) => r.getAttribute("fill") === "var(--ok, currentColor)")).toBe(true);
    expect(container!.textContent).not.toContain("Control Panel");
  });

  it("leaves the LEDs dark when every host is offline", async () => {
    desk([host({ status: "offline" })]);
    await render(<DeskPage />);
    const btn = container!.querySelector('button[title^="Modems"]')!;
    expect([...btn.querySelectorAll("rect")].some((r) => r.getAttribute("fill")?.includes("var(--ok"))).toBe(false);
  });
});

describe("Settings local hosts", () => {
  it("links to Modems and removes a host, without a second model catalogue", async () => {
    const calls = stubFetch((url, init) => {
      if (url === "/api/operator/settings") {
        return json({
          litellmBaseUrl: "https://router.example",
          sandboxProvider: "gke",
          cloudRunJob: "",
          tunnelDomain: "",
          operators: ["dev@localhost"],
          secrets: [],
          fleetSettings: { telemetry: { sentry: { enabled: false, tracesSampleRate: 0 } }, updatedAt: "2026-10-06T00:00:00.000Z" },
        });
      }
      if (url === "/api/local-hosts" && (init?.method ?? "GET") === "GET") return json({ hosts: [host()] });
      if (url.startsWith("/api/local-hosts/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({});
    });
    vi.stubGlobal("confirm", () => true);
    await render(<SettingsPage />);
    expect(text()).toContain("Local hosts");
    expect(container!.querySelector('a[href="/local-models"]')).toBeTruthy();
    expect(container!.querySelector('a[href="/account"]')).toBeTruthy();
    expect(text()).not.toContain("local/dev-mbp/qwen");
    const remove = [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Remove") as HTMLButtonElement;
    await act(async () => remove.click());
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/local-hosts/h1")).toBe(true);
  });
});
