/**
 * Optional Tape check: before a checkpoint, run a Playwright spec that is already in the
 * workspace against a fresh headless Chromium inside the Drive.
 *
 * This does not attach to the user's Chrome, does not load the companion extension, and does
 * not copy laptop cookies. The browser is Playwright's own Chromium (PLAYWRIGHT_BROWSERS_PATH
 * in the sandbox image). No spec, or a browser that cannot start, is a transcript entry -- the
 * checkpoint still runs. This function does not throw.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const PLAYWRIGHT_ENTRY_TYPE = "outfitter.playwright";

const CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
];

/** Directories that are never a project's Playwright suite. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  "blob-report",
]);

/** Playwright's own file match, used when the config names a testDir. */
const SPEC_OR_TEST = /\.(?:spec|test)\.(?:[cm]js|[cm]ts|[jt]sx?)$/;
/** Without an explicit testDir, only `*.spec.*` counts, so a repo's node:test `*.test.ts` tree is not a Playwright suite. */
const SPEC_ONLY = /\.spec\.(?:[cm]js|[cm]ts|[jt]sx?)$/;

const CONVENTIONAL_TEST_DIRS = ["tests", "e2e", "playwright", "test"];

const LOG_CAP = 4_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const IMAGE_CLI = "/opt/outfitter/playwright/node_modules/.bin/playwright";
const IMAGE_BROWSERS = "/opt/ms-playwright";

export interface PlaywrightSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Set when the process could not be started (ENOENT, EACCES). */
  error?: string;
}

export type PlaywrightSpawn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number; timeoutMs: number },
) => Promise<PlaywrightSpawnResult>;

export interface PlaywrightCheckOptions {
  /** Exactly true runs the check. Anything else, including omitted, does not spawn. */
  enabled: boolean;
  workspace: string;
  spawn?: PlaywrightSpawn;
  now?: () => Date;
  newId?: () => string;
  /** Run the browser as this user when agentd itself is root (the sandbox `agent` user). */
  uid?: number;
  gid?: number;
  home?: string;
  cliPath?: string;
  browsersPath?: string;
  timeoutMs?: number;
  /** Artifact directory. Default is a temp dir outside the workspace so the checkpoint commit stays clean. */
  outputDir?: string;
}

export interface PlaywrightCheckEntry {
  id: string;
  parentId: null;
  type: "custom";
  customType: typeof PLAYWRIGHT_ENTRY_TYPE;
  timestamp: string;
  data: {
    status: "pass" | "fail" | "skipped" | "unavailable";
    text: string;
    log: string;
    screenshotPath?: string;
  };
}

interface PlaywrightTarget {
  configPath: string;
  configDir: string;
}

/** Never rejects. `null` only when the guru flag is off -- no browser is spawned. */
export async function runPlaywrightBeforeCheckpoint(
  opts: PlaywrightCheckOptions,
): Promise<PlaywrightCheckEntry | null> {
  if (opts.enabled !== true) return null;
  try {
    return await runEnabled(opts);
  } catch (err) {
    return report(opts, "unavailable", errorMessage(err));
  }
}

async function runEnabled(opts: PlaywrightCheckOptions): Promise<PlaywrightCheckEntry> {
  const target = await findTarget(opts.workspace);
  if (!target) {
    return report(
      opts,
      "skipped",
      "No Playwright spec in this workspace (no playwright.config with a test directory).",
    );
  }

  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), "outfitter-playwright-")));
  await mkdir(outputDir, { recursive: true });
  // mkdir's mode is masked by umask. The sandbox runs this as root and the browser as `agent`.
  await chmod(outputDir, 0o777);

  const cli = opts.cliPath ?? (await findLocalCli(target.configDir, opts.workspace)) ?? imageCli();
  const startedAt = (opts.now ?? (() => new Date()))().getTime();
  const result = await (opts.spawn ?? defaultPlaywrightSpawn)(
    cli,
    ["test", "--config", target.configPath, "--reporter=line", "--output", outputDir],
    {
      cwd: target.configDir,
      env: spawnEnv(opts),
      uid: opts.uid,
      gid: opts.gid,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );

  const screenshotPath = await findNewScreenshot(
    [outputDir, join(target.configDir, "test-results"), join(target.configDir, "playwright-report")],
    startedAt,
  );
  const log = combinedLog(result);
  if (result.timedOut) return report(opts, "fail", log || "Timed out.", screenshotPath);
  if (result.code === 0) return report(opts, "pass", log, screenshotPath);
  if (browserUnavailable(result)) return report(opts, "unavailable", log || "Chromium could not start.", screenshotPath);
  return report(opts, "fail", log || `exit ${result.code ?? "unknown"}`, screenshotPath);
}

function imageCli(): string {
  return process.env.OUTFITTER_PLAYWRIGHT_CLI || IMAGE_CLI;
}

function spawnEnv(opts: PlaywrightCheckOptions): NodeJS.ProcessEnv {
  // Allowlist. agentd's own env holds the run token and git credentials; a spec the model
  // just wrote must not be able to read them. HOME is the agent user's home (or /tmp), never
  // a laptop Chrome profile. No channel, no storageState from outside the repo.
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: opts.home ?? "/tmp",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    PLAYWRIGHT_BROWSERS_PATH: opts.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? IMAGE_BROWSERS,
    CI: "1",
  };
}

