// The browser's view of repositories the GitHub App can reach. Scripted fetch: no network.
// A Drive's token is a different class (github-app.ts) and is not minted here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GithubCatalog, type GithubCatalogSnapshot } from "../src/github-catalog.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const NOW = Date.parse("2026-09-24T04:00:00Z");
const EXPIRES = "2026-09-24T05:00:00Z";

interface Call {
  url: string;
  method: string;
  body?: { name?: string; private?: boolean; auto_init?: boolean; permissions?: Record<string, string>; repositories?: string[] };
  auth: string;
}

const appRead = async (name: string) => (name.includes("private-key") ? pem : "12345");

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function token(value: string, fullName?: string): Response {
  return json(
    {
      token: value,
      expires_at: EXPIRES,
      ...(fullName ? { repositories: [{ full_name: fullName }] } : {}),
    },
    201,
  );
}

function installation(id: number, login: string, type: "Organization" | "User", suspended = false) {
  return { id, suspended_at: suspended ? "2026-01-01T00:00:00Z" : null, account: { login, type } };
}

function repo(fullName: string, pushed: string | null, extra: Record<string, unknown> = {}) {
  return {
    full_name: fullName,
    private: true,
    description: "A widget",
    default_branch: "main",
    pushed_at: pushed,
    html_url: `https://github.com/${fullName}`,
    language: "TypeScript",
    ...extra,
  };
}

function harness(read: (name: string) => Promise<string>, on: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined,
      auth: headers?.Authorization ?? "",
    };
    calls.push(call);
    return on(call);
  }) as typeof fetch;
  return { calls, catalog: new GithubCatalog(read, fetchImpl, () => NOW) };
}

function listHandler(call: Call): Response {
  // Token URLs live under /app/installations/:id/access_tokens, so they have to be matched
  // before the installation list.
  if (call.url.endsWith("/access_tokens")) {
    const id = call.url.split("/").at(-2);
    return token(id === "1" ? "ghs_CATALOGTOKEN" : "ghs_ADA");
  }
  if (call.url.startsWith("https://api.github.com/app/installations")) {
    return json([
      installation(2, "ada", "User"),
      installation(1, "acme", "Organization"),
      installation(3, "gone", "Organization", true),
      { id: 4, account: { login: "bad name", type: "Organization" } },
      { id: 5, account: { login: "bot", type: "Bot" } },
    ]);
  }
  if (call.url.startsWith("https://api.github.com/installation/repositories")) {
    if (call.auth.includes("ghs_CATALOGTOKEN")) {
      return json({
        repositories: [
          repo("acme/widget", "2026-09-01T00:00:00Z"),
          repo("acme/has space", "2026-09-02T00:00:00Z"),
          repo("acme/ends.git", "2026-09-03T00:00:00Z"),
          repo("acme/../nope", "2026-09-04T00:00:00Z"),
        ],
      });
    }
    return json({ repositories: [repo("ada/notes", "2026-09-23T00:00:00Z")] });
  }
  return new Response("unexpected " + call.url, { status: 500 });
}

function pull(number: number, head: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull ${number}`,
    html_url: `https://github.com/acme/widget/pull/${number}`,
    draft: number === 4,
    user: { login: "ada" },
    updated_at: "2026-09-23T01:00:00Z",
    head: { ref: head, repo: { full_name: "acme/widget" } },
    base: { ref: "main" },
    ...extra,
  };
}

test("list sorts repositories, drops ones the App should not show, and hides the token", async () => {
  const { catalog, calls } = harness(appRead, listHandler);
  const snapshot = await catalog.list();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.reason, undefined);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.accounts, [
    { login: "acme", type: "Organization" },
    { login: "ada", type: "User" },
  ]);
  assert.deepEqual(
    snapshot.repos.map((row) => row.fullName),
    ["ada/notes", "acme/widget"],
  );
  assert.equal(snapshot.repos[1]?.private, true);
  assert.equal(snapshot.repos[1]?.language, "TypeScript");
  const wire = JSON.stringify(snapshot);
  assert.equal(wire.includes("ghs_CATALOGTOKEN"), false);
  assert.equal(wire.includes("ghs_ADA"), false);
  assert.equal(wire.includes("installation"), false);
  const listMints = calls.filter((call) => call.url.endsWith("/access_tokens"));
  assert.equal(listMints.length, 2);
  for (const mint of listMints) {
    assert.deepEqual(mint.body?.permissions, { metadata: "read" });
    assert.equal(mint.body?.repositories, undefined);
    assert.equal(mint.auth.includes(pem), false);
  }
});

