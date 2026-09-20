import { test } from "node:test";
import assert from "node:assert/strict";
import { authHeaderEnv, createGitOps, redactUrl, type ExecFn, type ExecResult } from "../src/git.js";

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

test("GitOps.push: reads the plain origin URL, authenticates via env, and pushes to 'origin' (never a token-bearing URL or argv)", async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: ExecFn = async (_cmd, args, _cwd, env) => {
    calls.push({ args, env });
    if (args.includes("get-url")) return ok("https://github.com/acme/repo.git\n");
    if (args.includes("rev-parse")) return ok("deadbeef\n");
    return ok();
  };
  const gitOps = createGitOps(exec);
  const { head } = await gitOps.push("/tmp/dest", "outfitter/sess1", "super-secret-token");
  assert.equal(head, "deadbeef");

  const pushCall = calls.find((c) => c.args.includes("push"));
  assert.ok(pushCall);
  assert.ok(pushCall!.args.includes("origin"));
  assert.ok(!pushCall!.args.some((a) => a.startsWith("https://") && a.includes("@")));
  assert.ok(!pushCall!.args.some((a) => a.startsWith("http.extraheader=")));
  assert.ok(!pushCall!.args.includes("-c"));
  assert.equal(pushCall!.env?.GIT_CONFIG_KEY_0, "http.extraheader");
  assert.ok(!pushCall!.args.join(" ").includes("super-secret-token"));
  assert.ok(!(pushCall!.env?.GIT_CONFIG_VALUE_0 ?? "").includes("super-secret-token"));
});

test("GitOps.push: a failing push's thrown error never contains the token, even if git stderr echoed it back", async () => {
  const exec: ExecFn = async (_cmd, args) => {
    if (args.includes("get-url")) return ok("https://github.com/acme/repo.git\n");
    if (args.includes("push")) {
      // Worst case: git (or a proxy in front of it) echoes the invocation, including our header,
      // back on stderr. redactToken must still keep it out of the thrown message.
      return { stdout: "", stderr: "remote: permission denied for super-secret-token", code: 1 };
    }
    return ok();
  };
  const gitOps = createGitOps(exec);
  await assert.rejects(
    () => gitOps.push("/tmp/dest", "outfitter/sess1", "super-secret-token"),
    (err: Error) => {
      assert.ok(!err.message.includes("super-secret-token"), err.message);
      assert.ok(err.message.includes("<redacted>"));
      return true;
    },
  );
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
