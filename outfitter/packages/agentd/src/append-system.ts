/**
 * The APPEND_SYSTEM.md pi would find by itself (PR #146 review). pi only looks for that file when
 * no `--append-system-prompt` is passed (resource-loader.js), and since issue #132 renderGuru always
 * passes one, for the HTML preview paragraph. So agentd finds the file the way pi does and hands its
 * path over as its own `--append-system-prompt`, which pi accepts as a file (and more than once).
 *
 * pi's order: the project's `.pi/APPEND_SYSTEM.md` when the project is trusted (agentd always
 * passes `-a`), else `APPEND_SYSTEM.md` in the agent dir (PI_CODING_AGENT_DIR in the image).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export function discoverAppendSystemPromptFile(
  workspace: string,
  agentDir: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const project = join(workspace, ".pi", "APPEND_SYSTEM.md");
  if (exists(project)) return project;
  if (agentDir) {
    const global = join(agentDir, "APPEND_SYSTEM.md");
    if (exists(global)) return global;
  }
  return undefined;
}
