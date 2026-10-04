// @vitest-environment jsdom
// #389 CA-7 (docs/specs/central-auth.md §7): the Account page against the spec's API shapes, with
// fetch mocked: schema-driven editors with sources, If-Match writes and the 409 "changed
// elsewhere", profiles, write-only provider keys, the share toggle and spend.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountPage } from "../src/pages/AccountPage.tsx";

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

const PERSONAL = ["fleet", "user", "profile", "device", "local"];
const schema = {
  schemaVersion: 1,
  settings: [
    { key: "router.baseUrl", type: "url", secret: false, levels: ["fleet", "local"], override: "none", default: "https://router.kernal.one/v1", since: 1, description: "The router." },
    { key: "router.key", type: "string", secret: true, delivery: "login", levels: ["device", "local"], override: "any", since: 1, description: "Device key." },
    { key: "model.default", type: "string", secret: false, levels: PERSONAL, override: "any", since: 1, description: "Start model." },
    { key: "model.thinking", type: "enum", values: ["off", "low", "high"], secret: false, levels: PERSONAL, override: "any", since: 1, description: "Thinking." },
    { key: "localHost.shareModels", type: "boolean", secret: false, levels: ["user", "profile", "device", "local"], override: "any", default: false, since: 1, description: "Share local models." },
  ],
};

function config(profile: string | null) {
  return {
    schemaVersion: 1,
    account: { email: "dev@localhost", userId: "u_abc" },
    profile,
    profiles: ["personal", "work"],
    deviceId: null,
    values: {
      "router.baseUrl": { value: "https://router.kernal.one/v1", source: "fleet", override: "none", locked: true, localAllowed: true },
      "model.default": { value: "claude-auto-llm", source: "profile", sourceName: profile ?? "work", override: "any", locked: false, localAllowed: true },
      "model.thinking": { value: "high", source: "fleet", override: "none", locked: true, localAllowed: false },
      "localHost.shareModels": { value: false, source: "default", override: "any", locked: false, localAllowed: true },
    },
    versions: { fleet: 3, user: 3, profile: 2, device: 0 },
    resolvedAt: "2026-10-04T10:00:00.000Z",
  };
}

interface Options {
  operator?: boolean;
  putUser?: (body: any, headers: Record<string, string>) => Response;
  spendStatus?: number;
  operatorSpendStatus?: number;
  /** Answer a profile's PUT, PATCH or DELETE with this status instead (a 409 stale_version). */
  profileWriteStatus?: Partial<Record<"PUT" | "PATCH" | "DELETE", number>>;
}

