import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertApplication,
  assertAuthUrl,
  assertCountry,
  assertTransactionId,
  consentBody,
  formatValidUntil,
  headerContext,
  matchBank,
  needsDeviceId,
  projectAccount,
  projectAccountDetails,
  projectBalance,
  projectTransaction,
  psuHeaders,
  rememberAccount,
  requireSession,
  selectAccount,
  sessionView,
  validUntilFrom,
  wholeNumber,
  DEFAULT_UA,
} from "./banking.mjs";
import { createClient } from "./client.mjs";
import {
  assertUuid,
  ConfigError,
  DEFAULT_REDIRECT,
  findRepoRoot,
  loadConfig,
  pathIsInside,
  readKey,
  resolveExisting,
} from "./config.mjs";
import { pendingPath, readPrivateJson, removePrivate, sessionPath, writePrivate } from "./store.mjs";
import { waitForCallback } from "./link.mjs";
import { HTTPS_REDIRECT, loadCallbackTls } from "./tls.mjs";

async function connected() {
  const config = await loadConfig();
  const key = await readKey(config.keyPath);
  const client = createClient({ appId: config.appId, privateKey: key });
  const app = await client.application();
  const summary = assertApplication(app, config);
  return { config, client, app, summary };
}

export async function status() {
  try {
    const config = await loadConfig();
    const session = await readPrivateJson(sessionPath(config.configDir), "session");
    return { configured: true, environment: config.environment, ...sessionView(session, new Date()) };
  } catch (err) {
    if (err instanceof ConfigError && err.code === "NOT_CONFIGURED") {
      return { configured: false, detail: err.message };
    }
    throw err;
  }
}

export async function check() {
  const { summary } = await connected();
  return summary;
}

export async function listBanks(country) {
  const code = assertCountry(country);
  const { client, app } = await connected();
  if (app.countries?.length && !app.countries.includes(code)) {
    throw new Error(`This application does not list country ${code}.`);
  }
  const data = await client.aspsps(code);
  const banks = (Array.isArray(data.aspsps) ? data.aspsps : []).map((bank) => ({
    name: bank.name,
    country: bank.country,
    psuTypes: bank.psu_types || [],
    maxConsentDays: Math.floor((bank.maximum_consent_validity || 0) / 86400),
    beta: Boolean(bank.beta),
  }));
  return { country: code, banks };
}

async function useSession() {
  const ctx = await connected();
  const session = requireSession(await readPrivateJson(sessionPath(ctx.config.configDir), "session"), new Date());
  return { ...ctx, session };
}

export async function accounts() {
  const { session } = await useSession();
  return { bank: `${session.aspsp.name} (${session.aspsp.country})`, accounts: session.accounts.map(projectAccount) };
}

export async function accountDetails(which) {
  const { client, config, session } = await useSession();
  const account = selectAccount(session.accounts, which);
  const data = await client.accountDetails(account.uid, psuHeaders(session.requiredPsuHeaders, headerContext(session, config)));
  return { account: projectAccount(account), details: projectAccountDetails(data) };
}

export async function balances(which) {
  const { client, config, session } = await useSession();
  const account = selectAccount(session.accounts, which);
  const data = await client.balances(account.uid, psuHeaders(session.requiredPsuHeaders, headerContext(session, config)));
  const list = Array.isArray(data.balances) ? data.balances : [];
  return { account: projectAccount(account), balances: list.map(projectBalance) };
}

export async function transactions(which, daysValue, limitValue) {
  const days = wholeNumber(daysValue, 30, 1, 90, "days");
  const limit = wholeNumber(limitValue, 20, 1, 40, "limit");
  const { client, config, session } = await useSession();
  const account = selectAccount(session.accounts, which);
  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const headers = psuHeaders(session.requiredPsuHeaders, headerContext(session, config));
  const rows = [];
  let continuation = "";
  for (let page = 0; page < 4 && rows.length < limit; page += 1) {
    const data = await client.transactions(account.uid, {
      date_from: dateFrom,
      continuation_key: continuation || undefined,
    }, headers);
    const batch = Array.isArray(data.transactions) ? data.transactions : [];
    for (const tx of batch) {
      rows.push(projectTransaction(tx));
      if (rows.length >= limit) break;
    }
    continuation = typeof data.continuation_key === "string" ? data.continuation_key : "";
    if (!continuation) break;
  }
  return { account: projectAccount(account), dateFrom, transactions: rows };
}

