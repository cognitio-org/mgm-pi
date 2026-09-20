/**
 * Dev-only SandboxProvider that runs the outfitter-agent image with `docker run`, using the same
 * env vars a Cloud Run Job execution would set (OUTFITTER_API, RUN_ID, OUTFITTER_DEV_TOKEN). The
 * handle is the container id `docker run -d` prints.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunLaunch, SandboxProvider, SandboxStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export interface LocalDockerProviderOptions {
  /** Path to the docker binary. Defaults to "docker" (resolved via PATH). */
  dockerBin?: string;
  /** Default image reference when a RunLaunch does not name one. */
  defaultImage?: string;
}

export class LocalDockerProvider implements SandboxProvider {
  private readonly dockerBin: string;
  private readonly defaultImage: string;

  constructor(opts: LocalDockerProviderOptions = {}) {
    this.dockerBin = opts.dockerBin ?? "docker";
    this.defaultImage = opts.defaultImage ?? "outfitter-agent";
  }

  async start(run: RunLaunch): Promise<{ handle: string }> {
    const args = [
      "run",
      "--rm",
      "-d",
      "--name",
      `outfitter-${run.runId}`,
      "-e",
      `OUTFITTER_API=${run.apiOrigin}`,
      "-e",
      `RUN_ID=${run.runId}`,
    ];
    if (run.devToken) args.push("-e", `OUTFITTER_DEV_TOKEN=${run.devToken}`);
    for (const [k, v] of Object.entries(run.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(run.image ?? this.defaultImage);

    const { stdout } = await execFileAsync(this.dockerBin, args);
    const handle = stdout.trim();
    if (!handle) throw new Error("LocalDockerProvider: docker run produced no container id");
    return { handle };
  }

  async stop(handle: string): Promise<void> {
    await execFileAsync(this.dockerBin, ["stop", handle]).catch(() => {
      // already stopped/removed (--rm) is not an error for our purposes
    });
  }

  async status(handle: string): Promise<SandboxStatus> {
    try {
      const { stdout } = await execFileAsync(this.dockerBin, [
        "inspect",
        "-f",
        "{{.State.Status}}",
        handle,
      ]);
      const state = stdout.trim();
      if (state === "running") return "running";
      if (state === "created" || state === "restarting") return "starting";
      if (state === "exited" || state === "dead") return "exited";
      return "unknown";
    } catch {
      // docker inspect fails once a --rm container has been removed after exiting
      return "exited";
    }
  }
}
