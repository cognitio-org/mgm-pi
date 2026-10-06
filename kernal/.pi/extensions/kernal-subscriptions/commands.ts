/**
 * `kernal subscriptions` (subscriptions.md §5), run by bin/kernal before pi starts. Status, Claude's
 * `setup-token` upload, and disconnect. The token is uploaded and never printed.
 */
import { spawn } from "node:child_process";
import { getValue } from "../_shared/central-config.ts";
import type { SessionStorage } from "../_shared/outfitter-session.ts";
import { listSubscriptionVendors, outfitterError, outfitterJson, signedInAccount } from "./client.ts";
import { binaryOnPath, localVendorLogin } from "./local-login.ts";
import {
  SUBSCRIPTION_BINARY, SUBSCRIPTION_VENDORS, apiKeyEnvSet, isMode, isVendor,
  type SubscriptionMode, type SubscriptionVendor,
} from "./vendors.ts";

export const USAGE = "Usage: kernal subscriptions | kernal subscriptions connect claude | kernal subscriptions disconnect <claude|grok|codex|gemini>";

const LOGIN_FIRST = "Run kernal login first.";
const TOKEN_LINE = /^[!-~]{20,4096}$/;

export interface SubscriptionIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  storage?: SessionStorage;
  which?: (bin: string, env: NodeJS.ProcessEnv) => boolean;
  localLogin?: (vendor: SubscriptionVendor, env: NodeJS.ProcessEnv) => boolean;
  mode?: (vendor: SubscriptionVendor) => SubscriptionMode;
  spawnSetup?: (env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  home?: string;
}

/** A setup-token line, or undefined. A URL or a sentence is not a token. */
export function extractSetupToken(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (TOKEN_LINE.test(line)) return line;
  }
  return undefined;
}