function stubFetch(opts: Options = {}) {
  const calls: Array<{ method: string; url: string; body?: any; headers: Record<string, string> }> = [];
  let userDoc = { id: "user:u_abc", level: "user", values: { "model.default": "gpt-x" } as Record<string, unknown>, version: 3 };
  let keys = [{ provider: "openrouter", last4: "9f2a", setAt: "2026-10-01T00:00:00Z" }];
  const profiles = [
    { id: "profile:u_abc:personal", level: "profile", name: "personal", isDefault: false, values: {}, version: 1, updatedAt: "2026-10-01T00:00:00Z" },
    { id: "profile:u_abc:work", level: "profile", name: "work", isDefault: true, values: { "model.default": "claude-auto-llm" }, version: 2, updatedAt: "2026-10-02T00:00:00Z" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body, headers });
      if (url === "/api/me") return json({ email: "dev@localhost", operator: !!opts.operator });
      if (url === "/api/config/schema") return json(schema);
      if (url.startsWith("/api/config?profile=")) return json(config(decodeURIComponent(url.split("=")[1])));
      if (url === "/api/config") return json(config("work"));
      if (url === "/api/config/user" && method === "GET") return json(userDoc);
      if (url === "/api/config/user" && method === "PUT") {
        if (opts.putUser) return opts.putUser(body, headers);
        userDoc = { ...userDoc, values: { ...userDoc.values, ...body.values }, version: userDoc.version + 1 };
        for (const [k, v] of Object.entries(body.values)) if (v === null) delete userDoc.values[k];
        return json(userDoc);
      }
      if (url === "/api/config/profiles" && method === "GET") return json(profiles);
      if (url === "/api/config/profiles" && method === "POST") {
        const doc = { id: `profile:u_abc:${body.name}`, level: "profile", name: body.name, values: {}, version: 1 };
        profiles.push(doc as (typeof profiles)[number]);
        return json(doc, 201);
      }
      const forced = opts.profileWriteStatus?.[method as "PUT" | "PATCH" | "DELETE"];
      if (url.startsWith("/api/config/profiles/") && forced) return json({ error: "stale_version", current: null }, forced);
      if (url.startsWith("/api/config/profiles/") && method === "PUT") {
        const p = profiles.find((p) => p.name === decodeURIComponent(url.split("/").pop()!))!;
        Object.assign(p, { values: { ...p.values, ...body.values }, version: p.version + 1 });
        return json(p);
      }
      if (url.startsWith("/api/config/profiles/") && method === "PATCH") {
        const name = decodeURIComponent(url.split("/").pop()!);
        const p = profiles.find((p) => p.name === name)!;
        if (body.rename) {
          Object.assign(p, { name: body.rename, version: p.version + 1 });
          return json(p);
        }
        for (const q of profiles) {
          if (q.isDefault !== (q.name === name)) q.version += 1;
          q.isDefault = q.name === name;
        }
        return json(p);
      }
      if (url.startsWith("/api/config/profiles/") && method === "DELETE") {
        const name = decodeURIComponent(url.split("/").pop()!);
        profiles.splice(profiles.findIndex((p) => p.name === name), 1);
        return new Response(null, { status: 204 });
      }
      if (url === "/api/me/provider-keys") return json(keys);
      if (url.startsWith("/api/me/provider-keys/") && method === "PUT") {
        const provider = url.split("/").pop()!;
        const row = { provider, last4: String(body.value).slice(-4), setAt: "2026-10-04T00:00:00Z" };
        keys = [...keys.filter((k) => k.provider !== provider), row];
        return json(row);
      }
      if (url.startsWith("/api/me/provider-keys/") && method === "DELETE") {
        keys = keys.filter((k) => k.provider !== url.split("/").pop());
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("/api/me/spend")) {
        if (opts.spendStatus) return json({ error: "spend_unavailable" }, opts.spendStatus);
        return json({
          month: "2026-10",
          currency: "USD",
          total: 12.5,
          byDevice: [
            { alias: "kernal-device-dev_aaaa", deviceId: "dev_aaaa", deviceName: "mbp-matthew", kind: "device", spend: 10 },
            { alias: "outfitter-run-r1", kind: "run", spend: 2.5 },
          ],
          byModel: [{ model: "claude-auto-llm", spend: 12.5 }],
          fetchedAt: "2026-10-04T10:00:00Z",
        });
      }
      if (url.startsWith("/api/operator/spend")) {
        if (opts.operatorSpendStatus) {
          return json({ error: opts.operatorSpendStatus === 503 ? "spend_unavailable" : "router_failed" }, opts.operatorSpendStatus);
        }
        return json({ month: "2026-10", total: 40, users: [{ userId: "u_abc", email: "dev@localhost", total: 12.5 }, { userId: "u_def", email: "matej@example.com", total: 27.5 }] });
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
  await act(async () => root!.render(<AccountPage />));
  await flush();
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

function section(id: string): HTMLElement {
  return container!.querySelector(`section[aria-labelledby="${id}"]`) as HTMLElement;
}

function button(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

describe("AccountPage: account-wide settings", () => {
  it("shows only user-level, non-secret keys, with what is in effect and why", async () => {
    stubFetch();
    await render();
    const s = section("account-wide");
    const text = s.textContent!;
    expect(text).toContain("model.default");
    expect(text).toContain("model.thinking");
    expect(text).not.toContain("router.key");
    expect(text).not.toContain("router.baseUrl");
    // The share toggle has its own panel.
    expect(text).not.toContain("localHost.shareModels");
    expect((s.querySelector('[aria-label="model.default value"]') as HTMLInputElement).value).toBe("gpt-x");
    expect(text).toContain("profile work");
    // A value the fleet locks is read-only, "set by your Sysop".
    expect((s.querySelector('[aria-label="model.thinking value"]') as HTMLSelectElement).disabled).toBe(true);
    expect(text).toContain("set by your Sysop");
  });

  it("saves only the changed keys with If-Match", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-wide");
    await act(async () => setValue(s.querySelector('[aria-label="model.default value"]') as HTMLInputElement, ""));
    await click(button(s, "Save"));
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/config/user");
    expect(put?.headers["If-Match"]).toBe('W/"3"');
    expect(put?.body).toEqual({ values: { "model.default": null } });
    expect(s.textContent).toContain("Saved.");
  });

  it("says 'changed elsewhere' on a 409 and never retries", async () => {
    const calls = stubFetch({ putUser: () => json({ error: "stale_version", current: null }, 409) });
    await render();
    const s = section("account-wide");
    await act(async () => setValue(s.querySelector('[aria-label="model.default value"]') as HTMLInputElement, "other"));
    await click(button(s, "Save"));
    expect(s.textContent).toContain("Changed elsewhere");
    expect(calls.filter((c) => c.method === "PUT").length).toBe(1);
    expect(button(s, "Save").disabled).toBe(true);
    await click(button(s, "Reload"));
    expect(s.textContent).not.toContain("Changed elsewhere");
  });

  it("keeps unsaved edits when the share toggle saves the same document", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-wide");
    const field = () => s.querySelector('[aria-label="model.default value"]') as HTMLInputElement;
    await act(async () => setValue(field(), "typed-model"));
    await click(section("account-local").querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(field().value).toBe("typed-model");
    expect(s.textContent).not.toContain("Changed elsewhere");
    await click(button(s, "Save"));
    const puts = calls.filter((c) => c.method === "PUT" && c.url === "/api/config/user");
    expect(puts.length).toBe(2);
    // The save is based on the version the toggle left, and sends only the typed key.
    expect(puts[1].headers["If-Match"]).toBe('W/"4"');
    expect(puts[1].body).toEqual({ values: { "model.default": "typed-model" } });
  });

  it("lists the fleet's values read-only", async () => {
    stubFetch();
    await render();
    const s = section("account-fleet");
    expect(s.textContent).toContain("router.baseUrl");
    expect(s.textContent).toContain("set by your Sysop");
    expect(s.querySelector("input, select")).toBeNull();
  });
});

describe("AccountPage: profiles", () => {
  it("lists profiles, marks the default and edits it first", async () => {
    stubFetch();
    await render();
    const s = section("account-profiles");
    expect(s.textContent).toContain("personal");
    expect(s.textContent).toContain("default");
    expect(s.querySelector('form[aria-label="Profile work"]')).not.toBeNull();
  });

  it("makes a profile the default with If-Match", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-profiles");
    await click(button(s, "Make default"));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/config/profiles/personal");
    expect(patch?.headers["If-Match"]).toBe('W/"1"');
    expect(patch?.body).toEqual({ isDefault: true });
  });

  it("creates a profile copying another, and checks the name first", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-profiles");
    const name = s.querySelector('[aria-label="New profile name"]') as HTMLInputElement;
    await act(async () => setValue(name, "Bad Name"));
    await click(button(s, "Create profile"));
    expect(s.textContent).toContain("?SYNTAX ERROR");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await act(async () => setValue(name, "travel"));
    await act(async () => setValue(s.querySelector('[aria-label="Copy values from"]') as HTMLSelectElement, "work"));
    await click(button(s, "Create profile"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ name: "travel", copyFrom: "work" });
    expect(s.querySelector('form[aria-label="Profile travel"]')).not.toBeNull();
  });

  it("deletes a profile after a confirm, with If-Match", async () => {
    const calls = stubFetch();
    vi.stubGlobal("confirm", vi.fn(() => true));
    await render();
    const s = section("account-profiles");
    await click([...s.querySelectorAll("button")].filter((b) => b.textContent === "Delete")[0] as HTMLButtonElement);
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("/api/config/profiles/personal");
    expect(del?.headers["If-Match"]).toBe('W/"1"');
  });
});

