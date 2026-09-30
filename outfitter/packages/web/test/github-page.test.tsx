// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GithubPage } from "../src/pages/GithubPage.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function summary(name: string) {
  return {
    fullName: `acme/${name}`,
    owner: "acme",
    name,
    private: true,
    description: "A widget",
    defaultBranch: "main",
    pushedAt: "2026-09-23T00:00:00Z",
    htmlUrl: `https://github.com/acme/${name}`,
    language: "TypeScript",
    account: "acme",
    accountType: "Organization",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<GithubPage />));
  await act(async () => {});
}

describe("GithubPage", () => {
  it("lists repositories and shows an open pull request after one is chosen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/github/repos/acme/widget")) {
          return json({
            ...summary("widget"),
            openPulls: [
              {
                number: 7,
                title: "Fix the widget",
                url: "https://github.com/acme/widget/pull/7",
                draft: false,
                author: "ada",
                updatedAt: null,
                head: "fix",
                base: "main",
                additions: 10,
                deletions: 2,
              },
            ],
            lastCommit: {
              sha: "abcdef1",
              url: "https://github.com/acme/widget/commit/abcdef1",
              message: "First line",
              author: "ada",
              date: "2026-09-20T00:00:00Z",
            },
            contributions: { weeks: [0, 2, 4] },
          });
        }
        return json({
          configured: true,
          truncated: false,
          accounts: [{ login: "acme", type: "Organization" }],
          repos: [summary("widget"), summary("other")],
        });
      }),
    );
    await render();
    expect(container!.textContent).toContain("widget");
    expect(container!.textContent).toContain("other");
    expect(container!.textContent).toContain("private");
    const button = [...container!.querySelectorAll("button")].find((el) => el.textContent?.includes("widget"));
    await act(async () => {
      button?.click();
    });
    await act(async () => {});
    expect(container!.textContent).toContain("Fix the widget");
    expect(container!.textContent).toContain("First line");
    expect(container!.querySelector("button.is-selected")?.textContent).toContain("widget");
    expect(container!.querySelector(".github-weeks span.is-now")).toBeTruthy();
  });

  it("explains when the GitHub App is not set up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ configured: false, reason: "not-configured", truncated: false, accounts: [], repos: [] })),
    );
    await render();
    expect(container!.textContent).toContain("The GitHub App isn't set up.");
  });
});
