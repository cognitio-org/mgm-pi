/**
 * The ngrok tunnel provider (#380): the ngrok agent *program*, run as a child process, not the
 * `@ngrok/ngrok` npm package the issue first proposed.
 *
 * Why a child process. `@ngrok/ngrok` is a native Node addon (napi-rs, one `.node` per platform).
 * A release bundle runs pi as a Bun-compiled binary, which cannot load an addon from the bundle's
 * node_modules, and a laptop with a bundle may have no Node at all; only a source checkout is sure
 * to. The agent program runs the same under node, under pi's binary and under a LaunchAgent (#381),
 * whatever started it; a crash in it cannot take the service down; and it speaks the same traffic
 * policy as the SDK. It is the pattern outfitter/packages/agentd/src/ngrok-runner.ts already uses
 * for Drive previews. ngrok's REST API is no alternative: it configures endpoints (Outfitter uses it,
 * #383) but carries no traffic.
 *
 * Where the program comes from, first match wins:
 *   1. KERNAL_NGROK_BIN, for a person who wants a particular build. When it is set it is the only
 *      candidate: one that does not run or is too old is the reason, never a silent fall-through to
 *      another binary;
 *   2. Kernal's own copy in KERNAL_HOME/bin (a source checkout: .pi/bin), installed by
 *      installNgrok(): the pinned NGROK_PINNED release for this platform, its sha256 checked against
 *      the value recorded here before anything is unpacked (as package.sh checks pi's tarball);
 *   3. `ngrok` on PATH (Homebrew), when it is at least MIN_NGROK_VERSION.
 * Kernal's copy goes before PATH because it is the version the policy here was written against,
 * and because the Local Host LaunchAgent does not inherit a login shell's PATH, so Homebrew is
 * invisible there. `kernal local enable` installs the copy when it is missing even if this
 * shell can already run `ngrok`. The service itself never downloads.
 * None of them, or a broken one, is a status of "unavailable" with a reason, never an exception
 * from status().
 *
 * The authtoken never appears on a command line or in the child's environment: it goes in a 0600
 * config file in a private temp directory, removed when the tunnel stops. The child gets a minimal
 * environment (no LITELLM_*, no NGROK_* that could point it at another config), no web inspector
 * (it would expose request bodies on localhost:4040 and collide with tunnel.sh), no remote
 * management and no update checks. It runs in its own process group so stop() takes any helper it
 * spawns with it.
 *
 * A host that dies without calling stop() must not leave the agent holding the reserved domain
 * (the next start would meet ERR_NGROK_334) or its authtoken in $TMPDIR. While a tunnel is live a
 * process 'exit' hook kills the agent's group and removes the directory; for a death no hook sees
 * (SIGKILL, a crash in native code), each tunnel directory records its owner and agent pids, and
 * every start() first sweeps this user's kernal-tunnel-* directories whose owner is gone, killing
 * a leftover agent (only when its command line still names that directory) before binding.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env.ts";
import { kernalBin } from "../../kernal-github/gh.ts";
import { checkBearerToken, ngrokTrafficPolicy } from "./policy.ts";
import {
  DEFAULT_ALLOW_PATHS, TunnelError,
  type NgrokCredentials, type ProviderStatus, type Tunnel, type TunnelCredentials, type TunnelHealth, type TunnelProvider, type TunnelStartOptions,
} from "./types.ts";

export const NGROK_START_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 2_000;
/** Older agents lack `--url` or the traffic-policy actions used here. */
export const MIN_NGROK_VERSION = "3.20.0";

type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

/** The ngrok agent Kernal installs: versioned archive URLs (the "stable" ones change under a fixed
 * name, so no checksum could be pinned to them) with the sha256s ngrok publishes for them at
 * https://dl.equinox.io/ngrok/ngrok-v3/stable/archive. Bump all four together. */
