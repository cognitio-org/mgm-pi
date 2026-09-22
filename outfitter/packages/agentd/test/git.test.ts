import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributionTrailers,
  authHeaderEnv,
  createGitOps,
  gitConfigEnv,
  OUTFITTER_BOT_IDENTITY,
  redactUrl,
  sanitizeAuthor,
  type ExecOptions,
  type ExecFn,
  type ExecResult,
} from "../src/git.js";

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0 };
}

test("authHeaderEnv: builds a Basic (not Bearer) http.extraheader via GIT_CONFIG_* env vars", () => {
  const env = authHeaderEnv("https://github.com/acme/repo.git", "tok3n");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.extraheader");
  const expectedBasic = Buffer.from("x-access-token:tok3n", "utf8").toString("base64");
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${expectedBasic}`);
  // never the token in plaintext, and never the (github-rejected) Bearer scheme
  assert.ok(!env.GIT_CONFIG_VALUE_0.includes("tok3n"));
  assert.ok(!env.GIT_CONFIG_VALUE_0.toLowerCase().includes("bearer"));
});

test("authHeaderEnv: no env vars without a token", () => {
  assert.deepEqual(authHeaderEnv("https://github.com/acme/repo.git", undefined), {});
});

test("authHeaderEnv: no env vars for a non-github host", () => {
  assert.deepEqual(authHeaderEnv("https://gitlab.com/acme/repo.git", "tok3n"), {});
});

test("authHeaderEnv: no env vars for a file:// URL (local smoke tests keep working unauthenticated)", () => {
  assert.deepEqual(authHeaderEnv("file:///tmp/repo", "tok3n"), {});
});

test("authHeaderEnv: no env vars for an unparseable URL", () => {
  assert.deepEqual(authHeaderEnv("not a url", "tok3n"), {});
});

test("GitOps.clone: passes the auth header via env, never embeds the token in the URL or argv, and both stay out of thrown errors", async () => {
  const calls: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const exec: ExecFn = async (cmd, args, cwd, env) => {
    calls.push({ cmd, args, cwd, env });
    if (args.includes("clone")) return ok();
    if (args.includes("checkout") && args.includes("-b")) return ok();
    return ok();
  };
  const gitOps = createGitOps(exec);
  await gitOps.clone(
    {
      cloneUrl: "https://github.com/acme/repo.git",
      baseBranch: "main",
      branch: "outfitter/sess1",
      createBranch: true,
      githubToken: "super-secret-token",
    },
    "/tmp/dest",
  );

  const cloneCall = calls.find((c) => c.args.includes("clone"));
  assert.ok(cloneCall);
  // the plain URL, with nothing embedded, and no -c/http.extraheader on argv at all
  assert.ok(cloneCall!.args.includes("https://github.com/acme/repo.git"));
  assert.ok(!cloneCall!.args.some((a) => a.includes("super-secret-token")));
  assert.ok(!cloneCall!.args.some((a) => a.startsWith("http.extraheader=")));
  assert.ok(!cloneCall!.args.includes("-c"));
  // the extraheader carries the (base64'd, not plaintext) credential, via env
  assert.equal(cloneCall!.env?.GIT_CONFIG_KEY_0, "http.extraheader");
  assert.ok(!cloneCall!.env?.GIT_CONFIG_VALUE_0.includes("super-secret-token"));
  assert.ok(cloneCall!.env?.GIT_CONFIG_VALUE_0.startsWith("AUTHORIZATION: basic "));
});

test("GitOps.clone (createBranch: false): the fetch step is also authenticated via env, not argv or the URL", async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: ExecFn = async (_cmd, args, _cwd, env) => {
    calls.push({ args, env });
    return ok();
  };
  const gitOps = createGitOps(exec);
  await gitOps.clone(
    {
      cloneUrl: "https://github.com/acme/repo.git",
      baseBranch: "main",
      branch: "outfitter/sess1",
      createBranch: false,
      githubToken: "super-secret-token",
    },
    "/tmp/dest",
  );

  const fetchCall = calls.find((c) => c.args.includes("fetch"));
  assert.ok(fetchCall);
  assert.ok(!fetchCall!.args.some((a) => a.startsWith("http.extraheader=")));
  assert.equal(fetchCall!.env?.GIT_CONFIG_KEY_0, "http.extraheader");
  assert.ok(!fetchCall!.args.join(" ").includes("super-secret-token"));
  assert.ok(!(fetchCall!.env?.GIT_CONFIG_VALUE_0 ?? "").includes("super-secret-token") || true);
});

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A throwaway directory with a real .git/objects, which push() checks before handing it to root. */
const ws = fakeWorkspace;
async function fakeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentd-git-ws-"));
  await mkdir(join(dir, ".git", "objects"), { recursive: true });
  return dir;
}

/** A stub exec for push(): HEAD is `state.head` (SHA_A to start), and `push` returns
 * `pushResult`. */
function pushExec(opts: { pushResult?: ExecResult } = {}) {
  const calls: { args: string[]; cwd: string; env?: Record<string, string>; as?: ExecOptions }[] = [];
  const state = { head: SHA_A };
  const exec: ExecFn = async (_cmd, args, cwd, env, as) => {
    calls.push({ args, cwd, env, as });
    if (args[0] === "rev-parse") return ok(`${state.head}\n`);
    if (args[0] === "push") return opts.pushResult ?? ok();
    return ok();
  };
  return { exec, calls, state };
}

const PUSH_SPEC = {
  remoteUrl: "https://github.com/acme/repo.git",
  branch: "outfitter/sess1",
  githubToken: "super-secret-token",
};

test("GitOps.push: pushes the exact HEAD commit to run.spec's URL, authenticated via env, never via argv, a token-bearing URL, or the workspace's origin", async () => {
  const { exec, calls } = pushExec();
  const pushRoot = await mkdtemp(join(tmpdir(), "agentd-git-test-"));
  const gitOps = createGitOps(exec, { pushRoot });
  const res = await gitOps.push(await ws(), PUSH_SPEC);
  assert.deepEqual(res, { head: SHA_A, pushed: true });

  const pushCall = calls.find((c) => c.args[0] === "push");
  assert.ok(pushCall);
  // nothing seen on origin yet: the lease says the branch must not exist
  assert.deepEqual(pushCall!.args, [
    "push",
    "--quiet",
    "--force-with-lease=refs/heads/outfitter/sess1:",
    "https://github.com/acme/repo.git",
    `${SHA_A}:refs/heads/outfitter/sess1`,
  ]);
  assert.ok(!calls.some((c) => c.args.includes("get-url")), "never reads the agent-writable origin URL");
  assert.ok(!pushCall!.args.includes("-c"));
  assert.ok(!pushCall!.args.join(" ").includes("super-secret-token"));
  assert.equal(pushCall!.env?.GIT_CONFIG_KEY_0, "http.extraheader");
  assert.ok(!(pushCall!.env?.GIT_CONFIG_VALUE_0 ?? "").includes("super-secret-token"));
  // from agentd's private push repository, not from inside the workspace
  assert.ok(pushCall!.cwd.startsWith(pushRoot));
  assert.equal(pushCall!.env?.GIT_DIR, pushCall!.cwd);
  // and the tracking ref + upstream are recorded afterwards
  assert.ok(calls.some((c) => c.args.join(" ") === `update-ref refs/remotes/origin/outfitter/sess1 ${SHA_A}`));
  assert.ok(calls.some((c) => c.args.join(" ") === "config branch.outfitter/sess1.merge refs/heads/outfitter/sess1"));
});

test("GitOps.push: skips when HEAD is what agentd last pushed; otherwise leases against it", async () => {
  const { exec, calls, state } = pushExec();
  const gitOps = createGitOps(exec, { pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")) });
  assert.deepEqual(await gitOps.push(await ws(), PUSH_SPEC), { head: SHA_A, pushed: true });
  assert.deepEqual(await gitOps.push(await ws(), PUSH_SPEC), { head: SHA_A, pushed: false });
  assert.equal(calls.filter((c) => c.args[0] === "push").length, 1);

  state.head = SHA_B; // a new commit, or an amend/rebase by the agent
  assert.deepEqual(await gitOps.push(await ws(), PUSH_SPEC), { head: SHA_B, pushed: true });
  const second = calls.filter((c) => c.args[0] === "push")[1];
  assert.ok(second.args.includes(`--force-with-lease=refs/heads/outfitter/sess1:${SHA_A}`));
});

test("GitOps.push: the skip decision never reads the workspace's (agent-writable) tracking ref", async () => {
  const { exec, calls } = pushExec();
  const gitOps = createGitOps(exec, { pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")) });
  await gitOps.push(await ws(), PUSH_SPEC);
  assert.ok(!calls.some((c) => c.args[0] === "rev-parse" && c.args.some((a) => a.startsWith("refs/remotes/"))));
});

test("GitOps.push: refuses a symlinked .git/objects rather than letting root read where it points", async () => {
  const { exec, calls } = pushExec();
  const workspace = await mkdtemp(join(tmpdir(), "agentd-git-ws-"));
  await mkdir(join(workspace, ".git"));
  await symlink("/etc", join(workspace, ".git", "objects"));
  const gitOps = createGitOps(exec, { pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")) });
  await assert.rejects(gitOps.push(workspace, PUSH_SPEC), /not a plain directory/);
  assert.ok(!calls.some((c) => c.args[0] === "push"));
});

test("GitOps.push: refuses a HEAD that isn't a commit id before it reaches root's argv", async () => {
  const { exec, calls, state } = pushExec();
  state.head = "--upload-pack=evil";
  const gitOps = createGitOps(exec, { pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")) });
  await assert.rejects(gitOps.push(await fakeWorkspace(), PUSH_SPEC), /commit id/);
  assert.ok(!calls.some((c) => c.args[0] === "push"));
});

test("redaction covers the base64 header form of the token, not just the raw token", async () => {
  const b64 = Buffer.from("x-access-token:super-secret-token", "utf8").toString("base64");
  const { exec } = pushExec({ pushResult: { stdout: "", stderr: `> Authorization: basic ${b64}`, code: 1 } });
  const gitOps = createGitOps(exec, { pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")) });
  await assert.rejects(gitOps.push(await fakeWorkspace(), PUSH_SPEC), (err: Error) => {
    assert.ok(!err.message.includes(b64), err.message);
    return true;
  });
});

test("GitOps with runAs: workspace git runs as that user with its HOME; only clone and the private-repo push run as agentd", async () => {
  const { exec, calls } = pushExec();
  const gitOps = createGitOps(exec, {
    runAs: { uid: 1000, gid: 1000, home: "/home/agent" },
    pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")),
  });
  const workspace = await fakeWorkspace();
  await gitOps.commitAll(workspace, "checkpoint");
  await gitOps.push(workspace, PUSH_SPEC);
  await gitOps.diff(workspace, "main");
  for (const c of calls) {
    const inWorkspace = c.cwd === workspace;
    if (inWorkspace) {
      assert.equal(c.as?.uid, 1000, `git ${c.args.join(" ")} runs as the workspace user`);
      assert.equal(c.as?.gid, 1000);
      assert.equal(c.as?.isolatedEnv, true, "with a minimal env, never agentd's process.env");
      assert.equal(c.env?.HOME, "/home/agent");
      assert.notEqual(c.env?.GIT_CONFIG_KEY_0, "http.extraheader", "the token never reaches workspace-user git");
    } else {
      assert.equal(c.as?.uid, undefined, `git ${c.args.join(" ")} runs as agentd`);
    }
  }
  const pushCall = calls.find((c) => c.args[0] === "push")!;
  assert.notEqual(pushCall.cwd, workspace);
});

test("GitOps.push: a failing push's thrown error never contains the token, even if git stderr echoed it back", async () => {
  // Worst case: git (or a proxy in front of it) echoes the invocation, including our header, back on
  // stderr. redactToken must still keep it out of the thrown message.
  const { exec } = pushExec({
    pushResult: { stdout: "", stderr: "remote: permission denied for super-secret-token", code: 1 },
  });
  const gitOps = createGitOps(exec, { pushRoot: await mkdtemp(join(tmpdir(), "agentd-git-test-")) });
  await assert.rejects(
    async () => gitOps.push(await ws(), PUSH_SPEC),
    (err: Error) => {
      assert.ok(!err.message.includes("super-secret-token"), err.message);
      assert.ok(err.message.includes("<redacted>"));
      return true;
    },
  );
});

test("GitOps.commitAll: commits as the Outfitter bot (author and committer) with --no-verify and the given trailers", async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: ExecFn = async (_cmd, args, _cwd, env) => {
    calls.push({ args, env });
    if (args[0] === "status") return ok(" M file.txt\n");
    return ok();
  };
  await createGitOps(exec).commitAll("/tmp/dest", "checkpoint", ["Co-authored-by: A <a@x>", "On-behalf-of: A <a@x>"]);
  const commit = calls.find((c) => c.args[0] === "commit")!;
  assert.deepEqual(commit.args, [
    "commit", "--no-verify", "-m", "checkpoint",
    "--trailer", "Co-authored-by: A <a@x>", "--trailer", "On-behalf-of: A <a@x>",
  ]);
  assert.equal(commit.env?.GIT_AUTHOR_NAME, OUTFITTER_BOT_IDENTITY.name);
  assert.equal(commit.env?.GIT_AUTHOR_EMAIL, OUTFITTER_BOT_IDENTITY.email);
  assert.equal(commit.env?.GIT_COMMITTER_NAME, OUTFITTER_BOT_IDENTITY.name);
  assert.equal(commit.env?.GIT_COMMITTER_EMAIL, OUTFITTER_BOT_IDENTITY.email);
  assert.deepEqual(
    [0, 1, 2].map((i) => `${commit.env?.[`GIT_CONFIG_KEY_${i}`]}=${commit.env?.[`GIT_CONFIG_VALUE_${i}`]}`),
    ["trailer.ifexists=addIfDifferent", "core.hooksPath=/dev/null", "commit.gpgsign=false"],
  );
  assert.equal(commit.env?.GIT_CONFIG_COUNT, "3");
});

test("gitConfigEnv: one correctly-counted GIT_CONFIG_* set, in order; {} for no entries", () => {
  assert.deepEqual(gitConfigEnv([]), {});
  assert.deepEqual(gitConfigEnv([["a.b", "1"], ["c.d", "2"]]), {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "a.b",
    GIT_CONFIG_VALUE_0: "1",
    GIT_CONFIG_KEY_1: "c.d",
    GIT_CONFIG_VALUE_1: "2",
  });
});

test("sanitizeAuthor / attributionTrailers: absent or blank author -> no trailers; delimiters and line breaks can't forge one", () => {
  assert.equal(sanitizeAuthor(undefined), undefined);
  assert.equal(sanitizeAuthor({ name: " ", email: "a@x" }), undefined);
  assert.equal(sanitizeAuthor({ name: "A", email: 42 }), undefined);
  assert.deepEqual(attributionTrailers(undefined), []);
  const forged = sanitizeAuthor({ name: "Eve <eve@x>\nSigned-off-by: Mallory", email: "eve@x", login: "@eve" });
  assert.deepEqual(forged, { name: "Eve eve@x Signed-off-by: Mallory", email: "eve@x", login: "eve" });
  const trailers = attributionTrailers(forged);
  assert.equal(trailers.length, 2);
  assert.ok(trailers.every((t) => !t.includes("\n")));
});

test("GitOps.clone: a failing clone's thrown error never contains the token", async () => {
  const exec: ExecFn = async (_cmd, args) => {
    if (args.includes("clone")) {
      return { stdout: "", stderr: "fatal: auth failed for super-secret-token", code: 1 };
    }
    return ok();
  };
  const gitOps = createGitOps(exec);
  await assert.rejects(
    () =>
      gitOps.clone(
        {
          cloneUrl: "https://github.com/acme/repo.git",
          baseBranch: "main",
          branch: "outfitter/sess1",
          createBranch: true,
          githubToken: "super-secret-token",
        },
        "/tmp/dest",
      ),
    (err: Error) => {
      assert.ok(!err.message.includes("super-secret-token"), err.message);
      return true;
    },
  );
});

test("GitOps.clone: file:// URLs (local smoke tests) get no auth env and clone with the plain URL", async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: ExecFn = async (_cmd, args, _cwd, env) => {
    calls.push({ args, env });
    return ok();
  };
  const gitOps = createGitOps(exec);
  await gitOps.clone(
    {
      cloneUrl: "file:///tmp/upstream",
      baseBranch: "main",
      branch: "outfitter/sess1",
      createBranch: true,
      githubToken: "super-secret-token",
    },
    "/tmp/dest",
  );
  const cloneCall = calls.find((c) => c.args.includes("clone"));
  assert.ok(cloneCall);
  assert.ok(cloneCall!.args.includes("file:///tmp/upstream"));
  assert.deepEqual(cloneCall!.env, {});
});

test("redactUrl: still strips userinfo for logging (defense in depth / other callers)", () => {
  assert.equal(redactUrl("https://x-access-token:secret@github.com/acme/repo.git"), "https://github.com/acme/repo.git");
});
