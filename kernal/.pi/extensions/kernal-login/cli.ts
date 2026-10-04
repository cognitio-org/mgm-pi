/**
 * `kernal login`, `kernal logout`, `kernal whoami` (#391 CA-2, outfitter/docs/specs/central-auth.md
 * §2.5). bin/kernal runs this with node before pi starts, like teleport/cli.ts: argv[2] is the
 * subcommand, the rest its flags. Owned by task E. Exit codes: 0 done, 1 failed, 2 usage.
 * The commands themselves are in commands.ts.
 *
 * No index.ts here on purpose: pi loads only extension directories that have one.
 */
import { main } from "./commands.ts";
import { offerEnvImport, terminalAsk } from "./env-import.ts";

// Ctrl-C stops a login that is waiting for approval; nothing is stored then.
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());

const code = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  signal: abort.signal,
});
// CA-10 (§12.1): after a login, offer to move the keys in .env to the account. Asks only on a terminal.
if (code === 0 && process.argv[2] === "login") await offerEnvImport({ err: (line) => process.stderr.write(`${line}\n`), ask: terminalAsk() });
process.exit(code);
