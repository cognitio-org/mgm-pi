/**
 * Starts one ngrok agent for one Drive preview (docs/specs/drive-previews.md, #217). The agent binds
 * an *internal* endpoint (`https://p<port>.<run>.internal`): nothing on the internet can reach it,
 * only the api's cloud endpoint for this preview, through ngrok's forward-internal action. The
 * per-run credential's ACL (`bind:*.<run>.internal`) is what stops it binding anything else.
 *
 * agentd runs as root and pi as the `agent` user, so the credential lives in a 0600 root-owned temp
 * config the model's shell can't read (the spec assumes it could; this is stricter). The agent runs
 * in its own process group so stop() takes any helper it spawns with it.
 *
 * One agent per preview for now. A single agent serving every preview endpoint of the run would save
 * a process and a session per port; worth it once runs keep several previews open.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NGROK_START_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 2_000;

export class NgrokStartError extends Error {
  readonly kind: "timeout" | "failed";
  constructor(kind: "timeout" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface NgrokRunnerOptions {
  /** Where the tunnel delivers traffic: the local preview proxy, e.g. `http://127.0.0.1:41234`. */
  upstream: string;
  /** The internal endpoint to bind, e.g. `https://p3000.r1a2b.internal`. */
  url: string;
  authtoken: string;
  /** The ngrok binary (default `ngrok` on PATH). */
  bin?: string;
  startTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** Called once if the agent exits after it started (not after stop()). */
  onExit?: (reason: string) => void;
}

export interface NgrokTunnel {
  readonly url: string;
  stop(): Promise<void>;
}

/** One line of the agent's `--log-format json` output: bound, refused, or neither. */
export function classifyNgrokLog(line: string): { started: true } | { error: string } | undefined {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return /ERR_NGROK_\d+/.test(line) ? { error: line.trim().slice(0, 300) } : undefined;
  }
  if (rec.msg === "started tunnel") return { started: true };
  const err = typeof rec.err === "string" ? rec.err : undefined;
  if (rec.lvl === "crit" || rec.lvl === "eror" || (err && /ERR_NGROK_\d+/.test(err))) {
    const text = err ?? (typeof rec.msg === "string" ? rec.msg : line);
    // Session-level errors are fatal for a start; an "eror" about one request later isn't ours to judge.
    if (rec.lvl === "crit" || /ERR_NGROK_\d+/.test(text) || rec.obj === "tunnels.session") return { error: text.slice(0, 300) };
  }
  return undefined;
}

/** Starts the agent and resolves once it reports "started tunnel". Throws NgrokStartError. */
export async function startNgrok(opts: NgrokRunnerOptions): Promise<NgrokTunnel> {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-ngrok-"));
  const config = join(dir, "ngrok.yml");
  await writeFile(config, `version: 3\nagent:\n  authtoken: ${JSON.stringify(opts.authtoken)}\n`, { mode: 0o600 });
  const onLog = opts.onLog ?? (() => {});
  let child: ChildProcess;
  try {
    child = spawn(
      opts.bin ?? "ngrok",
      ["http", opts.upstream, "--url", opts.url, "--config", config, "--log", "stdout", "--log-format", "json"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NGROK_AUTHTOKEN: "" } },
    );
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new NgrokStartError("failed", `could not start ngrok: ${(err as Error).message}`);
  }
  let stopped = false;
  let started = false;
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new NgrokStartError("timeout", `ngrok did not start within ${opts.startTimeoutMs ?? NGROK_START_TIMEOUT_MS} ms`)), opts.startTimeoutMs ?? NGROK_START_TIMEOUT_MS);
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
          if (!started) { started = true; clearTimeout(timer); resolve(); }
        } else if (!started) {
          clearTimeout(timer);
          reject(new NgrokStartError("failed", verdict.error));
        } else {
          onLog(`ngrok ${opts.url}: ${verdict.error}`);
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (err) => { clearTimeout(timer); reject(new NgrokStartError("failed", `ngrok: ${err.message}`)); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      void cleanup();
      if (!started) reject(new NgrokStartError("failed", `ngrok exited before the tunnel started (code ${code}, signal ${signal})`));
      else if (!stopped) opts.onExit?.(`ngrok exited (code ${code}, signal ${signal})`);
    });
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) { await cleanup(); return; }
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    signalGroup(child.pid, "SIGTERM");
    const kill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
    kill.unref?.();
    await Promise.race([exited, new Promise((r) => setTimeout(r, STOP_GRACE_MS + 1000).unref?.())]);
    clearTimeout(kill);
    await cleanup();
  };

  try {
    await ready;
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: opts.url, stop };
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}
