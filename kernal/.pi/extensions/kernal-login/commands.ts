/**
 * The three commands behind cli.ts (central-auth.md §2.5), as a function so tests drive them with
 * a fake fetch and a temporary login directory instead of spawning node.
 */
import { login, loginState, logout, outfitterApi, type SessionStorage } from "../_shared/outfitter-session.ts";

export const USAGE = "Usage: kernal login [--device-name <name>] [--no-browser] | kernal logout | kernal whoami [--json]";

export interface CliIo {
  /** Results (whoami). */
  out: (line: string) => void;
  /** The URL, the code, progress, warnings, errors. */
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  openUrl?: (url: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  storage?: SessionStorage;
  platform?: NodeJS.Platform;
}

/** Whether `kernal login` may open a browser: not with KERNAL_NO_BROWSER, not over SSH, not on a
 * Linux without a display. */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const noBrowser = env.KERNAL_NO_BROWSER?.trim();
  if (noBrowser && noBrowser !== "0") return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

type Parsed = { command?: string; deviceName?: string; noBrowser: boolean; json: boolean; bad?: string };

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const p: Parsed = { command, noBrowser: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (command === "login" && a === "--no-browser") p.noBrowser = true;
    else if (command === "login" && a === "--device-name") {
      const v = rest[++i];
      if (!v || v.startsWith("-")) return { ...p, bad: "--device-name needs a name" };
      p.deviceName = v;
    } else if (command === "login" && a.startsWith("--device-name=")) p.deviceName = a.slice("--device-name=".length);
    else if (command === "whoami" && a === "--json") p.json = true;
    else return { ...p, bad: `unknown option ${a}` };
  }
  return p;
}

/** Runs one command; resolves to the exit code (0 done, 1 failed, 2 usage). */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  const storage: SessionStorage = { env, ...io.storage };
  const api = outfitterApi(env);
  const p = parseArgs(argv);
  if (p.bad) {
    io.err(`kernal ${p.command}: ${p.bad}`);
    io.err(USAGE);
    return 2;
  }

  if (p.command === "whoami") {
    const state = loginState({ ...storage, api });
    if (p.json) io.out(JSON.stringify(state.signedIn ? { signedIn: true, account: state.account } : { signedIn: false }));
    else if (state.signedIn) io.out(`${state.account.email} on ${state.account.api} (device ${state.account.deviceName})`);
    else io.out(`not signed in to ${api}`);
    return state.signedIn ? 0 : 1;
  }

  if (p.command === "login") {
    try {
      const account = await login({
        ...storage,
        api,
        deviceName: p.deviceName,
        openBrowser: !p.noBrowser && canOpenBrowser(env, io.platform),
        print: io.err,
        fetch: io.fetch,
        signal: io.signal,
        openUrl: io.openUrl,
        sleep: io.sleep,
      });
      io.err(`Signed in as ${account.email} on ${account.api} (device ${account.deviceName})`);
      return 0;
    } catch (err) {
      io.err(`kernal login: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (p.command === "logout") {
    const state = loginState({ ...storage, api });
    await logout({ ...storage, api, fetch: io.fetch });
    io.err(state.signedIn ? `Signed out of ${api} (device ${state.account.deviceName})` : `not signed in to ${api}`);
    return 0;
  }

  io.err(USAGE);
  return 2;
}
