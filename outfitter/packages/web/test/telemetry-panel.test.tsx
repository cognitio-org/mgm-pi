// @vitest-environment jsdom
// Settings → Telemetry: the fleet settings' Sentry switch (api fleet-settings.ts). Saving sends the
// whole Sentry section to PUT /api/operator/fleet-settings, the rate as a fraction; turning Sentry on
// without a DSN is refused before anything is sent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
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

const DSN = "https://publicKey@o0.ingest.us.sentry.io/1";

function operatorSettings(sentry: { enabled: boolean; dsn?: string; tracesSampleRate: number }) {
  return {
    litellmBaseUrl: "https://router.example",
    sandboxProvider: "gke",
    cloudRunJob: "",
    tunnelDomain: "",
    operators: ["dev@localhost"],
    secrets: [],
    fleetSettings: { telemetry: { sentry }, updatedAt: "2026-10-03T12:00:00.000Z", updatedBy: "operator@mgms.eu" },
  };
}

function serve(sentry: { enabled: boolean; dsn?: string; tracesSampleRate: number }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const body =
        call.url === "/api/operator/settings"
          ? operatorSettings(sentry)
          : call.url === "/api/operator/fleet-settings"
            ? { telemetry: { sentry: call.body && (call.body as { telemetry: { sentry: unknown } }).telemetry.sentry }, updatedAt: "2026-10-03T13:00:00.000Z", updatedBy: "dev@localhost" }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    ),
  );
  await settle();
  return host;
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

function setValue(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function saveButton(el: HTMLElement): HTMLButtonElement {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Save");
  if (!b) throw new Error('no "Save" button');
  return b as HTMLButtonElement;
}

function checkbox(el: HTMLElement): HTMLInputElement {
  const label = [...el.querySelectorAll("label")].find((l) => l.textContent?.includes("Send errors and traces to Sentry"));
  return label!.querySelector("input") as HTMLInputElement;
}

function signal(el: HTMLElement, key: string): HTMLInputElement {
  const input = el.querySelector(`input[data-signal="${key}"]`);
  if (!input) throw new Error(`no ${key} switch`);
  return input as HTMLInputElement;
}

describe("Settings → Telemetry", () => {
  it("shows the stored settings, the DSN included while off, and who changed them last", async () => {
    serve({ enabled: false, dsn: DSN, tracesSampleRate: 0.05 });
    const el = await render();
    expect(el.textContent).toContain("Telemetry");
    expect(checkbox(el).checked).toBe(false);
    expect((el.querySelector("#sentry-dsn") as HTMLInputElement).value).toBe(DSN);
    expect((el.querySelector("#sentry-rate") as HTMLInputElement).value).toBe("5");
    expect(el.textContent).toContain("by operator@mgms.eu");
    expect(saveButton(el).disabled).toBe(true);
  });

  it("turning Sentry on sends the whole section, the rate as a fraction", async () => {
    const calls = serve({ enabled: false, dsn: DSN, tracesSampleRate: 0.05 });
    const el = await render();
    await act(async () => checkbox(el).click());
    await act(async () => setValue(el.querySelector("#sentry-rate") as HTMLInputElement, "12.5"));
    await act(async () => saveButton(el).click());
    await settle();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/operator/fleet-settings");
    expect(put?.body).toEqual({ telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.125 } } });
    expect(el.textContent).toContain("Saved. Sentry is on for the fleet.");
    expect(el.textContent).toContain("by dev@localhost");
    expect(calls.filter((c) => c.url === "/api/operator/settings").length).toBe(1);
  });

  it("after a save the form is clean again, and editing clears the Saved note", async () => {
    serve({ enabled: false, dsn: DSN, tracesSampleRate: 0.05 });
    const el = await render();
    await act(async () => setValue(el.querySelector("#sentry-rate") as HTMLInputElement, "5.0"));
    await act(async () => checkbox(el).click());
    await act(async () => saveButton(el).click());
    await settle();
    expect((el.querySelector("#sentry-rate") as HTMLInputElement).value).toBe("5");
    expect(saveButton(el).disabled).toBe(true);
    await act(async () => checkbox(el).click());
    expect(el.textContent).not.toContain("Saved.");
  });

  it("an untouched rate is sent as stored, not as its rounded percentage", async () => {
    const calls = serve({ enabled: false, dsn: DSN, tracesSampleRate: 0.0123 });
    const el = await render();
    await act(async () => checkbox(el).click());
    await act(async () => saveButton(el).click());
    await settle();
    expect((calls.find((c) => c.method === "PUT")?.body as any).telemetry.sentry.tracesSampleRate).toBe(0.0123);
  });

  it("refuses to turn Sentry on without a DSN, before anything is sent", async () => {
    const calls = serve({ enabled: false, tracesSampleRate: 0.05 });
    const el = await render();
    await act(async () => checkbox(el).click());
    await act(async () => saveButton(el).click());
    await settle();
    expect(el.textContent).toContain("A DSN is needed to turn Sentry on");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("#424: every further signal starts off; turning some on sends only those, the profile rate as a fraction", async () => {
    const calls = serve({ enabled: true, dsn: DSN, tracesSampleRate: 0.05 });
    const el = await render();
    for (const key of ["logs", "metrics", "agentTraces", "agentContent"]) expect(signal(el, key).checked).toBe(false);
    expect(signal(el, "agentContent").disabled).toBe(true);
    expect((el.querySelector("#sentry-profiles") as HTMLInputElement).value).toBe("0");
    await act(async () => signal(el, "logs").click());
    await act(async () => signal(el, "agentTraces").click());
    expect(signal(el, "agentContent").disabled).toBe(false);
    await act(async () => signal(el, "agentContent").click());
    await act(async () => setValue(el.querySelector("#sentry-profiles") as HTMLInputElement, "10"));
    await act(async () => saveButton(el).click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.05, logs: true, agentTraces: true, agentContent: true, profilesSampleRate: 0.1 } },
    });
    expect(saveButton(el).disabled).toBe(true);
  });

  it("#424: shows stored signals, and turning agent traces off turns content off with them", async () => {
    const calls = serve({ enabled: true, dsn: DSN, tracesSampleRate: 0.05, agentTraces: true, agentContent: true, metrics: true, profilesSampleRate: 0.5 } as never);
    const el = await render();
    expect(signal(el, "metrics").checked).toBe(true);
    expect(signal(el, "agentContent").checked).toBe(true);
    expect((el.querySelector("#sentry-profiles") as HTMLInputElement).value).toBe("50");
    await act(async () => signal(el, "agentTraces").click());
    expect(signal(el, "agentContent").checked).toBe(false);
    await act(async () => setValue(el.querySelector("#sentry-profiles") as HTMLInputElement, "0"));
    await act(async () => saveButton(el).click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.05, metrics: true } } });
  });

  it("#424: refuses a profile rate outside 0 to 100%", async () => {
    const calls = serve({ enabled: true, dsn: DSN, tracesSampleRate: 0.05 });
    const el = await render();
    await act(async () => setValue(el.querySelector("#sentry-profiles") as HTMLInputElement, "-1"));
    await act(async () => saveButton(el).click());
    await settle();
    expect(el.textContent).toContain("A percentage from 0 to 100");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses a rate outside 0 to 100%", async () => {
    const calls = serve({ enabled: true, dsn: DSN, tracesSampleRate: 0.05 });
    const el = await render();
    await act(async () => setValue(el.querySelector("#sentry-rate") as HTMLInputElement, "150"));
    await act(async () => saveButton(el).click());
    await settle();
    expect(el.textContent).toContain("A percentage from 0 to 100");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
