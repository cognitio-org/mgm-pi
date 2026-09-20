#!/usr/bin/env node
/**
 * Headless half of `mgm --teleport <id>` (see ../../../bin/mgm). Runs before pi starts: pulls a
 * session out of the store, checks out the matching repo/branch if the manifest names one, imports
 * it into the local session dir for the current cwd via SessionManager.forkFrom, and prints the
 * resulting session file path on stdout. bin/mgm then execs `pi -a --session <path> ...`.
 *
 * No pi runtime is available yet at this point (pi.exec, ctx.ui, etc.), so git calls go straight
 * through node:child_process, and any conflict with an existing local session of the same id is
 * resolved by forking under a fresh id (the safe, non-destructive default for a non-interactive
 * path — the interactive /teleport pull command asks instead).
 *
 * Usage: node cli.ts <session-id> [cwd]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GitStore, parseOwnerRepo, verifyOwnerRepo, isWorkingTreeDirty } from "./lib.ts";

function fail(message: string): never {
  console.error(`mgm --teleport: ${message}`);
  process.exit(1);
}

function git(args: string[], cwd: string): { stdout: string; code: number } {
  try {
    return { stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), code: 0 };
  } catch (err: any) {
    return { stdout: String(err?.stdout ?? ""), code: typeof err?.status === "number" ? err.status : 1 };
  }
}

async function main() {
  const [id, cwdArg] = process.argv.slice(2);
  if (!id) fail("usage: cli.ts <session-id> [cwd]");
  const cwd = cwdArg ? join(cwdArg) : process.cwd();

  const store = new GitStore({ warn: (msg) => console.error(`mgm --teleport: ${msg}`) });
  let got;
  try {
    got = await store.get(id);
  } catch (err: any) {
    fail(`no session "${id}" in the store: ${err?.message ?? err}`);
  }
  const { file, manifest } = got!;

  if (manifest.repo) {
    const remote = git(["remote", "get-url", "origin"], cwd);
    const localOwnerRepo = remote.code === 0 ? parseOwnerRepo(remote.stdout.trim()) : undefined;
    const mismatch = verifyOwnerRepo(localOwnerRepo, manifest.repo.ownerRepo);
    if (mismatch) fail(mismatch);

    const status = git(["status", "--porcelain"], cwd);
    if (isWorkingTreeDirty(status.stdout)) fail("commit or stash your changes before pulling this session.");

    const fetch = git(["fetch", "origin", manifest.repo.branch], cwd);
    if (fetch.code !== 0) console.error(`mgm --teleport: could not fetch origin/${manifest.repo.branch} (offline?); trying the local branch.`);
    const checkout = git(["checkout", manifest.repo.branch], cwd);
    if (checkout.code !== 0) fail(`git checkout ${manifest.repo.branch} failed.`);
  }

  const tmpFile = join(mkdtempSync(join(tmpdir(), "mgm-teleport-")), `${manifest.id}.jsonl`);
  writeFileSync(tmpFile, file, "utf8");

  const existing = (await SessionManager.list(cwd)).find((s) => s.id === manifest.id);
  const forkId = existing ? undefined : manifest.id; // non-destructive default: fork under a new id on collision
  const sm = SessionManager.forkFrom(tmpFile, cwd, undefined, forkId ? { id: forkId } : undefined);

  console.log(sm.getSessionFile());
}

main().catch((err) => fail(err?.message ?? String(err)));
