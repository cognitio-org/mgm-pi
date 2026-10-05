/**
 * `kernal local enable | disable | status | run` (#381, outfitter/docs/specs/local-host.md §4).
 * bin/kernal runs this with Node 22.18+ or, in a release bundle without Node, the bundled pi binary
 * as Bun (exec_local_runtime), so it imports only node: built-ins and relative .ts files, never pi
 * or an npm package (tests/local-cli.test.ts walks the import graph). argv[2] is the subcommand.
 * Exit codes: 0 done, 1 failed, 2 usage. The commands themselves are in commands.ts.
 *
 * No index.ts here on purpose: pi loads only extension directories that have one.
 */
import { fileURLToPath } from "node:url";
import { main } from "./commands.ts";

const code = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  root: fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/+$/, ""),
});
process.exit(code);
