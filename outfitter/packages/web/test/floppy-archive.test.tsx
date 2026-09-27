// @vitest-environment jsdom
// #209: Archive, Restore and Format in the Disk Box (FleetPage) and the Format confirm dialog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { FleetPage } from "../src/pages/FleetPage.tsx";
import { FormatFloppyDialog } from "../src/components/FormatFloppyDialog.tsx";
import type { SessionSummary } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, name: id, status: "open", guru: "g1", repo: null, cost: 0, updatedAt: "2026-09-27T00:00:00.000Z", canManage: true, ...overrides };
}

interface Call {
  method: string;
  url: string;
}

/** Answers the few routes these views call; records every call. */
function stubApi(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: input });
      const key = `${method} ${input}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: `no stub for ${key}` }), { status: 500 });
      const body = routes[key];
      return body === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${container.textContent}`);
  return found as HTMLButtonElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Disk Box archive actions", () => {
  it("follows ?archived=only and writes the view back to the URL", async () => {
    stubApi({
      "GET /api/sessions?archived=only": [],
      "GET /api/sessions": [row("mine")],
      "GET /api/gurus": [],
    });
    const view = mount(
      <MemoryRouter initialEntries={["/fleet?archived=only"]}>
        <FleetPage />
      </MemoryRouter>,
    );
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Archive");
    const select = view.container.querySelector('select[aria-label="Show floppies"]') as HTMLSelectElement;
    act(() => {
      select.value = "active";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Disk Box");
    expect(button(view.container, "Archive")).toBeTruthy();
    view.unmount();
  });

  it("offers Archive only on floppies the user may manage, and archives through the api", async () => {
    const calls = stubApi({
      "GET /api/sessions": [row("mine"), row("theirs", { canManage: false })],
      "GET /api/gurus": [],
      "POST /api/sessions/mine/archive": { session: row("mine", { archivedAt: "2026-09-27T01:00:00.000Z" }) },
    });
    const view = mount(
      <MemoryRouter>
        <FleetPage />
      </MemoryRouter>,
    );
    await flush();

    const archiveButtons = [...view.container.querySelectorAll("button")].filter((b) => b.textContent === "Archive");
    expect(archiveButtons).toHaveLength(1);
    act(() => archiveButtons[0].click());
    await flush();

    expect(calls.some((c) => c.method === "POST" && c.url === "/api/sessions/mine/archive")).toBe(true);
    expect(calls.filter((c) => c.url === "/api/sessions").length).toBe(2); // reloaded after archiving
    view.unmount();
  });

  it("the Archive view lists archived floppies with Restore and Format", async () => {
    const calls = stubApi({
      "GET /api/sessions?archived=only": [row("old", { archivedAt: "2026-09-27T00:00:00.000Z" })],
      "GET /api/gurus": [],
      "POST /api/sessions/old/restore": { session: row("old") },
    });
    const view = mount(
      <MemoryRouter initialEntries={["/fleet?archived=only"]}>
        <FleetPage />
      </MemoryRouter>,
    );
    await flush();

    expect(button(view.container, "Format…")).toBeTruthy();
    act(() => button(view.container, "Restore").click());
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/sessions/old/restore")).toBe(true);
    view.unmount();
  });
});

describe("FormatFloppyDialog", () => {
  it("does nothing until confirmed, then formats and reports back", async () => {
    const calls = stubApi({ "DELETE /api/sessions/s1": null });
    const onFormatted = vi.fn();
    const onCancel = vi.fn();
    const view = mount(<FormatFloppyDialog sessionId="s1" title="My floppy" onFormatted={onFormatted} onCancel={onCancel} onError={vi.fn()} />);

    const dialog = view.container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Format My floppy?");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(calls).toHaveLength(0);

    act(() => button(view.container, "Yes, format").click());
    await flush();
    expect(calls).toEqual([{ method: "DELETE", url: "/api/sessions/s1" }]);
    expect(onFormatted).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    view.unmount();
  });

  it("Escape cancels and Tab stays on the two buttons", () => {
    stubApi({});
    const onCancel = vi.fn();
    const view = mount(<FormatFloppyDialog sessionId="s1" title="t" onFormatted={vi.fn()} onCancel={onCancel} onError={vi.fn()} />);
    const dialog = view.container.querySelector('[role="alertdialog"]') as HTMLElement;
    const key = (k: string, shiftKey = false) =>
      act(() => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
      });
    key("Tab");
    expect(document.activeElement?.textContent).toBe("Yes, format");
    key("Tab", true);
    expect(document.activeElement?.textContent).toBe("Cancel");
    key("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("passes a refusal to onError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "archive this floppy before formatting it" }), { status: 409 })));
    const onError = vi.fn();
    const view = mount(<FormatFloppyDialog sessionId="s1" title="t" onFormatted={vi.fn()} onCancel={vi.fn()} onError={onError} />);
    act(() => button(view.container, "Yes, format").click());
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    view.unmount();
  });
});
