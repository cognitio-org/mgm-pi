// @vitest-environment jsdom
// E9.9: the laptop approval widget: hidden with nothing to approve, a badge that opens to one card
// per ask (escaped text, clipped with "Show all"), Approve / Deny after the arm delay.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CLIP, LaptopApprovals, shortSession } from "../src/components/LaptopApprovals.tsx";
import { ARM_DELAY_MS } from "../src/components/UiRequestPanel.tsx";
import { ApiError, type LaptopApproval } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.useRealTimers();
});

const ASK: LaptopApproval = {
  id: "0b6f3c2e-0000-4000-8000-000000000001",
  op: "memory.save",
  title: "Share a memory with the team",
  facts: [
    { label: "Type", value: "semantic" },
    { label: "Label", value: "deploy" },
  ],
  summary: "<img src=x onerror=alert(1)> deploys go through tag-release.sh",
  origin: { laptopSessionId: "laptop:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", repo: "acme/widgets" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

async function render(load: () => Promise<{ approvals: LaptopApproval[] }>, decide: (id: string, approve: boolean) => Promise<unknown> = vi.fn(async () => ({}))) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<LaptopApprovals load={load} decide={decide} pollMs={60_000} />));
  return { decide, badge: () => container!.querySelector<HTMLButtonElement>(".laptop-approvals-badge") };
}

const buttons = () => [...container!.querySelectorAll<HTMLButtonElement>(".laptop-approval .composer-row button")];

describe("LaptopApprovals", () => {
  it("renders nothing with no pending asks, or when the api says this page has none (403)", async () => {
    await render(async () => ({ approvals: [] }));
    expect(container!.innerHTML).toBe("");
    act(() => root!.unmount());
    root = null;
    await render(async () => {
      throw new ApiError(403, "not with a token");
    });
    expect(container!.innerHTML).toBe("");
  });

  it("a badge with the count opens to a compact card: what, the exact text escaped, where from", async () => {
    const { badge } = await render(async () => ({ approvals: [ASK] }));
    expect(badge()!.textContent).toContain("1");
    expect(container!.querySelector(".laptop-approval")).toBeNull();
    act(() => badge()!.click());
    const card = container!.querySelector(".laptop-approval")!;
    expect(card.textContent).toContain("Outfitter asks you (not the agent)");
    expect(card.textContent).toContain("Share a memory with the team");
    expect(card.querySelector("pre")!.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
    expect([...card.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Type", "Label"]);
    expect(card.querySelector(".laptop-approval-from")!.textContent).toContain("Text from your laptop's agent");
    expect(card.textContent).toMatch(/expires in \d+ min/);
    expect(card.textContent).toContain(`laptop ${shortSession(ASK.origin.laptopSessionId)}`);
    expect(card.textContent).toContain("acme/widgets");
    expect(shortSession(ASK.origin.laptopSessionId)).toBe("0199a1b2");
  });

  it("long content is clipped, and Approve waits until it is shown in full (Deny doesn't)", async () => {
    vi.useFakeTimers();
    const long = { ...ASK, summary: `start ${"x".repeat(CLIP * 2)} end` };
    const { badge } = await render(async () => ({ approvals: [long] }));
    act(() => badge()!.click());
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    const pre = () => container!.querySelector("pre")!.textContent!;
    expect(pre().length).toBe(CLIP);
    expect(pre()).not.toContain("end");
    expect(buttons().map((b) => b.disabled)).toEqual([true, false]);
    act(() => container!.querySelector<HTMLButtonElement>(".laptop-approval-more")!.click());
    expect(pre()).toContain("end");
    expect(buttons().map((b) => b.disabled)).toEqual([false, false]);
  });

  it("expired asks are hidden; a 401 is a blip, the widget keeps polling", async () => {
    vi.useFakeTimers();
    const old = { ...ASK, expiresAt: new Date(Date.now() - 1000).toISOString() };
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(401, "sign in");
      return { approvals: [old] };
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<LaptopApprovals load={load} pollMs={1000} />));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(calls).toBeGreaterThan(1);
    expect(container!.innerHTML).toBe("");
  });

  it("Approve and Deny wake after the arm delay, call the api, and the card goes", async () => {
    vi.useFakeTimers();
    let pending = [ASK, { ...ASK, id: "0b6f3c2e-0000-4000-8000-000000000002", title: "Add a term to the team's shared glossary" }];
    const decide = vi.fn(async (id: string) => {
      pending = pending.filter((a) => a.id !== id);
      return { ok: true };
    });
    const { badge } = await render(async () => ({ approvals: pending }), decide);
    act(() => badge()!.click());
    expect(buttons().every((b) => b.disabled)).toBe(true);
    act(() => buttons()[0].click());
    expect(decide).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    await act(async () => buttons()[0].click());
    expect(decide).toHaveBeenCalledWith(ASK.id, true);
    expect(container!.querySelectorAll(".laptop-approval").length).toBe(1);
    // The next card slid up under the pointer: it re-arms, so a double click can't approve it.
    expect(buttons().every((b) => b.disabled)).toBe(true);
    await act(async () => buttons()[0].click());
    expect(decide).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    await act(async () => buttons()[1].click());
    expect(decide).toHaveBeenLastCalledWith("0b6f3c2e-0000-4000-8000-000000000002", false);
    expect(container!.innerHTML).toBe("");
  });

  it("a failed answer says why and keeps the card", async () => {
    vi.useFakeTimers();
    const decide = vi.fn(async () => {
      throw new ApiError(409, "that approval is no longer pending");
    });
    const { badge } = await render(async () => ({ approvals: [ASK] }), decide);
    act(() => badge()!.click());
    act(() => vi.advanceTimersByTime(ARM_DELAY_MS));
    await act(async () => buttons()[0].click());
    expect(container!.querySelector("[role=alert]")!.textContent).toContain("no longer pending");
    expect(container!.querySelector(".laptop-approval")).not.toBeNull();
  });
});
