/**
 * Run by scripts/install.sh during an upgrade (not an extension: pi loads only index.ts here):
 *
 *   settings-merge.ts --ours <old settings.json> --theirs <new settings.shipped.json> --out <new settings.json> [--base <old settings.shipped.json>]
 *
 * Writes the new release's settings with the user's changes on top (see settings.ts) and prints one
 * line saying what was kept. A release bundle has no Node, so the installer runs this with the
 * bundle's own pi binary (a Bun executable: BUN_BE_BUN=1 pi/pi settings-merge.ts ...); a machine with
 * Node 22.18+ can run it directly. Exit 1 leaves --out untouched.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mergeSettings } from "./settings.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function readObject(file: string): Record<string, any> {
  const v = JSON.parse(readFileSync(file, "utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} does not hold a JSON object`);
  return v;
}

try {
  const ours = arg("ours"), theirs = arg("theirs"), out = arg("out"), base = arg("base");
  if (!ours || !theirs || !out) throw new Error("usage: settings-merge.ts --ours <file> --theirs <file> --out <file> [--base <file>]");
  const r = mergeSettings(base && existsSync(base) ? readObject(base) : undefined, readObject(ours), readObject(theirs));
  writeFileSync(out, JSON.stringify(r.settings, null, 2) + "\n");
  const list = r.kept.length > 6 ? `${r.kept.slice(0, 6).join(", ")} and ${r.kept.length - 6} more` : r.kept.join(", ");
  console.log(r.kept.length
    ? `settings: kept your ${r.kept.length === 1 ? "change" : `${r.kept.length} changes`} (${list})${r.legacy ? "; first upgrade from a bundle without a shipped copy, so only your own choices were carried" : ""}; new defaults from this release applied`
    : "settings: nothing of yours to carry over; this release's defaults applied");
} catch (e: any) {
  console.error(`settings merge failed: ${e?.message ?? e}`);
  process.exit(1);
}
