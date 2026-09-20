/**
 * Resolves the Linux uid/gid agentd should spawn `pi` (and therefore the model's shell) as, so pi
 * never shares a Linux user -- and therefore never shares /proc/<pid>/environ or /proc/<pid>/cmdline
 * visibility -- with agentd's own `git` child process. Without this split, any process the model
 * spawns can read another same-user process's argv/environ (see git.ts's module doc and finding #1
 * in docs/reports/security-review-pr1.md: the GitHub PAT would otherwise be readable via `ps auxww`
 * or /proc/<pid>/cmdline for the lifetime of the git invocation).
 *
 * `image/Dockerfile` keeps the container's entrypoint running as root (root's own
 * /proc/<pid>/environ is root-only-readable, 0400) and drops privileges per-spawn instead: agentd's
 * own git child runs as root, pi runs as the unprivileged `agent` user (PI_RUN_AS_USER, default
 * "agent"). When agentd itself is not root (e.g. local dev outside the sandbox image, where the
 * whole point -- privilege separation between agentd and pi -- doesn't apply because there's only
 * one Linux user anyway), there is no privilege to drop: pi runs as whatever user agentd runs as,
 * and this just logs that instead of failing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";

const execFileAsync = promisify(execFile);

export interface RunAsUser {
  uid: number;
  gid: number;
  user: string;
  /** The user's home directory from its passwd entry; pi's HOME, so ~/.pi lands somewhere it can write. */
  home: string;
}

export interface IdExecResult {
  stdout: string;
  code: number;
}

export type IdExecFn = (cmd: string, args: string[]) => Promise<IdExecResult>;

async function defaultIdExec(cmd: string, args: string[]): Promise<IdExecResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: "", code: typeof err?.code === "number" ? err.code : 1 };
  }
}

export interface ResolveRunAsUserOptions {
  /** Overrides node:os.userInfo().uid, for tests. */
  currentUid?: number;
  /** Injectable `id -u`/`id -g` runner, for tests. */
  execFn?: IdExecFn;
  onLog?: (line: string) => void;
  /** Overrides PI_RUN_AS_USER, for tests. Default "agent". */
  targetUser?: string;
}

/** Returns the uid/gid to spawn pi as, or `undefined` when agentd is not running as root (no
 * privilege to drop, so pi inherits agentd's own user). Throws if agentd is root but the target
 * user (PI_RUN_AS_USER, default "agent") doesn't resolve -- that's a broken image, not something to
 * silently fall back from. */
export async function resolveRunAsUser(opts: ResolveRunAsUserOptions = {}): Promise<RunAsUser | undefined> {
  const uid = opts.currentUid ?? userInfo().uid;
  const onLog = opts.onLog ?? (() => {});
  if (uid !== 0) {
    onLog(`resolveRunAsUser: agentd is not running as root (uid ${uid}); pi will run as the same user`);
    return undefined;
  }
  const targetUser = opts.targetUser ?? process.env.PI_RUN_AS_USER ?? "agent";
  const exec = opts.execFn ?? defaultIdExec;
  const [uidRes, gidRes, pwRes] = await Promise.all([
    exec("id", ["-u", targetUser]),
    exec("id", ["-g", targetUser]),
    exec("getent", ["passwd", targetUser]),
  ]);
  if (uidRes.code !== 0 || gidRes.code !== 0) {
    throw new Error(`resolveRunAsUser: could not resolve uid/gid for PI_RUN_AS_USER="${targetUser}"`);
  }
  // passwd fields: name:x:uid:gid:gecos:home:shell. Fall back to the conventional path only if the
  // lookup itself failed (no getent on an unusual base image), never silently on a malformed line.
  const home = pwRes.code === 0 ? pwRes.stdout.trim().split(":")[5] : `/home/${targetUser}`;
  if (!home) throw new Error(`resolveRunAsUser: passwd entry for "${targetUser}" has no home directory`);
  const targetUid = Number.parseInt(uidRes.stdout.trim(), 10);
  const targetGid = Number.parseInt(gidRes.stdout.trim(), 10);
  if (!Number.isInteger(targetUid) || !Number.isInteger(targetGid)) {
    throw new Error(`resolveRunAsUser: unparseable uid/gid for PI_RUN_AS_USER="${targetUser}"`);
  }
  onLog(`resolveRunAsUser: pi will run as ${targetUser} (uid=${targetUid} gid=${targetGid} home=${home})`);
  return { uid: targetUid, gid: targetGid, user: targetUser, home };
}

/** Recursively chowns `path` to `uid:gid`. Used after `git clone`/`git push` (which, per finding
 * #1, run as root so the auth-header env vars stay root-only-readable) so files git writes in
 * /workspace end up owned by the unprivileged user pi actually runs as, not root. A no-op (never
 * called) when `resolveRunAsUser` returned `undefined`, i.e. agentd isn't root and there's only one
 * Linux user in play anyway. */
export async function chownRecursive(path: string, uid: number, gid: number, execFn: IdExecFn = defaultIdExec): Promise<void> {
  const res = await execFn("chown", ["-R", `${uid}:${gid}`, path]);
  if (res.code !== 0) {
    throw new Error(`chown -R ${uid}:${gid} ${path} failed (exit ${res.code})`);
  }
}
