import { readFileSync } from "node:fs";
import { join } from "node:path";

/** VERSION's first line in a release bundle, "source" in a checkout. `root` is the Kernal root. */
export function kernalVersion(root: string): string {
  try {
    return readFileSync(join(root, "VERSION"), "utf8").split("\n")[0].trim() || "source";
  } catch {
    return "source";
  }
}
