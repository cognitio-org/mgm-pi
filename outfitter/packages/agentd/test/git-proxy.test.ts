import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaderSecret } from "../src/git.js";
import {
  gitProxyInsteadOfEnv,
  githubRepoHttps,
  startGitProxy,
  type GitProxy,
} from "../src/git-proxy.js";
import { createAsyncLock } from "../src/lock.js";

const TOKEN = "ghp_test_TOKEN_89_do_not_leak";
const ALLOWED = "refs/heads/outfitter/sess1";
const GITHUB = githubRepoHttps("acme", "widget");

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body: Buffer;
}

interface FakeUpstream {
  base: string;
  seen: Seen[];
  close(): Promise<void>;
}

function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0")), body]);
}

function advertise(service: string, refs: { oid: string; name: string }[]): Buffer {
  const caps =
    service === "git-receive-pack"
      ? "report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=fake"
      : "ofs-delta side-band-64k agent=fake";
  const parts: Buffer[] = [pkt(`# service=${service}\n`), Buffer.from("0000")];
  if (refs.length === 0) {
    parts.push(pkt(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const cap = i === 0 ? `\0${caps}` : "";
      parts.push(pkt(`${ref.oid} ${ref.name}${cap}\n`));
    });
  }
  parts.push(Buffer.from("0000"));
  return Buffer.concat(parts);
}

function okReport(refs: string[]): Buffer {
  const inner = Buffer.concat([
    pkt("unpack ok\n"),
    ...refs.map((ref) => pkt(`ok ${ref}\n`)),
    Buffer.from("0000"),
  ]);
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), Buffer.from("0000")]);
}

function refUpdates(body: Buffer): { oldOid: string; newOid: string; ref: string }[] {
  const updates: { oldOid: string; newOid: string; ref: string }[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const len = Number.parseInt(body.subarray(off, off + 4).toString("ascii"), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) break;
    if (len < 4 || off + len > body.length) break;
    const text = body.subarray(off + 4, off + len).toString("utf8");
    const head = text.split("\0", 1)[0]!.replace(/\n$/, "");
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/i.exec(head);
    if (match) updates.push({ oldOid: match[1]!.toLowerCase(), newOid: match[2]!.toLowerCase(), ref: match[3]! });
    off += len;
  }
  return updates;
}