test("list follows GitHub's next link and stops at the page cap", async () => {
  let installPages = 0;
  let repoPages = 0;
  const { catalog } = harness(appRead, (call) => {
    if (call.url.endsWith("/access_tokens")) return token("ghs_PAGE");
    if (call.url.startsWith("https://api.github.com/app/installations")) {
      installPages += 1;
      const next = `https://api.github.com/app/installations?page=${installPages + 1}`;
      return json([installation(installPages, `org${installPages}`, "Organization")], 200, {
        link: `<${next}>; rel="next"`,
      });
    }
    if (call.url.startsWith("https://api.github.com/installation/repositories")) {
      repoPages += 1;
      if (repoPages === 1) {
        return json({ repositories: [repo("org1/one", "2026-09-02T00:00:00Z")] }, 200, {
          link: `<https://api.github.com/installation/repositories?page=2>; rel="next"`,
        });
      }
      return json({ repositories: [repo("org1/two", "2026-09-01T00:00:00Z")] });
    }
    return new Response("no", { status: 500 });
  });
  const snapshot = await catalog.list();
  assert.equal(installPages, 10);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.accounts.length, 10);
  assert.ok(snapshot.repos.some((row) => row.fullName === "org1/one"));
  assert.ok(snapshot.repos.some((row) => row.fullName === "org1/two"));
});

test("a warm list is reused until fresh is asked for", async () => {
  let installs = 0;
  const { catalog } = harness(appRead, (call) => {
    if (call.url.endsWith("/access_tokens")) return token("ghs_CATALOGTOKEN");
    if (call.url.startsWith("https://api.github.com/app/installations")) {
      installs += 1;
      return json([installation(1, "acme", "Organization")]);
    }
    if (call.url.startsWith("https://api.github.com/installation/repositories")) {
      return json({ repositories: [repo("acme/widget", "2026-09-01T00:00:00Z")] });
    }
    return new Response("no", { status: 500 });
  });
  await catalog.list();
  await catalog.list();
  assert.equal(installs, 1);
  await catalog.list({ fresh: true });
  assert.equal(installs, 2);
});

test("missing and unusable App secrets do not call GitHub", async () => {
  const empty = harness(async () => "", () => {
    throw new Error("should not fetch");
  });
  const missing = await empty.catalog.list();
  assert.deepEqual(missing, { configured: false, reason: "not-configured", truncated: false, accounts: [], repos: [] });

  const bad = harness(async (name) => (name.includes("private-key") ? "not a key" : "12345"), () => {
    throw new Error("should not fetch");
  });
  const misconfigured = await bad.catalog.list();
  assert.equal(misconfigured.reason, "misconfigured");

  let reads = 0;
  const down = harness(
    async () => {
      reads += 1;
      throw new Error("secret manager down");
    },
    () => {
      throw new Error("should not fetch");
    },
  );
  const unavailable = await down.catalog.list();
  assert.equal(unavailable.reason, "unavailable");
  const again = await down.catalog.list();
  assert.equal(again.reason, "unavailable");
  assert.equal(reads, 2); // id and key, once; the second list is the failure cache
});

test("create posts a private repository on the organization and drops the list cache", async () => {
  let created: Call["body"] | undefined;
  let installs = 0;
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url.endsWith("/access_tokens") && call.body?.permissions?.administration === "write") {
      assert.equal(call.body.repositories, undefined);
      assert.equal(call.body.permissions.metadata, "read");
      return token("ghs_CREATE");
    }
    if (call.method === "POST" && call.url === "https://api.github.com/orgs/acme/repos") {
      created = call.body;
      return json(repo("acme/widget", "2026-09-24T00:00:00Z"), 201);
    }
    if (call.url.startsWith("https://api.github.com/app/installations?")) installs += 1;
    return listHandler(call);
  });
  const result = await catalog.create({ owner: "ACME", name: "widget" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.repo.fullName, "acme/widget");
  assert.equal(result.repo.private, true);
  assert.deepEqual(created, { name: "widget", private: true, auto_init: true });
  assert.equal(calls.some((call) => call.auth.includes("ghs_CREATE") && call.method === "POST"), true);
  const before = installs;
  const listMints = () =>
    calls.filter((call) => call.url.endsWith("/access_tokens") && call.body?.permissions?.administration !== "write").length;
  const mints = listMints();
  await catalog.list();
  assert.equal(installs, before + 1);
  // The pre-create list token cannot see a repository minted onto a selected installation.
  assert.equal(listMints(), mints + 1);
});

