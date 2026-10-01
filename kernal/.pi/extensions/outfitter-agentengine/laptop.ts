/**
 * Agent Engine memory on a laptop (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §3.5, #349):
 * the same memory as the person's Drives, through their Dongle (POST /api/admin/ops).
 *
 * Settings, in the agent settings.json under `kernal` (connect/settings.ts; changed with `/memory`,
 * read once when Kernal starts, like every `kernal.*` setting):
 *
 *   memory        "off" | "tool" | "auto"  -- unset: `auto` when OUTFITTER_API and OUTFITTER_TOKEN
 *                                            are set, else off. `tool` = the `memory` tool;
 *                                            `auto` = the tool plus recall before each prompt.
 *   memoryRecord  true                     -- opt-in: also record this laptop's turns (record.ts).
 *   memoryImported, memoryImportOffered    -- the one-time pi-memory import (pi-memory.ts).
 *
 * bin/kernal reads `memory` the same way, before pi starts, to turn pi-memory's prompt injection and
 * exit summary off (pi-memory.ts says why it has to be there).
 *
 * Each call carries `laptop: {sessionId: "laptop:<pi session id>", repo}`. The repo is the working
 * directory's GitHub `origin` remote, lowercased; it only scopes the owner's own memory. The API
 * decides whose memory it is (the Dongle's owner) and enforces every rule; this side asks the
 * person before a shared save, because the API takes `confirmed` as their word.
 */
import { readSettings, updateSettings } from "../connect/settings.ts";
import { remote } from "../_shared/git.ts";
import type { AdminTransport, LaptopContext } from "../outfitter-admin/transport.ts";
import { registerMemoryTool, type Confirm } from "./memory.ts";
import { applyMemory, recallQuery, requestRecall } from "./recall.ts";
import { TurnRecorder } from "./record.ts";
import { importPlan, piMemoryInjectionOff, piMemorySource, withoutPiMemoryTools, type ImportNote } from "./pi-memory.ts";

export type MemoryMode = "off" | "tool" | "auto";
const MODES: readonly MemoryMode[] = ["off", "tool", "auto"];
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

export interface MemorySettings {
  /** As set; undefined means the default (see effectiveMode). */
  memory?: MemoryMode;
  memoryRecord: boolean;
  memoryImported?: string;
  memoryImportOffered: boolean;
}

/** The `kernal` section's memory settings; anything unrecognised reads as unset. */
export function memorySettings(settings: Record<string, unknown> = readSettings()): MemorySettings {
  const k = (settings.kernal ?? {}) as Record<string, unknown>;
  const memory = typeof k.memory === "string" && (MODES as readonly string[]).includes(k.memory) ? (k.memory as MemoryMode) : undefined;
  return {
    ...(memory ? { memory } : {}),
    memoryRecord: k.memoryRecord === true,
    ...(typeof k.memoryImported === "string" ? { memoryImported: k.memoryImported } : {}),
    memoryImportOffered: k.memoryImportOffered === true,
  };
}

/** The mode in force: the setting, else `auto` with a Dongle configured; always off without one. */
export function effectiveMode(s: Pick<MemorySettings, "memory">, hasDongle: boolean): MemoryMode {
  if (!hasDongle) return "off";
  return s.memory ?? "auto";
}

/** Recording happens only in `tool` or `auto`, and only when the person opted in. */
export function recordingOn(s: MemorySettings, mode: MemoryMode): boolean {
  return mode !== "off" && s.memoryRecord;
}

function writeKernal(patch: Record<string, unknown>): void {
  updateSettings((s) => {
    const k = (s.kernal && typeof s.kernal === "object" && !Array.isArray(s.kernal) ? s.kernal : {}) as Record<string, any>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete k[key];
      else k[key] = value;
    }
    s.kernal = k;
  });
}

// ---------- the laptop context ----------

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

