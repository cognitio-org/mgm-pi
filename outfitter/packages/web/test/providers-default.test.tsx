// @vitest-environment jsdom
// #169: with GKE and Cloud Run both registered, both sandbox rows are live, and the one new runs
// launch on is tagged on the Peripherals page and in the header strip's popover.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { api, type ProviderRow } from "../src/api/client.ts";
import { ProvidersPage } from "../src/pages/ProvidersPage.tsx";
import { ProviderStrip } from "../src/components/ProviderStrip.tsx";
import { PROVIDERS_REFRESH_MS } from "../src/hooks/useProviders.ts";
import { providerLabel, sandboxWarmth, summaryStatus, worstStatus, DEFAULT_PROVIDER_TAG } from "../src/lib/providers.ts";

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

async function render(node: React.ReactNode, withRows: ProviderRow[] = rows) {
  vi.spyOn(api, "providers").mockResolvedValue(withRows);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter>{node}</MemoryRouter>));
}

describe("sandboxWarmth", () => {
  const gke = (meta: ProviderRow["meta"], status: ProviderRow["status"] = "up"): ProviderRow => ({
    id: "gke",
    kind: "gke",
    name: "GKE Agent Sandbox",
    status,
    checkedAt: "2026-09-27T10:00:00.000Z",
    meta,
  });

  it("warm launch mode with ready pool pods: warm", () => {
    expect(sandboxWarmth(gke({ launchMode: "warm", warmReady: 2, warmDesired: 2 }))).toEqual({
      mode: "warm",
      detail: "Warm: 2 of 2 ready",
    });
  });

  it("warm launch mode, pool on but nothing ready yet: warming, the next run starts cold", () => {
    expect(sandboxWarmth(gke({ launchMode: "warm", warmReady: 0, warmDesired: 2 }))?.mode).toBe("warming");
  });

  it("warm launch mode outside the pool's hours (scaled to 0): cold", () => {
    expect(sandboxWarmth(gke({ launchMode: "warm", warmReady: 0, warmDesired: 0 }))).toEqual({
      mode: "cold",
      detail: "Cold: warm pool scaled to 0",
    });
  });

  it("cold launch mode is cold whatever the pool holds", () => {
    expect(sandboxWarmth(gke({ launchMode: "cold", warmReady: 2, warmDesired: 2 }))?.detail).toBe("Cold: launch mode is cold");
  });

  it("no warm pool object is a fault in either launch mode: every claim references it", () => {
    const missing = { mode: "missing", detail: "Warm pool missing: runs can't start" };
    expect(sandboxWarmth(gke({ launchMode: "warm" }))).toEqual(missing);
    expect(sandboxWarmth(gke({ launchMode: "cold" }))).toEqual(missing);
  });

  it("pool on but readiness not reported yet reads warming", () => {
    expect(sandboxWarmth(gke({ launchMode: "warm", warmDesired: 2 }))?.mode).toBe("warming");
  });

  it("more ready than the target (a scale-down in progress) says so instead of '3 of 2'", () => {
    expect(sandboxWarmth(gke({ launchMode: "warm", warmReady: 3, warmDesired: 2 }))?.detail).toBe("Warm: 3 ready (target 2)");
  });

  it("says nothing when it can't tell: not GKE, probe down, or an older api without launchMode", () => {
    expect(sandboxWarmth(gke({ warmReady: 1, warmDesired: 1 }))).toBeNull();
    expect(sandboxWarmth(gke({ launchMode: "warm", warmReady: 1, warmDesired: 1 }, "down"))).toBeNull();
    expect(sandboxWarmth({ ...gke({ launchMode: "warm" }), kind: "cloudrun" })).toBeNull();
  });

  it("shows on the Peripherals page and in the header strip's popover", async () => {
    const warmRow = { ...rows[0]!, meta: { launchMode: "warm" as const, warmReady: 1, warmDesired: 2 } };
    await render(<ProvidersPage />, [warmRow, rows[1]!]);
    expect(container!.querySelector(".chip.warmth-warm")?.textContent).toBe("warm");
    expect(container!.textContent).toContain("Warm: 1 of 2 ready");
    act(() => root?.unmount());
    root = null;
    container?.remove();
    await render(<ProviderStrip />, [warmRow, rows[1]!]);
    expect(container!.textContent).toContain(`GKE Agent Sandbox (${DEFAULT_PROVIDER_TAG} · warm)`);
  });
});

describe("useProviders refresh (#190)", () => {
  it("the always-mounted strip re-reads providers, so a pool scaling up turns cold into warm", async () => {
    vi.useFakeTimers();
    try {
      const cold = { ...rows[0]!, meta: { launchMode: "warm" as const, warmReady: 0, warmDesired: 0 } };
      const warm = { ...rows[0]!, meta: { launchMode: "warm" as const, warmReady: 2, warmDesired: 2 } };
      const spy = vi.spyOn(api, "providers").mockResolvedValueOnce([cold]).mockResolvedValue([warm]);
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root!.render(<MemoryRouter><ProviderStrip /></MemoryRouter>));
      expect(container.textContent).toContain("· cold)");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROVIDERS_REFRESH_MS);
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("· warm)");
    } finally {
      vi.useRealTimers();
    }
  });
});

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

describe("summary pill: a non-default sandbox provider caps at degraded (#169 review)", () => {
  const cloudrunDown: ProviderRow = { ...rows[1]!, status: "down", detail: "permission denied" };

  it("summaryStatus caps only a non-default sandbox row's down", () => {
    expect(summaryStatus(cloudrunDown)).toBe("degraded");
    expect(summaryStatus({ ...rows[0]!, status: "down" })).toBe("down");
    expect(summaryStatus({ kind: "litellm", status: "down" })).toBe("down");
    expect(summaryStatus({ ...rows[1]!, status: "unknown" })).toBe("unknown");
    expect(worstStatus([rows[0]!, cloudrunDown].map(summaryStatus))).toBe("degraded");
  });

  it("Cloud Run down doesn't turn the header pill red, but its own pill still says down", async () => {
    await render(<ProviderStrip />, [rows[0]!, cloudrunDown]);
    const summary = container!.querySelector(".provider-strip-summary")!;
    expect(summary.classList.contains("degraded")).toBe(true);
    expect(summary.classList.contains("down")).toBe(false);
    const cloudrunPill = [...container!.querySelectorAll(".provider-strip-popover .status-pill")][1]!;
    expect(cloudrunPill.classList.contains("down")).toBe(true);
  });

  it("the default provider down still turns it red", async () => {
    await render(<ProviderStrip />, [{ ...rows[0]!, status: "down" }, rows[1]!]);
    expect(container!.querySelector(".provider-strip-summary")!.classList.contains("down")).toBe(true);
  });
});
