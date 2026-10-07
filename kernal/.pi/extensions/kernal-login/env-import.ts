/**
 * The `.env` import offer after `kernal login` (#399 CA-10, outfitter/docs/specs/central-auth.md
 * §12.1). Owned by task J; cli.ts calls `offerEnvImport` once, after a login that succeeded.
 *
 * For each personal provider key found in this Kernal's `.env` files (OPENROUTER_API_KEY, ...;
 * PROVIDER_ENV in central-config.ts, except Deepgram: NOT_IMPORTED), it asks once whether to upload it to the account
 * (`PUT /api/me/provider-keys/:provider`, spec §4) and, when the server took it, removes that line
 * from `.env`. LITELLM_AGENT_KEY is never uploaded: with this device's own router key stored it
 * offers only to remove the shared key, which would otherwise win over the device key
 * (central-config.ts `layerCentralEnv`). A leftover Dongle (OUTFITTER_TOKEN, retired: Kernal no longer
 * reads it) gets the same remove-only offer.
 *
 * Every question defaults to No, and nothing is asked without a terminal (a script, a pipe). Before
 * the first change to a file it is copied whole to `<file>.bak-<UTC time>`, mode 0600; each file is
 * then rewritten whole and renamed into place. When another file still sets the same name to a
 * different value, that value would now win, so it is asked about too (and warned about if it stays).
 * Keys left in `.env` get a one-line deprecation warning.
 *
 * Only the `.env` files Kernal itself owns are read: ~/localllm/.env and the two that bin/kernal
 * sources (next to the bundle and one level up). A project's own `.env` in the working directory,
 * which connect also reads, is never touched.
 */
