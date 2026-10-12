// @vitest-environment jsdom
// #389 CA-1 web (docs/specs/central-auth.md §1.5, §1.9, §6): the /device approve page and the
// Devices page, against the spec's API shapes with a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DeviceApprovePage } from "../src/pages/DeviceApprovePage.tsx";
import { DevicesPage } from "../src/pages/DevicesPage.tsx";
import { ARM_DELAY_MS } from "../src/components/UiRequestPanel.tsx";

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
  vi.useRealTimers();
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init) ?? json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

async function render(ui: React.ReactNode, path = "/") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>));
  await act(async () => {});
  await act(async () => {});
}

function text(): string {
  return container!.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const b = [...container!.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}" in: ${text()}`);
  return b as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await act(async () => {});
}

function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const soon = () => new Date(Date.now() + 8 * 60_000).toISOString();

function pendingBody(over: Record<string, unknown> = {}) {
  return {
    userCode: "BCDF-GHJK",
    deviceName: "mbp-matthew",
    platform: "darwin-arm64",
    kernalVersion: "0.3.0",
    requestIp: "203.0.113.5",
    requestedAt: new Date().toISOString(),
    expiresAt: soon(),
    ...over,
  };
}

describe("DeviceApprovePage", () => {
  it("looks up a prefilled ?code= and names the device, platform, version, IP; never approves by itself", async () => {
    const calls = stubFetch((url) => {
      if (url === "/api/device/pending?code=BCDF-GHJK") return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com" });
    });
    await render(<DeviceApprovePage />, "/device?code=bcdf-ghjk");
    expect(text()).toContain("mbp-matthew");
    expect(text()).toContain("macOS, Apple silicon");
    expect(text()).toContain("0.3.0");
    expect(text()).toContain("203.0.113.5");
    expect(text()).toContain("BCDF-GHJK");
    // No IP from /api/me: no comparison, no warning.
    expect(container!.querySelector(".device-warning")).toBeNull();
    expect(calls.some((c) => c.url === "/api/device/approve")).toBe(false);
  });

  it("arms Approve after a delay, then approves with the normalized code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubFetch((url, init) => {
      if (url.startsWith("/api/device/pending")) return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com", ip: "203.0.113.5" });
      if (url === "/api/device/approve" && init?.method === "POST") return json({ status: "approved", deviceId: "dev_abc" });
    });
    await render(<DeviceApprovePage />, "/device?code=BCDFGHJK");
    expect(button("Approve").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(ARM_DELAY_MS + 10));
    expect(button("Approve").disabled).toBe(false);
    // Same address: no warning.
    expect(container!.querySelector(".device-warning")).toBeNull();
    await click(button("Approve"));
    const approve = calls.find((c) => c.url === "/api/device/approve");
    expect(JSON.parse(String(approve!.init!.body))).toEqual({ userCode: "BCDF-GHJK", approve: true });
    expect(text()).toContain("You can close this tab; Kernal is signed in.");
  });

  it("denies", async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com" });
      if (url === "/api/device/approve") return json({ status: "denied" });
    });
    await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
    await click(button("Deny"));
    const approve = calls.find((c) => c.url === "/api/device/approve");
    expect(JSON.parse(String(approve!.init!.body))).toEqual({ userCode: "BCDF-GHJK", approve: false });
    expect(text()).toContain("Denied.");
    expect(text()).not.toContain("is signed in");
  });

  it("warns when the request came from another address than the approver's", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com", ip: "198.51.100.7" });
    });
    await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
    const warning = container!.querySelector(".device-warning");
    expect(warning?.textContent).toContain("203.0.113.5");
    expect(warning?.textContent).toContain("198.51.100.7");
    expect(warning?.textContent).toContain("Deny");
  });

  it("asks for the code when none is given, refuses a malformed one, then looks it up", async () => {
    const calls = stubFetch((url) => {
      if (url === "/api/device/pending?code=BCDF-GHJK") return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com" });
    });
    await render(<DeviceApprovePage />, "/device");
    expect(calls).toHaveLength(0);
    const input = container!.querySelector<HTMLInputElement>("input[aria-label='Code']")!;
    await act(async () => setValue(input, "bcd"));
    await click(button("Continue"));
    expect(text()).toContain("?SYNTAX ERROR");
    expect(calls).toHaveLength(0);
    await act(async () => setValue(input, "bcdfghjk"));
    expect(input.value).toBe("BCDF-GHJK");
    await click(button("Continue"));
    await act(async () => {});
    expect(calls.some((c) => c.url === "/api/device/pending?code=BCDF-GHJK")).toBe(true);
    expect(text()).toContain("mbp-matthew");
  });

  it("says plainly when no sign-in waits for the code (404 unknown_code)", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json({ error: "unknown_code" }, 404);
      if (url === "/api/me") return json({ email: "a@example.com" });
    });
    await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
    expect(text()).toContain("No sign-in is waiting for BCDF-GHJK");
    expect(container!.querySelector("input[aria-label='Code']")).not.toBeNull();
    expect(container!.querySelector("[role='alertdialog']")).toBeNull();
  });

  it("an already answered code (409 not_pending) goes back to the form with a reason", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com" });
      if (url === "/api/device/approve") return json({ error: "not_pending" }, 409);
    });
    await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
    await click(button("Deny"));
    expect(text()).toContain("already answered or has expired");
  });

  it("shows the error dialog for other failures (rate limit)", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json({ error: "rate_limited", retryAfter: 60 }, 429);
      if (url === "/api/me") return json({ email: "a@example.com" });
    });
    await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
    expect(container!.querySelector("[role='alertdialog']")).not.toBeNull();
  });

  it("inside a frame shows only an open-directly notice: no lookup, no Approve (clickjacking)", async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json(pendingBody());
      if (url === "/api/me") return json({ email: "a@example.com" });
    });
    const top = vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    try {
      await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
      expect(text()).toContain("Open this page directly");
      expect([...container!.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Approve")).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      top.mockRestore();
    }
  });

  it("an expired code offers no buttons", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/device/pending")) return json(pendingBody({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
      if (url === "/api/me") return json({ email: "a@example.com" });
    });
    await render(<DeviceApprovePage />, "/device?code=BCDF-GHJK");
    expect(text()).toContain("This code has expired");
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent === "Approve")).toBe(false);
  });
});

