// @vitest-environment jsdom
// #257: voice spend on screen: the formatters, your figures (compact in the mic's menu, a table on
// the Tokens page) and sysops' per-person month.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { formatMinutes, formatUsd } from "../src/lib/voice-spend.ts";
import { ProjectVoiceSpendView, VoiceSpendView } from "../src/components/VoiceSpend.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

function answer(path: string, body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(path);
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
  return host;
}

const fig = (minutes: number, usd: number) => ({ minutes, ttsCharacters: 0, usd });

describe("formatters", () => {
  it("never shows a real cost as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.006)).toBe("$0.01");
    expect(formatUsd(2.5)).toBe("$2.50");
  });
  it("minutes, then hours", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(0.4)).toBe("<1 min");
    expect(formatMinutes(42.4)).toBe("42 min");
    expect(formatMinutes(150)).toBe("2.5 h");
  });
});

describe("VoiceSpendView", () => {
  const spend = { available: true, currency: "USD", today: fig(2, 0.0154), week: fig(10, 0.077), month: fig(60, 0.462), asOf: "x" };

  it("compact: one line for the mic's menu, with the cap when there is one", async () => {
    answer("/api/me/voice/spend", { ...spend, capUsd: 5 });
    const el = await render(<VoiceSpendView compact />);
    expect(el.textContent).toBe("$0.02 today · $0.08 week · $0.46 month of $5.00 cap");
  });

  it("full: today, this week and this month with audio minutes", async () => {
    answer("/api/me/voice/spend", spend);
    const el = await render(<VoiceSpendView />);
    const rows = Array.from(el.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.children).map((td) => td.textContent));
    expect(rows).toEqual([
      ["Today", "2 min", "$0.02"],
      ["This week", "10 min", "$0.08"],
      ["This month", "60 min", "$0.46"],
    ]);
  });

  it("not set up: nothing in the menu, a note on the page", async () => {
    answer("/api/me/voice/spend", { available: false });
    expect((await render(<VoiceSpendView compact />)).textContent).toBe("");
    act(() => root!.unmount());
    answer("/api/me/voice/spend", { available: false });
    expect((await render(<VoiceSpendView />)).textContent).toMatch(/isn't set up/);
  });

  it("says so when Deepgram's usage can't be read", async () => {
    answer("/api/me/voice/spend", { error: "voice_usage_upstream" }, 502);
    expect((await render(<VoiceSpendView />)).textContent).toMatch(/Couldn't read/);
  });
});

describe("ProjectVoiceSpendView", () => {
  it("lists each person, the untagged laptop use and the total", async () => {
    answer("/api/operator/voice/spend", {
      available: true,
      currency: "USD",
      users: [
        { tag: "outfitter-user-aaaa", email: "alice@example.com", ...fig(90, 0.693) },
        { tag: "outfitter-user-bbbb", ...fig(5, 0.0385) },
      ],
      untagged: fig(30, 0.231),
      total: fig(125, 0.9625),
      asOf: "x",
      rates: { sttUsdPerMinute: 0.0077, ttsUsdPer1kChars: 0.03 },
    });
    const el = await render(<ProjectVoiceSpendView />);
    const rows = Array.from(el.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.children).map((td) => td.textContent));
    expect(rows).toEqual([
      ["alice@example.com", "90 min", "$0.69"],
      ["outfitter-user-bbbb", "5 min", "$0.04"],
      ["Laptop (kernal, untagged)", "30 min", "$0.23"],
      ["Total", "2.1 h", "$0.96"],
    ]);
    expect(el.textContent).toMatch(/\$0\.0077\/min/);
  });
});
