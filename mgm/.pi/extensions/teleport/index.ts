/**
 * /teleport — move this pi session to/from another machine, the way Claude Code's teleport does.
 *
 *   /teleport                interactive picker (pick a pushed session, then pull it)
 *   /teleport list           list sessions in the store
 *   /teleport push [name]    push the current session (requires a clean tree; same-repo pull later)
 *   /teleport pull [id]      pull a session by id (prompts to pick one if id is omitted)
 *
 * Sessions move through a pluggable Store (see ./lib.ts): phase 1/2 ship GitStore, a local clone
 * directory (MGM_TELEPORT_STORE, default ~/.mgm-sessions) that is a plain git repo. A future
 * "Outfitter" cloud API can implement the same Store interface without touching these commands.
 *
 * `mgm --teleport <id>` (see ../../../bin/mgm and ./cli.ts) does the pull step headlessly, before pi
 * even starts, then launches pi with --session pointed at the imported file.
 *
 * All git calls go through pi.exec; the only direct child_process use is GitStore's injected default
 * exec in lib.ts, which tests replace with a stub. Pure logic lives in ./lib.ts and is unit-tested.
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir, homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  GitStore, parseOwnerRepo, pickModelForHost, manifestFromGit, describeRef,
  isWorkingTreeDirty, needsPush, verifyOwnerRepo,
  type GitInfo, type Manifest, type SessionRef,
} from "./lib.ts";

// Persist into the agent config dir (PI_CODING_AGENT_DIR when launched via bin/mgm, else
// ~/.pi/agent), same convention as ../connect/index.ts.
function settingsPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
}

/** teleport.autoPush in settings.json. There's no ctx.settings accessor in this pi version, so this
 * falls back to reading the settings file directly, same as ../connect/index.ts does for its own
 * defaultProvider/defaultModel. */