export async function transactionDetail(which, transactionId) {
  const id = assertTransactionId(transactionId);
  const { client, config, session } = await useSession();
  const account = selectAccount(session.accounts, which);
  const data = await client.transaction(account.uid, id, psuHeaders(session.requiredPsuHeaders, headerContext(session, config)));
  return { account: projectAccount(account), transaction: projectTransaction(data) };
}

function openOnMac(url) {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

export async function linkBank({ country, name, days, psuType = "personal", openBrowser = openOnMac, timeoutMs, log = console.log }) {
  const code = assertCountry(country);
  const consentDays = wholeNumber(days, 10, 1, 90, "days");
  const { config, client, app } = await connected();
  if (app.countries?.length && !app.countries.includes(code)) {
    throw new Error(`This application does not list country ${code}.`);
  }
  const listed = await client.aspsps(code);
  const bank = matchBank(listed.aspsps, name);
  const until = formatValidUntil(validUntilFrom(new Date(), consentDays, bank.maximum_consent_validity));
  const state = randomUUID();
  const required = Array.isArray(bank.required_psu_headers) ? bank.required_psu_headers : [];
  const deviceId = needsDeviceId(required) ? randomUUID() : null;
  const pending = {
    version: 1,
    state,
    createdAt: new Date().toISOString(),
    requiredPsuHeaders: required,
    deviceId,
  };
  const tls = config.tls ? await loadCallbackTls() : null;
  await writePrivate(pendingPath(config.configDir), `${JSON.stringify(pending)}\n`);
  const waiter = waitForCallback({ port: config.port, expectedState: state, timeoutMs, tls });
  try {
    await waiter.ready;
    const headers = psuHeaders(required, {
      ip: "127.0.0.1",
      userAgent: DEFAULT_UA,
      referer: config.redirectUrl,
      deviceId,
    });
    const started = await client.startAuth(consentBody({
      aspsp: { name: bank.name, country: bank.country },
      state,
      redirectUrl: config.redirectUrl,
      validUntil: until,
      psuType,
    }), headers);
    const url = assertAuthUrl(started.url);
    log(`Waiting for the bank to redirect to ${config.redirectUrl}`);
    log(`Open this login if the browser does not:\n${url}`);
    openBrowser(url);
    const callback = await waiter.done;
    const created = await client.createSession(callback.code, psuHeaders(required, {
      ip: "127.0.0.1",
      userAgent: callback.userAgent || DEFAULT_UA,
      referer: config.redirectUrl,
      deviceId,
    }));
    const sessionId = assertUuid(created.session_id, "Session id");
    const confirmed = await client.getSession(sessionId);
    if (confirmed.status !== "AUTHORIZED") {
      throw new Error(`Bank session status is ${confirmed.status}. Nothing was saved.`);
    }
    const accounts = [];
    for (const raw of Array.isArray(created.accounts) ? created.accounts : []) {
      const account = rememberAccount(raw, accounts.length + 1);
      if (account) accounts.push(account);
    }
    if (!accounts.length) throw new Error("The bank authorized no readable account. Nothing was saved.");
    const session = {
      version: 1,
      sessionId,
      aspsp: { name: bank.name, country: bank.country },
      psuType,
      validUntil: created.access?.valid_until || until,
      linkedAt: new Date().toISOString(),
      requiredPsuHeaders: required,
      psuUserAgent: callback.userAgent || DEFAULT_UA,
      deviceId,
      accounts,
    };
    await writePrivate(sessionPath(config.configDir), `${JSON.stringify(session)}\n`);
    return {
      bank: `${bank.name} (${bank.country})`,
      validUntil: session.validUntil,
      accounts: accounts.map(projectAccount),
    };
  } finally {
    await waiter.close();
    await removePrivate(pendingPath(config.configDir));
  }
}

export async function unlink(configDir = process.env.ENABLEBANKING_CONFIG_DIR || path.join(homedir(), ".config", "enablebanking")) {
  return {
    removedSession: await removePrivate(sessionPath(configDir)),
    removedPending: await removePrivate(pendingPath(configDir)),
  };
}

export async function init({
  appId,
  keyPath,
  configDir,
  repoRoot,
  force = false,
  environment = "sandbox",
  allowProduction = false,
  sandboxDir,
}) {
  const id = assertUuid(appId, "Application id");
  if (!keyPath) throw new ConfigError("CONFIG", "Pass --key with the .pem file Enable Banking downloaded.");
  const envName = String(environment || "sandbox").toLowerCase();
  if (envName !== "sandbox" && envName !== "production") {
    throw new ConfigError("CONFIG", "Pass --environment sandbox or --environment production.");
  }
  if (envName === "production" && !allowProduction) {
    throw new ConfigError(
      "PRODUCTION",
      "Export ENABLEBANKING_ALLOW_PRODUCTION=1 in the shell for this init. The flag is not written to config.env.",
    );
  }
  const sandboxDefault = sandboxDir ?? path.join(homedir(), ".config", "enablebanking");
  const dir = configDir ?? (envName === "production"
    ? path.join(homedir(), ".config", "enablebanking-prod")
    : sandboxDefault);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (envName === "production") {
    const resolvedDir = await resolveExisting(dir);
    const resolvedSandbox = await resolveExisting(sandboxDefault);
    if (resolvedDir === resolvedSandbox) {
      throw new ConfigError("PRODUCTION", "Production init will not write into the sandbox directory ~/.config/enablebanking.");
    }
  }
  const redirectUrl = envName === "production" ? HTTPS_REDIRECT : DEFAULT_REDIRECT;
  const source = path.resolve(keyPath);
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigError("PRIVATE_FILE", "The key path must be a regular file, not a symlink.");
  }
  if (info.size > 16_384) throw new ConfigError("PRIVATE_FILE", "That file is too large to be an application private key.");
  const pem = await readFile(source, "utf8");
  if (!pem.includes("PRIVATE KEY")) throw new ConfigError("PRIVATE_FILE", "That file does not look like a PEM private key.");
  const root = repoRoot === undefined ? findRepoRoot(process.cwd()) : repoRoot;
  const sourceReal = await realpath(source);
  const resolvedRoot = await resolveExisting(root);
  if (resolvedRoot && pathIsInside(sourceReal, resolvedRoot)) {
    throw new ConfigError("PRIVATE_FILE", "That key is inside the git checkout. Pass the downloaded file. init moves it to ~/.config/enablebanking/.");
  }
  const dest = path.join(dir, `${id}.pem`);
  const destReal = await resolveExisting(dest);
  if (destReal !== sourceReal) {
    let existing = null;
    try {
      existing = await lstat(dest);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (existing) {
      if (existing.isSymbolicLink()) throw new ConfigError("PRIVATE_FILE", `${dest} is a symlink. Remove it yourself, then run init again.`);
      if (!force) throw new ConfigError("PRIVATE_FILE", `${dest} already exists. Pass --force to replace it.`);
      await rm(dest);
    }
    try {
      await rename(sourceReal, dest);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      await copyFile(sourceReal, dest);
      await rm(sourceReal);
    }
  }
  await chmod(dest, 0o600);
  const body = [
    "# Local Enable Banking proof of concept. This file is mode 600.",
    `ENABLEBANKING_APP_ID=${id}`,
    `ENABLEBANKING_KEY_PATH=${dest}`,
    `ENABLEBANKING_ENVIRONMENT=${envName}`,
    `ENABLEBANKING_REDIRECT_URL=${redirectUrl}`,
    "",
  ].join("\n");
  await writePrivate(path.join(dir, "config.env"), body);
  return { configDir: dir, keyPath: dest, redirectUrl, environment: envName, appId: id };
}
