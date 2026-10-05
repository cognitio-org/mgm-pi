// Test-only guard (#433), loaded by the npm test scripts with --test-global-setup, so it runs once
// in the `node --test` runner process (which does not load --import modules): it snapshots the
// real home's Kernal and pi state before any test file starts and fails the run if any of it was
// created, removed or modified by the end. tests/isolate.mjs is what keeps it unchanged;
// tests/real-home-guard.test.ts checks the same snapshot mid-run.
//
// Cheap on purpose: the watched dirs' direct entries only, by mtime and size, no recursion and no
// file contents. Entries a real Kernal or pi in another shell touches on its own (sessions, the
// update check, installed bundles) are left out so a concurrent session cannot fail the run.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The real-home dirs Kernal and pi keep user state in. */
export function watchedDirs(realHome) {
  return [
    ".kernal",
    ".kernal/auth",
    ".kernal/config-cache",
    ".kernal/reports",
    ".kernal/bin",
    ".kernal-sessions",
    ".mgm-sessions",
    ".pi",
    ".pi/agent",
    ".pi/agent/memory",
    ".config/codebase-index",
  ].map((d) => join(realHome, d));
}

const noise = /^(\.DS_Store|\.update-check\.json|current|state|chrome|sessions|(kernal|mgm)-\d.*)$/;

/** `{ path: "mtime size" | "dir" | "missing" }` for each watched dir and its direct entries. */
export function snapshotRealHome(realHome) {
  const out = {};
  const stamp = (p) => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs} ${s.isDirectory() ? "dir" : s.size}`;
    } catch {
      return "missing";
    }
  };
  for (const dir of watchedDirs(realHome)) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      out[dir] = "missing";
      continue;
    }
    out[dir] = "dir"; // its own mtime moves with any entry, noise included
    for (const n of names) if (!noise.test(n)) out[join(dir, n)] = stamp(join(dir, n));
  }
  return out;
}

/** What differs between two snapshots, as sorted readable lines. */
export function diffSnapshots(before, after) {
  const lines = [];
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[p] ?? "missing";
    const b = after[p] ?? "missing";
    if (a === b) continue;
    lines.push(a === "missing" ? `created ${p}` : b === "missing" ? `removed ${p}` : `modified ${p}`);
  }
  return lines.sort();
}

let state;

export function globalSetup() {
  if (process.env.KERNAL_E2E === "1") return;
  const realHome = (process.env.KERNAL_TEST_REAL_HOME ||= homedir());
  const dir = mkdtempSync(join(tmpdir(), "kernal-test-guard-"));
  const file = join(dir, "real-home-snapshot.json");
  const before = snapshotRealHome(realHome);
  writeFileSync(file, JSON.stringify(before));
  process.env.KERNAL_TEST_HOME_SNAPSHOT = file;
  state = { realHome, dir, before };
}

export function globalTeardown() {
  if (!state) return;
  const { realHome, dir, before } = state;
  state = undefined;
  rmSync(dir, { recursive: true, force: true });
  const changed = diffSnapshots(before, snapshotRealHome(realHome));
  if (changed.length) {
    process.stderr.write(`\ntests/home-guard.mjs: the test run changed the real home (${realHome}); a test is not isolated:\n${changed.map((c) => `  ${c}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}
