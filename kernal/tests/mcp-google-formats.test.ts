/**
 * Google's MCP servers (*.googleapis.com/mcp) mark fields with their own format names
 * (google-duration, ...). pi-mcp-adapter's Ajv doesn't know them and logs `unknown format
 * "google-duration" ignored in schema ...` for every such tool schema, a screenful when the
 * google_cloud toolset loads. The patch (applied in package.sh, like the re-auth one) registers
 * them. Checked here against the real adapter and Ajv, unpatched and patched.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = join(root, "scripts/patches/pi-mcp-adapter-google-formats.patch");
const packageSh = join(root, "scripts/package.sh");
const applyScript = join(root, "scripts/apply-adapter-patch.sh");
const modules = join(root, ".pi/npm/node_modules");
const adapterPath = join(modules, "pi-mcp-adapter");
const jitiPath = join(modules, "jiti/lib/jiti.mjs");
const canRun = existsSync(adapterPath) && existsSync(jitiPath);

// A google-duration field, as cloudmonitoring/cloudlogging/firestore ship it.
const schema = (stamp?: string) => ({
  ...(stamp ? { $schema: stamp } : {}),
  type: "object",
  properties: { period: { type: "string", format: "google-duration" }, id: { type: "string", format: "uint64" } },
});
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

let work = "";
let unpatched = "";
let patched = "";

before(() => {
  if (!canRun) {
    assert.ok(!process.env.CI, `pi-mcp-adapter or jiti is missing from ${modules}`);
    return;
  }
  // Inside node_modules, so the copies resolve ajv and the MCP SDK from the real install.
  work = mkdtempSync(join(modules, ".google-formats-"));
  unpatched = join(work, "a", "pi-mcp-adapter");
  patched = join(work, "b", "pi-mcp-adapter");
  for (const dest of [unpatched, patched]) cpSync(join(adapterPath, "json-schema-validator.ts"), join(dest, "json-schema-validator.ts"));
  execFileSync(applyScript, [join(work, "b"), patchPath], { encoding: "utf8", stdio: "pipe" });
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Compiles `s` with the adapter copy in `dir`; returns Ajv's warnings and a validate function. */
async function compile(dir: string, s: object): Promise<{ warnings: string[]; valid: (v: unknown) => boolean }> {
  const { createJiti } = await import(jitiPath);
  const jiti = createJiti(join(dir, "json-schema-validator.ts"), { moduleCache: false });
  const { createJsonSchemaValidator } = await jiti.import(join(dir, "json-schema-validator.ts"));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    const validator = createJsonSchemaValidator().getValidator(s);
    return { warnings, valid: (v) => validator(v).valid };
  } finally {
    console.warn = warn;
  }
}

test("package.sh applies the Google formats patch after npm ci and checks it landed", () => {
  const script = readFileSync(packageSh, "utf8");
  const ci = script.indexOf("npm ci --legacy-peer-deps");
  const apply = script.indexOf("pi-mcp-adapter-google-formats.patch");
  assert.ok(ci > 0 && apply > ci, "the patch must run after npm ci replaces node_modules");
  assert.ok(script.includes(`grep -c 'addGoogleFormats(ajv);'`), "package.sh verifies the staged adapter");
});

test("the patch applies once, then reports already applied", { skip: !canRun }, () => {
  assert.equal(readFileSync(join(patched, "json-schema-validator.ts"), "utf8").match(/addGoogleFormats\(ajv\);/g)?.length, 2);
  assert.match(execFileSync(applyScript, [join(work, "b"), patchPath], { encoding: "utf8", stdio: "pipe" }), /^already applied: /m);
});

test("unpatched, Ajv warns about google-duration (what the patch is for)", { skip: !canRun }, async () => {
  const { warnings } = await compile(unpatched, schema());
  assert.ok(warnings.some((w) => /unknown format "google-duration" ignored/.test(w)), warnings.join("\n"));
});

test("patched, Google's formats compile silently in both dialects, and google-duration is checked", { skip: !canRun }, async () => {
  for (const stamp of [undefined, DRAFT_07]) {
    const { warnings, valid } = await compile(patched, schema(stamp));
    assert.deepEqual(warnings.filter((w) => /unknown format/.test(w)), [], `dialect ${stamp ?? "2020-12"}`);
    assert.equal(valid({ period: "3.5s", id: "18446744073709551615" }), true);
    assert.equal(valid({ period: "60s" }), true);
    assert.equal(valid({ period: "3.5" }), false, "a duration without its unit is rejected");
  }
});

test("patched, other unknown formats still warn: only Google's names are added", { skip: !canRun }, async () => {
  const { warnings } = await compile(patched, { type: "object", properties: { x: { type: "string", format: "made-up" } } });
  assert.ok(warnings.some((w) => /unknown format "made-up"/.test(w)), warnings.join("\n"));
});
