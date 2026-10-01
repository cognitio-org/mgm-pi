/**
 * /tape: play a cloud tape on this laptop (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §7.1,
 * #354). lib.ts holds the rules and the pin store, shared with `kernal --tape` (cli.ts) and the
 * Tapes page of /admin (admin.ts).
 *
 *   /tape [status]   what this session plays, what new sessions play, whether the cloud changed it
 *   /tape list       the cloud's tapes, with what is pinned here
 *   /tape show [id]  what a tape does and its full prompts
 *   /tape <id>       review (pin on first play; the diff when the cloud changed it), install its
 *                    packages on your yes, make it the tape new sessions play, and restart into
 *                    this session with it
 *   /tape off        new sessions play no tape; restarts this session without it
 *
 * A tape's model, prompts, tools and packages are pi start-up flags, so switching restarts pi into
 * the same session file (process.execve of bin/kernal, under node). pi's compiled binary has no
 * execve: there Kernal says what to run instead.
 *
 * Inside a Drive this registers nothing: agentd plays the tape there.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inSandbox } from "../_shared/env.ts";
import { personHere } from "../_shared/person.ts";
import { readSettings, updateKernal, updateSettings } from "../connect/settings.ts";
import { laptopTransport, type AdminTransport } from "../outfitter-admin/transport.ts";
import { repoHere } from "../_shared/repo.ts";
import { playing } from "../_shared/tape-env.ts";
import {
  activeTape, changeIntro, diffTapes, installPackages, launchPlan, listCloudTapes, listPins, npmRunner, ownPackages, packagePlan, pinIntro, pinState, promptText, readPin, repoWarning,
  reviewTape, shortHash, summaryLines, tapeDir, tapeHash, tapeNpmDir, TAPE_ID, transportFetch, type Reviewer, type Runner,
} from "./lib.ts";

const USAGE = "usage: /tape [status] | list | show [id] | <id> | off";
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

export interface TapeDeps {
  env?: NodeJS.ProcessEnv;
  transport?: AdminTransport;
  dir?: string;
  run?: Runner;
  /** Tests: the working directory's repo (_shared/repo.ts repoInfo). */
  repo?: (cwd: string) => Promise<{ repo?: string; note?: string }>;
  /** Tests: what a restart would do, instead of doing it. */
  relaunch?: (args: string[], ctx: any) => void;
  settings?: () => Record<string, unknown>;
  writeSettings?: (change: (s: Record<string, any>) => void) => void;
}

/** Restarts Kernal into this session: bin/kernal again (so the tape is reviewed and applied the one
 * way, and the tape markers and pi-memory override of this run are cleared there before anything
 * starts), after pi has shut down cleanly. The Dongle comes back from .env. Returns false when this
 * pi can't, with nothing done. */
export function restartInto(args: string[], ctx: any, env: NodeJS.ProcessEnv = process.env): boolean {
  const agentDir = env.PI_CODING_AGENT_DIR;
  const bin = agentDir ? join(dirname(agentDir), "bin", "kernal") : "";
  const execve = (process as any).execve as ((file: string, args: string[], env: NodeJS.ProcessEnv) => never) | undefined;
  if (!bin || !existsSync(bin) || typeof execve !== "function" || process.versions.bun || typeof ctx?.shutdown !== "function") return false;
  // The TUI already asked about the packages; cli.ts doesn't ask again.
  const next = { ...env, KERNAL_TAPE_ASKED: "1" };
  process.once("exit", () => {
    try {
      execve(bin, [bin, ...args], next);
    } catch {
      // The process is ending anyway; the person starts Kernal again.
    }
  });
  ctx.shutdown();
  return true;
}

