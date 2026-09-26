// @vitest-environment jsdom
// #169: with GKE and Cloud Run both registered, both sandbox rows are live, and the one new runs
// launch on is tagged on the Peripherals page and in the header strip's popover.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { api, type ProviderRow } from "../src/api/client.ts";
import { ProvidersPage } from "../src/pages/ProvidersPage.tsx";
import { ProviderStrip, providerLabel, DEFAULT_PROVIDER_TAG } from "../src/components/ProviderStrip.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

const rows: ProviderRow[] = [
  { id: "gke", kind: "gke", name: "GKE Agent Sandbox", status: "up", checkedAt: "2026-09-26T10:00:00.000Z", isDefault: true },
  { id: "cloudrun", kind: "cloudrun", name: "Cloud Run agent job", status: "up", checkedAt: "2026-09-26T10:00:00.000Z" },
];

async function render(node: React.ReactNode) {
  vi.spyOn(api, "providers").mockResolvedValue(rows);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter>{node}</MemoryRouter>));
}

describe("default sandbox provider marker", () => {
  it("providerLabel tags only the default", () => {
    expect(providerLabel(rows[0]!)).toBe(`GKE Agent Sandbox (${DEFAULT_PROVIDER_TAG})`);
    expect(providerLabel(rows[1]!)).toBe("Cloud Run agent job");
  });

  it("the Peripherals page tags the default provider's row and not the other one", async () => {
    await render(<ProvidersPage />);
    const nameCells = [...container!.querySelectorAll<HTMLTableCellElement>('td[data-label="Name"]')];
    expect(nameCells).toHaveLength(2);
    expect(nameCells[0]!.querySelector(".chip")?.textContent).toBe(DEFAULT_PROVIDER_TAG);
    expect(nameCells[1]!.querySelector(".chip")).toBeNull();
    expect(nameCells[1]!.textContent).toBe("Cloud Run agent job");
  });

  it("the header strip's popover labels the default", async () => {
    await render(<ProviderStrip />);
    const pills = [...container!.querySelectorAll(".provider-strip-popover .status-pill")].map((p) => p.textContent);
    expect(pills).toEqual([`GKE Agent Sandbox (${DEFAULT_PROVIDER_TAG})`, "Cloud Run agent job"]);
  });
});