function autoPushEnabled(ctx: ExtensionContext): boolean {
  const fromCtx = (ctx as unknown as { settings?: any }).settings;
  if (fromCtx && typeof fromCtx === "object") return fromCtx.teleport?.autoPush === true;
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"))?.teleport?.autoPush === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const store = new GitStore({ warn: (msg) => console.error(msg) });
  let cachedRefs: SessionRef[] = [];
  const refreshCache = async () => {
    try {
      cachedRefs = await store.list();
    } catch {
      // Keep the previous cache; list()/pull() surface the real error to the user.
    }
  };
  void refreshCache();

  async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
    const [remote, branch, head] = await Promise.all([
      pi.exec("git", ["remote", "get-url", "origin"], { cwd }),
      pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
      pi.exec("git", ["rev-parse", "HEAD"], { cwd }),
    ]);
    if (remote.code !== 0 || branch.code !== 0 || head.code !== 0) return undefined;
    return { remote: remote.stdout.trim(), branch: branch.stdout.trim(), head: head.stdout.trim() };
  }

  // ---------- push ----------
  async function push(ctx: ExtensionCommandContext, name: string | undefined, opts: { quiet?: boolean } = {}) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      if (!opts.quiet) ctx.ui.notify("teleport push: this session is ephemeral (--no-session); nothing to push.", "error");
      return;
    }
    const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
    if (status.code !== 0) {
      if (!opts.quiet) ctx.ui.notify(`teleport push: ${ctx.cwd} is not a git repository.`, "error");
      return;
    }
    if (isWorkingTreeDirty(status.stdout)) {
      if (!opts.quiet) ctx.ui.notify("Commit or stash your changes before teleporting this session.", "error");
      return;
    }
    const git = await gitInfo(ctx.cwd);
    if (!git) {
      if (!opts.quiet) ctx.ui.notify(`teleport push: could not read the git remote/branch/head for ${ctx.cwd}.`, "error");
      return;
    }

    try {
      const branchStatus = await pi.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctx.cwd });
      if (needsPush(branchStatus.stdout)) {
        const pushRes = await pi.exec("git", ["push", "-u", "origin", git.branch], { cwd: ctx.cwd });
        if (pushRes.code !== 0) {
          ctx.ui.notify(`teleport push: git push failed: ${pushRes.stderr.trim()}`, "error");
          return;
        }
      }

      const jsonl = await readFile(sessionFile, "utf8");
      const id = ctx.sessionManager.getSessionId();
      const manifest = manifestFromGit({ id, name: name ?? ctx.sessionManager.getSessionName(), host: hostname(), cwd: ctx.cwd, git });
      await store.put(id, jsonl, manifest);
      pi.appendEntry("teleport", manifest);
      await refreshCache();
      ctx.ui.notify(`Teleported ${id.slice(0, 8)}. Pull it elsewhere with: mgm --teleport ${id}  (or /teleport pull ${id})`, "info");
    } catch (err: any) {
      ctx.ui.notify(`teleport push failed: ${err?.message ?? err}`, "error");
    }
  }

  // ---------- pull ----------
  async function pull(ctx: ExtensionCommandContext, id: string | undefined) {
    if (!id) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /teleport pull <id>", "error");
        return;
      }
      await interactivePick(ctx);
      return;
    }

    let got: { file: string; manifest: Manifest };
    try {
      got = await store.get(id);
    } catch (err: any) {
      ctx.ui.notify(`teleport: no session "${id}" in the store: ${err?.message ?? err}`, "error");
      return;
    }
    const { file, manifest } = got;

    if (manifest.repo) {
      const remote = await pi.exec("git", ["remote", "get-url", "origin"], { cwd: ctx.cwd });
      const localOwnerRepo = remote.code === 0 ? parseOwnerRepo(remote.stdout.trim()) : undefined;
      const mismatch = verifyOwnerRepo(localOwnerRepo, manifest.repo.ownerRepo);
      if (mismatch) {
        ctx.ui.notify(`teleport pull: ${mismatch}`, "error");
        return;
      }
      const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
      if (isWorkingTreeDirty(status.stdout)) {
        ctx.ui.notify("Commit or stash your changes before pulling this session.", "error");
        return;
      }
      const fetch = await pi.exec("git", ["fetch", "origin", manifest.repo.branch], { cwd: ctx.cwd });
      if (fetch.code !== 0) ctx.ui.notify(`teleport pull: could not fetch origin/${manifest.repo.branch} (offline?); trying the local branch.`, "warning");
      const checkout = await pi.exec("git", ["checkout", manifest.repo.branch], { cwd: ctx.cwd });
      if (checkout.code !== 0) {
        ctx.ui.notify(`teleport pull: git checkout ${manifest.repo.branch} failed: ${checkout.stderr.trim()}`, "error");
        return;
      }
    }

    const tmp = join(tmpdir(), `teleport-${manifest.id}-${Date.now()}.jsonl`);
    await writeFile(tmp, file, "utf8");

    const existing = (await SessionManager.list(ctx.cwd)).find((s) => s.id === manifest.id);
    let forkId: string | undefined = manifest.id;
    if (existing) {
      const choice = await ctx.ui.select(
        `A session with id ${manifest.id.slice(0, 8)} already exists here (${existing.name || existing.firstMessage.slice(0, 60)}). What now?`,
        ["Overwrite the local copy", "Import as a new session"],
      );
      if (!choice) {
        ctx.ui.notify("teleport pull cancelled", "info");
        return;
      }
      if (choice.startsWith("Overwrite")) await rm(existing.path);
      else forkId = undefined;
    }

    const sm = SessionManager.forkFrom(tmp, ctx.cwd, undefined, forkId ? { id: forkId } : undefined);
    const available = [...new Set(ctx.modelRegistry.getAvailable().map((m) => m.provider))];
    const pick = pickModelForHost(sm.getEntries(), available);
    const model = ctx.modelRegistry.find(pick.provider, pick.modelId);
    if (model) sm.appendModelChange(pick.provider, pick.modelId);

    const newPath = sm.getSessionFile()!;
    const message = model
      ? `Teleported in from ${manifest.host}. Model set to ${pick.provider}/${pick.modelId}.`
      : `Teleported in from ${manifest.host}. Wanted ${pick.provider}/${pick.modelId} but it isn't configured here; keeping the session's saved model.`;
    const result = await ctx.switchSession(newPath, {
      withSession: async (newCtx) => newCtx.ui.notify(message, "info"),
    });
    if (result.cancelled) ctx.ui.notify("teleport pull cancelled", "info");
  }

  async function interactivePick(ctx: ExtensionCommandContext) {
    const refs = await store.list();
    if (refs.length === 0) {
      ctx.ui.notify("No sessions in the teleport store yet. Push one with /teleport push.", "info");
      return;
    }
    const labels = refs.map(describeRef);
    const choice = await ctx.ui.select("Teleport from", labels);
    if (!choice) return;
    await pull(ctx, refs[labels.indexOf(choice)].id);
  }

  async function listCmd(ctx: ExtensionCommandContext) {
    const refs = await store.list();
    if (refs.length === 0) {
      ctx.ui.notify("No sessions in the teleport store yet.", "info");
      return;
    }
    const lines = refs.map((r) => `${r.id.slice(0, 8)}  ${describeRef(r)}`);
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    else for (const l of lines) console.log(l);
  }

  pi.registerCommand("teleport", {
    description: "Move this session to/from another machine: list | push [name] | pull [id]",
    getArgumentCompletions: (prefix) => {
      const [first, ...rest] = prefix.split(/\s+/);
      if (rest.length === 0) {
        return ["list", "push", "pull"].filter((s) => s.startsWith(first ?? "")).map((s) => ({ value: s, label: s }));
      }
      if (first === "pull") {
        const idPrefix = rest[0] ?? "";
        return cachedRefs.filter((r) => r.id.startsWith(idPrefix)).map((r) => ({ value: `pull ${r.id}`, label: r.id.slice(0, 8), description: describeRef(r) }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!sub) return interactivePick(ctx);
      if (sub === "list") return listCmd(ctx);
      if (sub === "push") return push(ctx, rest.join(" ") || undefined);
      if (sub === "pull") return pull(ctx, rest[0]);
      ctx.ui.notify(`Unknown /teleport subcommand "${sub}". Use list, push, or pull.`, "error");
    },
  });

  // ---------- optional auto-push ----------
  // teleport.autoPush in settings.json (default off). Fires after each turn; silently skipped when
  // the tree isn't clean or there's nothing to push, and never throws.
  pi.on("agent_end", async (_ev, ctx) => {
    if (!autoPushEnabled(ctx)) return;
    try {
      await push(ctx, undefined, { quiet: true });
    } catch (err: any) {
      ctx.ui.notify(`teleport autoPush failed: ${err?.message ?? err}`, "error");
    }
  });
}
