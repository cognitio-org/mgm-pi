/**
 * Explicit /mcp-auth must open the browser even when a gateway refresh token is saved, and the
 * browser URL must carry a client registered for this run's callback port.
 * pi-mcp-adapter is installed by npm ci, so the change ships as a patch applied in package.sh.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = join(root, "scripts/patches/pi-mcp-adapter-force-reauth.patch");
const packageSh = join(root, "scripts/package.sh");
const applyScript = join(root, "scripts/apply-adapter-patch.sh");
const modules = join(root, ".pi/npm/node_modules");
const adapterPath = join(modules, "pi-mcp-adapter");
const jitiPath = join(modules, "jiti/lib/jiti.mjs");
const PATCHED_MARKER = "skipStaleClient(): void";
const canRun = existsSync(adapterPath) && existsSync(jitiPath);

test("package.sh reapplies the explicit re-auth patch after npm ci", () => {
  const script = readFileSync(packageSh, "utf8");
  const ci = script.indexOf("npm ci --legacy-peer-deps");
  const apply = script.indexOf("pi-mcp-adapter-force-reauth.patch");
  assert.ok(ci > 0 && apply > ci, "the patch must run after npm ci replaces node_modules");
  assert.match(script, /"\$ROOT\/scripts\/apply-adapter-patch\.sh" "\$STAGE\/\.pi\/npm\/node_modules" "\$ROOT\/scripts\/patches\/pi-mcp-adapter-force-reauth\.patch"/);
});

// The release build's own patch step, run for real with the system `patch` (BSD on a Mac, GNU in
// CI). kernal 0.3.9 shipped unpatched because a reverse dry run with GNU --batch "succeeded" on an
// unpatched tree; only running it catches that.
test("apply-adapter-patch.sh applies once, then skips, and refuses a partly patched tree", { skip: !existsSync(adapterPath) }, () => {
  const files = ["mcp-auth-flow.ts", "mcp-oauth-provider.ts", "commands.ts"];
  const dir = mkdtempSync(join(tmpdir(), "adapter-patch-"));
  const pkg = join(dir, "pi-mcp-adapter");
  try {
    cpSync(adapterPath, pkg, { recursive: true, filter: (src) => src === adapterPath || files.includes(basename(src)) });
    if (readFileSync(join(pkg, "mcp-oauth-provider.ts"), "utf8").includes(PATCHED_MARKER)) {
      execFileSync("patch", ["-d", dir, "-p1", "-R", "--force", "--fuzz=0", "-s"], { input: readFileSync(patchPath), stdio: ["pipe", "ignore", "ignore"] });
    }
    const pristine = files.map((f) => readFileSync(join(pkg, f), "utf8"));
    const apply = () => execFileSync(applyScript, [dir, patchPath], { encoding: "utf8", stdio: "pipe" });
    assert.match(apply(), /^applied /m);
    const patched = files.map((f) => readFileSync(join(pkg, f), "utf8"));
    assert.ok(patched[1].includes(PATCHED_MARKER), "the patch landed");
    assert.match(patched[0], /authProvider\.skipStaleClient\(\)/);
    assert.match(patched[2], /forceReauthorization: true,/);
    assert.match(apply(), /^already applied: /m);
    assert.deepEqual(files.map((f) => readFileSync(join(pkg, f), "utf8")), patched, "a second run changes nothing");
    // Half the fix: one file back to the published version.
    writeFileSync(join(pkg, "commands.ts"), pristine[2]);
    assert.throws(apply, (error: { status?: number }) => error.status === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * One patched copy of the published adapter's source, inside node_modules so its imports
 * resolve. Locally, undefined when the copy carries some other edit (an earlier version of this
 * patch): run npm ci. In CI the copy is the published package, so a patch that no longer applies
 * fails the test with patch's own output.
 */
let patched: { dir: string; adapter: string } | undefined;

before(() => {
  if (!canRun) {
    // CI installs the lockfile, so a missing adapter or jiti there is a broken install.
    if (process.env.CI) throw new Error(`pi-mcp-adapter or jiti is missing from ${modules}`);
    return;
  }
  // A killed run skips its after hook. Clear its copies, but not a concurrent run's.
  for (const name of readdirSync(modules)) {
    if (!name.startsWith(".mcp-reauth-")) continue;
    const path = join(modules, name);
    const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    if (mtime !== undefined && Date.now() - mtime > 60 * 60_000) rmSync(path, { recursive: true, force: true });
  }
  const dir = mkdtempSync(join(modules, ".mcp-reauth-"));
  const adapter = join(dir, "pi-mcp-adapter");
  // Source only: the docs, examples, bundled skills and dist build are not imported.
  // Top level only, so nested dependencies and same-named source folders are kept.
  const skip = new Set(["dist", "examples", "skills"]);
  cpSync(adapterPath, adapter, {
    recursive: true,
    filter: (src) => dirname(src) !== adapterPath || !(skip.has(basename(src)) || /\.(md|png)$/.test(src)),
  });
  const patch = readFileSync(patchPath);
  const run = (args: string[]) => execFileSync("patch", ["-d", dir, "-p1", "--forward", "--fuzz=0", ...args], { input: patch, encoding: "utf8", stdio: "pipe" });
  try {
    // A local checkout may already be patched. CI's npm ci copy is the published package.
    if (readFileSync(join(adapter, "mcp-oauth-provider.ts"), "utf8").includes(PATCHED_MARKER)) {
      execFileSync("patch", ["-d", dir, "-p1", "--force", "--fuzz=0", "-R"], { input: patch, encoding: "utf8", stdio: "pipe" });
    }
    run([]);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    if (process.env.CI) throw new Error(`the re-auth patch no longer applies to the pinned pi-mcp-adapter:\n${stdout}${stderr}`);
    return;
  }
  patched = { dir, adapter };
});

