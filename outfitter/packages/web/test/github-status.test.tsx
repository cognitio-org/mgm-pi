// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GithubStatus, GithubStatusView } from "../src/components/GithubStatus.tsx";
import type { GithubSessionStatus } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function status(overrides: Partial<GithubSessionStatus> = {}): GithubSessionStatus {
  return {
    connected: true,
    repo: "acme/widget",
    branch: "outfitter/abc",
    baseBranch: "main",
    pulls: [
      { number: 9, title: "This branch", url: "https://github.com/acme/widget/pull/9", draft: false, author: "ada", updatedAt: null, head: "outfitter/abc", base: "main", additions: 3, deletions: 1 },
      { number: 4, title: "Other", url: "https://github.com/acme/widget/pull/4", draft: true, author: "ada", updatedAt: null, head: "other", base: "main", additions: null, deletions: null },
      { number: 5, title: "Third", url: "https://github.com/acme/widget/pull/5", draft: false, author: null, updatedAt: null, head: "third", base: "main", additions: null, deletions: null },
      { number: 6, title: "Fourth", url: "https://github.com/acme/widget/pull/6", draft: false, author: null, updatedAt: null, head: "fourth", base: "main", additions: null, deletions: null },
    ],
    branchPull: { number: 9, title: "This branch", url: "https://github.com/acme/widget/pull/9", draft: false, author: "ada", updatedAt: null, head: "outfitter/abc", base: "main", additions: 3, deletions: 1 },
    diff: { additions: 3, deletions: 1, source: "pull" },
    ...overrides,
  };
}

describe("GithubStatusView", () => {
  it("shows the branch, three pull requests, the rest, and the line counts", () => {
    mount(<GithubStatusView status={status()} />);
    const cluster = container!.querySelector(".github-status");
    expect(cluster?.getAttribute("aria-label")).toBe("GitHub status");
    expect(container!.querySelector(".github-status-branch")?.textContent).toBe("outfitter/abc");
    expect(container!.textContent).toContain("#9");
    expect(container!.textContent).toContain("#4");
    expect(container!.textContent).toContain("#5");
    expect(container!.textContent).not.toContain("#6");
    expect(container!.querySelector(".github-status-more")?.textContent).toBe("+1");
    expect(container!.querySelector(".github-status-more")?.getAttribute("title")).toContain("#6 Fourth");
    expect(container!.querySelector("a")?.getAttribute("title")).toContain("this branch");
    expect(container!.querySelector(".github-status-add")?.textContent).toBe("+3");
    expect(container!.querySelector(".github-status-del")?.textContent).toBe("−1");
    expect(container!.textContent).not.toContain("acme/widget");
    expect(container!.querySelector(".github-status-branch .github-glyph-branch")).toBeTruthy();
    expect(container!.querySelector("a")?.classList.contains("is-branch")).toBe(true);
    expect(container!.querySelector("a.is-draft")?.textContent).toContain("#4");
    expect(container!.querySelector("a.is-draft")?.textContent).toContain("draft");
  });

  it("renders nothing when the App cannot see the repository", () => {
    mount(<GithubStatusView status={status({ connected: false, reason: "not-installed", pulls: [], branchPull: null, diff: null })} />);
    expect(container!.querySelector(".github-status")).toBeNull();
  });
});

describe("GithubStatus", () => {
  it("hides itself when the status says the App is not connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ connected: false, reason: "not-installed", repo: "acme/widget", branch: "main", baseBranch: "main", pulls: [], branchPull: null, diff: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    await act(async () => {
      mount(<GithubStatus sessionId="s1" repo="acme/widget" />);
    });
    await act(async () => {});
    expect(container!.querySelector(".github-status")).toBeNull();
  });
});