/** `owner/name` of a github.com remote, lowercased, or undefined. */
export function githubRepo(r: { host?: string; owner?: string; repo?: string } | undefined): string | undefined {
  if (!r?.owner || !r.repo || (r.host ?? "").toLowerCase() !== "github.com") return undefined;
  const repo = `${r.owner}/${r.repo}`.toLowerCase();
  return REPO.test(repo) ? repo : undefined;
}

export type RepoOf = (cwd: string) => Promise<string | undefined>;

/** The cwd's GitHub repo, from `origin`, cached per directory for this process. */
export function cachedRepoOf(lookup: (cwd: string) => Promise<{ host?: string; owner?: string; repo?: string } | undefined> = remote): RepoOf {
  const cache = new Map<string, Promise<string | undefined>>();
  return (cwd) => {
    let hit = cache.get(cwd);
    if (!hit) {
      hit = lookup(cwd).then(githubRepo, () => undefined);
      cache.set(cwd, hit);
    }
    return hit;
  };
}

/** The `laptop` context for this call, or undefined when pi has no usable session id. */
export async function laptopContextOf(ctx: any, repoOf: RepoOf): Promise<LaptopContext | undefined> {
  const id = ctx?.sessionManager?.getSessionId?.();
  if (typeof id !== "string" || !SESSION.test(id)) return undefined;
  const repo = typeof ctx?.cwd === "string" ? await repoOf(ctx.cwd).catch(() => undefined) : undefined;
  return { sessionId: `laptop:${id}`, ...(repo ? { repo } : {}) };
}

/** A person is at the terminal (outfitter-admin's personHere, without its Drive check). */
function personHere(ctx: any): boolean {
  return ctx?.mode === "tui" && typeof ctx?.ui?.confirm === "function";
}

// ---------- registration ----------

export interface LaptopDeps {
  settings?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  repoOf?: RepoOf;
  /** Tests: shorter recall wait. */
  recallTimeoutMs?: number;
}

/**
 * Registers laptop memory on `pi` over the Dongle's `transport`: always the `/memory` command; in
 * `tool`/`auto` the tool and pi-memory's tools out; in `auto` recall; with the opt-in, recording.
 */
export function registerLaptopMemory(pi: any, transport: AdminTransport, deps: LaptopDeps = {}): { mode: MemoryMode; recording: boolean } {
  const env = deps.env ?? process.env;
  const settings = memorySettings(deps.settings ?? readSettings());
  const mode = effectiveMode(settings, true);
  const recording = recordingOn(settings, mode);
  const repoOf = deps.repoOf ?? cachedRepoOf();
  const context = (ctx: any) => laptopContextOf(ctx, repoOf);

  registerMemoryCommand(pi, transport, { settings, mode, env, context });
  if (mode === "off") return { mode, recording };

  // pi-memory reads this at exit, so setting it here is enough (bin/kernal does too).
  env.PI_MEMORY_EXIT_SUMMARY = "0";

  registerMemoryTool(pi, transport, {
    laptop: context,
    confirm: (ctx) =>
      personHere(ctx) ? (title, message, signal) => ctx.ui.confirm(title, message, { signal, timeout: CONFIRM_TIMEOUT_MS }) : undefined,
  });

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    try {
      if (typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
        const active: string[] = pi.getActiveTools();
        const kept = withoutPiMemoryTools(active);
        if (kept.length !== active.length) pi.setActiveTools(kept);
      }
    } catch {
      // A pi without the tool API keeps them; bin/kernal still turned the injection off.
    }
    await offerImport(ctx, settings, env).catch(() => {});
  });

  if (mode === "auto") {
    let told = false;
    pi.on("before_agent_start", async (event: any, ctx: any) => {
      try {
        const query = recallQuery(event?.prompt);
        if (!query) return;
        const laptop = await context(ctx);
        if (!laptop) return;
        const text = await requestRecall(transport, query, laptop, {
          timeoutMs: deps.recallTimeoutMs,
          // Say once when this Outfitter can't recall at all (memory off there, or an old release);
          // a slow or failed turn is skipped quietly.
          onError: (error) => {
            if (told || !/not configured|works only in a Drive|newer Kernal|no admin ops/.test(error)) return;
            told = true;
            ctx?.ui?.notify?.(`memory: ${error} (recall is skipped; /memory off to stop asking)`, "warning");
          },
        });
        applyMemory(event?.systemPromptOptions, text);
      } catch {
        // Recall is best effort: the prompt goes on without it.
      }
    });
  }

  if (recording) {
    let notify: (m: string) => void = () => {};
    const recorder = new TurnRecorder(transport, (m) => notify(m));
    pi.on("agent_end", async (_event: unknown, ctx: any) => {
      notify = (m) => ctx?.ui?.notify?.(m, "warning");
      const laptop = await context(ctx).catch(() => undefined);
      const branch = ctx?.sessionManager?.getBranch?.();
      if (laptop && Array.isArray(branch)) recorder.note(branch, laptop);
    });
    pi.on("session_shutdown", async () => {
      await recorder.flush();
    });
  }
  return { mode, recording };
}

