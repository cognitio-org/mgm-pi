// @vitest-environment jsdom
// The version indicator's hook: the page's own version, and "updated" when a later check differs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppVersion, versionLabel } from "../src/hooks/useAppVersion.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let seen: ReturnType<typeof useAppVersion> | null = null;

function Probe() {
  seen = useAppVersion();
  return null;
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  seen = null;
  vi.unstubAllGlobals();
});

describe("useAppVersion", () => {
  it("keeps the first answer as the page's version and flags a later, different commit as an update", async () => {
    const answers = [
      { commit: "aaaaaaaaaaaa", release: "outfitter-v2026.09.27.9" },
      { commit: "aaaaaaaaaaaa", release: "outfitter-v2026.09.27.9" },
      { commit: "bbbbbbbbbbbb", release: "outfitter-v2026.09.28.1" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answers.shift() ?? { commit: "bbbbbbbbbbbb", release: null }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(<Probe />));
    await flush();
    expect(seen!.version?.release).toBe("outfitter-v2026.09.27.9");
    expect(seen!.updated).toBeNull();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(seen!.updated).toBeNull();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(seen!.updated?.commit).toBe("bbbbbbbbbbbb");
    expect(seen!.version?.commit).toBe("aaaaaaaaaaaa");
  });

  it("labels a release by its date and number, else the short commit, else nothing", () => {
    expect(versionLabel({ commit: "34d84792da6a", release: "outfitter-v2026.09.27.9" })).toBe("2026.09.27.9");
    expect(versionLabel({ commit: "34d84792da6ad473b00b", release: null })).toBe("34d84792da6a");
    expect(versionLabel({ commit: null, release: null })).toBeNull();
    expect(versionLabel(null)).toBeNull();
  });
});
