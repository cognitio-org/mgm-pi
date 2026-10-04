/**
 * The `.env` import offer after `kernal login` (#399 CA-10, central-auth.md §12.1): env-import.ts
 * driven with a fake Outfitter (fetch), a file-backed login in a temporary KERNAL_AUTH_DIR and
 * temporary `.env` files. No real server, no keychain.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CliIo } from "../.pi/extensions/kernal-login/commands.ts";
import {
  findEnvVars, kernalEnvFiles, offerEnvImport, removeEnvLine, terminalAsk, type EnvImportIo,
} from "../.pi/extensions/kernal-login/env-import.ts";

const API = "https://link.outfitter.test";
const OR_KEY = "sk-or-v1-abcdefghijklmnop1234";
const DG_KEY = "dg_0123456789abcdefWXYZ";
const OA_KEY = "sk-proj-0123456789abcdefWXYZ";

type Call = { method: string; path: string; auth?: string; body?: unknown };

/** A fake Outfitter: the device login, and PUT /api/me/provider-keys/:provider answering `put`. */
function outfitter(opts: { routerKey?: boolean; put?: (provider: string) => number } = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path, auth: headers.authorization, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (path === "/api/device/code") {
      return json(200, { device_code: "kdc_abc", user_code: "BCDF-GHJK", verification_uri: "https://app.outfitter.test/device",
        verification_uri_complete: "https://app.outfitter.test/device?code=BCDF-GHJK", expires_in: 600, interval: 0 });
    }
    if (path === "/api/device/token") {
      return json(200, {
        token_type: "Bearer", access_token: "kda_1", expires_in: 3600, refresh_token: "kdr_1", refresh_expires_in: 2592000,
        device: { id: "dev_aaaaaaaaaaaaaaaa", name: "ci-box" }, account: { email: "a@example.com", userId: "u_123" },
        delivery: opts.routerKey ? { routerKey: { key: "sk-device", baseUrl: "https://router.test/v1", alias: "kernal-device-dev_aaaaaaaaaaaaaaaa" } } : {},
        problems: [],
      });
    }
    const m = path.match(/^\/api\/me\/provider-keys\/([a-z]+)$/);
    if (m && init.method === "PUT") {
      const status = opts.put?.(m[1]) ?? 200;
      return status === 200
        ? json(200, { provider: m[1], last4: String(body.value).slice(-4), setAt: "2026-10-04T10:00:00.000Z" })
        : json(status, { error: status === 400 ? "invalid_value" : "nope" });
    }
    return json(404, { error: "not found" });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** A signed-in machine: a temporary home with ~/localllm/.env holding `envText`. */
async function signedIn(envText: string, opts: { routerKey?: boolean; put?: (provider: string) => number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kernal-migrate-"));
  mkdirSync(join(home, "localllm"));
  const envFile = join(home, "localllm", ".env");
  writeFileSync(envFile, envText, { mode: 0o600 });
  const env = { HOME: home, OUTFITTER_API: API, KERNAL_AUTH_DIR: join(home, ".kernal", "auth"), KERNAL_AUTH_BACKEND: "file" };
  const server = outfitter(opts);
  const lines: string[] = [];
  const cli: CliIo = { out: () => {}, err: () => {}, env, fetch: server.fn, sleep: async () => {} };
  assert.equal(await main(["login", "--no-browser"], cli), 0);
  const asked: string[] = [];
  const io = (answers: string[] = []): EnvImportIo => ({
    err: (l) => lines.push(l),
    ask: async (q) => { asked.push(q); return answers.shift() ?? ""; },
    env,
    fetch: server.fn,
    now: () => new Date("2026-10-04T10:20:30.000Z"),
  });
  return { home, envFile, env, server, lines, asked, io };
}

describe("finding keys in .env", () => {
  test("kernalEnvFiles: ~/localllm/.env and the two next to the bundle, each once, existing only", () => {
    const home = mkdtempSync(join(tmpdir(), "kernal-envfiles-"));
    mkdirSync(join(home, "localllm", "kernal", ".pi"), { recursive: true });
    writeFileSync(join(home, "localllm", ".env"), "A=1\n");
    // A source checkout: the agent dir is ~/localllm/kernal/.pi, so ROOT/../.env is ~/localllm/.env.
    const checkout = kernalEnvFiles({ HOME: home, PI_CODING_AGENT_DIR: join(home, "localllm", "kernal", ".pi") });
    assert.equal(checkout.length, 1);
    assert.match(checkout[0], /localllm\/\.env$/);
    writeFileSync(join(home, "localllm", "kernal", ".env"), "B=1\n");
    const both = kernalEnvFiles({ HOME: home, PI_CODING_AGENT_DIR: join(home, "localllm", "kernal", ".pi") });
    assert.equal(both.length, 2);
    assert.match(both[1], /kernal\/\.env$/);
    assert.deepEqual(kernalEnvFiles({ HOME: join(home, "nowhere") }), []);
  });

  test("findEnvVars: the nearest file's value, and every file holding exactly that value", () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-find-"));
    const a = join(dir, "a.env");
    const b = join(dir, "b.env");
    writeFileSync(a, `OPENROUTER_API_KEY=old\nDEEPGRAM_API_KEY="${DG_KEY}"\n`);
    writeFileSync(b, `export OPENROUTER_API_KEY=${OR_KEY}\nDEEPGRAM_API_KEY=${DG_KEY}\nOPENAI_API_KEY=\n`);
    assert.deepEqual(findEnvVars([a, b], ["OPENROUTER_API_KEY", "DEEPGRAM_API_KEY", "OPENAI_API_KEY"]), [
      { name: "OPENROUTER_API_KEY", value: OR_KEY, files: [b] },
      { name: "DEEPGRAM_API_KEY", value: DG_KEY, files: [a, b] },
    ]);
  });

  test("removeEnvLine drops only the line with that value", () => {
    const text = `# keys\nexport OPENROUTER_API_KEY="${OR_KEY}"\nOPENROUTER_API_KEY=other\nLITELLM_BASE_URL=x\n`;
    assert.equal(removeEnvLine(text, "OPENROUTER_API_KEY", OR_KEY), "# keys\nOPENROUTER_API_KEY=other\nLITELLM_BASE_URL=x\n");
    assert.equal(removeEnvLine(text, "OPENAI_API_KEY", OR_KEY), text);
  });

  test("terminalAsk: nothing is asked without a terminal", () => {
    const notTty = { isTTY: false } as unknown as NodeJS.ReadStream;
    assert.equal(terminalAsk(notTty, { isTTY: true } as unknown as NodeJS.WriteStream), undefined);
    assert.equal(terminalAsk({ isTTY: true } as unknown as NodeJS.ReadStream, { isTTY: false } as unknown as NodeJS.WriteStream), undefined);
  });
});

describe("offerEnvImport", () => {
  test("yes: uploads with the device token, removes the line, keeps a 0600 backup", async () => {
    const s = await signedIn(`# mine\nOPENROUTER_API_KEY=${OR_KEY}\nLITELLM_BASE_URL=https://router.test/v1\n`);
    const r = await offerEnvImport(s.io(["y"]));
    assert.deepEqual(r.uploaded, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(r.removed, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(r.kept, []);
    const put = s.server.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.path, "/api/me/provider-keys/openrouter");
    assert.equal(put.auth, "Bearer kda_1");
    assert.deepEqual(put.body, { value: OR_KEY });
    assert.equal(s.asked.length, 1);
    assert.match(s.asked[0], /Upload OPENROUTER_API_KEY \(…1234\).*personal openrouter key.*\[y\/N\]/);
    assert.ok(!s.asked[0].includes(OR_KEY), "the question never shows the whole key");
    assert.equal(readFileSync(s.envFile, "utf8"), "# mine\nLITELLM_BASE_URL=https://router.test/v1\n");
    assert.equal(statSync(s.envFile).mode & 0o777, 0o600);
    assert.deepEqual(r.backups, [`${realpathSync(s.envFile)}.bak-20261004T102030Z`]);
    assert.match(readFileSync(r.backups[0], "utf8"), new RegExp(`OPENROUTER_API_KEY=${OR_KEY}`));
    assert.equal(statSync(r.backups[0]).mode & 0o777, 0o600);
    assert.ok(!s.lines.some((l) => l.includes(OR_KEY)), "no output line carries the key");
  });

  test("no (the default): nothing uploaded or changed, and a deprecation warning", async () => {
    const text = `OPENROUTER_API_KEY=${OR_KEY}\nOPENAI_API_KEY=${OA_KEY}\n`;
    const s = await signedIn(text);
    const r = await offerEnvImport(s.io(["n", ""]));
    assert.deepEqual(r.uploaded, []);
    assert.deepEqual(r.kept, ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]);
    assert.equal(s.asked.length, 2, "asks once per key");
    assert.ok(!s.server.calls.some((c) => c.method === "PUT"));
    assert.equal(readFileSync(s.envFile, "utf8"), text);
    assert.equal(readdirSync(join(s.home, "localllm")).length, 1, "no backup without a change");
    assert.ok(s.lines.includes("OPENROUTER_API_KEY in .env is deprecated: run kernal login again to move it to your account, or save it with /admin"));
  });

  test("without a terminal: asks nothing, changes nothing, warns", async () => {
    const text = `OPENROUTER_API_KEY=${OR_KEY}\nOUTFITTER_TOKEN=outf_abc\n`;
    const s = await signedIn(text);
    const r = await offerEnvImport({ ...s.io(), ask: undefined });
    assert.deepEqual(r.kept, ["OPENROUTER_API_KEY", "OUTFITTER_TOKEN"]);
    assert.equal(readFileSync(s.envFile, "utf8"), text);
    assert.ok(!s.server.calls.some((c) => c.method === "PUT"));
    assert.ok(s.lines.includes("OUTFITTER_TOKEN in .env is deprecated: kernal login replaces it"));
  });

  test("an upload the server refuses keeps the key in .env", async () => {
    const text = `OPENROUTER_API_KEY=${OR_KEY}\nOPENAI_API_KEY=${OA_KEY}\n`;
    const s = await signedIn(text, { put: (p) => (p === "openrouter" ? 503 : 200) });
    const r = await offerEnvImport(s.io(["y", "yes"]));
    assert.deepEqual(r.uploaded, ["OPENAI_API_KEY"]);
    assert.deepEqual(r.kept, ["OPENROUTER_API_KEY"]);
    assert.equal(readFileSync(s.envFile, "utf8"), `OPENROUTER_API_KEY=${OR_KEY}\n`);
    assert.ok(s.lines.some((l) => l === "Could not upload OPENROUTER_API_KEY: the server answered 503 (nope). It stays in .env."));
  });

  test("LITELLM_AGENT_KEY is never uploaded; with a device router key it may be removed", async () => {
    const s = await signedIn(`LITELLM_AGENT_KEY=sk-shared-1234567\nOUTFITTER_TOKEN=outf_abc\n`, { routerKey: true });
    const r = await offerEnvImport(s.io(["y", "n"]));
    assert.ok(!s.server.calls.some((c) => c.method === "PUT"));
    assert.match(s.asked[0], /^Remove LITELLM_AGENT_KEY from .*This device's own router key replaces it/);
    assert.match(s.asked[1], /^Remove OUTFITTER_TOKEN from .*This login replaces the Dongle/);
    assert.deepEqual(r.removed, ["LITELLM_AGENT_KEY"]);
    assert.deepEqual(r.kept, ["OUTFITTER_TOKEN"]);
    assert.equal(readFileSync(s.envFile, "utf8"), "OUTFITTER_TOKEN=outf_abc\n");
  });

  test("without a device router key LITELLM_AGENT_KEY is left alone and not asked about", async () => {
    const text = "LITELLM_AGENT_KEY=sk-shared-1234567\n";
    const s = await signedIn(text);
    const r = await offerEnvImport(s.io(["y"]));
    assert.equal(s.asked.length, 0);
    assert.deepEqual(r, { uploaded: [], removed: [], kept: [], backups: [] });
    assert.equal(readFileSync(s.envFile, "utf8"), text);
  });

  test("the bundle's shared DEEPGRAM_API_KEY is neither offered nor warned about", async () => {
    const text = `# Shared voice key (pi-listen Deepgram streaming); /setup adds the rest.\nDEEPGRAM_API_KEY=${DG_KEY}\n`;
    const s = await signedIn(text);
    const r = await offerEnvImport(s.io(["y"]));
    assert.equal(s.asked.length, 0);
    assert.deepEqual(r, { uploaded: [], removed: [], kept: [], backups: [] });
    assert.equal(readFileSync(s.envFile, "utf8"), text);
  });

  test("a value that is not a key is not offered", async () => {
    const s = await signedIn("OPENROUTER_API_KEY=short\n");
    const r = await offerEnvImport(s.io(["y"]));
    assert.equal(s.asked.length, 0);
    assert.deepEqual(r.kept, ["OPENROUTER_API_KEY"]);
  });

  test("two files, two values for a provider key: the other value is asked about, then warned about", async () => {
    const s = await signedIn("OPENROUTER_API_KEY=sk-or-v1-oldoldoldold9876\n");
    const near = join(s.home, "near.env");
    writeFileSync(near, `OPENROUTER_API_KEY=${OR_KEY}\n`, { mode: 0o600 });
    const files = [realpathSync(s.envFile), realpathSync(near)];
    // Upload the nearest value, then say no to the older one left in ~/localllm/.env.
    const r = await offerEnvImport({ ...s.io(["y", "n"]), files });
    assert.deepEqual(r.uploaded, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(r.removed, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(r.kept, ["OPENROUTER_API_KEY"]);
    assert.equal(s.asked.length, 2);
    assert.match(s.asked[1], /^OPENROUTER_API_KEY is also set to a different value \(…9876\) in .*localllm\/\.env, which would now override your account key\. Remove it too\? \[y\/N\]/);
    assert.equal(readFileSync(near, "utf8"), "");
    assert.equal(readFileSync(s.envFile, "utf8"), "OPENROUTER_API_KEY=sk-or-v1-oldoldoldold9876\n");
    assert.ok(s.lines.some((l) => /^OPENROUTER_API_KEY is still set to a different value in .*localllm\/\.env; it overrides your account key until you remove it$/.test(l)));
    assert.ok(!s.lines.some((l) => l.includes("is deprecated")), "the specific warning replaces the generic one");
    assert.ok(!s.lines.some((l) => l.includes("oldoldold") || l.includes(OR_KEY)), "no output line carries a key");
  });

  test("two files, two values for LITELLM_AGENT_KEY: yes to both removes both", async () => {
    const s = await signedIn("LITELLM_AGENT_KEY=sk-shared-older-1111\n", { routerKey: true });
    const near = join(s.home, "near.env");
    writeFileSync(near, "LITELLM_AGENT_KEY=sk-shared-newer-2222\nLITELLM_BASE_URL=x\n", { mode: 0o600 });
    const files = [realpathSync(s.envFile), realpathSync(near)];
    const r = await offerEnvImport({ ...s.io(["y", "y"]), files });
    assert.match(s.asked[0], /^Remove LITELLM_AGENT_KEY from .*near\.env\?/);
    assert.match(s.asked[1], /^LITELLM_AGENT_KEY is also set to a different value \(…1111\) in .*localllm\/\.env, which would now override this device's own router key/);
    assert.deepEqual(r.removed, ["LITELLM_AGENT_KEY"]);
    assert.deepEqual(r.kept, []);
    assert.equal(r.backups.length, 2);
    assert.equal(readFileSync(near, "utf8"), "LITELLM_BASE_URL=x\n");
    assert.equal(readFileSync(s.envFile, "utf8"), "");
    assert.deepEqual(findEnvVars(files, ["LITELLM_AGENT_KEY"]), []);
  });

  test("two files, two values for LITELLM_AGENT_KEY: no to the older one warns that it overrides the device key", async () => {
    const s = await signedIn("LITELLM_AGENT_KEY=sk-shared-older-1111\n", { routerKey: true });
    const near = join(s.home, "near.env");
    writeFileSync(near, "LITELLM_AGENT_KEY=sk-shared-newer-2222\n", { mode: 0o600 });
    const r = await offerEnvImport({ ...s.io(["y", ""]), files: [realpathSync(s.envFile), realpathSync(near)] });
    assert.deepEqual(r.kept, ["LITELLM_AGENT_KEY"]);
    assert.equal(readFileSync(s.envFile, "utf8"), "LITELLM_AGENT_KEY=sk-shared-older-1111\n");
    assert.ok(s.lines.some((l) => /^LITELLM_AGENT_KEY is still set to a different value in .*localllm\/\.env; it overrides this device's own router key until you remove it$/.test(l)));
  });

  test("no .env files: nothing to do", async () => {
    const r = await offerEnvImport({ err: () => assert.fail("no output"), ask: async () => assert.fail("no question"), files: [] });
    assert.deepEqual(r, { uploaded: [], removed: [], kept: [], backups: [] });
  });
});

describe("cli.ts with node", () => {
  test("a scripted kernal login (no terminal) asks nothing, leaves .env alone and warns", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        if (req.url === "/api/device/code") {
          return send(200, { device_code: "kdc_abc", user_code: "BCDF-GHJK", verification_uri: "http://x/device",
            verification_uri_complete: "http://x/device?code=BCDF-GHJK", expires_in: 600, interval: 0 });
        }
        if (req.url === "/api/device/token") {
          return send(200, { token_type: "Bearer", access_token: "kda_1", expires_in: 3600, refresh_token: "kdr_1", refresh_expires_in: 2592000,
            device: { id: "dev_aaaaaaaaaaaaaaaa", name: "ci-box" }, account: { email: "a@example.com", userId: "u_123" }, delivery: {}, problems: [] });
        }
        send(404, { error: "not found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const home = mkdtempSync(join(tmpdir(), "kernal-migrate-cli-"));
    mkdirSync(join(home, "localllm"));
    const text = `OPENROUTER_API_KEY=${OR_KEY}\n`;
    writeFileSync(join(home, "localllm", ".env"), text);
    try {
      const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [new URL("../.pi/extensions/kernal-login/cli.ts", import.meta.url).pathname, "login"], {
          env: { PATH: process.env.PATH, HOME: home, OUTFITTER_API: `http://127.0.0.1:${port}`, KERNAL_AUTH_DIR: join(home, "auth"),
            KERNAL_AUTH_BACKEND: "file", KERNAL_NO_BROWSER: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (code) => resolve({ code, stderr }));
      });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /Signed in as a@example.com/);
      assert.match(r.stderr, /OPENROUTER_API_KEY in .env is deprecated/);
      assert.doesNotMatch(r.stderr, /\[y\/N\]/);
      assert.equal(readFileSync(join(home, "localllm", ".env"), "utf8"), text);
    } finally {
      server.close();
    }
  });
});
