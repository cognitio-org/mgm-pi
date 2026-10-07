// @vitest-environment jsdom
// docs/specs/subscriptions.md §4: the Subscriptions page against the spec's HTTP shapes, with
// fetch mocked. Secrets are write-only; modes and prefer go through the config API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SubscriptionsPage } from "../src/pages/SubscriptionsPage.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const STORED_VALUE = "sk-ant-SHOULD-NOT-APPEAR";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function config() {
  return {
    schemaVersion: 4,
    account: { email: "dev@localhost", userId: "u_abc" },
    profile: null,
    profiles: [],
    deviceId: null,
    values: {},
    versions: { fleet: 1, user: 7 },
    resolvedAt: "2026-10-06T12:00:00.000Z",
  };
}

function stubFetch() {
  const calls: Array<{ method: string; url: string; body?: any; headers: Record<string, string> }> = [];
  let userDoc = { id: "user:u_abc", level: "user", values: {} as Record<string, unknown>, version: 7 };
  let secrets: Array<Record<string, unknown>> = [
    { vendor: "claude", last4: "c0de", setAt: "2026-10-06T12:00:00.000Z", version: 2, value: STORED_VALUE },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body, headers });
      if (url === "/api/config" && method === "GET") return json(config());
      if (url === "/api/config/user" && method === "GET") return json(userDoc);
      if (url === "/api/config/user" && method === "PUT") {
        userDoc = { ...userDoc, values: { ...userDoc.values, ...body.values }, version: userDoc.version + 1 };
        return json(userDoc);
      }
      if (url === "/api/me/subscription-secrets" && method === "GET") return json(secrets);
      if (url.startsWith("/api/me/subscription-secrets/") && method === "PUT") {
        const vendor = decodeURIComponent(url.split("/").pop()!);
        const row = { vendor, last4: "ffff", setAt: "2026-10-06T12:00:00.000Z", version: (body.ifVersion ?? 0) + 1, value: body.value };
        secrets = [...secrets.filter((row) => row.vendor !== vendor), { vendor, last4: "ffff", setAt: row.setAt, version: row.version }];
        return json(row);
      }
      if (url.startsWith("/api/me/subscription-secrets/") && method === "DELETE") {
        const vendor = decodeURIComponent(url.split("/").pop()!);
        secrets = secrets.filter((row) => row.vendor !== vendor);
        return new Response(null, { status: 204 });
      }
      return json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><SubscriptionsPage /></MemoryRouter>));
  await flush();
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

function card(label: string): HTMLElement {
  const found = container!.querySelector(`section.panel[aria-label="${label}"]`);
  if (!found) throw new Error(`no card "${label}"`);
  return found as HTMLElement;
}

describe("SubscriptionsPage", () => {
  it("renders four cards and shows a saved Claude secret's last4, not its value", async () => {
    const calls = stubFetch();
    await render();
    expect(container!.textContent).toContain("Subscriptions · your Claude, Grok, Codex, and Antigravity logins");
    expect([...container!.querySelectorAll("section.panel")].map((el) => el.getAttribute("aria-label"))).toEqual([
      "Claude",
      "Grok",
      "Codex",
      "Antigravity",
    ]);
    expect(card("Antigravity").querySelector('[name="subscriptions.gemini"]')).not.toBeNull();
    const claude = card("Claude");
    expect(claude.textContent).toContain("c0de");
    expect(claude.textContent).toContain("connected");
    expect(container!.innerHTML).not.toContain(STORED_VALUE);
    const field = claude.querySelector('[aria-label="Claude secret"]') as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.value).toBe("");
    expect(calls.some((call) => call.url.includes("/api/device/subscription-secrets"))).toBe(false);
  });

  it("disconnects Claude with DELETE", async () => {
    const calls = stubFetch();
    vi.stubGlobal("confirm", vi.fn(() => true));
    await render();
    const claude = card("Claude");
    expect(claude.textContent).toContain("connected …c0de");
    expect(claude.textContent).toContain("Laptop: Ready (one-shot worker)");
    expect(claude.textContent).toContain("Cloud Drives: Pending #473");
    await click(button(card("Claude"), "Disconnect"));
    expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/me/subscription-secrets/claude")).toBe(true);
    expect(card("Claude").textContent).toContain("not connected");
    expect(container!.innerHTML).not.toContain(STORED_VALUE);
  });

  it("writes subscriptions.claude when the mode changes", async () => {
    const calls = stubFetch();
    await render();
    const select = card("Claude").querySelector('[aria-label="Claude mode"]') as HTMLSelectElement;
    expect(select.value).toBe("off");
    await act(async () => setValue(select, "sandboxed"));
    await flush();
    const put = calls.find((call) => call.method === "PUT" && call.url === "/api/config/user");
    expect(put?.headers["If-Match"]).toBe('W/"7"');
    expect(put?.body).toEqual({ values: { "subscriptions.claude": "sandboxed" } });
    expect(select.value).toBe("sandboxed");
  });

  it("writes a prefer subset and clears a pasted secret after connect", async () => {
    const calls = stubFetch();
    await render();
    const order = container!.querySelector('[aria-label="subscriptions.prefer"]') as HTMLInputElement;
    await act(async () => setValue(order, "claude,gemini"));
    await click(button(container!, "Save"));
    const prefer = calls.find((call) => call.method === "PUT" && call.url === "/api/config/user");
    expect(prefer?.body).toEqual({ values: { "subscriptions.prefer": "claude,gemini" } });

    const claude = card("Claude");
    const field = claude.querySelector('[aria-label="Claude secret"]') as HTMLInputElement;
    const pasted = "sk-ant-setup-token-pasted-9999";
    await act(async () => setValue(field, pasted));
    await click(button(claude, "Connect"));
    const put = calls.find((call) => call.method === "PUT" && call.url === "/api/me/subscription-secrets/claude");
    expect(put?.body).toEqual({ value: pasted, ifVersion: 2 });
    expect(field.value).toBe("");
    expect(container!.innerHTML).not.toContain(pasted);
    expect(container!.innerHTML).not.toContain(STORED_VALUE);
  });
});