describe("AccountPage: profile changes", () => {
  it("renames a profile with If-Match and then edits it under the new name", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-profiles");
    await click(button(s, "Edit")); // personal (work is selected)
    await click([...s.querySelectorAll("button")].filter((b) => b.textContent === "Rename")[0] as HTMLButtonElement);
    await act(async () => setValue(s.querySelector('[aria-label="New name for personal"]') as HTMLInputElement, "home"));
    await click(button(s, "Save name"));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/config/profiles/personal");
    expect(patch?.headers["If-Match"]).toBe('W/"1"');
    expect(patch?.body).toEqual({ rename: "home" });
    expect(s.querySelector('form[aria-label="Profile home"]')).not.toBeNull();
    expect(s.querySelector('[aria-label="New name for personal"]')).toBeNull();
  });

  it("keeps a profile's unsaved edits when another profile becomes the default", async () => {
    stubFetch();
    await render();
    const s = section("account-profiles");
    const field = () => s.querySelector('form[aria-label="Profile work"] [aria-label="model.default value"]') as HTMLInputElement;
    await act(async () => setValue(field(), "typed-model"));
    await click(button(s, "Make default")); // personal; work's version moves too
    expect(field().value).toBe("typed-model");
  });

  it("says 'changed elsewhere' when a profile's values lost a race, and never retries", async () => {
    const calls = stubFetch({ profileWriteStatus: { PUT: 409 } });
    await render();
    const form = section("account-profiles").querySelector('form[aria-label="Profile work"]') as HTMLElement;
    await act(async () => setValue(form.querySelector('[aria-label="model.default value"]') as HTMLInputElement, "other"));
    await click(button(form, "Save"));
    expect(form.textContent).toContain("Changed elsewhere");
    expect(calls.filter((c) => c.method === "PUT" && c.url.startsWith("/api/config/profiles/")).length).toBe(1);
    expect(button(form, "Save").disabled).toBe(true);
  });

  it.each([
    ["PATCH", "Make default"],
    ["DELETE", "Delete"],
  ] as const)("a %s that lost a race says so and reloads the list instead of retrying", async (method, label) => {
    const calls = stubFetch({ profileWriteStatus: { [method]: 409 } });
    vi.stubGlobal("confirm", vi.fn(() => true));
    await render();
    const s = section("account-profiles");
    const lists = () => calls.filter((c) => c.method === "GET" && c.url === "/api/config/profiles").length;
    const before = lists();
    await click([...s.querySelectorAll("button")].filter((b) => b.textContent === label)[0] as HTMLButtonElement);
    expect(s.textContent).toContain("Changed elsewhere");
    expect(calls.filter((c) => c.method === method).length).toBe(1);
    expect(lists()).toBe(before + 1);
  });

  it("falls back to the default profile when the selected one is deleted", async () => {
    stubFetch();
    vi.stubGlobal("confirm", vi.fn(() => true));
    await render();
    const s = section("account-profiles");
    await click(button(s, "Edit")); // personal
    expect(s.querySelector('form[aria-label="Profile personal"]')).not.toBeNull();
    await click([...s.querySelectorAll("button")].filter((b) => b.textContent === "Delete")[0] as HTMLButtonElement);
    expect(s.textContent).not.toContain("personal");
    expect(s.querySelector('form[aria-label="Profile work"]')).not.toBeNull();
  });
});

