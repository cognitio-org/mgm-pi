/**
 * `kernal subscriptions` (subscriptions.md §5). bin/kernal runs this with node before pi starts, so
 * it imports nothing from pi. argv[2] is `subscriptions`. Exit codes: 0 done, 1 failed, 2 usage.
 *
 * No index.ts here on purpose: pi loads only extension directories that have one. The Claude runner
 * is runner.ts, imported by the coordinator, not started from this command.
 */
import { main } from "./commands.ts";

const code = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exit(code);
