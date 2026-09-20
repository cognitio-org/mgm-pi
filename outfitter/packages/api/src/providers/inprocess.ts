// Dev provider: spawns `node <AGENTD_MAIN>` as a plain child process instead of a container or
// Cloud Run Job. Good enough for local end-to-end runs of the API against a real agentd.

import { spawn, type ChildProcess } from "node:child_process";
import type { SandboxProvider, RunStartInput, ProviderStatus } from "./types.ts";

interface InProcessHandle {
  pid?: number;
}

export class InProcessProvider implements SandboxProvider {
  private readonly children = new Map<number, ChildProcess>();
  private readonly apiOrigin: string;
  private readonly agentdMain: string | undefined;

  constructor(apiOrigin: string, agentdMain: string | undefined = process.env.AGENTD_MAIN) {
    this.apiOrigin = apiOrigin;
    this.agentdMain = agentdMain;
  }

  async start(run: RunStartInput): Promise<{ handle: unknown }> {
    if (!this.agentdMain) {
      throw new Error("AGENTD_MAIN is not set; required for SANDBOX_PROVIDER=inprocess");
    }
    const child = spawn(process.execPath, [this.agentdMain], {
      env: { ...process.env, RUN_ID: run.runId, OUTFITTER_API: this.apiOrigin },
      stdio: "inherit",
    });
    if (child.pid) {
      this.children.set(child.pid, child);
      child.on("exit", () => {
        if (child.pid) this.children.delete(child.pid);
      });
    }
    const handle: InProcessHandle = { pid: child.pid };
    return { handle };
  }

  async stop(handle: unknown): Promise<void> {
    const pid = (handle as InProcessHandle).pid;
    if (!pid) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already exited
    }
  }

  async status(handle: unknown): Promise<ProviderStatus> {
    const pid = (handle as InProcessHandle).pid;
    if (!pid) return { state: "unknown" };
    return { state: this.children.has(pid) ? "running" : "stopped" };
  }
}