export const NGROK_PINNED: { version: string; assets: Record<PlatformKey, { url: string; sha256: string }> } = {
  version: "3.39.11",
  assets: {
    "darwin-arm64": { url: "https://bin.equinox.io/a/6nG16rF52TE/ngrok-v3-3.39.11-darwin-arm64.tar.gz", sha256: "cdf75135a6a7962dd368c0d4ec1bad2312420d933a41296a146fffcc6be13ee8" },
    "darwin-x64": { url: "https://bin.equinox.io/a/jPvqdBYWoCy/ngrok-v3-3.39.11-darwin-amd64.tar.gz", sha256: "098a72a436276227f71ea6a57f3560d47e15135b4c5c6ba605cd63edba386987" },
    "linux-x64": { url: "https://bin.equinox.io/a/5Mrhp7gRDVb/ngrok-v3-3.39.11-linux-amd64.tar.gz", sha256: "cec0b4997fcc5f529dfc74bac89050354d11a915f968720600039738fdf330cf" },
    "linux-arm64": { url: "https://bin.equinox.io/a/dg26hrkwY2F/ngrok-v3-3.39.11-linux-arm64.tar.gz", sha256: "3b6ba05a9d9585c34157fa0819fa95cdb13839f5b506b9e63204705cf7f79e29" },
  },
};

export function platformKey(platform: string = process.platform, arch: string = process.arch): PlatformKey | undefined {
  const os = platform === "darwin" || platform === "linux" ? platform : undefined;
  const cpu = arch === "arm64" || arch === "x64" ? arch : undefined;
  return os && cpu ? (`${os}-${cpu}` as PlatformKey) : undefined;
}

/** -1, 0 or 1 for two `x.y.z` versions (missing parts are 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Runs a short command; a missing program is code 127, never a rejection. */
export const execShort: Exec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", env: childEnv() }, (err: any, stdout, stderr) => {
      if (err?.code === "ENOENT" || err?.code === "EACCES") return resolve({ stdout: "", stderr: String(err.message), code: 127 });
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: typeof err?.code === "number" ? err.code : err ? 1 : 0 });
    });
  });

/** What the agent sees of our environment: enough to find its home and temp dir, nothing else. */
function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot"]) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

export interface FoundNgrok {
  path: string;
  version: string;
  source: "env" | "managed" | "path";
}

