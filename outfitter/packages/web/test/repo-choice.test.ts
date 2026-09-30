import { describe, expect, it } from "vitest";
import type { GithubAccount, GithubRepoSummary } from "../src/api/client.ts";
import { normalizeRepoInput, repoMenu } from "../src/lib/repo-choice.ts";

function repo(fullName: string): GithubRepoSummary {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner: owner!,
    name: name!,
    private: true,
    description: null,
    defaultBranch: "main",
    pushedAt: null,
    htmlUrl: `https://github.com/${fullName}`,
    language: null,
    account: owner!,
    accountType: "Organization",
  };
}

const acme: GithubAccount = { login: "acme", type: "Organization" };
const ada: GithubAccount = { login: "ada", type: "User" };

describe("normalizeRepoInput", () => {
  it("keeps owner/repo and strips a pasted GitHub URL or SSH form", () => {
    expect(normalizeRepoInput("  acme/widget  ")).toBe("acme/widget");
    expect(normalizeRepoInput("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(normalizeRepoInput("https://www.github.com/acme/widget")).toBe("acme/widget");
    expect(normalizeRepoInput("git@github.com:acme/widget.git")).toBe("acme/widget");
  });
});

describe("repoMenu", () => {
  const repos = [repo("ada/notes"), repo("acme/widget")];

  it("offers no repository and the recent list when the query is empty", () => {
    const items = repoMenu("", repos, [acme, ada]);
    expect(items[0]).toEqual({ kind: "none", label: "No repository", value: "" });
    expect(items.slice(1).map((item) => item.value)).toEqual(["ada/notes", "acme/widget"]);
  });

  it("caps the empty list at 50 repositories", () => {
    const many = Array.from({ length: 60 }, (_, i) => repo(`acme/r${i}`));
    expect(repoMenu("", many, [acme])).toHaveLength(51);
  });

  it("filters by name and does not add use or create for an exact listed repository", () => {
    const items = repoMenu("acme/widget", repos, [acme, ada]);
    expect(items.map((item) => item.kind)).toEqual(["repo"]);
  });

  it("offers use for an unlisted name, and create when that owner is an installation", () => {
    const other = repoMenu("other/widget", repos, [acme, ada]);
    expect(other.map((item) => item.kind)).toEqual(["use"]);
    const created = repoMenu("ACME/new", repos, [acme, ada]);
    expect(created.map((item) => item.label)).toEqual(["Use ACME/new", "Create acme/new"]);
    const user = repoMenu("ada/scratch", repos, [acme, ada]);
    expect(user.map((item) => item.kind)).toEqual(["use", "create"]);
  });

  it("treats a pasted URL as owner/repo", () => {
    const items = repoMenu("https://github.com/other/repo.git", repos, [acme]);
    expect(items.map((item) => item.label)).toEqual(["Use other/repo"]);
  });
});
