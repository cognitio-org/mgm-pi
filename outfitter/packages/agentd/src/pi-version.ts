/**
 * pi's version for the `hello` frame. Read from pi's own package.json next to the binary
 * (`node_modules/.bin/pi` is a symlink into `@earendil-works/pi-coding-agent/dist/...`) instead of
 * spawning `pi --version`: the spawn loads pi's whole CLI bundle and sat on the critical path ahead
 * of the link connect on every wake, while the file read takes a millisecond
 * (docs/reports/startup-trim.md). Falls back to `pi --version` when no package.json is found (a
 * wrapper script, a test fake), and to "unknown" if that fails too.
 */
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_LEVELS_UP = 5;

export async function versionFromPackageJson(piBin: string): Promise<string | undefined> {
  let dir: string;
  try {
    dir = dirname(await realpath(piBin));
  } catch {
    return undefined;
  }
  for (let i = 0; i < MAX_LEVELS_UP; i++) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (pkg?.name === PI_PACKAGE_NAME && typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // no (readable) package.json at this level; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function getPiVersion(piBin: string): Promise<string> {
  const fromPackage = await versionFromPackageJson(piBin);
  if (fromPackage) return fromPackage;
  try {
    const { stdout } = await execFileAsync(piBin, ["--version"], { timeout: 5000 });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
