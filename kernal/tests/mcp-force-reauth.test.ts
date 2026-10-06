/**
 * Explicit /mcp-auth must open the browser even when a gateway refresh token is saved.
 * pi-mcp-adapter is installed by npm ci, so the change ships as a patch applied in package.sh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = join(root, "scripts/patches/pi-mcp-adapter-force-reauth.patch");
const packageSh = join(root, "scripts/package.sh");
const flowPath = join(root, ".pi/npm/node_modules/pi-mcp-adapter/mcp-auth-flow.ts");
const commandsPath = join(root, ".pi/npm/node_modules/pi-mcp-adapter/commands.ts");

test("package.sh reapplies the explicit re-auth patch after npm ci", () => {
  const script = readFileSync(packageSh, "utf8");
  const ci = script.indexOf("npm ci --legacy-peer-deps");
  const apply = script.indexOf("pi-mcp-adapter-force-reauth.patch");
  assert.ok(ci > 0 && apply > ci, "the patch must run after npm ci replaces node_modules");
  const patch = readFileSync(patchPath, "utf8");
  assert.match(patch, /forceReauthorization: options\.forceReauthorization === true/);
  assert.match(patch, /forceReauthorization: true/);
  assert.doesNotMatch(patch, /reconnectServer/);
});

test("the installed adapter forces re-auth only for explicit /mcp-auth", { skip: !existsSync(flowPath) }, () => {
  const flow = readFileSync(flowPath, "utf8");
  const commands = readFileSync(commandsPath, "utf8");
  const forced = flow.match(/forceReauthorization: options\.forceReauthorization === true/g) ?? [];
  assert.equal(forced.length, 1);
  const refreshCalls = [...flow.matchAll(/runSdkAuth\(authProvider, \{([^}]*)\}/gs)].map((match) => match[1]);
  assert.equal(refreshCalls.filter((body) => body.includes("forceReauthorization")).length, 1);
  const reconnect = commands.slice(commands.indexOf("export async function reconnectServer"), commands.indexOf("export async function authenticateServer"));
  assert.doesNotMatch(reconnect, /forceReauthorization/);
  assert.equal((commands.match(/forceReauthorization: true/g) ?? []).length, 1);

  const dir = mkdtempSync(join(tmpdir(), "mcp-reauth-"));
  const adapter = join(dir, "pi-mcp-adapter");
  mkdirSync(adapter);
  cpSync(flowPath, join(adapter, "mcp-auth-flow.ts"));
  cpSync(commandsPath, join(adapter, "commands.ts"));
  const patch = readFileSync(patchPath);
  execFileSync("patch", ["-d", dir, "-p1", "-R", "--batch"], { input: patch });
  assert.doesNotMatch(readFileSync(join(dir, "pi-mcp-adapter/mcp-auth-flow.ts"), "utf8"), /forceReauthorization: options\.forceReauthorization === true/);
  execFileSync("patch", ["-d", dir, "-p1", "--batch"], { input: patch });
  assert.equal(readFileSync(join(dir, "pi-mcp-adapter/mcp-auth-flow.ts"), "utf8"), flow);
  assert.equal(readFileSync(join(dir, "pi-mcp-adapter/commands.ts"), "utf8"), commands);
  rmSync(dir, { recursive: true, force: true });
});