after(() => {
  if (patched) rmSync(patched.dir, { recursive: true, force: true });
});

const LOCAL_EDITS = "the local pi-mcp-adapter has other edits; run npm ci in .pi/npm";

test("the patch forces re-auth only for explicit /mcp-auth", { skip: !canRun }, (t) => {
  if (!patched) return t.skip(LOCAL_EDITS);
  const flow = readFileSync(join(patched.adapter, "mcp-auth-flow.ts"), "utf8");
  const commands = readFileSync(join(patched.adapter, "commands.ts"), "utf8");
  // The SDK skips the saved refresh token; the provider skips a client for another port.
  assert.equal((flow.match(/forceReauthorization: options\.forceReauthorization === true/g) ?? []).length, 1);
  assert.equal((flow.match(/authProvider\.skipStaleClient\(\)/g) ?? []).length, 1);
  // startAuth's cleanup leaves the saved entry alone on a forced flow.
  assert.match(flow, /if \(options\.forceReauthorization !== true\) clearClientInfo\(/);
  const reconnect = commands.slice(
    commands.indexOf("export async function reconnectServer"),
    commands.indexOf("export async function authenticateServer"),
  );
  assert.doesNotMatch(reconnect, /forceReauthorization/);
  assert.equal((commands.match(/forceReauthorization: true/g) ?? []).length, 1);
});

/** The parent's env minus anything that points the adapter's credential store at a real home. */
function childEnv(agentDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "PI_PACKAGE_DIR" || name === "MCP_OAUTH_DIR" || name.endsWith("_CODING_AGENT_DIR")) delete env[name];
  }
  return { ...env, PI_CODING_AGENT_DIR: agentDir, PI_MCP_ADAPTER_OAUTH_FILE_KEY: randomBytes(32).toString("base64") };
}

/**
 * Drives the SDK's own auth() against a local authorization server, the way startAuth and the
 * callback do, so every call the SDK makes into the provider (including its re-save of the saved
 * tokens to stamp an issuer) is exercised. The saved tokens predate issuer binding.
 */