describe("AccountPage: personal keys", () => {
  it("shows only the last four characters and never shows a typed key back", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-keys");
    expect(s.textContent).toContain("…9f2a");
    await click(button(s, "Set")); // the first unset provider (Deepgram)
    const input = s.querySelector('[aria-label="Deepgram key"]') as HTMLInputElement;
    expect(input.type).toBe("password");
    // Not a sign-in form: password managers aren't offered the key.
    expect(input.autocomplete).toBe("new-password");
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.hasAttribute("data-1p-ignore")).toBe(true);
    await act(async () => setValue(input, "dg-secret-value-1234"));
    await click(button(s, "Save"));
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/me/provider-keys/deepgram");
    expect(put?.body).toEqual({ value: "dg-secret-value-1234" });
    expect(container!.innerHTML).not.toContain("dg-secret-value");
    expect(s.textContent).toContain("…1234");
  });
});

describe("AccountPage: local models", () => {
  it("writes localHost.shareModels at the user level", async () => {
    const calls = stubFetch();
    await render();
    const box = section("account-local").querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await click(box);
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/config/user");
    expect(put?.body).toEqual({ values: { "localHost.shareModels": true } });
    expect(put?.headers["If-Match"]).toBe('W/"3"');
    expect(box.checked).toBe(true);
  });
});

describe("AccountPage: spend", () => {
  it("shows this month by device and by model, without the operator view for a person", async () => {
    const calls = stubFetch();
    await render();
    const s = section("account-spend");
    expect(s.textContent).toContain("$12.50");
    expect(s.textContent).toContain("mbp-matthew");
    expect(s.textContent).toContain("Drive run");
    expect(s.textContent).toContain("claude-auto-llm");
    expect(calls.some((c) => c.url.startsWith("/api/operator/spend"))).toBe(false);
    expect(s.textContent).not.toContain("matej@example.com");
  });

  it("shows every user to a Sysop", async () => {
    stubFetch({ operator: true });
    await render();
    const s = section("account-spend");
    expect(s.textContent).toContain("matej@example.com");
    expect(s.textContent).toContain("$40.00");
  });

  it.each([
    [500, "router_failed"],
    [503, "isn't available"],
  ])("tells a Sysop when everyone's spend fails (%i)", async (status, text) => {
    stubFetch({ operator: true, operatorSpendStatus: status });
    await render();
    const s = section("account-spend");
    expect(s.textContent).toContain("Everyone");
    expect(s.querySelector('[role="alert"]')?.textContent).toContain(text);
    // The person's own spend still shows.
    expect(s.textContent).toContain("$12.50");
  });

  it("says when spend isn't available", async () => {
    stubFetch({ spendStatus: 503 });
    await render();
    expect(section("account-spend").textContent).toContain("isn't available");
  });
});
