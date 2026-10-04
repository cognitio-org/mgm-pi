/**
 * The Outfitter Drive image deletes laptop-only extensions (outfitter/image/Dockerfile `rm -rf
 * ./.pi/extensions/...`). An extension the image keeps must not statically import one it deletes,
 * or pi fails to load it on every Drive (2026-10-05: connect → kernal-admin/central.ts broke the
 * image build's extension prewarm). A dynamic `await import(...)` is fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const extDir = join(root, ".pi", "extensions");
const dockerfile = readFileSync(join(root, "..", "outfitter", "image", "Dockerfile"), "utf8");

const removed = new Set([...dockerfile.matchAll(/\.\/\.pi\/extensions\/([\w-]+)/g)].map((m) => m[1]).filter((d) => {
  // only the directories under an `rm -rf`, not the COPY of the whole folder
  return dockerfile.includes(`./.pi/extensions/${d} `) || dockerfile.includes(`./.pi/extensions/${d}\n`) || dockerfile.includes(`./.pi/extensions/${d} \\`);
}));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules") return [];
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("the Drive image's kept extensions don't statically import the ones it deletes", () => {
  assert.ok(removed.has("kernal-admin") && removed.has("kernal-voice"), `parsed: ${[...removed].join(", ")}`);
  const kept = readdirSync(extDir).filter((d) => !removed.has(d) && statSync(join(extDir, d)).isDirectory());
  const bad: string[] = [];
  for (const d of kept) {
    for (const f of tsFiles(join(extDir, d))) {
      for (const m of readFileSync(f, "utf8").matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']\.\.\/([\w-]+)\//gm)) {
        if (removed.has(m[1]) && !/^\s*import\s+type\b/.test(m[0])) bad.push(`${f.slice(extDir.length + 1)} → ${m[1]}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
