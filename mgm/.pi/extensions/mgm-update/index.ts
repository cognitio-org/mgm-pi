/**
 * mgm update check — once a day (per machine, cached in ~/.mgm/.update-check.json) asks GitHub for
 * the latest mgm release and tells the user when it is newer than the installed bundle. /update runs
 * the launcher's `mgm update`, which downloads the release installer and upgrades in place (keys in
 * .env are kept). Source checkouts (no VERSION file) are never nagged. Env:
 *   MGM_NO_UPDATE_CHECK=1   skip the automatic check (tests, CI)
 *   MGM_UPDATE_REPO         override the GitHub repo (default mgmonteleone/mgm-pi)
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPO, checkDue, parseVersion, showVersion, tagFromGh, updateNotice, type CheckCache } from "./lib.ts";

export type Deps = {
  latest: () => Promise<string | undefined>;                         // latest release tag, e.g. "v0.1.4"
  run: (onLine: (l: string) => void) => Promise<{ code: number; tail: string }>;   // the upgrade itself
  now?: () => number;
};

const root = () => dirname(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const cachePath = () => process.env.MGM_UPDATE_CACHE || join(root(), "..", ".update-check.json");
export function installedVersion(): string | undefined {
  const f = join(root(), "VERSION");
  try { return existsSync(f) ? readFileSync(f, "utf8").split("\n")[0].trim() : undefined; } catch { return undefined; }
}
function readCache(): CheckCache | undefined { try { return JSON.parse(readFileSync(cachePath(), "utf8")); } catch { return undefined; } }
function writeCache(c: CheckCache) { try { writeFileSync(cachePath(), JSON.stringify(c)); } catch {} }

const repo = () => process.env.MGM_UPDATE_REPO || REPO;
async function ghLatest(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("gh", ["release", "view", "--repo", repo(), "--json", "tagName"], { timeout: 8000, encoding: "utf8" }, (err, out) => resolve(err ? undefined : tagFromGh(out)));
  });
}
async function apiLatest(): Promise<string | undefined> {
  if (!process.env.GH_TOKEN) return undefined;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`https://api.github.com/repos/${repo()}/releases/latest`, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return undefined;
    const t2 = (await res.json())?.tag_name; return typeof t2 === "string" ? t2 : undefined;
  } catch { return undefined; }
}
const defaultLatest = async () => (await ghLatest()) ?? (await apiLatest());

function defaultRun(onLine: (l: string) => void): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const child = spawn("bash", [join(root(), "bin", "mgm"), "update"], { env: { ...process.env, MGM_SKIP_LMS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const feed = (chunk: Buffer) => { for (const l of chunk.toString().split("\n")) { const s = l.trim(); if (s) { lines.push(s); onLine(s); } } };
    child.stdout.on("data", feed); child.stderr.on("data", feed);
    child.on("error", (e) => resolve({ code: 1, tail: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, tail: lines.slice(-4).join("\n") }));
  });
}

export default function (pi: ExtensionAPI, deps: Partial<Deps> = {}) {
  const d: Deps = { latest: defaultLatest, run: defaultRun, now: () => Date.now(), ...deps };
  let latestKnown: string | undefined;

  async function check(force: boolean): Promise<string | undefined> {
    const cache = readCache();
    if (!checkDue(cache, d.now!(), force)) { latestKnown = cache?.latest; return latestKnown; }
    const latest = await d.latest();
    writeCache({ checkedAt: d.now!(), latest: latest ?? cache?.latest });
    latestKnown = latest ?? cache?.latest;
    return latestKnown;
  }

  pi.on("session_start", async (_e, ctx) => {
    if (ctx.mode !== "tui" || process.env.MGM_NO_UPDATE_CHECK) return;
    const installed = installedVersion();
    if (!parseVersion(installed)) return;   // source checkout: nothing to upgrade
    const notice = updateNotice(installed, await check(false));
    if (notice) { ctx.ui.notify(notice, "info"); ctx.ui.setStatus("update", `⬆ ${showVersion(parseVersion(latestKnown!)!)} available · /update`); }
  });

  pi.registerCommand("update", {
    description: "Upgrade mgm to the latest release (or `/update check` to just look)",
    handler: async (args, ctx) => {
      const installed = installedVersion();
      if (args.trim() === "check") {
        const latest = await check(true);
        const notice = updateNotice(installed, latest);
        ctx.ui.notify(notice ?? (latest ? `mgm ${installed ?? "(source checkout)"} is up to date (latest release ${latest}).` : "Could not reach GitHub (is the gh CLI logged in?)."), notice ? "info" : latest ? "info" : "warning");
        return;
      }
      if (!parseVersion(installed)) { ctx.ui.notify("This is a source checkout; update it with git pull.", "warning"); return; }
      ctx.ui.notify(`Upgrading mgm ${installed} → latest release. Keys in .env are kept…`, "info");
      ctx.ui.setStatus("update", "⬆ installing…");
      const { code, tail } = await d.run((l) => ctx.ui.setStatus("update", `⬆ ${l.slice(0, 60)}`));
      if (code === 0) {
        ctx.ui.setStatus("update", "⬆ restart mgm");
        ctx.ui.notify(`Installed. Restart mgm to use the new version.\n${tail}`, "info");
      } else {
        ctx.ui.setStatus("update", undefined);
        ctx.ui.notify(`Update failed (exit ${code}):\n${tail}`, "error");
      }
    },
  });
}
