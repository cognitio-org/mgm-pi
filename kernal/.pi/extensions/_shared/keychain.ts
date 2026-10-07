/**
 * Where Kernal keeps the secret half of its Outfitter login (#391 CA-2,
 * outfitter/docs/specs/central-auth.md §2.3): the macOS Keychain, the Linux Secret Service, or a
 * mode-0600 file when neither works. One item per account, named `<api>|<email>`.
 *
 * Synchronous on purpose (SecretBackend): start-up reads the login before any await. A secret is
 * never put on a command line, where `ps` would show it: the Keychain gets it hex-encoded through
 * `security -i` on stdin, secret-tool reads it from stdin.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretBackend } from "./outfitter-session.ts";

/** The Keychain service and Secret Service attribute every item is filed under. */
export const SERVICE = "kernal-outfitter";
const LABEL = "Kernal (Outfitter)";

/** Runs a program and reports how it ended; tests pass a fake. */
export type Runner = (cmd: string, args: string[], input?: string) => { status: number | null; stdout: string };

export const realRunner: Runner = (cmd, args, input) => {
  // Set by the test harness (tests/isolate.mjs, #433) so no test can reach the developer's real
  // Keychain or Secret Service: the tool behaves as if it could not run.
  if (process.env.KERNAL_TEST_NO_KEYCHAIN === "1") return { status: null, stdout: "" };
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

/** `<sha256(item)[:16]>`: the file name of an item's fallback file and refresh lock. */
export function itemHash(item: string): string {
  return createHash("sha256").update(item).digest("hex").slice(0, 16);
}

/** An item name goes inside double quotes in `security -i`; nothing in it may end the quote. */
function quoted(item: string): string {
  if (/["\\\s]/.test(item)) throw new Error(`unusable keychain item name: ${JSON.stringify(item)}`);
  return `"${item}"`;
}

/** The macOS Keychain, through /usr/bin/security. */
export function keychainBackend(run: Runner = realRunner, bin = "/usr/bin/security"): SecretBackend {
  return {
    name: "keychain",
    get(item) {
      const r = run(bin, ["find-generic-password", "-s", SERVICE, "-a", item, "-w"]);
      return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
    },
    set(item, value) {
      const hex = Buffer.from(value, "utf8").toString("hex");
      const r = run(bin, ["-i"], `add-generic-password -U -s ${SERVICE} -a ${quoted(item)} -l "${LABEL}" -X ${hex}\n`);
      if (r.status !== 0) throw new Error("could not write to the macOS Keychain");
      // `security -i` answers 0 even when one of its commands failed: read it back.
      if (this.get(item) !== value) throw new Error("could not write to the macOS Keychain");
    },
    delete(item) {
      run(bin, ["delete-generic-password", "-s", SERVICE, "-a", item]);
    },
  };
}

/** The Linux Secret Service (GNOME Keyring, KWallet), through libsecret's secret-tool. */
export function secretServiceBackend(run: Runner = realRunner, bin = "secret-tool"): SecretBackend {
  return {
    name: "secret-service",
    get(item) {
      const r = run(bin, ["lookup", "service", SERVICE, "account", item]);
      return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : undefined;
    },
    set(item, value) {
      const r = run(bin, ["store", `--label=${LABEL}`, "service", SERVICE, "account", item], value);
      if (r.status !== 0) throw new Error("could not write to the Secret Service");
    },
    delete(item) {
      run(bin, ["clear", "service", SERVICE, "account", item]);
    },
  };
}

/** The fallback: `<dir>/<itemHash>.json`, mode 0600, written whole and renamed. */
export function fileBackend(dir: string): SecretBackend {
  const path = (item: string) => join(dir, `${itemHash(item)}.json`);
  return {
    name: "file",
    get(item) {
      try {
        const v = JSON.parse(readFileSync(path(item), "utf8")) as { item?: unknown; value?: unknown };
        return v.item === item && typeof v.value === "string" ? v.value : undefined;
      } catch {
        return undefined;
      }
    },
    set(item, value) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path(item)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ item, value }) + "\n", { mode: 0o600 });
      renameSync(tmp, path(item));
    },
    delete(item) {
      rmSync(path(item), { force: true });
    },
  };
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, cmd)));
}

/**
 * The backend for this machine: KERNAL_AUTH_BACKEND (`keychain`, `secret-service`, `file`) when
 * set, else the Keychain on macOS, the Secret Service on Linux when secret-tool and a session bus
 * are there, else the file. A backend that turns out not to work on write is replaced by the file
 * (outfitter-session.ts), so this only picks the first candidate.
 */
export function chooseBackend(authDir: string, env: NodeJS.ProcessEnv = process.env, run: Runner = realRunner): SecretBackend {
  const want = env.KERNAL_AUTH_BACKEND?.trim();
  if (want === "keychain") return keychainBackend(run);
  if (want === "secret-service") return secretServiceBackend(run);
  if (want === "file") return fileBackend(authDir);
  if (process.platform === "darwin" && existsSync("/usr/bin/security")) return keychainBackend(run);
  if (process.platform === "linux" && env.DBUS_SESSION_BUS_ADDRESS && onPath("secret-tool", env)) return secretServiceBackend(run);
  return fileBackend(authDir);
}

/** The backend a stored login names (accounts.json `backend`), so a read goes where the write went. */
export function backendNamed(name: SecretBackend["name"], authDir: string, run: Runner = realRunner): SecretBackend {
  if (name === "keychain") return keychainBackend(run);
  if (name === "secret-service") return secretServiceBackend(run);
  return fileBackend(authDir);
}
