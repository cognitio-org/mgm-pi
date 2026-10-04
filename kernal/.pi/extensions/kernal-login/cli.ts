/**
 * `kernal login`, `kernal logout`, `kernal whoami` (#391 CA-2, outfitter/docs/specs/central-auth.md
 * §2.5). bin/kernal runs this with node before pi starts, like teleport/cli.ts: argv[2] is the
 * subcommand, the rest its flags. Owned by task E. Exit codes: 0 done, 1 failed, 2 usage.
 *
 * No index.ts here on purpose: pi loads only extension directories that have one.
 */
import { loginState, outfitterApi } from "../_shared/outfitter-session.ts";

const [command] = process.argv.slice(2);

if (command === "whoami") {
  const state = loginState();
  if (state.signedIn) console.log(`${state.account.email} on ${state.account.api} (device ${state.account.deviceName})`);
  else console.log(`not signed in to ${outfitterApi()}`);
  process.exit(state.signedIn ? 0 : 1);
} else if (command === "login" || command === "logout") {
  console.error(`kernal ${command}: not available yet (outfitter/docs/specs/central-auth.md, CA-2)`);
  process.exit(1);
} else {
  console.error("Usage: kernal login | kernal logout | kernal whoami");
  process.exit(2);
}