export default function (pi: ExtensionAPI, deps: TapeDeps = {}) {
  const env = deps.env ?? process.env;
  if (inSandbox() || env.OUTFITTER_SESSION_ID || env.OUTFITTER_ADMIN_SOCKET) return;
  const dir = deps.dir ?? tapeDir(env);
  const settings = deps.settings ?? (() => readSettings());
  const setTape = (id: string | undefined) => updateKernal({ tape: id }, (deps.writeSettings ?? updateSettings) as typeof updateSettings);
  let transport: AdminTransport | undefined | null = deps.transport ?? null;
  const way = () => (transport === null ? (transport = laptopTransport()) : transport);
  const now = playing(env);
  const here = (ctx: any) => repoHere(typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(), deps.repo);

  pi.on("session_start", async (_e: unknown, ctx: any) => {
    if (now) ctx?.ui?.setStatus?.("tape", `▶ tape ${now.id}`);
  });

  const restart = (args: string[], ctx: any, what: string) => {
    const file = ctx?.sessionManager?.getSessionFile?.();
    const full = [...args, ...(file ? ["--session", file] : [])];
    if (deps.relaunch) return deps.relaunch(full, ctx);
    ctx.ui.notify(`${what} Restarting Kernal into this session…`, "info");
    if (!restartInto(full, ctx, env)) {
      ctx.ui.notify(`${what} It applies when Kernal starts: exit, then run: kernal ${full.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`, "warning");
    }
  };

  /** Review in the TUI: the summary or the diff above, the decision in a select. */
  const tuiReviewer = (ctx: any): Reviewer => {
    const decide = async (text: string, question: string, yes: string, no: string, prompts: string): Promise<boolean> => {
      ctx.ui.notify(text, "info");
      for (;;) {
        const pick = await ctx.ui.select(question, [yes, "Show the full prompts", no], { timeout: CONFIRM_TIMEOUT_MS });
        if (pick === "Show the full prompts") {
          ctx.ui.notify(prompts, "info");
          continue;
        }
        return pick === yes;
      }
    };
    return {
      pin: (tape, summary) => decide(pinIntro(tape, summary), `Pin this version of ${tape.id} and play it?`, "Pin and play", "Cancel", promptText(tape)),
      change: (pin, cloud, changes) => decide(changeIntro(pin, cloud, changes), `Play the new version of ${cloud.id}?`, "Pin and play the new version", "Keep the pinned version", promptText(cloud)),
    };
  };

  async function status(ctx: any): Promise<string> {
    const out: string[] = [];
    const active = activeTape(settings());
    const where = await here(ctx);
    const inRepo = where.repo ? ` in ${where.repo}` : ", no repo";
    out.push(now ? `this session plays tape ${now.id} (${shortHash(now.hash)})${inRepo}, memory ${now.memory}${now.agentEngine ? ", Agent Engine" : ""}` : `this session plays no tape${inRepo}`);
    if (where.note) out.push(`repo: ${where.note}`);
    out.push(`new sessions play: ${active ?? "no tape"}`);
    const id = now?.id ?? active;
    if (id) {
      const pin = readPin(dir, id);
      const t = way();
      if (pin && t) {
        const cloud = await transportFetch(t)(id);
        if (!cloud.ok) out.push(`cloud: not reached (${cloud.error}); the pinned version plays`);
        else if (pinState(pin, { hash: tapeHash(cloud.tape) }) === "pinned") out.push("cloud: same as the pinned version");
        else out.push(`cloud: changed since you pinned it (${diffTapes(pin.tape, cloud.tape).map((c) => c.field).join(", ")}); /tape ${id} reviews it`);
      }
      if (pin) {
        for (const n of launchPlan(pin.tape, packagePlan(pin.tape, tapeNpmDir(dir, id)), tapeNpmDir(dir, id), env).notes) out.push(n);
        const warn = repoWarning(pin.tape, where.repo);
        if (warn) out.push(`${warn} (a hint: it plays anyway)`);
      }
    }
    return out.join("\n");
  }

  async function list(): Promise<string> {
    const pins = new Map(listPins(dir).map((p) => [p.tape.id, p]));
    const t = way();
    const cloud = t ? await listCloudTapes(t) : { ok: false as const, error: "no Dongle (OUTFITTER_API and OUTFITTER_TOKEN)" };
    const rows: string[] = [];
    if (cloud.ok) {
      for (const c of cloud.tapes) {
        const pin = pins.get(c.id);
        pins.delete(c.id);
        const state = !pin ? "not pinned" : pinState(pin, c) === "pinned" ? `pinned ${shortHash(pin.hash)}` : `pinned ${shortHash(pin.hash)}, changed in the cloud`;
        rows.push(`${c.id}  ${c.name !== c.id ? `${c.name}  ` : ""}${c.model}  ${state}`);
      }
    } else rows.push(`cloud: ${cloud.error}`);
    for (const p of pins.values()) rows.push(`${p.tape.id}  ${p.tape.model}  pinned ${shortHash(p.hash)}${cloud.ok ? ", not in the cloud any more" : ""}`);
    return rows.join("\n") || "no tapes";
  }

  async function play(ref: string, ctx: any): Promise<void> {
    const t = way();
    const review = await reviewTape(ref, { dir, fetch: t ? transportFetch(t) : undefined, reviewer: tuiReviewer(ctx), env, reaskKept: true });
    for (const n of review.notes) ctx.ui.notify(n, "info");
    if (!review.ok || !review.tape) return ctx.ui.notify(review.error ?? "nothing to play", "warning");
    const tape = review.tape;
    const npmDir = tapeNpmDir(dir, tape.id);
    const plan = packagePlan(tape, npmDir, ownPackages(settings()));
    if (plan.missing.length) {
      const yes = await ctx.ui.confirm(
        `Install ${plan.missing.length} npm package${plan.missing.length === 1 ? "" : "s"} for ${tape.id}?`,
        `${plan.missing.map((p) => p.spec).join(", ")}\n\nThey install into ${npmDir} with install scripts off, and run as you in sessions that play this tape. No plays the tape without them.`,
        { timeout: CONFIRM_TIMEOUT_MS },
      );
      if (yes) {
        ctx.ui.notify("installing…", "info");
        const res = await installPackages(plan.missing, npmDir, deps.run ?? npmRunner);
        if (!res.ok) ctx.ui.notify(`npm install failed; the tape plays without them:\n${res.output.split("\n").slice(-8).join("\n")}`, "warning");
      }
    }
    const warn = repoWarning(tape, (await here(ctx)).repo);
    if (warn) ctx.ui.notify(`${warn}. It's a hint: the tape plays anyway.`, "warning");
    setTape(tape.id);
    restart(["--tape", tape.id], ctx, `Tape ${tape.id} (${shortHash(tapeHash(tape))}) plays in new sessions.`);
  }

  pi.registerCommand("tape", {
    description: "tape [status] | list | show [id] | <id> | off -- play a cloud tape on this laptop (pinned, reviewed on change)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "list", "show", "off", ...listPins(dir).map((p) => p.tape.id)].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
    handler: async (args: string, ctx: any) => {
      const notify = (m: string, level = "info") => ctx?.ui?.notify?.(m, level);
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      try {
        if (sub === "status") return notify(await status(ctx));
        if (sub === "list") return notify(await list());
        if (sub === "show") {
          const id = parts[1] ?? now?.id ?? activeTape(settings());
          if (!id || !TAPE_ID.test(id)) return notify("usage: /tape show <id>", "warning");
          const t = way();
          const cloud = t ? await transportFetch(t)(id) : undefined;
          const pin = readPin(dir, id);
          const tape = cloud?.ok ? cloud.tape : pin?.tape;
          if (!tape) return notify(`tape ${id}: ${cloud && !cloud.ok ? cloud.error : "not pinned here"}`, "warning");
          const s = pinState(pin, { hash: tapeHash(tape) });
          const state = !pin ? "not pinned" : s === "pinned" ? `pinned ${shortHash(pin.hash)}` : `changed in the cloud since the pin ${shortHash(pin.hash)}`;
          return notify(`${summaryLines(tape, env).join("\n")}\n(${state})\n\n${promptText(tape)}`);
        }
        if (sub === "off") {
          setTape(undefined);
          if (!now) return notify("New sessions play no tape.");
          if (!personHere(ctx, "select")) return notify("New sessions play no tape. Restart Kernal to stop this session's tape.");
          return restart(["--tape", "none"], ctx, `Stopped tape ${now.id}.`);
        }
        if (parts.length !== 1 || !TAPE_ID.test(sub)) return notify(USAGE, "warning");
        if (!personHere(ctx, "select")) return notify("Playing a tape needs your review at the terminal: run /tape in the TUI, or kernal --tape <id>.", "warning");
        return await play(sub, ctx);
      } catch (err) {
        return notify(`tape: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });
}
