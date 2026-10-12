#!/usr/bin/env node
import { spawn } from "node:child_process";
import { wiseBalances, wiseStatement, wiseStatus, linkWise, WiseError } from "./wise.mjs";

function openOnMac(url) {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const command = process.argv[2];

try {
  if (command === "status") {
    console.log(JSON.stringify(await wiseStatus(), null, 2));
  } else if (command === "link") {
    const linked = await linkWise({ openBrowser: openOnMac, log: console.error });
    console.log(JSON.stringify(linked, null, 2));
  } else if (command === "balances") {
    console.log(JSON.stringify(await wiseBalances(), null, 2));
  } else if (command === "statement") {
    console.log(JSON.stringify(await wiseStatement(process.env, arg("--balance"), arg("--days")), null, 2));
  } else {
    console.error("Usage: node src/wise-cli.mjs <status|link|balances|statement>");
    process.exit(2);
  }
} catch (err) {
  const code = err instanceof WiseError ? err.code : "PROVIDER_ERROR";
  console.error(`${code}: ${err instanceof Error ? err.message : "Wise request failed."}`);
  process.exit(1);
}