function report(
  opts: PlaywrightCheckOptions,
  status: PlaywrightCheckEntry["data"]["status"],
  log: string,
  screenshotPath?: string,
): PlaywrightCheckEntry {
  const short = tail(log.trim(), LOG_CAP);
  const headline =
    status === "skipped"
      ? "Playwright: nothing to run"
      : status === "unavailable"
        ? "Playwright: Chromium could not start"
        : status === "pass"
          ? "Playwright: pass"
          : "Playwright: fail";
  const lines = [headline];
  if (short && short !== headline) lines.push(short);
  if (screenshotPath) lines.push(`Screenshot: ${screenshotPath}`);
  const text = lines.join("\n");
  return {
    id: opts.newId?.() ?? `playwright-${randomUUID()}`,
    parentId: null,
    type: "custom",
    customType: PLAYWRIGHT_ENTRY_TYPE,
    timestamp: (opts.now ?? (() => new Date()))().toISOString(),
    data: {
      status,
      text,
      log: short || text,
      ...(screenshotPath ? { screenshotPath } : {}),
    },
  };
}

function browserUnavailable(result: PlaywrightSpawnResult): boolean {
  if (result.error) return true;
  const blob = `${result.stderr}\n${result.stdout}`;
  return /Executable doesn't exist|Executable not found|Failed to launch|browserType\.launch|Cannot launch|playwright install/i.test(
    blob,
  );
}

function combinedLog(result: PlaywrightSpawnResult): string {
  const parts: string[] = [];
  if (result.timedOut) parts.push("Timed out.");
  if (result.error) parts.push(result.error);
  if (result.code !== null && result.code !== 0 && !result.timedOut) parts.push(`exit ${result.code}`);
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  if (result.stderr.trim()) parts.push(result.stderr.trim());
  return parts.join("\n");
}

async function findTarget(workspace: string): Promise<PlaywrightTarget | null> {
  const root = resolve(workspace);
  const configPath = await findConfig(root);
  if (!configPath) return null;
  const configDir = dirname(configPath);
  const declared = await declaredTestDir(configPath);
  if (declared !== null) {
    const abs = resolve(configDir, declared);
    if (!inside(root, abs)) return null;
    return (await directoryHasSpec(abs, SPEC_OR_TEST)) ? { configPath, configDir } : null;
  }
  for (const name of CONVENTIONAL_TEST_DIRS) {
    const abs = join(configDir, name);
    if (!inside(root, abs)) continue;
    if (await directoryHasSpec(abs, SPEC_ONLY)) return { configPath, configDir };
  }
  return null;
}

async function declaredTestDir(configPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/);
  return match ? match[1] : null;
}

async function findConfig(root: string): Promise<string | null> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < 400) {
    const current = queue.shift();
    if (!current) break;
    seen++;
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
    const configs = entries
      .filter((entry) => entry.isFile() && CONFIG_NAMES.includes(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => CONFIG_NAMES.indexOf(a) - CONFIG_NAMES.indexOf(b));
    if (configs.length > 0) return join(current.dir, configs[0]);
    if (current.depth >= 4) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const next = join(current.dir, entry.name);
      if (inside(root, next)) queue.push({ dir: next, depth: current.depth + 1 });
    }
  }
  return null;
}

async function directoryHasSpec(dir: string, pattern: RegExp): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return false;
  const queue = [dir];
  let seen = 0;
  while (queue.length > 0 && seen < 800) {
    const current = queue.shift();
    if (!current) break;
    seen++;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        queue.push(path);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

async function findLocalCli(configDir: string, workspace: string): Promise<string | null> {
  const root = resolve(workspace);
  let dir = resolve(configDir);
  for (;;) {
    if (!inside(root, dir) && dir !== root) return null;
    const candidate = join(dir, "node_modules", ".bin", "playwright");
    if (await exists(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function findNewScreenshot(dirs: string[], startedAtMs: number): Promise<string | undefined> {
  for (const dir of dirs) {
    const found = await walkImage(dir, startedAtMs, 0);
    if (found) return found;
  }
  return undefined;
}

async function walkImage(dir: string, startedAtMs: number, depth: number): Promise<string | undefined> {
  if (depth > 6) return undefined;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const nested = await walkImage(path, startedAtMs, depth + 1);
      if (nested) return nested;
    } else if (entry.isFile() && /\.(?:png|jpe?g)$/i.test(entry.name)) {
      const info = await stat(path).catch(() => undefined);
      if (info && info.mtimeMs >= startedAtMs - 1000) return path;
    }
  }
  return undefined;
}

function inside(root: string, target: string): boolean {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  return absTarget === absRoot || absTarget.startsWith(absRoot + sep);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tail(text: string, cap: number): string {
  return text.length > cap ? text.slice(text.length - cap) : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Production spawn. Tests inject their own. Never rejects. */
export const defaultPlaywrightSpawn: PlaywrightSpawn = (command, args, opts) => {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: PlaywrightSpawnResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        uid: opts.uid,
        gid: opts.gid,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: "", error: errorMessage(err) });
      return;
    }

    const killGroup = () => {
      if (!child.pid || child.pid <= 0) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };

    child.stdout?.on("data", (buf: Buffer) => {
      stdout = tail(stdout + buf.toString("utf8"), LOG_CAP);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr = tail(stderr + buf.toString("utf8"), LOG_CAP);
    });
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killGroup();
      killTimer = setTimeout(() => {
        finish({ code: null, stdout, stderr, timedOut: true });
      }, 2_000);
    }, opts.timeoutMs);

    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, error: errorMessage(err), timedOut });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
};
