import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

export const DEFAULT_REDIRECT = "http://127.0.0.1:8787/callback";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function findRepoRoot(start) {
  let dir = path.resolve(start);
  while (true) {
    try {
      const info = statSync(path.join(dir, ".git"));
      if (info.isDirectory() || info.isFile()) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new ConfigError("CONFIG", "config.env has a line that is not KEY=VALUE.");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/[\n\r]/.test(value)) throw new ConfigError("CONFIG", "config.env values cannot span lines.");
    out[match[1]] = value;
  }
  if (Object.hasOwn(out, "ENABLEBANKING_ALLOW_PRODUCTION")) {
    throw new ConfigError(
      "PRODUCTION",
      "Remove ENABLEBANKING_ALLOW_PRODUCTION from config.env. Export it in the shell for one command if you intend to use a production application.",
    );
  }
  return out;
}

export function parseRedirect(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("REDIRECT", "ENABLEBANKING_REDIRECT_URL is not a URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname !== "127.0.0.1") {
    throw new ConfigError("REDIRECT", "The redirect URL must be http://127.0.0.1:<port>/callback or https://127.0.0.1:<port>/callback. This proof of concept does not listen on a public host.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ConfigError("REDIRECT", "The redirect port must be between 1024 and 65535.");
  }
  if (url.pathname !== "/callback" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError("REDIRECT", "The redirect URL path must be exactly /callback, with no query, fragment, or userinfo.");
  }
  return {
    redirectUrl: `${url.protocol}//127.0.0.1:${port}/callback`,
    port,
    tls: url.protocol === "https:",
  };
}

export async function resolveExisting(dir) {
  if (!dir) return null;
  try {
    return await realpath(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return path.resolve(dir);
  }
}

export function pathIsInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new ConfigError("CONFIG", `${label} is not a UUID.`);
  return value.toLowerCase();
}

export async function assertPrivateFile(file) {
  const info = await lstat(file);
  if (info.isSymbolicLink()) {
    throw new ConfigError("PRIVATE_FILE", `${file} is a symlink. Point the config at the real file.`);
  }
  if (!info.isFile()) throw new ConfigError("PRIVATE_FILE", `${file} is not a regular file.`);
  if (typeof info.uid === "number" && info.uid !== process.getuid()) {
    throw new ConfigError("PRIVATE_FILE", `${file} is owned by another user.`);
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    throw new ConfigError("PRIVATE_FILE", `${file} is mode ${mode.toString(8)}. Run: chmod 600 ${file}`);
  }
  const resolved = await realpath(file);
  const parent = await lstat(path.dirname(resolved));
  if (parent.isSymbolicLink()) {
    throw new ConfigError("PRIVATE_FILE", `The directory holding ${file} is a symlink.`);
  }
  if (typeof parent.uid === "number" && parent.uid !== process.getuid()) {
    throw new ConfigError("PRIVATE_FILE", `The directory holding ${file} is owned by another user.`);
  }
  const parentMode = parent.mode & 0o777;
  if ((parentMode & 0o077) !== 0) {
    throw new ConfigError(
      "PRIVATE_FILE",
      `The directory holding the private key must not be readable by the group or by others. ${path.dirname(resolved)} is mode ${parentMode.toString(8)}.`,
    );
  }
  return resolved;
}

export async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? env.ENABLEBANKING_CONFIG_DIR ?? path.join(options.homedir ?? homedir(), ".config", "enablebanking");
  const repoRoot = options.repoRoot === undefined
    ? findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))
    : options.repoRoot;
  const resolvedRepo = await resolveExisting(repoRoot);

  let fromFile = {};
  const envFile = path.join(configDir, "config.env");
  try {
    const info = await lstat(envFile);
    if (info.isSymbolicLink()) throw new ConfigError("PRIVATE_FILE", `${envFile} is a symlink.`);
    const mode = info.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o400) {
      throw new ConfigError("PRIVATE_FILE", `${envFile} is mode ${mode.toString(8)}. Run: chmod 600 ${envFile}`);
    }
    fromFile = parseEnvFile(await readFile(envFile, "utf8"));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (err.code !== "ENOENT") throw err;
  }

  const merged = { ...fromFile, ...stripEmpty(env) };
  const appId = merged.ENABLEBANKING_APP_ID;
  const keyPath = merged.ENABLEBANKING_KEY_PATH;
  const environment = (merged.ENABLEBANKING_ENVIRONMENT || "").toLowerCase();
  if (!appId || !keyPath || !environment) {
    throw new ConfigError(
      "NOT_CONFIGURED",
      "Enable Banking is not configured. From the banking directory, run: node src/cli.mjs init --app-id <application-id> --key <path-to.pem>",
    );
  }
  if (environment !== "sandbox" && environment !== "production") {
    throw new ConfigError("CONFIG", "ENABLEBANKING_ENVIRONMENT must be sandbox or production.");
  }
  const allowProduction = env.ENABLEBANKING_ALLOW_PRODUCTION === "1";
  if (environment === "production" && !allowProduction) {
    throw new ConfigError(
      "PRODUCTION",
      "config.env says production. Export ENABLEBANKING_ALLOW_PRODUCTION=1 in the shell for one command to use it. A sandbox application is the one to use until then.",
    );
  }
  const redirect = parseRedirect(merged.ENABLEBANKING_REDIRECT_URL || DEFAULT_REDIRECT);
  if (!path.isAbsolute(keyPath)) throw new ConfigError("PRIVATE_FILE", "ENABLEBANKING_KEY_PATH must be an absolute path.");
  let resolvedKey;
  try {
    resolvedKey = await assertPrivateFile(keyPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new ConfigError("PRIVATE_FILE", `Private key not found at ${keyPath}. Run init again with the .pem you downloaded.`);
    }
    throw err;
  }
  if (resolvedRepo && pathIsInside(resolvedKey, resolvedRepo)) {
    throw new ConfigError("PRIVATE_FILE", "The private key is inside the git checkout. Move it to ~/.config/enablebanking/.");
  }
  return {
    configDir,
    appId: assertUuid(appId, "ENABLEBANKING_APP_ID"),
    keyPath: resolvedKey,
    environment,
    allowProduction,
    ...redirect,
  };
}

function stripEmpty(env) {
  const out = {};
  for (const key of ["ENABLEBANKING_APP_ID", "ENABLEBANKING_KEY_PATH", "ENABLEBANKING_ENVIRONMENT", "ENABLEBANKING_REDIRECT_URL"]) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}

export async function readKey(file) {
  const resolved = await assertPrivateFile(file);
  const pem = await readFile(resolved, "utf8");
  if (!pem.includes("PRIVATE KEY")) throw new ConfigError("PRIVATE_FILE", "The key file does not look like a PEM private key.");
  return pem;
}
