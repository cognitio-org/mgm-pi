#!/usr/bin/env node
import { accountDetails, accounts, balances, check, init, linkBank, listBanks, status, transactionDetail, transactions, unlink } from "./actions.mjs";
import { ensureCallbackTls, HTTPS_REDIRECT, trustCallbackCa } from "./tls.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "help";
  const flags = {};
  for (let i = command === "help" ? 0 : 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}.`);
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next == null || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function print(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const HELP = `Local read-only Enable Banking proof of concept.

  node src/cli.mjs init --app-id <uuid> --key <downloaded.pem>
  ENABLEBANKING_ALLOW_PRODUCTION=1 node src/cli.mjs init --environment production --app-id <uuid> --key <downloaded.pem>
  node src/cli.mjs check
  node src/cli.mjs banks --country FI
  node src/cli.mjs link --country FI --name "Mock ASPSP"
  node src/cli.mjs accounts
  node src/cli.mjs balances [--account 1]
  node src/cli.mjs details [--account 1]
  node src/cli.mjs transactions [--account 1] [--days 30] [--limit 20]
  node src/cli.mjs transaction --account 1 --id <id-from-transactions>
  node src/cli.mjs unlink
  node src/cli.mjs status
  node src/cli.mjs tls

The private key and the bank session stay in ~/.config/enablebanking (mode 600).
This program never calls a payment endpoint.`;

async function main() {
  const { command, flags } = parseArgs(process.argv);
  if (command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "init") {
    const environment = typeof flags.environment === "string" ? flags.environment : "sandbox";
    const saved = await init({
      appId: flags["app-id"],
      keyPath: flags.key,
      force: flags.force === true,
      environment,
      allowProduction: process.env.ENABLEBANKING_ALLOW_PRODUCTION === "1",
      configDir: environment.toLowerCase() === "production" ? process.env.ENABLEBANKING_CONFIG_DIR : undefined,
    });
    print(saved);
    console.log(`\nIn the Enable Banking control panel, whitelist exactly:\n  ${saved.redirectUrl}\nThen run: node src/cli.mjs check`);
    return;
  }
  if (command === "check") {
    const summary = await check();
    print(summary);
    return;
  }
  if (command === "tls") {
    const saved = await ensureCallbackTls();
    await trustCallbackCa(saved.caCrt);
    console.log(`Local callback certificate is in ${saved.dir}.`);
    console.log(`In the production application, whitelist exactly:\n  ${HTTPS_REDIRECT}`);
    return;
  }
  if (command === "status") return print(await status());
  if (command === "banks") return print(await listBanks(flags.country));
  if (command === "accounts") return print(await accounts());
  if (command === "balances") return print(await balances(flags.account));
  if (command === "details") return print(await accountDetails(flags.account));
  if (command === "transactions") return print(await transactions(flags.account, flags.days, flags.limit));
  if (command === "transaction") return print(await transactionDetail(flags.account, flags.id));
  if (command === "unlink") return print(await unlink());
  if (command === "link") {
    const linked = await linkBank({
      country: flags.country,
      name: flags.name,
      days: flags.days,
      psuType: flags["psu-type"] || "personal",
    });
    print(linked);
    return;
  }
  throw new Error(`Unknown command ${command}. Run: node src/cli.mjs`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Banking command failed.");
  process.exitCode = 1;
});