const SDK_FLOW = String.raw`
  const http = await import("node:http");
  const { createJiti } = await import(process.env.JITI);
  const adapter = process.env.ADAPTER;
  const jiti = createJiti(adapter + "/index.ts");
  const auth = await jiti.import(adapter + "/mcp-auth.ts");
  const { McpOAuthProvider, setOAuthCallbackPort } = await jiti.import(adapter + "/mcp-oauth-provider.ts");
  const { auth: runSdkAuth } = await jiti.import("@modelcontextprotocol/client");

  const seen = { registered: 0, refreshes: [], exchanges: 0 };
  let rejectCode = false;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const base = "http://127.0.0.1:" + server.address().port;
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const path = req.url.split("?")[0];
    if (path === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: base + "/mcp", authorization_servers: [base] });
    if (path === "/.well-known/oauth-authorization-server") return json(200, {
      issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token",
      registration_endpoint: base + "/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    });
    if (path === "/register") {
      seen.registered += 1;
      return json(201, { ...JSON.parse(body), client_id: "client-" + seen.registered });
    }
    if (path === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        seen.refreshes.push(form.get("client_id"));
        return json(200, { access_token: "refreshed-token", refresh_token: "saved-refresh", token_type: "Bearer" });
      }
      seen.exchanges += 1;
      if (rejectCode) return json(400, { error: "invalid_client" });
      return json(200, { access_token: "new-token", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    json(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = "http://127.0.0.1:" + server.address().port + "/mcp";
  const store = { credentialStore: "encrypted-file" };
  setOAuthCallbackPort(60535);

  const seed = () => {
    auth.updateClientInfo("sentry", { clientId: "old-client", clientIdIssuedAt: 1, redirectUris: ["http://localhost:51000/callback"] }, serverUrl, store);
    auth.updateTokens("sentry", { accessToken: "saved-token", refreshToken: "saved-refresh" }, serverUrl, store);
  };
  const saved = () => { const e = auth.getAuthForUrl("sentry", serverUrl, store); return { client: e?.clientInfo?.clientId ?? null, refresh: e?.tokens?.refreshToken ?? null }; };
  const redirects = [];
  const provider = (state) => new McpOAuthProvider("sentry", serverUrl, {}, { onRedirect: async (url) => { redirects.push(url) } }, store, undefined, state);
  // startAuth's forced path: skip the stale client, then the browser leg.
  const browserLeg = async (p) => { p.skipStaleClient(); return runSdkAuth(p, { serverUrl, forceReauthorization: true }); };
  const out = {};

  seed();
  const abandoned = provider("state-1");
  out.firstLeg = await browserLeg(abandoned);
  const url = new URL(redirects.at(-1));
  out.redirect = { client: url.searchParams.get("client_id"), redirectUri: url.searchParams.get("redirect_uri") };
  out.refreshesWhenForced = seen.refreshes.length;
  out.afterBrowserLeg = saved();
  abandoned.deactivate();
  out.afterAbandon = saved();

  // The SDK re-saves the saved tokens after registering when they carry no issuer. tokens()
  // stamps one first in practice, so make that call directly: it must not commit the new client.
  const resave = provider("state-5");
  resave.skipStaleClient();
  await resave.saveClientInformation({ client_id: "client-resave", redirect_uris: ["http://localhost:60535/callback"] });
  await resave.saveTokens({ access_token: "saved-token", refresh_token: "saved-refresh", token_type: "Bearer" });
  out.afterResave = saved();
  resave.deactivate();

  const rejected = provider("state-2");
  await browserLeg(rejected);
  rejectCode = true;
  out.rejectedError = await runSdkAuth(rejected, { serverUrl, authorizationCode: "code", forceReauthorization: true }).then(() => null, (e) => e.message);
  rejectCode = false;
  rejected.deactivate();
  out.afterRejected = saved();

  const completed = provider("state-3");
  await browserLeg(completed);
  out.completed = await runSdkAuth(completed, { serverUrl, authorizationCode: "code", forceReauthorization: true });
  out.afterComplete = saved();

  seed();
  out.reconnect = await runSdkAuth(provider(), { serverUrl });
  out.reconnectRefreshedWith = seen.refreshes.at(-1);

  const cimdUrl = "https://kernal.example/oauth-client.json";
  auth.updateClientInfo("sentry", { clientId: cimdUrl, redirectUris: ["http://localhost:51000/callback"] }, serverUrl, store);
  const cimd = new McpOAuthProvider("sentry", serverUrl, { clientMetadataUrl: cimdUrl }, { onRedirect: async () => {} }, store, undefined, "state-4");
  cimd.skipStaleClient();
  out.cimdClient = (await cimd.clientInformation())?.client_id ?? null;

  server.close();
  console.log(JSON.stringify(out));
`;

test("a forced sign-in registers a client for this callback and persists nothing until the code is exchanged", { skip: !canRun }, (t) => {
  if (!patched) return t.skip(LOCAL_EDITS);
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-reauth-agent-"));
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", SDK_FLOW], {
      env: { ...childEnv(agentDir), JITI: jitiPath, ADAPTER: patched.adapter },
      encoding: "utf8",
    });
    const out = JSON.parse(stdout.trim().split("\n").pop()!);
    // The browser URL carries a client registered for this run's callback, not the saved one
    // (the router answered that with "redirect_uri is not registered for this client").
    assert.equal(out.firstLeg, "REDIRECT");
    assert.deepEqual(out.redirect, { client: "client-1", redirectUri: "http://localhost:60535/callback" });
    assert.equal(out.refreshesWhenForced, 0, "forceReauthorization skips the saved refresh token");
    // The SDK re-saved the issuer-less saved tokens on that leg: they stay with the saved client.
    assert.deepEqual(out.afterBrowserLeg, { client: "old-client", refresh: "saved-refresh" });
    assert.deepEqual(out.afterAbandon, { client: "old-client", refresh: "saved-refresh" });
    assert.deepEqual(out.afterResave, { client: "old-client", refresh: "saved-refresh" });
    // invalid_client at the token endpoint: the sign-in fails and the saved pair is untouched.
    assert.ok(out.rejectedError);
    assert.deepEqual(out.afterRejected, { client: "old-client", refresh: "saved-refresh" });
    // The code exchange saves the new client and its tokens together.
    assert.equal(out.completed, "AUTHORIZED");
    assert.deepEqual(out.afterComplete, { client: "client-3", refresh: "new-refresh" });
    // Reconnect still refreshes with the saved client.
    assert.equal(out.reconnect, "AUTHORIZED");
    assert.equal(out.reconnectRefreshedWith, "old-client");
    // A metadata-document client is not bound to a redirect URI, so it is not skipped.
    assert.equal(out.cimdClient, "https://kernal.example/oauth-client.json");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