/** The ngrok program to run, or why there is none. Never throws. */
export async function findNgrok(deps: { exec?: Exec; binDir?: string } = {}): Promise<{ found: FoundNgrok } | { found?: undefined; reason: string }> {
  const exec = deps.exec ?? execShort;
  const managed = join(deps.binDir ?? kernalBin(), "ngrok");
  const override = env("NGROK_BIN")?.trim();
  const candidates: Array<[string, FoundNgrok["source"]]> = [];
  // An explicit choice is the only candidate: a typo or a broken pinned build must fail loudly,
  // not quietly run some other ngrok.
  if (override) candidates.push([override, "env"]);
  else {
    if (existsSync(managed)) candidates.push([managed, "managed"]);
    candidates.push(["ngrok", "path"]);
  }
  const problems: string[] = [];
  for (const [path, source] of candidates) {
    const r = await exec(path, ["version"], 10_000).catch((e) => ({ stdout: "", stderr: String(e?.message ?? e), code: 1 }));
    if (r.code === 127 && source === "path") continue;   // simply not installed
    const version = /ngrok version (\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr)?.[1];
    if (r.code !== 0 || !version) { problems.push(`${path} does not run (${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`})`); continue; }
    if (compareVersions(version, MIN_NGROK_VERSION) < 0) { problems.push(`${path} is ngrok ${version}; Kernal needs ${MIN_NGROK_VERSION} or newer`); continue; }
    return { found: { path, version, source } };
  }
  return { reason: problems.length ? problems.join("; ") : "the ngrok agent is not installed" };
}

export interface InstallDeps {
  fetchBinary?: (url: string) => Promise<Buffer>;
  exec?: Exec;
  binDir?: string;
  platform?: PlatformKey;
  pinned?: typeof NGROK_PINNED;
}

export type InstallResult = { ok: true; path: string; version: string } | { ok: false; detail: string };

/**
 * Installs the pinned ngrok agent into Kernal's bin directory: downloads this platform's archive,
 * refuses it unless its sha256 is the one recorded in NGROK_PINNED, unpacks the one `ngrok` file
 * and checks it runs. Nothing is written to the bin directory before the checksum matches.
 */
export async function installNgrok(deps: InstallDeps = {}): Promise<InstallResult> {
  const pinned = deps.pinned ?? NGROK_PINNED;
  const platform = deps.platform ?? platformKey();
  const asset = platform ? pinned.assets[platform] : undefined;
  if (!platform || !asset) return { ok: false, detail: `Kernal has no ngrok build for ${process.platform}/${process.arch}` };
  const exec = deps.exec ?? execShort;
  const binDir = deps.binDir ?? kernalBin();
  const fetchBinary = deps.fetchBinary ?? (async (url: string) => {
    const res = await fetch(url, { headers: { "user-agent": "kernal" }, signal: AbortSignal.timeout(300_000), redirect: "follow" });
    if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  });
  let tmp: string | undefined;
  try {
    const data = await fetchBinary(asset.url);
    const got = createHash("sha256").update(data).digest("hex");
    if (got !== asset.sha256) return { ok: false, detail: `the downloaded ngrok ${pinned.version} does not match its published checksum; nothing was installed` };
    tmp = await mkdtemp(join(tmpdir(), "kernal-ngrok-"));
    const archive = join(tmp, "ngrok.tar.gz");
    await writeFile(archive, data);
    const unpack = await exec("tar", ["xzf", archive, "-C", tmp, "ngrok"], 120_000);
    if (unpack.code !== 0) return { ok: false, detail: `unpacking ngrok failed: ${unpack.stderr.trim()}` };
    const found = join(tmp, "ngrok");
    if (!existsSync(found)) return { ok: false, detail: "the ngrok archive did not contain the ngrok program" };
    await chmod(found, 0o755);
    await mkdir(binDir, { recursive: true });
    const target = join(binDir, "ngrok");
    // Into place in one rename, from a name in the same directory, so a running service never
    // sees half a binary.
    const staged = join(binDir, `.ngrok-${randomBytes(4).toString("hex")}`);
    await rename(found, staged).catch(async () => { await copyFile(found, staged); await chmod(staged, 0o755); });
    await rename(staged, target);
    const check = await exec(target, ["version"], 10_000);
    const version = /ngrok version (\d+\.\d+\.\d+)/.exec(check.stdout)?.[1];
    if (check.code !== 0 || !version) return { ok: false, detail: `the installed ngrok does not run: ${check.stderr.trim()}` };
    return { ok: true, path: target, version };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** One line of the agent's `--log-format json` output: started (with its URL), refused, or neither.
 * The same reading as outfitter/packages/agentd/src/ngrok-runner.ts (a copy: Kernal ships without
 * Outfitter's code). */
export function classifyNgrokLog(line: string): { started: true; url?: string } | { error: string } | undefined {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return /ERR_NGROK_\d+/.test(line) ? { error: line.trim().slice(0, 300) } : undefined;
  }
  if (rec.msg === "started tunnel") return { started: true, url: typeof rec.url === "string" ? rec.url : undefined };
  const err = typeof rec.err === "string" ? rec.err : undefined;
  if (rec.lvl === "crit" || rec.lvl === "eror" || (err && /ERR_NGROK_\d+/.test(err))) {
    const text = err ?? (typeof rec.msg === "string" ? rec.msg : line);
    if (rec.lvl === "crit" || /ERR_NGROK_\d+/.test(text) || rec.obj === "tunnels.session") return { error: text.slice(0, 300) };
  }
  return undefined;
}

/** The agent config: the authtoken and everything the agent would otherwise open on its own, off. */
export function ngrokConfig(authtoken: string): string {
  return [
    "version: 3",
    "agent:",
    `  authtoken: ${JSON.stringify(authtoken)}`,
    "  web_addr: false",
    "  console_ui: false",
    "  update_check: false",
    "  remote_management: false",
    "",
  ].join("\n");
}

/** The reason selection and the UI (#385) show when there are none: what to set, until Outfitter
 * provisions them (#383). */
export const NO_NGROK_CREDENTIALS = "no ngrok credentials (set NGROK_AUTHTOKEN in .env; Kernal does not read ngrok's own config)";

function checkCredentials(c: TunnelCredentials | undefined): NgrokCredentials {
  if (!c || c.provider !== "ngrok") throw new TunnelError("credentials", NO_NGROK_CREDENTIALS);
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(c.authtoken ?? "")) throw new TunnelError("credentials", "the ngrok authtoken is missing or malformed");
  if (c.url !== undefined) {
    let u: URL | undefined;
    try { u = new URL(c.url); } catch { /* below */ }
    // https only: a plain-http endpoint would carry the bearer token and every prompt in clear.
    if (!u || u.protocol !== "https:" || u.port || u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
      throw new TunnelError("credentials", `not an https ngrok endpoint URL: ${c.url}`);
    }
  }
  if (c.bearerToken !== undefined) checkBearerToken(c.bearerToken);
  if (c.trafficPolicy !== undefined && (typeof c.trafficPolicy !== "string" || !c.trafficPolicy.trim())) {
    throw new TunnelError("credentials", "the traffic policy is empty");
  }
  return c;
}

// ---------- leftover agents ----------

const DIR_PREFIX = "kernal-tunnel-";
const OWNER_FILE = "owner.json";
/** A directory with no owner record (its host died between mkdtemp and the first write) this old is litter. */
const ORPHAN_DIR_MS = 10 * 60_000;

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

/** The live tunnels this process owns, for the 'exit' hook. */
const live = new Map<string, { pid?: number }>();
let exitHooked = false;
function onProcessExit(): void {
  for (const [dir, t] of live) {
    if (t.pid !== undefined) signalGroup(t.pid, "SIGKILL");
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  live.clear();
}
function track(dir: string, pid?: number): void {
  live.set(dir, { pid });
  if (!exitHooked) { process.once("exit", onProcessExit); exitHooked = true; }
}
function untrack(dir: string): void {
  live.delete(dir);
  if (live.size === 0 && exitHooked) { process.removeListener("exit", onProcessExit); exitHooked = false; }
}

/**
 * Removes this user's kernal-tunnel-* directories whose owning process is gone, first killing the
 * agent each one records, but only when that pid's command line still names the directory (a pid
 * the system has since reused is left alone). Never throws.
 */
export async function sweepLeftoverTunnels(deps: { exec?: Exec; tmp?: string } = {}): Promise<{ removed: string[]; killed: number[] }> {
  const exec = deps.exec ?? execShort;
  const base = deps.tmp ?? tmpdir();
  const out = { removed: [] as string[], killed: [] as number[] };
  const uid = process.getuid?.();
  let names: string[];
  try { names = await readdir(base); } catch { return out; }
  for (const name of names) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(base, name);
    if (live.has(dir)) continue;
    try {
      const st = await stat(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      let owner: { owner?: unknown; agent?: unknown } | undefined;
      try { owner = JSON.parse(await readFile(join(dir, OWNER_FILE), "utf8")); } catch { owner = undefined; }
      if (!owner) {
        if (Date.now() - st.mtimeMs > ORPHAN_DIR_MS) { await rm(dir, { recursive: true, force: true }); out.removed.push(dir); }
        continue;
      }
      if (typeof owner.owner === "number" && isAlive(owner.owner)) continue;   // another live host's tunnel
      const agent = typeof owner.agent === "number" && owner.agent > 1 ? owner.agent : undefined;
      if (agent !== undefined && isAlive(agent)) {
        const ps = await exec("ps", ["-o", "command=", "-p", String(agent)], 5_000);
        if (ps.code === 0 && ps.stdout.includes(dir)) {
          signalGroup(agent, "SIGKILL");
          for (let i = 0; i < 50 && isAlive(agent); i++) await new Promise((r) => setTimeout(r, 20));
          out.killed.push(agent);
        }
      }
      await rm(dir, { recursive: true, force: true });
      out.removed.push(dir);
    } catch { /* another sweeper got there first, or it is not ours */ }
  }
  return out;
}

export interface NgrokProviderDeps {
  exec?: Exec;
  binDir?: string;
  startTimeoutMs?: number;
}

export function ngrokProvider(deps: NgrokProviderDeps = {}): TunnelProvider {
  const timeoutMs = deps.startTimeoutMs ?? NGROK_START_TIMEOUT_MS;
  return {
    id: "ngrok",

    async status(credentials) {
      const base: ProviderStatus = { provider: "ngrok", available: false };
      try {
        const r = await findNgrok(deps);
        if (!r.found) return { ...base, reason: r.reason, installable: !!platformKey() };
        const runtime = `ngrok ${r.found.version} (${r.found.path})`;
        if (credentials) {
          try { checkCredentials(credentials); } catch (e: any) { return { ...base, runtime, reason: e.message }; }
        }
        return { provider: "ngrok", available: true, runtime, source: r.found.source };
      } catch (e: any) {
        return { ...base, reason: `could not check for ngrok: ${e?.message ?? e}` };
      }
    },

    async start(opts: TunnelStartOptions): Promise<Tunnel> {
      const creds = checkCredentials(opts.credentials);
      const policy = creds.trafficPolicy ?? ngrokTrafficPolicy({ allowPaths: opts.allowPaths ?? DEFAULT_ALLOW_PATHS, rateLimit: opts.rateLimit, bearerToken: creds.bearerToken });
      const r = await findNgrok(deps);
      if (!r.found) throw new TunnelError("unavailable", r.reason);
      const onLog = opts.onLog ?? (() => {});

      // An agent a dead host left behind still holds the domain: clear it before binding.
      const swept = await sweepLeftoverTunnels({ exec: deps.exec });
      for (const pid of swept.killed) onLog(`ngrok: stopped a leftover agent (pid ${pid}) from a host that exited without stopping it`);

      const dir = await mkdtemp(join(tmpdir(), DIR_PREFIX));
      await chmod(dir, 0o700);
      const ownerFile = join(dir, OWNER_FILE);
      await writeFile(ownerFile, JSON.stringify({ owner: process.pid }), { mode: 0o600 });
      track(dir);
      const cleanup = () => { untrack(dir); return rm(dir, { recursive: true, force: true }).catch(() => {}); };
      const config = join(dir, "ngrok.yml");
      const policyFile = join(dir, "policy.yml");
      await writeFile(config, ngrokConfig(creds.authtoken), { mode: 0o600 });
      await writeFile(policyFile, policy, { mode: 0o600 });
      const args = ["http", opts.localUrl, "--config", config, "--traffic-policy-file", policyFile, "--log", "stdout", "--log-format", "json"];
      if (creds.url) args.push("--url", creds.url);

      let child: ChildProcess;
      try {
        child = spawn(r.found.path, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
      } catch (err: any) {
        await cleanup();
        throw new TunnelError("unavailable", `could not start ngrok: ${err?.message ?? err}`);
      }
      track(dir, child.pid);
      await writeFile(ownerFile, JSON.stringify({ owner: process.pid, agent: child.pid }), { mode: 0o600 }).catch(() => {});
      let stopped = false;
      let started = false;
      let health: TunnelHealth = { state: "down", reason: "starting", since: new Date().toISOString() };
      let publicUrl = creds.url ?? "";

      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TunnelError("timeout", `ngrok did not start within ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
        let buf = "";
        const onData = (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            const verdict = classifyNgrokLog(line);
            if (!verdict) continue;
            if ("started" in verdict) {
              if (started) continue;
              publicUrl ||= verdict.url ?? "";
              if (!publicUrl) { clearTimeout(timer); reject(new TunnelError("failed", "ngrok started without reporting its URL")); return; }
              started = true;
              clearTimeout(timer);
              health = { state: "up", since: new Date().toISOString() };
              resolve();
            } else if (!started) {
              clearTimeout(timer);
              reject(new TunnelError(/ERR_NGROK_(105|4018)\b/.test(verdict.error) ? "credentials" : "failed", `ngrok: ${verdict.error}`));
            } else {
              onLog(`ngrok: ${verdict.error}`);
            }
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", (err) => { clearTimeout(timer); reject(new TunnelError("unavailable", `ngrok: ${err.message}`)); });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          void cleanup();
          const reason = `ngrok exited (code ${code}, signal ${signal})`;
          if (!started) { reject(new TunnelError("failed", `${reason} before the tunnel started`)); return; }
          if (stopped) return;
          health = { state: "down", reason, since: new Date().toISOString() };
          opts.onDown?.(reason);
        });
      });

      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        health = { state: "stopped", since: new Date().toISOString() };
        if (child.exitCode !== null || child.signalCode !== null) { await cleanup(); return; }
        const exited = new Promise<void>((res) => child.once("exit", () => res()));
        signalGroup(child.pid, "SIGTERM");
        const kill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
        kill.unref?.();
        await Promise.race([exited, new Promise((res) => setTimeout(res, STOP_GRACE_MS + 1000).unref?.())]);
        clearTimeout(kill);
        await cleanup();
      };

      try {
        await ready;
      } catch (err) {
        await stop();
        throw err;
      }
      return { provider: "ngrok", get publicUrl() { return publicUrl; }, health: () => ({ ...health }), stop };
    },
  };
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}
