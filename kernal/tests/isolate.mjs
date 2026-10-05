// Test-only isolation (#433): no test may read or write the developer's real login or settings.
// Imported first by tests/resolve-pi.mjs, which every npm test script loads with --import, so it
// runs in each test file's process before any test module.
//
// Each process gets a fresh temporary HOME (and XDG dirs under it), so every homedir()-derived path
// -- ~/.kernal (auth, config.local.json, config-cache, reports, bin), ~/.pi/agent (pi-listen's
// voice settings), ~/.config/codebase-index, ~/.kernal-sessions, ~/localllm/.env -- lands in it.
// Inherited overrides that point at user state (KERNAL_*/MGM_*, PI_*, OUTFITTER_*, SENTRY_*) are
// dropped, so a developer's shell behaves like CI. KERNAL_AUTH_BACKEND=file keeps the login off the
// macOS Keychain / Secret Service, and KERNAL_TEST_NO_KEYCHAIN=1 makes the real `security` /
// `secret-tool` runner refuse outright (a test that wants a keychain passes a fake runner).
// Tests that set their own HOME, KERNAL_AUTH_DIR, PI_CODING_AGENT_DIR, ... still win: this only
// sets the starting values.
//
// tests/home-guard.mjs (--test-global-setup) checks the real home did not change during the run.
// KERNAL_E2E=1 (npm run test:e2e) opts out: those tests use the real keys on purpose. So does a
// script that borrows the resolver (scripts/index-eval.mjs reads the real codebase-index config):
// only a `node --test` child or a directly run *.test.* file is isolated.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const isTest = !!process.env.NODE_TEST_CONTEXT || /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
if (isTest && process.env.KERNAL_E2E !== "1") {
  // The real home: recorded by the runner (home-guard.mjs) when it ran, else this process's.
  process.env.KERNAL_TEST_REAL_HOME ||= homedir();

  const keep = /^(KERNAL_(LIVE|E2E|TEST_))/;
  for (const k of Object.keys(process.env)) {
    if (/^(KERNAL_|MGM_|PI_|OUTFITTER_|SENTRY_)/.test(k) && !keep.test(k)) delete process.env[k];
  }

  const home = mkdtempSync(join(tmpdir(), "kernal-test-home-"));
  for (const d of [".config", ".cache", ".local/share", ".local/state"]) mkdirSync(join(home, d), { recursive: true });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    KERNAL_AUTH_BACKEND: "file",
    KERNAL_TEST_NO_KEYCHAIN: "1",
  });
  if (homedir() !== home) throw new Error(`tests/isolate.mjs: os.homedir() still answers ${homedir()}`);

  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