test("create on a user installation uses POST /user/repos", async () => {
  let url = "";
  const { catalog } = harness(appRead, (call) => {
    if (call.url.endsWith("/access_tokens")) return token("ghs_CREATE");
    if (call.url.startsWith("https://api.github.com/app/installations")) return json([installation(2, "ada", "User")]);
    if (call.url.startsWith("https://api.github.com/installation/repositories")) return json({ repositories: [] });
    if (call.method === "POST") {
      url = call.url;
      return json(repo("ada/notes", "2026-09-24T00:00:00Z"), 201);
    }
    return new Response("no", { status: 500 });
  });
  const result = await catalog.create({ owner: "ada", name: "notes", private: false });
  assert.equal(result.ok, true);
  assert.equal(url, "https://api.github.com/user/repos");
});

test("create refuses an unknown owner and a bad name before GitHub does", async () => {
  const { catalog, calls } = harness(appRead, listHandler);
  const unknown = await catalog.create({ owner: "other", name: "widget" });
  assert.deepEqual(unknown, { ok: false, status: 404, error: "the GitHub App isn't installed on other" });
  assert.equal(calls.some((call) => call.method === "POST" && call.url.includes("/repos")), false);
  const before = calls.length;
  const bad = await catalog.create({ owner: "acme", name: "bad name" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
  assert.equal(calls.length, before);
  const flag = await catalog.create({ owner: "acme", name: "widget", private: "yes" as unknown as boolean });
  assert.equal(flag.ok, false);
  if (!flag.ok) assert.equal(flag.status, 400);
});

test("create reports a missing Administration permission and a name already taken", async () => {
  const denied = harness(appRead, (call) => {
    if (call.url.endsWith("/access_tokens") && call.body?.permissions?.administration) {
      return json({ message: "The permissions requested are not granted to this installation." }, 422);
    }
    return listHandler(call);
  });
  const permission = await denied.catalog.create({ owner: "acme", name: "widget" });
  assert.equal(permission.ok, false);
  if (!permission.ok) {
    assert.equal(permission.status, 403);
    assert.match(permission.error, /Administration permission on acme/);
  }

  const taken = harness(appRead, (call) => {
    if (call.method === "POST" && call.url.endsWith("/repos")) {
      return json({ message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }, 422);
    }
    if (call.url.endsWith("/access_tokens") && call.body?.permissions?.administration) return token("ghs_CREATE");
    return listHandler(call);
  });
  const exists = await taken.catalog.create({ owner: "acme", name: "widget" });
  assert.equal(exists.ok, false);
  if (!exists.ok) assert.equal(exists.status, 409);
});

test("floppy status prefers the pull request's line counts and puts that pull first", async () => {
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url === "https://api.github.com/repos/acme/widget/installation") return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) {
      assert.deepEqual(call.body?.repositories, ["widget"]);
      return token("ghs_READ", "acme/widget");
    }
    if (call.url.includes("/pulls?")) {
      return json([
        pull(4, "other", { additions: 99, deletions: 99 }),
        pull(9, "outfitter/abc", { additions: 99, deletions: 99, html_url: "https://evil.example/pr" }),
        { ...pull(11, "forked"), head: { ref: "forked", repo: { full_name: "elsewhere/widget" } } },
      ]);
    }
    if (call.url.endsWith("/pulls/9")) return json({ additions: 3, deletions: 1 });
    return new Response("no", { status: 500 });
  });
  const status = await catalog.sessionStatus({ repo: "https://github.com/acme/widget.git", branch: "outfitter/abc", baseBranch: "main" });
  assert.equal(status.connected, true);
  assert.equal(status.repo, "acme/widget");
  assert.equal(status.pulls[0]?.number, 9);
  assert.equal(status.pulls.some((row) => row.number === 11), false);
  assert.equal(status.branchPull?.url, "https://github.com/acme/widget/pull/9");
  assert.deepEqual(status.diff, { additions: 3, deletions: 1, source: "pull" });
  assert.equal(calls.some((call) => call.url.endsWith("/pulls/9")), true);
  assert.equal(calls.some((call) => call.url.includes("/compare/")), false);
});

