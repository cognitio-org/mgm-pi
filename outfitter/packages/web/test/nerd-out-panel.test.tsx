// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NerdOutPanel } from "../src/components/NerdOutPanel.tsx";
import { CATCH_UP_PAGES, FOLLOW_MS, LogViewerDialog } from "../src/components/LogViewerDialog.tsx";
import type { SandboxDetail, SandboxLogLine } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = "11111111-2222-4333-8444-555555555555";
const OLD_RUN = "99999999-2222-4333-8444-555555555555";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let calls: string[] = [];
let routes: Record<string, () => { status: number; body: unknown }> = {};

function respond(path: string): Response {
  calls.push(path);
  const key = Object.keys(routes)
    .sort((a, b) => b.length - a.length)
    .find((k) => path.startsWith(k));
  const r = key ? routes[key]!() : { status: 404, body: { error: "not found" } };
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(String(input))));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  await flush();
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
}

function detail(over: Partial<SandboxDetail> = {}): SandboxDetail {
  return {
    run: { id: RUN, state: "running", provider: "gke", createdAt: "2026-09-27T05:00:00Z", lastSeenAt: "2026-09-27T05:10:00Z" },
    memory: { lastMb: 3500, peakMb: 3800, limitMb: 4096 },
    live: {
      name: "outfitter-pod-abc",
      node: "gk3-node-1",
      image: "europe-docker.pkg.dev/p/r/outfitter-agent@sha256:0123456789abcdef0123",
      phase: "Running",
      resources: { cpu: "2", memory: "4Gi", ephemeralStorage: "10Gi" },
    },
    runs: [
      { id: RUN, state: "running", createdAt: "2026-09-27T05:00:00Z" },
      { id: OLD_RUN, state: "failed", createdAt: "2026-09-26T05:00:00Z" },
    ],
    ...over,
  };
}

const lines = (msgs: string[], start = 0): SandboxLogLine[] =>
  msgs.map((message, i) => ({ time: new Date(Date.UTC(2026, 8, 27, 5, 0, start + i)).toISOString(), severity: "INFO", message }));

