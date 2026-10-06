/**
 * Explicit /mcp-auth must open the browser even when a gateway refresh token is saved, and the
 * browser URL must carry a client registered for this run's callback port.
 * pi-mcp-adapter is installed by npm ci, so the change ships as a patch applied in package.sh.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = join(root, "scripts/patches/pi-mcp-adapter-force-reauth.patch");
const packageSh = join(root, "scripts/package.sh");
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
  // The guard that skips an already-patched stage must look for lines this patch adds, or a
  // second run re-patches, fails, and set -e stops the release build.
  const patch = readFileSync(patchPath, "utf8");
  const added = patch.split("\n").filter((line) => line.startsWith("+"));
  const markers = [...script.matchAll(/grep -q '([^']+)' "\$MCP_ADAPTER\/([^"]+)"/g)];
  assert.deepEqual(markers.map((m) => m[2]).sort(), ["commands.ts", "mcp-auth-flow.ts", "mcp-oauth-provider.ts"]);
  for (const [, marker] of markers) assert.ok(added.some((line) => line.includes(marker)), `the patch adds "${marker}"`);
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
  const run = (args: string[]) => execFileSync("patch", ["-d", dir, "-p1", "--batch", "--forward", "--fuzz=0", ...args], { input: patch, encoding: "utf8", stdio: "pipe" });
  try {
    // A local checkout may already be patched. CI's npm ci copy is the published package.
    if (readFileSync(join(adapter, "mcp-oauth-provider.ts"), "utf8").includes(PATCHED_MARKER)) {
      execFileSync("patch", ["-d", dir, "-p1", "--batch", "--fuzz=0", "-R"], { input: patch, encoding: "utf8", stdio: "pipe" });
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

test("a forced sign-in skips a client registered for an old callback port and persists nothing until it succeeds", { skip: !canRun }, (t) => {
  if (!patched) return t.skip(LOCAL_EDITS);
  const { adapter } = patched;
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-reauth-agent-"));
  // The callback port is random per run, so a dynamic registration from an earlier run is
  // refused: "redirect_uri is not registered for this client".
  const script = `
    const { createJiti } = await import(${JSON.stringify(jitiPath)});
    const jiti = createJiti(${JSON.stringify(join(adapter, "index.ts"))});
    const auth = await jiti.import(${JSON.stringify(join(adapter, "mcp-auth.ts"))});
    const { McpOAuthProvider, setOAuthCallbackPort } = await jiti.import(${JSON.stringify(join(adapter, "mcp-oauth-provider.ts"))});
    const store = { credentialStore: "encrypted-file" };
    const url = "https://router.example/sentry/mcp";
    setOAuthCallbackPort(60535);
    const provider = () => new McpOAuthProvider("sentry", url, {}, { onRedirect: async () => {} }, store);
    const client = async (p) => (await p.clientInformation())?.client_id ?? null;
    const saved = () => { const e = auth.getAuthForUrl("sentry", url, store); return { client: e?.clientInfo?.clientId ?? null, refresh: e?.tokens?.refreshToken ?? null }; };
    const register = (p) => p.saveClientInformation({ client_id: "new-client", redirect_uris: ["http://localhost:60535/callback"] });
    const out = {};
    auth.updateClientInfo("sentry", { clientId: "old-client", clientIdIssuedAt: 1, redirectUris: ["http://localhost:51000/callback"] }, url, store);
    auth.updateTokens("sentry", { accessToken: "saved-token", refreshToken: "saved-refresh" }, url, store);
    out.normal = await client(provider());
    // The SDK's browser leg: no usable client, so it registers one, then sends the URL.
    const abandoned = provider();
    abandoned.skipStaleClient();
    out.forced = await client(abandoned);
    await register(abandoned);
    out.afterRegister = await client(abandoned);
    out.whileRegistered = saved();
    // invalid_client: the SDK invalidates "client" then "tokens" and retries. The stale client
    // stays skipped, and nothing on disk changes.
    await abandoned.invalidateCredentials("client");
    await abandoned.invalidateCredentials("tokens");
    out.afterInvalidClient = await client(abandoned);
    abandoned.deactivate();
    out.afterAbandon = saved();
    // Completing the flow saves the new client and its tokens together.
    const completed = provider();
    completed.skipStaleClient();
    await register(completed);
    await completed.saveTokens({ access_token: "new-token", refresh_token: "new-refresh", token_type: "Bearer" });
    out.afterComplete = saved();
    const reused = provider();
    reused.skipStaleClient();
    out.forcedCurrentPort = await client(reused);
    console.log(JSON.stringify(out));
  `;
  try {
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: childEnv(agentDir),
      encoding: "utf8",
    }).trim().split("\n").pop()!);
    // Reconnect still refreshes with the saved client.
    assert.equal(out.normal, "old-client");
    // Explicit auth skips the stale client, so the SDK registers the current callback.
    assert.equal(out.forced, null);
    assert.equal(out.afterRegister, "new-client");
    // The registration stays in memory: the saved client and refresh token remain a pair.
    assert.deepEqual(out.whileRegistered, { client: "old-client", refresh: "saved-refresh" });
    assert.equal(out.afterInvalidClient, null);
    assert.deepEqual(out.afterAbandon, { client: "old-client", refresh: "saved-refresh" });
    assert.deepEqual(out.afterComplete, { client: "new-client", refresh: "new-refresh" });
    // A registration that already lists this callback is reused.
    assert.equal(out.forcedCurrentPort, "new-client");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