test("floppy status sums a compare when the pull request has no line counts", async () => {
  const head = encodeURIComponent("outfitter/abc");
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url === "https://api.github.com/repos/acme/widget/installation") return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) return token("ghs_READ", "acme/widget");
    if (call.url.includes("/pulls?")) return json([pull(9, "outfitter/abc", { additions: 1, deletions: 1 })]);
    if (call.url.endsWith("/pulls/9")) return json({ additions: null, deletions: null });
    if (call.url.includes("/compare/")) {
      const files = [
        { additions: 4, deletions: 1 },
        { additions: 2, deletions: 3 },
      ];
      return json({ ahead_by: 2, behind_by: 0, files });
    }
    return new Response("no", { status: 500 });
  });
  const status = await catalog.sessionStatus({ repo: "acme/widget", branch: "outfitter/abc", baseBranch: "main" });
  assert.equal(status.diff?.additions, 6);
  assert.equal(status.diff?.deletions, 4);
  assert.equal(status.diff?.source, "compare");
  assert.equal(status.diff?.ahead, 2);
  assert.equal(status.diff?.partial, undefined);
  assert.ok(calls.some((call) => call.url.endsWith(`/compare/main...${head}`)));
});

test("a compare that GitHub truncated is marked partial, and an unsafe ref is skipped", async () => {
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) return token("ghs_READ", "acme/widget");
    if (call.url.includes("/pulls?")) return json([]);
    if (call.url.includes("/compare/")) {
      return json({ files: Array.from({ length: 300 }, () => ({ additions: 1, deletions: 0 })) });
    }
    return new Response("no", { status: 500 });
  });
  const partial = await catalog.sessionStatus({ repo: "acme/widget", branch: "feature", baseBranch: "main" });
  assert.equal(partial.diff?.partial, true);
  assert.equal(partial.diff?.additions, 300);
  const compares = () => calls.filter((call) => call.url.includes("/compare/")).length;
  const before = compares();
  const skipped = await catalog.sessionStatus({ repo: "acme/widget", branch: "a..b", baseBranch: "main" });
  assert.equal(skipped.connected, true);
  assert.equal(skipped.diff, null);
  assert.equal(compares(), before);
});

test("a repository the App is not installed on does not mint a token", async () => {
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return new Response("{}", { status: 404 });
    return new Response("should not be called: " + call.url, { status: 500 });
  });
  const status = await catalog.sessionStatus({ repo: "acme/widget", branch: "main", baseBranch: "main" });
  assert.equal(status.connected, false);
  assert.equal(status.reason, "not-installed");
  assert.equal(calls.some((call) => call.url.includes("/access_tokens")), false);
});

test("a floppy with no repository does not call GitHub", async () => {
  const { catalog, calls } = harness(appRead, () => {
    throw new Error("should not fetch");
  });
  const status = await catalog.sessionStatus({ repo: null, branch: null, baseBranch: null });
  assert.equal(status.connected, false);
  assert.equal(status.reason, "no-repository");
  assert.equal(calls.length, 0);
  const invalid = await catalog.sessionStatus({ repo: "not a repo" });
  assert.equal(invalid.reason, "invalid");
  assert.equal(calls.length, 0);
});

