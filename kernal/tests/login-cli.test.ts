/**
 * `kernal login | logout | whoami` (#391 CA-2, central-auth.md §2.5): commands.ts driven with a fake
 * fetch, then cli.ts run with node against a local fake Outfitter (no real server, no keychain:
 * KERNAL_AUTH_BACKEND=file in a temporary KERNAL_AUTH_DIR), and bin/kernal's pi_memory_env check.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canOpenBrowser, main, parseArgs, type CliIo } from "../.pi/extensions/kernal-login/commands.ts";

const API = "https://link.outfitter.test";
const CODE = {
  device_code: "kdc_abc",
  user_code: "BCDF-GHJK",
  verification_uri: "https://app.outfitter.test/device",
  verification_uri_complete: "https://app.outfitter.test/device?code=BCDF-GHJK",
  expires_in: 600,
  interval: 0,
};
const TOKENS = {
  token_type: "Bearer",
  access_token: "kda_1",
  expires_in: 3600,
  refresh_token: "kdr_1",
  refresh_expires_in: 2592000,
  device: { id: "dev_aaaaaaaaaaaaaaaa", name: "ci-box" },
  account: { email: "a@example.com", userId: "u_123" },
  delivery: {},
  problems: [],
};

function answers(routes: Record<string, { status: number; body: unknown }>) {
  const paths: string[] = [];
  const fn = (async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const r = routes[path] ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, paths };
}

function io(extra: Partial<CliIo> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "kernal-cli-")), "auth");
  const out: string[] = [];
  const err: string[] = [];
  const env = { OUTFITTER_API: API, KERNAL_AUTH_DIR: dir, KERNAL_AUTH_BACKEND: "file", ...extra.env };
  return { out, err, dir, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), sleep: async () => {}, ...extra, env } as CliIo };
}

describe("parseArgs and canOpenBrowser", () => {
  test("flags per command", () => {
    assert.deepEqual(parseArgs(["login", "--device-name", "box", "--no-browser"]), { command: "login", deviceName: "box", noBrowser: true, json: false });
    assert.equal(parseArgs(["login", "--device-name=box"]).deviceName, "box");
    assert.match(parseArgs(["login", "--device-name"]).bad!, /needs a name/);
    assert.equal(parseArgs(["whoami", "--json"]).json, true);
    assert.match(parseArgs(["whoami", "--no-browser"]).bad!, /unknown option/);
  });

  test("no browser with KERNAL_NO_BROWSER, over SSH, or on a Linux without a display", () => {
    assert.equal(canOpenBrowser({}, "darwin"), true);
    assert.equal(canOpenBrowser({ KERNAL_NO_BROWSER: "1" }, "darwin"), false);
    assert.equal(canOpenBrowser({ KERNAL_NO_BROWSER: "0" }, "darwin"), true);
    assert.equal(canOpenBrowser({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, "darwin"), false);
    assert.equal(canOpenBrowser({}, "linux"), false);
    assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
    assert.equal(canOpenBrowser({ DISPLAY: ":0", SSH_TTY: "/dev/pts/1" }, "linux"), false);
  });
});

describe("main", () => {
  test("whoami signed out: exit 1; --json says so", async () => {
    const a = io();
    assert.equal(await main(["whoami"], a.io), 1);
    assert.deepEqual(a.out, [`not signed in to ${API}`]);
    assert.equal(await main(["whoami", "--json"], a.io), 1);
    assert.deepEqual(JSON.parse(a.out[1]), { signedIn: false });
  });

  test("login, whoami, logout", async () => {
    const opened: string[] = [];
    const f = answers({
      "/api/device/code": { status: 200, body: CODE },
      "/api/device/token": { status: 200, body: TOKENS },
      "/api/device/revoke": { status: 200, body: {} },
    });
    const a = io({ fetch: f.fn, openUrl: (u) => opened.push(u), platform: "darwin" });
    assert.equal(await main(["login", "--device-name", "ci-box"], a.io), 0);
    assert.deepEqual(opened, [CODE.verification_uri_complete]);
    assert.ok(a.err.some((l) => l.includes("BCDF-GHJK")));
    assert.equal(a.err.at(-1), `Signed in as a@example.com on ${API} (device ci-box)`);
    assert.equal(a.out.length, 0, "login writes nothing to stdout");

    assert.equal(await main(["whoami"], a.io), 0);
    assert.equal(a.out.at(-1), `a@example.com on ${API} (device ci-box)`);
    assert.equal(await main(["whoami", "--json"], a.io), 0);
    assert.deepEqual(JSON.parse(a.out.at(-1)!), {
      signedIn: true,
      account: { api: API, email: "a@example.com", userId: "u_123", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "ci-box" },
    });

    assert.equal(await main(["logout"], a.io), 0);
    assert.equal(a.err.at(-1), `Signed out of ${API} (device ci-box)`);
    assert.deepEqual(f.paths, ["/api/device/code", "/api/device/token", "/api/device/revoke"]);
    assert.equal(await main(["whoami"], a.io), 1);
    assert.equal(await main(["logout"], a.io), 0, "logout when signed out is fine");
  });

  test("--no-browser and KERNAL_NO_BROWSER open nothing", async () => {
    for (const [args, env] of [[["login", "--no-browser"], {}], [["login"], { KERNAL_NO_BROWSER: "1" }]] as const) {
      const opened: string[] = [];
      const f = answers({ "/api/device/code": { status: 200, body: CODE }, "/api/device/token": { status: 200, body: TOKENS } });
      const a = io({ fetch: f.fn, openUrl: (u) => opened.push(u), platform: "darwin", env: env as NodeJS.ProcessEnv });
      assert.equal(await main([...args], a.io), 0);
      assert.deepEqual(opened, []);
    }
  });

  test("a failed login: exit 1 with the reason; usage errors exit 2", async () => {
    const f = answers({ "/api/device/code": { status: 200, body: CODE }, "/api/device/token": { status: 400, body: { error: "access_denied" } } });
    const a = io({ fetch: f.fn, openUrl: () => {} });
    assert.equal(await main(["login"], a.io), 1);
    assert.match(a.err.at(-1)!, /^kernal login: the sign-in was denied/);
    assert.equal(await main(["nope"], a.io), 2);
    assert.equal(await main(["login", "--bogus"], a.io), 2);
  });
});

describe("cli.ts with node", () => {
  /** A fake Outfitter link origin on localhost. */
  async function fakeOutfitter() {
    const seen: { path: string; body: any }[] = [];
    let polls = 0;
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", body: data ? JSON.parse(data) : undefined });
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.url === "/api/device/code") return send(200, CODE);
        if (req.url === "/api/device/token") return ++polls < 2 ? send(400, { error: "authorization_pending" }) : send(200, { ...TOKENS, problems: ["router key: not configured"] });
        if (req.url === "/api/device/revoke") return send(200, {});
        send(404, { error: "not found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    return { api: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
  }

  function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [new URL("../.pi/extensions/kernal-login/cli.ts", import.meta.url).pathname, ...args], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  test("login, whoami, logout end to end; nothing secret on stdout", async () => {
    const srv = await fakeOutfitter();
    const dir = join(mkdtempSync(join(tmpdir(), "kernal-cli-")), "auth");
    const env = { OUTFITTER_API: srv.api, KERNAL_AUTH_DIR: dir, KERNAL_AUTH_BACKEND: "file", KERNAL_NO_BROWSER: "1" };
    try {
      const li = await run(["login", "--device-name", "ci-box"], env);
      assert.equal(li.code, 0, li.stderr);
      assert.match(li.stderr, /enter the code BCDF-GHJK/);
      assert.match(li.stderr, /warning: router key: not configured/);
      assert.match(li.stderr, new RegExp(`Signed in as a@example.com on ${srv.api} \\(device ci-box\\)`));
      assert.equal(srv.seen[0].body.deviceName, "ci-box");
      assert.equal(srv.seen[0].body.kernalVersion, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);

      const who = await run(["whoami"], env);
      assert.equal(who.code, 0);
      assert.equal(who.stdout, `a@example.com on ${srv.api} (device ci-box)\n`);
      assert.ok(!who.stdout.includes("kda_") && !li.stdout.includes("kda_"));

      const out = await run(["logout"], env);
      assert.equal(out.code, 0);
      assert.deepEqual(srv.seen.at(-1), { path: "/api/device/revoke", body: { token: "kdr_1" } });
      assert.equal((await run(["whoami"], env)).code, 1);
      assert.equal((await run([], env)).code, 2);
    } finally {
      srv.close();
    }
  });
});