/** What may be shown while `claude setup-token` runs. Long tokens go; URLs stay. */
export function redactSetupOutput(text: string): string {
  return text.replace(/[!-~]{20,}/g, (m) => (/:\/\//.test(m) ? m : "[redacted]"));
}

export interface StatusRow {
  vendor: SubscriptionVendor;
  mode: SubscriptionMode;
  binary: boolean;
  localLogin: boolean;
  /** `signed-out` and `unknown` are not a secret; `yes` means the account has one. */
  accountSecret: "yes" | "no" | "signed-out" | "unknown";
  /** Names of shadowing API-key variables that are set. Never the values. */
  apiKeyVars: string[];
}

export function formatStatus(row: StatusRow): string {
  const api = row.apiKeyVars.length ? `set:${row.apiKeyVars.join("+")}` : "unset";
  return `${row.vendor}  mode=${row.mode}  binary=${row.binary ? "yes" : "no"}  local-login=${row.localLogin ? "yes" : "no"}  account-secret=${row.accountSecret}  api-key=${api}`;
}

function modeOf(io: SubscriptionIo, vendor: SubscriptionVendor): SubscriptionMode {
  if (io.mode) return io.mode(vendor);
  const v = getValue(`subscriptions.${vendor}`);
  return isMode(typeof v === "string" ? v : undefined) ? v : "off";
}

/** `claude setup-token`, relaying stdout with tokens masked. stderr stays the terminal's. */
export function spawnSetupToken(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["setup-token"], { env, stdio: ["inherit", "pipe", "inherit"] });
    let stdout = "";
    let buf = "";
    const flush = (line: string) => process.stderr.write(`${redactSetupOutput(line)}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      buf += c;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) flush(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf) flush(buf);
      resolve({ code, stdout, stderr: "" });
    });
  });
}

async function status(io: SubscriptionIo): Promise<number> {
  const env = io.env ?? process.env;
  const which = io.which ?? ((bin, e) => binaryOnPath(bin, e));
  const local = io.localLogin ?? ((vendor, e) => localVendorLogin(vendor, { env: e, home: io.home }));
  const account = signedInAccount({ env, fetch: io.fetch, storage: io.storage });
  let secrets: Set<SubscriptionVendor> | undefined;
  let unknown = false;
  if (!account) {
    // signed out: the column says so. No request.
  } else {
    const listed = await listSubscriptionVendors({ env, fetch: io.fetch, storage: io.storage });
    if (listed.ok) secrets = listed.vendors;
    else {
      unknown = true;
      io.err(`Could not read account secrets (${"error" in listed ? listed.error : "not signed in"}).`);
    }
  }
  for (const vendor of SUBSCRIPTION_VENDORS) {
    const accountSecret = !account ? "signed-out" : unknown ? "unknown" : secrets?.has(vendor) ? "yes" : "no";
    io.out(formatStatus({
      vendor,
      mode: modeOf(io, vendor),
      binary: which(SUBSCRIPTION_BINARY[vendor], env),
      localLogin: local(vendor, env),
      accountSecret,
      apiKeyVars: apiKeyEnvSet(vendor, env),
    }));
  }
  return 0;
}

async function connect(vendor: string | undefined, extra: string | undefined, io: SubscriptionIo): Promise<number> {
  if (extra || !vendor) {
    io.err(USAGE);
    return 2;
  }
  if (vendor !== "claude") {
    io.err("kernal subscriptions connect: only claude has a guided login in this slice");
    return 2;
  }
  const env = io.env ?? process.env;
  if (!signedInAccount({ env, fetch: io.fetch, storage: io.storage })) {
    io.err(LOGIN_FIRST);
    return 1;
  }
  const run = io.spawnSetup ?? spawnSetupToken;
  let child: { code: number | null; stdout: string; stderr: string };
  try {
    child = await run(env);
  } catch {
    io.err("kernal subscriptions connect: could not run claude setup-token");
    return 1;
  }
  if (child.code !== 0) {
    io.err(`kernal subscriptions connect: claude setup-token exited ${child.code ?? "with a signal"}`);
    return 1;
  }
  const token = extractSetupToken(child.stdout);
  if (!token) {
    io.err("kernal subscriptions connect: claude setup-token did not print a token");
    return 1;
  }
  let res;
  try {
    res = await outfitterJson({ env, fetch: io.fetch, storage: io.storage }, "PUT", "/api/me/subscription-secrets/claude", { value: token });
  } catch (err) {
    io.err(`kernal subscriptions connect: ${err instanceof Error ? err.message : "Outfitter could not be reached"}`);
    return 1;
  }
  if ("signedOut" in res) {
    io.err(LOGIN_FIRST);
    return 1;
  }
  if (res.status < 200 || res.status >= 300) {
    const code = outfitterError(res.body);
    io.err(`kernal subscriptions connect: Outfitter refused the token (${res.status}${code ? `: ${code}` : ""})`);
    return 1;
  }
  io.err("Saved the Claude subscription token to your account.");
  return 0;
}

async function disconnect(vendor: string | undefined, extra: string | undefined, io: SubscriptionIo): Promise<number> {
  if (extra || !vendor || !isVendor(vendor)) {
    io.err(USAGE);
    return 2;
  }
  const env = io.env ?? process.env;
  if (!signedInAccount({ env, fetch: io.fetch, storage: io.storage })) {
    io.err(LOGIN_FIRST);
    return 1;
  }
  let res;
  try {
    res = await outfitterJson({ env, fetch: io.fetch, storage: io.storage }, "DELETE", `/api/me/subscription-secrets/${vendor}`);
  } catch (err) {
    io.err(`kernal subscriptions disconnect: ${err instanceof Error ? err.message : "Outfitter could not be reached"}`);
    return 1;
  }
  if ("signedOut" in res) {
    io.err(LOGIN_FIRST);
    return 1;
  }
  if (res.status < 200 || res.status >= 300) {
    const code = outfitterError(res.body);
    io.err(`kernal subscriptions disconnect: Outfitter refused (${res.status}${code ? `: ${code}` : ""})`);
    return 1;
  }
  io.err(`Removed the ${vendor} subscription secret.`);
  return 0;
}

/** Exit 0 done, 1 failed, 2 usage. argv is `kernal`'s arguments, starting with `subscriptions`. */
export async function main(argv: string[], io: SubscriptionIo): Promise<number> {
  const [command, sub, vendor, extra] = argv;
  if (command !== "subscriptions") {
    io.err(USAGE);
    return 2;
  }
  if (!sub) return status(io);
  if (sub === "connect") return connect(vendor, extra, io);
  if (sub === "disconnect") return disconnect(vendor, extra, io);
  io.err(USAGE);
  return 2;
}
