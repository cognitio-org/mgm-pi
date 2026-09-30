// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RepoField } from "../src/components/RepoField.tsx";
import { NewSessionDialog } from "../src/components/NewSessionDialog.tsx";
import type { GithubCatalogSnapshot, GithubRepoSummary } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(fullName: string, account: string): GithubRepoSummary {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner: owner!,
    name: name!,
    private: false,
    description: null,
    defaultBranch: "main",
    pushedAt: null,
    htmlUrl: `https://github.com/${fullName}`,
    language: "TypeScript",
    account,
    accountType: account === "ada" ? "User" : "Organization",
  };
}

const snap: GithubCatalogSnapshot = {
  configured: true,
  truncated: false,
  accounts: [
    { login: "acme", type: "Organization" },
    { login: "ada", type: "User" },
  ],
  repos: [summary("acme/widget", "acme"), summary("ada/notes", "ada")],
};

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

function setInput(value: string) {
  const input = container!.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RepoField", () => {
  it("does not load repositories until the field is opened", async () => {
    const loadRepos = vi.fn(async () => snap);
    function Harness() {
      const [value, setValue] = useState("");
      return <RepoField id="ns-repo" value={value} onChange={setValue} loadRepos={loadRepos} />;
    }
    mount(<Harness />);
    expect(loadRepos).not.toHaveBeenCalled();
    const input = container!.querySelector("#ns-repo") as HTMLInputElement;
    await act(async () => {
      input.click();
    });
    expect(loadRepos).toHaveBeenCalledOnce();
    expect(container!.textContent).toContain("acme/widget");
    expect(container!.textContent).toContain("No repository");
  });

  it("filters, selects, offers Use without Create for an unknown owner, and creates on a connected account", async () => {
    const loadRepos = vi.fn(async () => snap);
    const createRepo = vi.fn(async () => ({ repo: summary("acme/new", "acme") }));
    const seen: string[] = [];
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <RepoField
          id="ns-repo"
          value={value}
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
          loadRepos={loadRepos}
          createRepo={createRepo}
        />
      );
    }
    mount(<Harness />);
    const input = container!.querySelector("#ns-repo") as HTMLInputElement;
    await act(async () => {
      input.click();
    });

    setInput("notes");
    expect(container!.textContent).toContain("ada/notes");
    expect(container!.textContent).not.toContain("acme/widget");
    const notes = [...container!.querySelectorAll("button")].find((button) => button.textContent === "ada/notes");
    expect(notes?.querySelector(".github-glyph-repo")).toBeTruthy();
    act(() => notes?.click());
    expect(seen.at(-1)).toBe("ada/notes");

    setInput("other/widget");
    expect(container!.textContent).toContain("Use other/widget");
    expect(container!.textContent).not.toContain("Create other/widget");

    setInput("acme/new");
    const create = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Create acme/new");
    act(() => create?.click());
    const confirm = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Create repository");
    await act(async () => {
      confirm?.click();
    });
    expect(createRepo).toHaveBeenCalledWith({ owner: "acme", name: "new", private: true });
    expect(seen.at(-1)).toBe("acme/new");
  });

  it("Enter while the menu is open selects the active repository", async () => {
    const loadRepos = vi.fn(async () => snap);
    const seen: string[] = [];
    function Harness() {
      const [value, setValue] = useState("acme/widget");
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            seen.push("submit");
          }}
        >
          <RepoField
            id="ns-repo"
            value={value}
            onChange={(next) => {
              seen.push(next);
              setValue(next);
            }}
            loadRepos={loadRepos}
          />
        </form>
      );
    }
    mount(<Harness />);
    const input = container!.querySelector("#ns-repo") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(seen).toContain("acme/widget");
    expect(seen).not.toContain("submit");
  });
});

describe("NewSessionDialog", () => {
  it("keeps the repository field and does not fetch the catalog on open", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount(<NewSessionDialog gurus={[]} onClose={() => {}} onCreated={() => {}} />);
    expect(container!.querySelector("#ns-repo")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
