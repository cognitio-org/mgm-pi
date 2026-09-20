/**
 * SandboxProvider that spawns agentd as a plain child process (no container), for tests and for the
 * host-only e2e smoke test when Docker isn't available. The handle is a synthetic id (not the OS
 * pid alone, since pids are reused); the live ChildProcess is kept in memory keyed by that id.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { RunLaunch, SandboxProvider, SandboxStatus } from "./types.js";

export interface InProcessProviderOptions {
  /** Path to the agentd entry point (e.g. ".../packages/agentd/dist/main.js"). */
  agentdPath: string;
  /** Path to the pi binary; forwarded as PI_BIN. */
  piBin: string;
  /** PI_CODING_AGENT_DIR forwarded to the child. */
  piCodingAgentDir?: string;
  /** WORKSPACE forwarded to the child; defaults to "/workspace". */
  workspace?: string;
  /** Injectable for tests; defaults to node:child_process.spawn. */
  spawnFn?: typeof spawn;
}

export class InProcessProvider implements SandboxProvider {
  private readonly children = new Map<string, ChildProcess>();
  private nextId = 1;

  constructor(private readonly opts: InProcessProviderOptions) {}

  async start(run: RunLaunch): Promise<{ handle: string }> {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const env: Record<string, string> = {
      ...process.env,
      OUTFITTER_API: run.apiOrigin,
      RUN_ID: run.runId,
      RUN_TOKEN: run.runToken,
      WORKSPACE: this.opts.workspace ?? "/workspace",
      PI_BIN: this.opts.piBin,
      ...(this.opts.piCodingAgentDir ? { PI_CODING_AGENT_DIR: this.opts.piCodingAgentDir } : {}),
      ...(run.devToken ? { OUTFITTER_DEV_TOKEN: run.devToken } : {}),
      ...(run.env ?? {}),
    };
    const child = spawnFn(process.execPath, [this.opts.agentdPath], { env, stdio: "inherit" });
    const handle = `inproc-${this.nextId++}`;
    this.children.set(handle, child);
    child.on("exit", () => this.children.delete(handle));
    return { handle };
  }

  async stop(handle: string): Promise<void> {
    this.children.get(handle)?.kill("SIGTERM");
  }

  async status(handle: string): Promise<SandboxStatus> {
    const child = this.children.get(handle);
    if (!child) return "exited";
    if (child.exitCode !== null || child.signalCode !== null) return "exited";
    return child.pid ? "running" : "starting";
  }
}