function startFakeUpstream(opts: { dropReceive?: boolean; holdInfoRefs?: Promise<void> } = {}): Promise<FakeUpstream> {
  const seen: Seen[] = [];
  const refs = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const chunks: Buffer[] = [];
    const drop = opts.dropReceive === true && req.method === "POST" && url.includes("/git-receive-pack");
    if (drop) {
      seen.push({
        method: req.method ?? "",
        url,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        body: Buffer.alloc(0),
      });
      req.socket.destroy();
      return;
    }
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? "",
        url,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        body,
      });
      const pathname = url.split("?", 1)[0] ?? "";
      if (req.method === "GET" && pathname.endsWith("/info/refs")) {
        void (async () => {
          if (opts.holdInfoRefs) await opts.holdInfoRefs;
          const service = new URL(url, "http://127.0.0.1").searchParams.get("service") ?? "git-upload-pack";
          const advertised = [...refs.entries()].map(([name, oid]) => ({ oid, name }));
          const payload = advertise(service, advertised);
          const type =
            service === "git-receive-pack"
              ? "application/x-git-receive-pack-advertisement"
              : "application/x-git-upload-pack-advertisement";
          res.writeHead(200, { "content-type": type, "cache-control": "no-cache", "content-length": payload.length });
          res.end(payload);
        })();
        return;
      }
      if (req.method === "POST" && pathname.endsWith("/git-receive-pack")) {
        if (body.includes("proxy-echo-check")) {
          const auth = String(req.headers.authorization ?? "");
          const b64 = auth.replace(/^Basic\s+/i, "");
          const decoded = Buffer.from(b64, "base64").toString("utf8");
          const raw = decoded.startsWith("x-access-token:") ? decoded.slice("x-access-token:".length) : decoded;
          const echoed = Buffer.from(`echo ${raw}\n${b64}\n${auth}\n`);
          res.writeHead(200, {
            "content-type": "text/plain",
            "x-echo": raw,
            "content-length": echoed.length,
          });
          res.end(echoed);
          return;
        }
        const updates = refUpdates(body);
        for (const update of updates) {
          if (/^0+$/.test(update.newOid)) refs.delete(update.ref);
          else refs.set(update.ref, update.newOid);
        }
        const payload = okReport(updates.map((update) => update.ref));
        res.writeHead(200, {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
          "content-length": payload.length,
        });
        res.end(payload);
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("fake upstream failed to bind"));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function rawHttp(
  port: number,
  method: string,
  path: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

async function gitEnv(dir: string, overlay: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  await writeFile(join(dir, "empty-gitconfig"), "");
  return {
    ...process.env,
    ...overlay,
    HOME: dir,
    GIT_CONFIG_GLOBAL: join(dir, "empty-gitconfig"),
    GIT_CONFIG_SYSTEM: join(dir, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "proxy-test",
    GIT_AUTHOR_EMAIL: "proxy-test@example.com",
    GIT_COMMITTER_NAME: "proxy-test",
    GIT_COMMITTER_EMAIL: "proxy-test@example.com",
  };
}

async function initRepo(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const init = await runGit(dir, env, ["init", "-b", "main"]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal((await runGit(dir, env, ["config", "user.email", "proxy-test@example.com"])).code, 0);
  assert.equal((await runGit(dir, env, ["config", "user.name", "proxy-test"])).code, 0);
  await runGit(dir, env, ["remote", "add", "origin", GITHUB]);
}

function receivePacks(seen: Seen[]): Seen[] {
  return seen.filter((row) => row.method === "POST" && row.url.includes("/git-receive-pack"));
}

function assertNoSecret(text: string, where: string): void {
  assert.ok(!text.includes(TOKEN), `${where} contains the token`);
  assert.ok(!text.includes(authHeaderSecret(TOKEN)), `${where} contains the token's base64 form`);
}

async function withProxy(
  t: { after: (fn: () => void | Promise<void>) => void },
  opts: { allowedRefs?: string[]; allowedPrefixes?: string[]; dropReceive?: boolean; log?: string[] } = {},
): Promise<{ proxy: GitProxy; upstream: FakeUpstream; dir: string; env: NodeJS.ProcessEnv }> {
  const upstream = await startFakeUpstream({ dropReceive: opts.dropReceive });
  const logs = opts.log;
  const proxy = await startGitProxy({
    owner: "acme",
    repo: "widget",
    token: TOKEN,
    allowedRefs: opts.allowedRefs ?? [ALLOWED],
    allowedPrefixes: opts.allowedPrefixes,
    upstreamBase: upstream.base,
    log: logs ? (line) => logs.push(line) : undefined,
  });
  const dir = await mkdtemp(join(tmpdir(), "git-proxy-"));
  const env = await gitEnv(dir, gitProxyInsteadOfEnv(proxy.url, GITHUB));
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { proxy, upstream, dir, env };
}

test("upstream forwards share the caller's lock with each other", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const upstream = await startFakeUpstream({ holdInfoRefs: gate });
  let active = 0;
  let max = 0;
  let waiting = 0;
  const lock = createAsyncLock();
  const counting = <T>(fn: () => Promise<T>): Promise<T> => {
    waiting++;
    return lock(async () => {
      waiting--;
      active++;
      max = Math.max(max, active);
      try {
        return await fn();
      } finally {
        active--;
      }
    });
  };
  const proxy = await startGitProxy({
    owner: "acme",
    repo: "widget",
    token: TOKEN,
    allowedRefs: [ALLOWED],
    upstreamBase: upstream.base,
    lock: counting,
  });
  t.after(async () => {
    release();
    await proxy.close();
    await upstream.close();
  });
  const first = rawHttp(proxy.port, "GET", "/acme/widget.git/info/refs?service=git-upload-pack");
  await waitFor(() => active === 1);
  const second = rawHttp(proxy.port, "GET", "/acme/widget.git/info/refs?service=git-upload-pack");
  await waitFor(() => waiting === 1);
  assert.equal(max, 1);
  assert.equal(active, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(max, 1);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("insteadOf env pins the proxy URL and not the token or an auth header", () => {
  const env = gitProxyInsteadOfEnv("http://127.0.0.1:9/acme/widget.git", GITHUB);
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "url.http://127.0.0.1:9/acme/widget.git.insteadOf");
  assert.equal(env.GIT_CONFIG_VALUE_0, GITHUB);
  const blob = Object.values(env).join("\n");
  assertNoSecret(blob, "insteadOf env");
  assert.ok(!blob.toLowerCase().includes("extraheader"));
  assert.ok(!blob.toLowerCase().includes("authorization"));
});

test("a small push is forwarded, the auth header is only on the upstream request, and a force-update of the allowed ref is allowed", async (t) => {
  const logs: string[] = [];
  const { proxy, upstream, dir, env } = await withProxy(t, { log: logs });
  assert.equal(new URL(proxy.url).hostname, "127.0.0.1");
  await initRepo(dir, env);
  await writeFile(join(dir, "readme.txt"), "hello\n");
  assert.equal((await runGit(dir, env, ["add", "readme.txt"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "-m", "init"])).code, 0, "commit");

  const pushed = await runGit(dir, env, ["push", "origin", `HEAD:${ALLOWED}`]);
  assert.equal(pushed.code, 0, pushed.stderr);
  assertNoSecret(pushed.stdout + pushed.stderr, "git push output");

  const packs = receivePacks(upstream.seen);
  assert.equal(packs.length, 1);
  assert.ok(packs[0]!.body.includes("PACK"), "pack was not forwarded");
  assert.ok(packs[0]!.body.includes(ALLOWED));
  const expectedAuth = `Basic ${authHeaderSecret(TOKEN)}`;
  for (const row of upstream.seen) {
    assert.equal(row.authorization, expectedAuth);
  }
  assert.ok(upstream.seen.some((row) => row.url.includes("/info/refs")));

  const other = await rawHttp(proxy.port, "GET", "/other/nope.git/info/refs?service=git-upload-pack");
  assert.equal(other.status, 404);
  assertNoSecret(other.body.toString("utf8"), "404 body");
  assert.equal(upstream.seen.filter((row) => row.url.includes("/other/")).length, 0);

  const echoBody = Buffer.concat([
    pkt(`${"0".repeat(40)} ${"a".repeat(40)} ${ALLOWED}\0 report-status side-band-64k\n`),
    Buffer.from("0000"),
    Buffer.from("proxy-echo-check"),
  ]);
  const echo = await rawHttp(proxy.port, "POST", "/acme/widget.git/git-receive-pack", echoBody, {
    "content-type": "application/x-git-receive-pack-request",
  });
  const clientText = `${echo.status}\n${JSON.stringify(echo.headers)}\n${echo.body.toString("utf8")}`;
  assertNoSecret(clientText, "client-facing response");
  assert.ok(echo.body.includes("[redacted]"), "expected the upstream echo of the token to be scrubbed");
  assert.equal(echo.headers["x-echo"], undefined);

  await writeFile(join(dir, "readme.txt"), "hello again\n");
  assert.equal((await runGit(dir, env, ["add", "readme.txt"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "--amend", "--no-edit"])).code, 0);
  const forced = await runGit(dir, env, ["push", "--force", "origin", `HEAD:${ALLOWED}`]);
  assert.equal(forced.code, 0, forced.stderr);
  const forwarded = receivePacks(upstream.seen).filter((row) => !row.body.includes("proxy-echo-check"));
  const last = forwarded.at(-1)!;
  const update = refUpdates(last.body).find((row) => row.ref === ALLOWED);
  assert.ok(update, "force-update was not forwarded");
  assert.notEqual(update!.newOid, "0".repeat(40));
  assert.notEqual(update!.oldOid, "0".repeat(40));
  assert.notEqual(update!.oldOid, update!.newOid);
  assertNoSecret(logs.join("\n"), "proxy log");
});

test("a few-hundred-kilobyte pack is forwarded with the auth header", async (t) => {
  const { upstream, dir, env } = await withProxy(t);
  await initRepo(dir, env);
  const payload = randomBytes(300 * 1024);
  await writeFile(join(dir, "blob.bin"), payload);
  assert.equal((await runGit(dir, env, ["add", "blob.bin"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "-m", "blob"])).code, 0);
  const pushed = await runGit(dir, env, ["push", "origin", `HEAD:${ALLOWED}`]);
  assert.equal(pushed.code, 0, pushed.stderr);
  const pack = receivePacks(upstream.seen).at(-1);
  assert.ok(pack);
  assert.ok(pack!.body.length > payload.length);
  assert.ok(pack!.body.includes(payload.subarray(0, 64)) || pack!.body.includes("PACK"));
  assert.equal(pack!.authorization, `Basic ${authHeaderSecret(TOKEN)}`);
  assertNoSecret(pushed.stdout + pushed.stderr, "large push output");
});

test("a ref outside the allow-list is refused and the push is not forwarded", async (t) => {
  const { upstream, dir, env } = await withProxy(t);
  await initRepo(dir, env);
  await writeFile(join(dir, "readme.txt"), "hello\n");
  assert.equal((await runGit(dir, env, ["add", "readme.txt"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "-m", "init"])).code, 0);
  const before = receivePacks(upstream.seen).length;
  const pushed = await runGit(dir, env, ["push", "origin", "HEAD:refs/heads/main", `HEAD:${ALLOWED}`]);
  assert.notEqual(pushed.code, 0);
  assert.match(pushed.stderr, /refusing push/);
  assert.match(pushed.stderr, /refs\/heads\/main is not an allowed ref/);
  assert.equal(receivePacks(upstream.seen).length, before);
  assert.ok(!upstream.seen.some((row) => row.body.includes("refs/heads/main")));
  assertNoSecret(pushed.stdout + pushed.stderr, "refused push output");
});

test("a push certificate whose ref line is not its own pkt-line is refused and not forwarded", async (t) => {
  const { proxy, upstream } = await withProxy(t);
  const before = receivePacks(upstream.seen).length;
  const oldOid = "0".repeat(40);
  const newOid = "a".repeat(40);
  const certificate = `certificate version 0.1\npusher cert-test <cert@example.com>\n${oldOid} ${newOid} ${ALLOWED}\n`;
  const body = Buffer.concat([pkt(certificate), Buffer.from("0000")]);
  const refused = await rawHttp(proxy.port, "POST", "/acme/widget.git/git-receive-pack", body, {
    "content-type": "application/x-git-receive-pack-request",
  });
  assert.equal(refused.status, 200);
  assert.match(refused.body.toString("utf8"), /refusing push: malformed receive-pack request/);
  assert.equal(receivePacks(upstream.seen).length, before);
  assertNoSecret(refused.body.toString("utf8"), "push-cert refusal");

  const empty = await rawHttp(proxy.port, "POST", "/acme/widget.git/git-receive-pack", Buffer.from("0000"), {
    "content-type": "application/x-git-receive-pack-request",
  });
  assert.equal(empty.status, 200);
  assert.doesNotMatch(empty.body.toString("utf8"), /malformed/);
  assert.equal(receivePacks(upstream.seen).length, before + 1);
});

test("a branch under the configured prefix is forwarded, and main is not", async (t) => {
  const { upstream, dir, env } = await withProxy(t, {
    allowedRefs: ["refs/heads/feat/teleport"],
    allowedPrefixes: ["outfitter/"],
  });
  await initRepo(dir, env);
  await writeFile(join(dir, "readme.txt"), "hello\n");
  assert.equal((await runGit(dir, env, ["add", "readme.txt"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "-m", "init"])).code, 0);

  const prefixed = await runGit(dir, env, ["push", "origin", "HEAD:refs/heads/outfitter/issue-4"]);
  assert.equal(prefixed.code, 0, prefixed.stderr);
  assert.equal(receivePacks(upstream.seen).length, 1);

  const session = await runGit(dir, env, ["push", "--force", "origin", "HEAD:refs/heads/feat/teleport"]);
  assert.equal(session.code, 0, session.stderr);

  const before = receivePacks(upstream.seen).length;
  const main = await runGit(dir, env, ["push", "origin", "HEAD:refs/heads/main"]);
  assert.notEqual(main.code, 0);
  assert.match(main.stderr, /refs\/heads\/main is not an allowed ref/);
  assert.equal(receivePacks(upstream.seen).length, before);

  const deleted = await runGit(dir, env, ["push", "origin", ":refs/heads/outfitter/issue-4"]);
  assert.notEqual(deleted.code, 0);
  assert.match(deleted.stderr, /refusing to delete refs\/heads\/outfitter\/issue-4/);
  assert.equal(receivePacks(upstream.seen).length, before);
});

test("a deletion is refused and nothing is forwarded", async (t) => {
  const { upstream, dir, env } = await withProxy(t);
  await initRepo(dir, env);
  await writeFile(join(dir, "readme.txt"), "hello\n");
  assert.equal((await runGit(dir, env, ["add", "readme.txt"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "-m", "init"])).code, 0);
  const pushed = await runGit(dir, env, ["push", "origin", `HEAD:${ALLOWED}`]);
  assert.equal(pushed.code, 0, pushed.stderr);
  const before = receivePacks(upstream.seen).length;
  const deleted = await runGit(dir, env, ["push", "origin", `:${ALLOWED}`]);
  assert.notEqual(deleted.code, 0);
  assert.match(deleted.stderr, /refusing to delete refs\/heads\/outfitter\/sess1/);
  assert.equal(receivePacks(upstream.seen).length, before);
  assertNoSecret(deleted.stdout + deleted.stderr, "delete output");
});

test("a dropped upstream connection surfaces as an error to the client", async (t) => {
  const logs: string[] = [];
  const { dir, env } = await withProxy(t, { dropReceive: true, log: logs });
  await initRepo(dir, env);
  await writeFile(join(dir, "readme.txt"), "hello\n");
  assert.equal((await runGit(dir, env, ["add", "readme.txt"])).code, 0);
  assert.equal((await runGit(dir, env, ["commit", "-m", "init"])).code, 0);
  const pushed = await runGit(dir, env, ["push", "origin", `HEAD:${ALLOWED}`]);
  assert.notEqual(pushed.code, 0);
  assert.match(pushed.stderr, /error|fatal|RPC failed|hung up|dropped|Empty reply/i);
  assertNoSecret(pushed.stdout + pushed.stderr, "dropped upstream output");
  assertNoSecret(logs.join("\n"), "dropped upstream log");
});