describe("bin/kernal pi_memory_env", () => {
  /** Runs bin/kernal's pi_memory_env alone under bash and reports whether it turned pi-memory off. */
  function piMemoryOff(env: NodeJS.ProcessEnv): boolean {
    const src = readFileSync(new URL("../bin/kernal", import.meta.url), "utf8");
    const fn = /^pi_memory_env\(\) \{[\s\S]*?^\}$/m.exec(src)![0];
    const r = spawnSync("bash", ["-c", `${fn}\npi_memory_env; printf %s "\${KERNAL_PI_MEMORY_OFF:-}"`], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "kernal-agent-")), ...env },
      encoding: "utf8",
    });
    return r.stdout === "1";
  }

  test("a stored login counts like a Dongle; with neither, pi-memory stays on", () => {
    const HOME = mkdtempSync(join(tmpdir(), "kernal-home-"));
    assert.equal(piMemoryOff({ HOME }), false);
    assert.equal(piMemoryOff({ HOME, OUTFITTER_API: API, OUTFITTER_TOKEN: "outf_x" }), true);
    mkdirSync(join(HOME, ".kernal", "auth"), { recursive: true });
    writeFileSync(join(HOME, ".kernal", "auth", "accounts.json"), "{}");
    assert.equal(piMemoryOff({ HOME }), true);
    const dir = mkdtempSync(join(tmpdir(), "kernal-auth-"));
    assert.equal(piMemoryOff({ HOME: mkdtempSync(join(tmpdir(), "kernal-home-")), KERNAL_AUTH_DIR: dir }), false);
    writeFileSync(join(dir, "accounts.json"), "{}");
    assert.equal(piMemoryOff({ HOME: mkdtempSync(join(tmpdir(), "kernal-home-")), KERNAL_AUTH_DIR: dir }), true);
  });
});