const rows = [
  {
    id: "dev_aaaaaaaaaaaaaaaa",
    name: "mbp-matthew",
    kind: "laptop",
    platform: "darwin-arm64",
    kernalVersion: "0.3.0",
    createdAt: "2026-10-01T00:00:00Z",
    lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastSeenIp: "203.0.113.5",
    loginIp: "198.51.100.7",
    routerKey: { alias: "kernal-device-dev_aaaaaaaaaaaaaaaa", createdAt: "2026-10-01T00:00:00Z" },
  },
  {
    id: "dev_bbbbbbbbbbbbbbbb",
    name: "ci-e2e",
    kind: "machine",
    createdAt: "2026-10-02T00:00:00Z",
    routerKey: null,
  },
];

describe("DevicesPage", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("lists the devices: name, platform, last seen, IP, router key yes/no", async () => {
    stubFetch((url) => (url === "/api/me/devices" ? json(rows) : undefined));
    await render(<DevicesPage />, "/devices");
    const body = container!.querySelectorAll("tbody tr");
    expect(body).toHaveLength(2);
    expect(body[0]!.textContent).toContain("mbp-matthew");
    expect(body[0]!.textContent).toContain("macOS, Apple silicon");
    expect(body[0]!.textContent).toContain("5m ago");
    expect(body[0]!.textContent).toContain("203.0.113.5");
    expect(body[0]!.querySelector("[data-label='Router key']")!.textContent).toBe("yes");
    expect(body[1]!.textContent).toContain("machine token");
    expect(body[1]!.textContent).toContain("not yet");
    expect(body[1]!.querySelector("[data-label='Router key']")!.textContent).toBe("no");
    expect(text()).toContain("kernal login");
  });

  it("keeps Dongles reachable, marked retired", async () => {
    stubFetch((url) => (url === "/api/me/devices" ? json([]) : undefined));
    await render(<DevicesPage />, "/devices");
    expect(text()).toContain("No devices signed in yet.");
    expect(text()).toContain("Dongles (retired)");
    expect(container!.querySelector("a[href='/tokens']")).not.toBeNull();
  });

  it("signs a device out after a confirm", async () => {
    const calls = stubFetch((url, init) => {
      if (url === "/api/me/devices") return json(rows);
      if (url === "/api/me/devices/dev_aaaaaaaaaaaaaaaa" && init?.method === "DELETE") {
        return json({ id: "dev_aaaaaaaaaaaaaaaa", revokedAt: new Date().toISOString() });
      }
    });
    await render(<DevicesPage />, "/devices");
    await click(container!.querySelector<HTMLButtonElement>("button[aria-label='Sign out mbp-matthew']")!);
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.url === "/api/me/devices/dev_aaaaaaaaaaaaaaaa" && c.init?.method === "DELETE")).toBe(true);
    expect(container!.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(text()).not.toContain("mbp-matthew");
  });

  it("does nothing when the confirm is cancelled", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const calls = stubFetch((url) => (url === "/api/me/devices" ? json(rows) : undefined));
    await render(<DevicesPage />, "/devices");
    await click(container!.querySelector<HTMLButtonElement>("button[aria-label='Sign out ci-e2e']")!);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    expect(container!.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("shows the error dialog when the list fails", async () => {
    stubFetch(() => json({ error: "boom" }, 500));
    await render(<DevicesPage />, "/devices");
    expect(container!.querySelector(".bomb-dialog")).not.toBeNull();
    expect(container!.querySelector(".bomb-message")?.textContent?.toLowerCase()).toContain("boom");
  });
});