/** At most once ever: a person with pi-memory notes hears that /memory import can bring them over. */
async function offerImport(ctx: any, settings: MemorySettings, env: NodeJS.ProcessEnv): Promise<void> {
  if (settings.memoryImported || settings.memoryImportOffered || !personHere(ctx)) return;
  const { notes } = await importPlan(piMemorySource(env));
  if (!notes.length) return;
  writeKernal({ memoryImportOffered: true });
  ctx.ui.notify?.(
    `Agent Engine memory is on, so pi-memory is off here. You have ${notes.length} pi-memory note${notes.length === 1 ? "" : "s"}: /memory import lists them and brings them over on your yes.`,
    "info",
  );
}

// ---------- /memory ----------

const USAGE = "usage: /memory [status] | off | tool | auto | record on|off | import [--dry-run]";

function status(settings: MemorySettings, mode: MemoryMode, env: NodeJS.ProcessEnv): string {
  return [
    `memory: ${mode}${settings.memory ? "" : " (default)"}`,
    `  recording laptop turns: ${recordingOn(settings, mode) ? "on" : settings.memoryRecord ? "opted in, but memory is off" : "off (opt in with /memory record on)"}`,
    `  pi-memory: ${mode === "off" ? "on" : piMemoryInjectionOff(env) ? "off (its tools, prompt and exit summary)" : "tools off; restart Kernal to turn its prompt off too"}`,
    `  pi-memory import: ${settings.memoryImported ? `done ${settings.memoryImported.slice(0, 10)}` : "not yet (/memory import)"}`,
    "Changes apply when Kernal next starts.",
  ].join("\n");
}

function preview(notes: ImportNote[]): string {
  const shown = notes.slice(0, 15).map((n) => `- ${n.text.length > 140 ? `${n.text.slice(0, 139)}…` : n.text}`);
  return [...shown, ...(notes.length > 15 ? [`… and ${notes.length - 15} more`] : [])].join("\n");
}

/** Saves `notes` as private, repo-less semantic memories. A report line, never a throw. */
export async function importNotes(transport: AdminTransport, notes: ImportNote[], laptop: LaptopContext): Promise<{ saved: number; failed: string[] }> {
  let saved = 0;
  const failed: string[] = [];
  // Repo-less on purpose: pi-memory's notes were never about one repository.
  const context: LaptopContext = { sessionId: laptop.sessionId };
  for (const note of notes) {
    const reply = await transport.call("memory.save", { type: "semantic", text: note.text, label: note.label }, { laptop: context });
    if (reply.ok) saved++;
    else {
      failed.push(reply.error);
      // The same refusal for every note (memory off there, a bad Dongle): stop at the first.
      if (failed.length === 1 && /not configured|works only in a Drive|newer Kernal|rejected|unreachable|no admin ops/.test(reply.error)) break;
    }
  }
  return { saved, failed };
}