import { chmodSync, copyFileSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { cleanKey, parseEnvText } from "../connect/lib.ts";
import { PROVIDER_ENV } from "../_shared/central-config.ts";
import { getAccessToken, getRouterKey, outfitterApi, type SessionStorage } from "../_shared/outfitter-session.ts";
import { sendWithBearer } from "../_shared/outfitter-env.ts";

/** The router key variables the device key replaces (settings key `router.key`, spec §3.2). */
export const ROUTER_KEY_ENV = ["LITELLM_AGENT_KEY", "LITELLM_API_KEY"] as const;
export const DONGLE_ENV = "OUTFITTER_TOKEN";
/** Not offered: release bundles ship a shared DEEPGRAM_API_KEY in their `.env` (scripts/package.sh),
 * which is nobody's personal key, and voice keeps reading its key from the environment for now
 * (central-auth.md "Gotchas": Deepgram). */
export const NOT_IMPORTED: ReadonlySet<string> = new Set(["deepgram"]);

/** Spec §4: 8-512 printable ASCII characters, no whitespace. */
const KEY_VALUE = /^[\x21-\x7e]{8,512}$/;

/** One variable found in the `.env` files: the value Kernal uses (the nearest file's) and every
 * file whose line holds exactly that value. */
export interface EnvFinding {
  name: string;
  value: string;
  files: string[];
}

export interface EnvImportIo {
  /** Questions, progress and warnings. */
  err: (line: string) => void;
  /** Asks one question and resolves to the answer; absent: nothing is asked and nothing changes. */
  ask?: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  storage?: SessionStorage;
  /** The `.env` files to look at, lowest priority first (default `kernalEnvFiles(env)`). */
  files?: string[];
  now?: () => Date;
}

export interface EnvImportResult {
  uploaded: string[];
  removed: string[];
  kept: string[];
  backups: string[];
}

/** Questions on the terminal (stdin, prompts on stderr); undefined when stdin or stderr is not a
 * terminal, so a scripted `kernal login` never waits for an answer and never changes `.env`. */
export function terminalAsk(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): ((question: string) => Promise<string>) | undefined {
  if (!input.isTTY || !output.isTTY) return undefined;
  let stopped = false;
  return async (question) => {
    if (stopped) return "";
    const rl = createInterface({ input, output });
    const abort = new AbortController();
    // Ctrl-C answers No to this question and every one after it.
    rl.on("SIGINT", () => { stopped = true; output.write("\n"); abort.abort(); });
    rl.on("close", () => abort.abort());   // stdin ended: No
    try {
      return await rl.question(question, { signal: abort.signal });
    } catch {
      return "";   // Ctrl-C or a closed stdin: No
    } finally {
      rl.close();
    }
  };
}

/** The `.env` files Kernal owns, lowest priority first, each once (by real path), existing only. */
export function kernalEnvFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  const candidates = [join(home, "localllm", ".env")];
  if (agentDir) {
    const root = dirname(agentDir);
    candidates.push(join(root, "..", ".env"), join(root, ".env"));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of candidates) {
    let real: string;
    try {
      if (!statSync(f).isFile()) continue;
      real = realpathSync(f);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/** The variables in `names` that the files set, with the value the nearest file gives. */
export function findEnvVars(files: string[], names: readonly string[]): EnvFinding[] {
  const parsed = files.map((f) => {
    try {
      return { file: f, vars: parseEnvText(readFileSync(f, "utf8")) };
    } catch {
      return { file: f, vars: {} as Record<string, string> };
    }
  });
  const out: EnvFinding[] = [];
  for (const name of names) {
    let value: string | undefined;
    for (const p of parsed) if (p.vars[name]?.trim()) value = p.vars[name];
    if (value === undefined) continue;
    out.push({ name, value, files: parsed.filter((p) => p.vars[name] === value).map((p) => p.file) });
  }
  return out;
}

/** `text` without the lines that set `name` to `value` (other values for it stay). */
export function removeEnvLine(text: string, name: string, value: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
    return !(m && m[1] === name && parseEnvText(line)[name] === value);
  });
  return kept.length === lines.length ? text : kept.join("\n");
}

function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function yes(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

function last4(value: string): string {
  return value.length > 8 ? `…${value.slice(-4)}` : "…";
}

/** Uploads one personal key; resolves to undefined on success, else a one-line reason. */
async function upload(api: string, provider: string, value: string, io: EnvImportIo): Promise<string | undefined> {
  const storage = { ...io.storage, env: io.env ?? io.storage?.env };
  const bearer = (rejected?: string) => getAccessToken({ ...storage, api, fetch: io.fetch, ...(rejected ? { rejected } : {}) });
  const fetchImpl = io.fetch ?? fetch;
  try {
    const res = await sendWithBearer(bearer, (token) => fetchImpl(`${api}/api/me/provider-keys/${encodeURIComponent(provider)}`, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(10_000),
    }));
    if (res.ok) return undefined;
    let code = "";
    try { code = String(((await res.json()) as { error?: unknown }).error ?? ""); } catch {}
    return `the server answered ${res.status}${code ? ` (${code})` : ""}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Asks about each key in Kernal's `.env` files and does what the person said yes to. Never throws:
 * a key that could not be uploaded stays in `.env`.
 */
export async function offerEnvImport(io: EnvImportIo): Promise<EnvImportResult> {
  const result: EnvImportResult = { uploaded: [], removed: [], kept: [], backups: [] };
  try {
    await offer(io, result);
  } catch (err) {
    // The login itself already succeeded; a failure here only leaves .env as it is.
    io.err(`Could not check .env for keys: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

async function offer(io: EnvImportIo, result: EnvImportResult): Promise<void> {
  const env = io.env ?? process.env;
  const files = io.files ?? kernalEnvFiles(env);
  if (!files.length) return;
  const api = outfitterApi(env);
  const now = io.now ?? (() => new Date());
  const backedUp = new Set<string>();

  const strip = (f: EnvFinding): boolean => {
    try {
      for (const file of f.files) {
        const text = readFileSync(file, "utf8");
        const next = removeEnvLine(text, f.name, f.value);
        if (next === text) continue;
        if (!backedUp.has(file)) {
          const backup = `${file}.bak-${backupStamp(now())}`;
          copyFileSync(file, backup);
          chmodSync(backup, 0o600);
          backedUp.add(file);
          result.backups.push(backup);
          io.err(`Backed up ${file} to ${backup}`);
        }
        const tmp = `${file}.kernal-tmp`;
        writeFileSync(tmp, next, { mode: statSync(file).mode & 0o777 });
        renameSync(tmp, file);
      }
      if (!result.removed.includes(f.name)) result.removed.push(f.name);
      return true;
    } catch (err) {
      io.err(`Could not remove ${f.name} from .env: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  const where = (f: EnvFinding) => f.files.join(", ");
  /** Names still set to another value after a removal, with where: that value now wins over the
   * account or device key (connect's loadEnv reads every file; layerCentralEnv fills only gaps). */
  const shadowed = new Map<string, string>();
  const replaces = (name: string) => ((ROUTER_KEY_ENV as readonly string[]).includes(name)
    ? "this device's own router key"
    : name === DONGLE_ENV ? "your login" : "your account key");
  /** After `f` was removed: asks about each other value the files still give the same name. */
  const stripRest = async (f: EnvFinding, ask: (q: string) => Promise<string>): Promise<void> => {
    for (let rest = findEnvVars(files, [f.name])[0]; rest; rest = findEnvVars(files, [f.name])[0]) {
      const answer = await ask(`${f.name} is also set to a different value (${last4(cleanKey(rest.value))}) in ${where(rest)}, which would now override ${replaces(f.name)}. Remove it too? [y/N] `);
      if (yes(answer) && strip(rest)) continue;
      shadowed.set(f.name, where(rest));
      if (!result.kept.includes(f.name)) result.kept.push(f.name);
      return;
    }
  };

  const providers = Object.entries(PROVIDER_ENV).filter(([provider]) => !NOT_IMPORTED.has(provider));
  const keys = findEnvVars(files, providers.map(([, name]) => name));
  const routerKey = (() => { try { return getRouterKey({ ...io.storage, env, api }); } catch { return undefined; } })();
  const removeOnly = findEnvVars(files, [...(routerKey ? ROUTER_KEY_ENV : []), DONGLE_ENV]);
  if (!keys.length && !removeOnly.length) return;

  if (!io.ask) {
    for (const f of [...keys, ...removeOnly]) result.kept.push(f.name);
  } else {
    for (const f of keys) {
      const provider = providers.find(([, name]) => name === f.name)![0];
      const value = cleanKey(f.value);
      if (!KEY_VALUE.test(value)) {
        io.err(`${f.name} in ${where(f)} does not look like a key; left as it is.`);
        result.kept.push(f.name);
        continue;
      }
      const answer = await io.ask(`Upload ${f.name} (${last4(value)}) from ${where(f)} to your account as your personal ${provider} key, then remove it from .env? [y/N] `);
      if (!yes(answer)) { result.kept.push(f.name); continue; }
      const failed = await upload(api, provider, value, io);
      if (failed) {
        io.err(`Could not upload ${f.name}: ${failed}. It stays in .env.`);
        result.kept.push(f.name);
        continue;
      }
      result.uploaded.push(f.name);
      io.err(`Uploaded ${f.name} to your account.`);
      if (!strip(f)) { result.kept.push(f.name); continue; }
      await stripRest(f, io.ask);
    }
    for (const f of removeOnly) {
      const why = f.name === DONGLE_ENV
        ? "Dongles are retired and Kernal no longer reads it"
        : "this device's own router key replaces it, and a key in .env would win over it";
      const answer = await io.ask(`Remove ${f.name} from ${where(f)}? ${why[0].toUpperCase()}${why.slice(1)}. [y/N] `);
      if (yes(answer) && strip(f)) { await stripRest(f, io.ask); continue; }
      result.kept.push(f.name);
    }
  }

  for (const name of result.kept) {
    const other = shadowed.get(name);
    if (other) io.err(`${name} is still set to a different value in ${other}; it overrides ${replaces(name)} until you remove it`);
    else if (name === DONGLE_ENV) io.err(`Dongles are retired; ${name} in .env is no longer read`);
    else if ((ROUTER_KEY_ENV as readonly string[]).includes(name)) io.err(`${name} in .env is deprecated: this device's own router key replaces it`);
    else io.err(`${name} in .env is deprecated: run kernal login again to move it to your account, or save it with /admin`);
  }
}