test("repository detail maps the pull, the commit's first line, and a pending contribution count", async () => {
  const { catalog } = harness(appRead, (call) => {
    if (call.url === "https://api.github.com/repos/acme/widget/installation") return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) {
      assert.deepEqual(call.body?.repositories, ["widget"]);
      return token("ghs_READ", "acme/widget");
    }
    if (call.url === "https://api.github.com/repos/acme/widget") {
      return json({ ...repo("acme/widget", "2026-09-23T00:00:00Z"), html_url: "javascript:alert(1)" });
    }
    if (call.url.includes("/pulls?")) return json([pull(7, "fix", { title: "Fix the widget", additions: 99, deletions: 99 })]);
    if (call.url.endsWith("/pulls/7")) return json(pull(7, "fix", { title: "Fix the widget", additions: 10, deletions: 2 }));
    if (call.url.includes("/commits?")) {
      return json([
        {
          sha: "abcdef1",
          html_url: "https://github.com/acme/widget/commit/abcdef1",
          author: { login: "ada" },
          commit: { message: "First line\n\nthe rest", author: { name: "Ada", date: "2026-09-20T00:00:00Z" } },
        },
      ]);
    }
    if (call.url.endsWith("/stats/participation")) return new Response(null, { status: 202 });
    return new Response("no " + call.url, { status: 500 });
  });
  const detail = await catalog.detail("acme", "widget");
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.equal(detail.repo.htmlUrl, "https://github.com/acme/widget");
  assert.equal(detail.repo.openPulls[0]?.title, "Fix the widget");
  assert.equal(detail.repo.openPulls[0]?.additions, 10);
  assert.equal(detail.repo.lastCommit?.message, "First line");
  assert.equal(detail.repo.lastCommit?.author, "ada");
  assert.deepEqual(detail.repo.contributions, { pending: true });
  const bad = await catalog.detail("acme", "bad name");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
});

test("a scoped token is kept only when it is exactly this repository", async () => {
  const wide = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) {
      return json(
        {
          token: "ghs_WIDE",
          expires_at: EXPIRES,
          repositories: [{ full_name: "acme/widget" }, { full_name: "acme/other" }],
        },
        201,
      );
    }
    return new Response("should not be called: " + call.url, { status: 500 });
  });
  const rejected = await wide.catalog.sessionStatus({ repo: "acme/widget", branch: "main", baseBranch: "main" });
  assert.equal(rejected.connected, false);
  assert.equal(rejected.reason, "not-installed");
  assert.equal(wide.calls.some((call) => call.url.includes("/pulls")), false);

  const followed = harness(appRead, (call) => {
    if (call.url.endsWith("/installation") && !call.url.includes("/repositories")) {
      return json(installation(1, "acme", "Organization"));
    }
    if (call.url.endsWith("/access_tokens")) return token("ghs_BARE");
    if (call.url.startsWith("https://api.github.com/installation/repositories")) {
      const fullName = call.auth.includes("ghs_BARE") ? "acme/widget" : "other/widget";
      return json({ repositories: [repo(fullName, null)] });
    }
    if (call.url.includes("/pulls?")) return json([]);
    return new Response("no " + call.url, { status: 500 });
  });
  const accepted = await followed.catalog.sessionStatus({ repo: "acme/widget", branch: "main", baseBranch: "main" });
  assert.equal(accepted.connected, true);
  assert.equal(followed.calls.some((call) => call.auth.includes("ghs_BARE") && call.url.includes("/installation/repositories")), true);

  const other = harness(appRead, (call) => {
    if (call.url.endsWith("/installation") && !call.url.includes("/repositories")) {
      return json(installation(1, "acme", "Organization"));
    }
    if (call.url.endsWith("/access_tokens")) return token("ghs_BARE");
    if (call.url.startsWith("https://api.github.com/installation/repositories")) {
      return json({ repositories: [repo("acme/widget", null), repo("acme/other", null)] });
    }
    return new Response("should not be called: " + call.url, { status: 500 });
  });
  const several = await other.catalog.sessionStatus({ repo: "acme/widget", branch: "main", baseBranch: "main" });
  assert.equal(several.connected, false);
  assert.equal(several.reason, "not-installed");
});

test("pagination ignores a link that is not the list itself", async () => {
  const urls: string[] = [];
  const { catalog } = harness(appRead, (call) => {
    urls.push(call.url);
    if (call.url.endsWith("/access_tokens")) return token("ghs_PAGE");
    if (call.url === "https://api.github.com/app/installations?per_page=100") {
      return json([installation(1, "acme", "Organization")], 200, {
        link: `<https://api.github.com/app/installations/../../app/installations/1/access_tokens>; rel="next"`,
      });
    }
    if (call.url.startsWith("https://api.github.com/installation/repositories")) {
      return json({ repositories: [repo("acme/widget", "2026-09-01T00:00:00Z")] }, 200, {
        link: `<https://api.github.com/installation/repositories/../app/installations/1/access_tokens>; rel="next"`,
      });
    }
    return new Response("no", { status: 500 });
  });
  const snapshot = await catalog.list();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.repos[0]?.fullName, "acme/widget");
  assert.equal(urls.some((url) => url.includes("..")), false);
  assert.equal(urls.filter((url) => url.includes("/access_tokens")).length, 1);
});

