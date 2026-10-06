/**
 * Explicit /mcp-auth must open the browser even when a gateway refresh token is saved, and the
 * browser URL must carry a client registered for this run's callback port.
 * pi-mcp-adapter is installed by npm ci, so the change ships as a patch applied in package.sh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = join(root, "scripts/patches/pi-mcp-adapter-force-reauth.patch");
const packageSh = join(root, "scripts/package.sh");
const modules = join(root, ".pi/npm/node_modules");
const adapterPath = join(modules, "pi-mcp-adapter");
const jitiPath = join(modules, "jiti/lib/jiti.mjs");
const PATCHED_MARKER = "async skipStoredSession()";

test("package.sh reapplies the explicit re-auth patch after npm ci", () => {
  const script = readFileSync(packageSh, "utf8");
  const ci = script.indexOf("npm ci --legacy-peer-deps");
  const apply = script.indexOf("pi-mcp-adapter-force-reauth.patch");
  assert.ok(ci > 0 && apply > ci, "the patch must run after npm ci replaces node_modules");
  const patch = readFileSync(patchPath, "utf8");
  assert.match(patch, /forceReauthorization: true/);
  assert.match(patch, /await authProvider\.skipStoredSession\(\)/);
  assert.doesNotMatch(patch, /reconnectServer/);
});

/** A patched copy of the published adapter, inside node_modules so its imports resolve. */
function patchedAdapter(): { dir: string; adapter: string } {
  const dir = mkdtempSync(join(modules, ".mcp-reauth-"));
  const adapter = join(dir, "pi-mcp-adapter");
  cpSync(adapterPath, adapter, { recursive: true });
  const patch = readFileSync(patchPath);
  // A local checkout may already be patched. CI's npm ci copy is the published package.
  if (readFileSync(join(adapter, "mcp-oauth-provider.ts"), "utf8").includes(PATCHED_MARKER)) {
    execFileSync("patch", ["-d", dir, "-p1", "-R", "--batch"], { input: patch });
  }
  execFileSync("patch", ["-d", dir, "-p1", "--batch"], { input: patch });
  return { dir, adapter };
}

test("the patch forces re-auth only for explicit /mcp-auth", { skip: !existsSync(adapterPath) }, () => {
  const { dir, adapter } = patchedAdapter();
  try {
    const flow = readFileSync(join(adapter, "mcp-auth-flow.ts"), "utf8");
    const commands = readFileSync(join(adapter, "commands.ts"), "utf8");
    assert.equal((flow.match(/await authProvider\.skipStoredSession\(\)/g) ?? []).length, 1);
    const reconnect = commands.slice(
      commands.indexOf("export async function reconnectServer"),
      commands.indexOf("export async function authenticateServer"),
    );
    assert.doesNotMatch(reconnect, /forceReauthorization/);
    assert.equal((commands.match(/forceReauthorization: true/g) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forced sign-in hides the saved session and a client registered for an old callback port", { skip: !existsSync(adapterPath) }, () => {
  const { dir, adapter } = patchedAdapter();
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-reauth-agent-"));
  // The SDK refreshes any saved refresh token, and sends the saved client in the browser URL. The
  // callback port is random per run, so a dynamic registration from an earlier run is refused:
  // "redirect_uri is not registered for this client".
  const script = `
    const { createJiti } = await import(${JSON.stringify(jitiPath)});
    const jiti = createJiti(${JSON.stringify(join(adapter, "index.ts"))});
    const auth = await jiti.import(${JSON.stringify(join(adapter, "mcp-auth.ts"))});
    const { McpOAuthProvider, setOAuthCallbackPort } = await jiti.import(${JSON.stringify(join(adapter, "mcp-oauth-provider.ts"))});
    const store = { credentialStore: "encrypted-file" };
    const url = "https://router.example/sentry/mcp";
    setOAuthCallbackPort(60535);
    const view = async (forced) => {
      const p = new McpOAuthProvider("sentry", url, {}, { onRedirect: async () => {} }, store);
      if (forced) await p.skipStoredSession();
      return { client: (await p.clientInformation())?.client_id ?? null, token: (await p.tokens())?.access_token ?? null };
    };
    const out = {};
    auth.updateClientInfo("sentry", { clientId: "old-client", clientIdIssuedAt: 1, redirectUris: ["http://localhost:51000/callback"] }, url, store);
    auth.updateTokens("sentry", { accessToken: "saved-token", refreshToken: "saved-refresh" }, url, store);
    out.normal = await view(false);
    out.forced = await view(true);
    out.afterAbandon = await view(false);
    auth.updateClientInfo("sentry", { clientId: "current-client", clientIdIssuedAt: 1, redirectUris: ["http://localhost:60535/callback"] }, url, store);
    out.forcedCurrentPort = await view(true);
    console.log(JSON.stringify(out));
  `;
  try {
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MCP_ADAPTER_OAUTH_FILE_KEY: randomBytes(32).toString("base64") },
      encoding: "utf8",
    }).trim().split("\n").pop()!);
    // Reconnect still refreshes the saved session with the saved client.
    assert.deepEqual(out.normal, { client: "old-client", token: "saved-token" });
    // Explicit auth: no refresh, and no stale client, so the SDK registers the current callback.
    assert.deepEqual(out.forced, { client: null, token: null });
    // Nothing was deleted: an abandoned sign-in leaves the saved session usable.
    assert.deepEqual(out.afterAbandon, { client: "old-client", token: "saved-token" });
    // A registration that already lists this callback is reused; only the session is skipped.
    assert.deepEqual(out.forcedCurrentPort, { client: "current-client", token: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