function registerMemoryCommand(
  pi: any,
  transport: AdminTransport,
  o: { settings: MemorySettings; mode: MemoryMode; env: NodeJS.ProcessEnv; context: (ctx: any) => Promise<LaptopContext | undefined> },
): void {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("memory", {
    description: "memory [status] | off | tool | auto | record on|off | import [--dry-run] -- Agent Engine memory on this laptop (shared with your Drives)",
    handler: async (args: string, ctx: any) => {
      const notify = (m: string, level = "info") => ctx?.ui?.notify?.(m, level);
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      try {
        if (sub === "status") return notify(status(o.settings, o.mode, o.env));
        if ((MODES as readonly string[]).includes(sub)) {
          writeKernal({ memory: sub });
          return notify(`memory set to ${sub}; it applies when Kernal next starts.${sub === "off" ? " pi-memory comes back then." : " pi-memory is off from then on."}`);
        }
        if (sub === "record") {
          const on = parts[1];
          if (on !== "on" && on !== "off") return notify("usage: /memory record on|off", "warning");
          if (on === "on" && personHere(ctx)) {
            const yes = await ctx.ui.confirm(
              "Record this laptop's turns in Agent Engine memory?",
              "Your prompts and Kernal's final answers from laptop sessions go to your Outfitter's Agent Engine memory (secrets redacted; never tool output), and are recalled in your Drives and laptop sessions. They stay private to you. Turn it off any time with /memory record off.",
              { timeout: CONFIRM_TIMEOUT_MS },
            );
            if (!yes) return;
          }
          writeKernal({ memoryRecord: on === "on" ? true : undefined });
          return notify(`recording ${on}; it applies when Kernal next starts${on === "on" && o.mode === "off" ? " (memory is off: /memory auto as well)" : ""}.`);
        }
        if (sub === "import") return await runImport(parts.includes("--dry-run"), ctx, notify);
        return notify(USAGE, "warning");
      } catch (err) {
        return notify(`memory: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  async function runImport(dryRun: boolean, ctx: any, notify: (m: string, level?: string) => void): Promise<void> {
    const source = piMemorySource(o.env);
    const { file, notes } = await importPlan(source);
    if (!notes.length) return notify(`no pi-memory notes to import (${file} is missing or empty)`);
    const list = `${notes.length} note${notes.length === 1 ? "" : "s"} from ${file}:\n${preview(notes)}`;
    if (dryRun) return notify(`${list}\n\nDry run: nothing was saved. /memory import saves them (private, for every repo).`);
    if (!personHere(ctx)) return notify(`${list}\n\nImport needs your yes at the terminal; run /memory import in the TUI.`, "warning");
    const again = o.settings.memoryImported ? `\n\nAlready imported on ${o.settings.memoryImported.slice(0, 10)}; the same notes update in place, they don't double.` : "";
    const yes = await ctx.ui.confirm(`Import ${notes.length} pi-memory note${notes.length === 1 ? "" : "s"} into Agent Engine memory?`, `${list}\n\nThey are saved as private semantic memories, for every repo.${again}`, { timeout: CONFIRM_TIMEOUT_MS });
    if (!yes) return;
    const laptop = await o.context(ctx);
    if (!laptop) return notify("memory: this session has no id yet; send a prompt first, then /memory import", "warning");
    const { saved, failed } = await importNotes(transport, notes, laptop);
    if (saved > 0) writeKernal({ memoryImported: new Date().toISOString() });
    notify([`imported ${saved} of ${notes.length} note${notes.length === 1 ? "" : "s"}`, ...failed.slice(0, 3).map((e) => `  ${e}`)].join("\n"), failed.length ? "warning" : "info");
  }
}

export type { Confirm };