test("a failed pulls list is not stored as no open pull requests", async () => {
  let pulls = 0;
  const { catalog } = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) return token("ghs_READ", "acme/widget");
    if (call.url.includes("/pulls?")) {
      pulls += 1;
      return new Response("no", { status: 500 });
    }
    return new Response("no", { status: 500 });
  });
  const status = await catalog.sessionStatus({ repo: "acme/widget", branch: "main", baseBranch: "main" });
  assert.equal(status.connected, false);
  assert.equal(status.reason, "unavailable");
  await catalog.sessionStatus({ repo: "acme/widget", branch: "main", baseBranch: "main" });
  assert.equal(pulls, 1);

  const detail = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) return token("ghs_READ", "acme/widget");
    if (call.url === "https://api.github.com/repos/acme/widget") return json(repo("acme/widget", "2026-09-01T00:00:00Z"));
    if (call.url.includes("/pulls?")) return new Response("no", { status: 502 });
    if (call.url.includes("/commits?")) return json([]);
    if (call.url.endsWith("/stats/participation")) return new Response(null, { status: 202 });
    return new Response("no", { status: 500 });
  });
  const result = await detail.catalog.detail("acme", "widget");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 503);
});

test("the list snapshot type stays free of installation ids", () => {
  const snapshot: GithubCatalogSnapshot = {
    configured: true,
    truncated: false,
    accounts: [],
    repos: [],
  };
  assert.equal("installations" in snapshot, false);
});

test("#499: compareBranch lists files with patches, the tip, and caches until the pushed head moves", async () => {
  const tip = "c".repeat(40);
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) return token("ghs_READ", "acme/widget");
    if (call.url.includes("/compare/")) {
      return json({
        ahead_by: 2,
        behind_by: 1,
        commits: [{ sha: "b".repeat(40) }, { sha: tip }],
        files: [
          { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
          { filename: "src/b.ts", previous_filename: "b.ts", status: "renamed", additions: 0, deletions: 0 },
        ],
      });
    }
    return new Response("no", { status: 500 });
  });
  const args = { repo: "acme/widget", branch: "outfitter/abc", baseBranch: "main", expectedHead: "a".repeat(40) };
  const result = await catalog.compareBranch(args);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 1);
  assert.equal(result.head, tip);
  assert.equal(result.partial, false);
  assert.deepEqual(
    result.files.map((f) => [f.path, f.status, f.oldPath ?? null]),
    [
      ["src/a.ts", "M", null],
      ["src/b.ts", "R", "b.ts"],
    ],
  );
  assert.ok(calls.some((call) => call.url.endsWith(`/compare/main...${encodeURIComponent("outfitter/abc")}`) && call.auth === "Bearer ghs_READ"));
  const compares = () => calls.filter((call) => call.url.includes("/compare/")).length;
  await catalog.compareBranch(args);
  assert.equal(compares(), 1);
  await catalog.compareBranch({ ...args, expectedHead: tip });
  assert.equal(compares(), 2);
});

test("#499: compareBranch says not-found for a branch that isn't pushed, and never calls GitHub for a bad ref", async () => {
  const { catalog, calls } = harness(appRead, (call) => {
    if (call.url.endsWith("/installation")) return json(installation(1, "acme", "Organization"));
    if (call.url.endsWith("/access_tokens")) return token("ghs_READ", "acme/widget");
    if (call.url.includes("/compare/")) return new Response("{}", { status: 404 });
    return new Response("no", { status: 500 });
  });
  assert.deepEqual(await catalog.compareBranch({ repo: "acme/widget", branch: "outfitter/abc", baseBranch: "main" }), {
    ok: false,
    reason: "not-found",
  });
  const before = calls.length;
  assert.deepEqual(await catalog.compareBranch({ repo: "acme/widget", branch: "a..b", baseBranch: "main" }), { ok: false, reason: "invalid" });
  assert.deepEqual(await catalog.compareBranch({ repo: null, branch: "x", baseBranch: "main" }), { ok: false, reason: "no-repository" });
  assert.equal(calls.length, before);
});