describe("NerdOutPanel", () => {
  it("shows the drive, live memory and history, and fetches no logs until asked", async () => {
    routes[`/api/sessions/s1/sandbox`] = () => ({ status: 200, body: detail() });
    routes[`/api/sessions/s1/sandbox/metrics`] = () => ({
      status: 200,
      body: {
        runId: RUN,
        podName: "outfitter-pod-abc",
        series: {
          memoryMb: [["2026-09-27T05:00:00Z", 1000], ["2026-09-27T05:01:00Z", 3500]],
          cpuCores: [["2026-09-27T05:00:00Z", 0.5]],
          diskMb: [],
        },
      },
    });
    await mount(<NerdOutPanel sessionId="s1" runState="running" startup={null} onClose={() => {}} />);

    const text = container!.textContent ?? "";
    expect(text).toContain("outfitter-pod-abc");
    expect(text).toContain("gk3-node-1");
    expect(text).toContain("outfitter-agent@0123456789ab");
    expect(text).toContain("2 cpu · 4Gi mem · 10Gi disk");
    expect(text).toContain("3.4 GiB");
    const meter = container!.querySelector('[role="meter"]')!;
    expect(meter.getAttribute("aria-valuenow")).toBe("85");
    expect(meter.className).toContain("meter-warn");
    expect(container!.querySelectorAll(".strip-chart")).toHaveLength(3);
    expect(container!.querySelector(".strip-chart-limit")).not.toBeNull();
    expect(calls.some((c) => c.includes("/sandbox/logs"))).toBe(false);
    expect(calls).toContain(`/api/sessions/s1/sandbox/metrics?runId=${RUN}`);

    const view = [...container!.querySelectorAll("button")].find((b) => b.textContent === "View logs")!;
    routes[`/api/sessions/s1/sandbox/logs`] = () => ({ status: 200, body: { runId: RUN, untrusted: true, lines: lines(["hello"]) } });
    await act(async () => view.click());
    await flush();
    expect(calls).toContain(`/api/sessions/s1/sandbox/logs?runId=${RUN}`);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("hello");
  });

  it("says why history is missing: Cloud Run, and access not granted", async () => {
    routes[`/api/sessions/s1/sandbox`] = () => ({
      status: 200,
      body: detail({ run: { id: RUN, state: "stopped", provider: "cloudrun", createdAt: "2026-09-27T05:00:00Z" }, live: undefined }),
    });
    await mount(<NerdOutPanel sessionId="s1" runState="stopped" startup={null} onClose={() => {}} />);
    expect(container!.textContent).toContain("GKE drives only");
    expect(calls.some((c) => c.includes("/metrics"))).toBe(false);

    act(() => root!.unmount());
    routes[`/api/sessions/s1/sandbox`] = () => ({ status: 200, body: detail() });
    routes[`/api/sessions/s1/sandbox/metrics`] = () => ({ status: 503, body: { error: "forbidden", unavailable: "forbidden" } });
    await mount(<NerdOutPanel sessionId="s1" runState="running" startup={null} onClose={() => {}} />);
    expect(container!.textContent).toContain("access isn't granted yet");
  });

  it("shows how a run ended, and switches runs with the picker", async () => {
    routes[`/api/sessions/s1/sandbox?runId=${OLD_RUN}`] = () => ({
      status: 200,
      body: detail({
        run: { id: OLD_RUN, state: "failed", provider: "gke", createdAt: "2026-09-26T05:00:00Z", reason: "out of memory" },
        exit: { reason: "OOMKilled", exitCode: 137 },
        live: undefined,
      }),
    });
    routes[`/api/sessions/s1/sandbox`] = () => ({ status: 200, body: detail() });
    routes[`/api/sessions/s1/sandbox/metrics`] = () => ({ status: 200, body: { runId: RUN, series: { memoryMb: [], cpuCores: [], diskMb: [] } } });
    await mount(<NerdOutPanel sessionId="s1" runState="running" startup={null} onClose={() => {}} />);
    const picker = container!.querySelector<HTMLSelectElement>(".nerd-out-run-picker")!;
    expect(picker.options).toHaveLength(3);
    expect(picker.value).toBe("");
    await act(async () => {
      picker.value = OLD_RUN;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const ended = container!.querySelector(".spec-row dd.is-danger");
    expect(ended?.textContent).toBe("OOMKilled · exit 137");
    expect(container!.textContent).toContain("out of memory");

    // Back to "Latest run": follows the latest again, no id pinned.
    calls = [];
    await act(async () => {
      picker.value = "";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(calls).toContain("/api/sessions/s1/sandbox");
  });

  it("keeps the charts when the run ends", async () => {
    let state = "running";
    let metricsCalls = 0;
    routes[`/api/sessions/s1/sandbox`] = () => ({
      status: 200,
      body: detail({ run: { id: RUN, state, provider: "gke", createdAt: "2026-09-27T05:00:00Z" } }),
    });
    routes[`/api/sessions/s1/sandbox/metrics`] = () => {
      metricsCalls++;
      return metricsCalls === 1
        ? { status: 200, body: { runId: RUN, podName: "p", series: { memoryMb: [["2026-09-27T05:00:00Z", 4000]], cpuCores: [], diskMb: [] } } }
        : { status: 502, body: { error: "failed" } };
    };
    await mount(<NerdOutPanel sessionId="s1" runState="running" startup={null} onClose={() => {}} />);
    expect(container!.querySelectorAll(".strip-chart")).toHaveLength(3);
    state = "failed";
    await act(async () => root!.render(<NerdOutPanel sessionId="s1" runState="failed" startup={null} onClose={() => {}} />));
    await flush();
    expect(metricsCalls).toBe(2);
    expect(container!.querySelectorAll(".strip-chart")).toHaveLength(3);
  });

  it("says there's no run yet for a session that never ran", async () => {
    routes[`/api/sessions/s1/sandbox`] = () => ({ status: 404, body: { error: "this session has no run yet" } });
    await mount(<NerdOutPanel sessionId="s1" runState={undefined} startup={null} onClose={() => {}} />);
    expect(container!.textContent).toContain("No run yet");
  });
});

describe("LogViewerDialog", () => {
  it("renders lines as plain text with the untrusted note, and pages back", async () => {
    routes[`/api/sessions/s1/sandbox/logs?runId=${RUN}&pageToken=older`] = () => ({
      status: 200,
      body: { runId: RUN, untrusted: true, lines: lines(["first"], 0) },
    });
    routes[`/api/sessions/s1/sandbox/logs?runId=${RUN}`] = () => ({
      status: 200,
      body: { runId: RUN, untrusted: true, lines: lines(['<img src=x onerror="alert(1)">', "second"], 10), nextPageToken: "older" },
    });
    await mount(<LogViewerDialog sessionId="s1" runId={RUN} live={false} onClose={() => {}} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("aren't verified");
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror="alert(1)">');

    const earlier = dialog.querySelector<HTMLButtonElement>(".log-viewer-earlier")!;
    await act(async () => earlier.click());
    await flush();
    expect([...dialog.querySelectorAll(".log-msg")].map((n) => n.textContent)).toEqual([
      "first",
      '<img src=x onerror="alert(1)">',
      "second",
    ]);
    expect(dialog.textContent).toContain("start of the run's log");
    expect(dialog.querySelector(".log-viewer-earlier")).toBeNull();
  });

  it("filters by level and text", async () => {
    routes[`/api/sessions/s1/sandbox/logs`] = () => ({
      status: 200,
      body: {
        runId: RUN,
        untrusted: true,
        lines: [
          { time: "2026-09-27T05:00:00Z", severity: "INFO", message: "boot" },
          { time: "2026-09-27T05:00:01Z", severity: "ERROR", message: "pi crashed" },
        ],
      },
    });
    await mount(<LogViewerDialog sessionId="s1" runId={RUN} live={false} onClose={() => {}} />);
    const errBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Err")!;
    await act(async () => errBtn.click());
    expect([...document.querySelectorAll(".log-msg")].map((n) => n.textContent)).toEqual(["pi crashed"]);
    expect(document.querySelector(".log-viewer-status")?.textContent).toContain("1 of 2 lines");
  });

  it("follows a live run by re-reading the newest page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let page = lines(["one"]);
    routes[`/api/sessions/s1/sandbox/logs`] = () => ({ status: 200, body: { runId: RUN, untrusted: true, lines: page } });
    await mount(<LogViewerDialog sessionId="s1" runId={RUN} live onClose={() => {}} />);
    expect(document.querySelectorAll(".log-msg")).toHaveLength(1);
    page = lines(["one", "two"]);
    await act(async () => {
      vi.advanceTimersByTime(FOLLOW_MS);
    });
    await flush();
    expect([...document.querySelectorAll(".log-msg")].map((n) => n.textContent)).toEqual(["one", "two"]);
  });

  it("catches up across a burst, and marks a hole it can't fill", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let newest: { lines: SandboxLogLine[]; nextPageToken?: string } = { lines: lines(["one"], 0) };
    const older: Record<string, { lines: SandboxLogLine[]; nextPageToken?: string }> = {};
    routes[`/api/sessions/s1/sandbox/logs?runId=${RUN}&pageToken=`] = () => {
      const token = decodeURIComponent(calls[calls.length - 1]!.split("pageToken=")[1]!);
      return { status: 200, body: { runId: RUN, untrusted: true, ...older[token]! } };
    };
    routes[`/api/sessions/s1/sandbox/logs?runId=${RUN}`] = () => ({ status: 200, body: { runId: RUN, untrusted: true, ...newest } });
    await mount(<LogViewerDialog sessionId="s1" runId={RUN} live onClose={() => {}} />);

    // Two pages arrive: the newest doesn't reach "one", the next page back does.
    newest = { lines: lines(["four", "five"], 40), nextPageToken: "p2" };
    older.p2 = { lines: lines(["two", "three"], 20), nextPageToken: "p3" };
    older.p3 = { lines: lines(["one"], 0) };
    await act(async () => {
      vi.advanceTimersByTime(FOLLOW_MS);
    });
    await flush();
    expect([...document.querySelectorAll(".log-msg")].map((n) => n.textContent)).toEqual(["one", "two", "three", "four", "five"]);
    expect(document.querySelector(".log-viewer-earlier")).toBeNull();

    // A burst longer than CATCH_UP_PAGES: the hole is said, not hidden.
    newest = { lines: lines(["z"], 900), nextPageToken: "q1" };
    for (let i = 1; i <= CATCH_UP_PAGES; i++) older[`q${i}`] = { lines: lines([`q${i}`], 900 - i * 10), nextPageToken: `q${i + 1}` };
    await act(async () => {
      vi.advanceTimersByTime(FOLLOW_MS);
    });
    await flush();
    expect(document.querySelector(".log-viewer-status")?.textContent).toMatch(/were skipped/);
  });

  it("doesn't close when a selection is dragged out onto the backdrop", async () => {
    routes[`/api/sessions/s1/sandbox/logs`] = () => ({ status: 200, body: { runId: RUN, untrusted: true, lines: lines(["one"]) } });
    const onClose = vi.fn();
    await mount(<LogViewerDialog sessionId="s1" runId={RUN} live={false} onClose={onClose} />);
    const backdrop = document.querySelector<HTMLElement>(".log-viewer-backdrop")!;
    const msg = document.querySelector<HTMLElement>(".log-msg")!;
    act(() => {
      msg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("explains a 503 and closes on Escape", async () => {
    routes[`/api/sessions/s1/sandbox/logs`] = () => ({ status: 503, body: { error: "forbidden", unavailable: "forbidden" } });
    const onClose = vi.fn();
    await mount(<LogViewerDialog sessionId="s1" runId={RUN} live={false} onClose={onClose} />);
    expect(document.querySelector(".log-viewer-error")?.textContent).toContain("access isn't granted yet");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
