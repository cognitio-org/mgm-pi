/**
 * /config: the settings in force in this Kernal and where each one comes from (#397 CA-8,
 * outfitter/docs/specs/central-auth.md §10). Signed in (`kernal login`) the central part comes from
 * Outfitter, for this process's profile (`--profile` / KERNAL_PROFILE); this machine's overrides,
 * .env and the shell are layered over it (_shared/central-config.ts has the order).
 *
 *   /config           every known key: value (secrets masked), source, and whether it is locked
 *   /config reload    fetch the account's settings again and re-resolve
 *   /config profile   the active profile and the account's profiles
 *
 * At load it starts the background refresh (settings into the cache, personal provider keys into
 * memory, the router key re-minted when due); start-up never waits on it. connect has registered
 * its providers by then (it loads first), so when the refresh brings keys it didn't have, or a new
 * router key, this asks connect to register again (`kernal:connect` op "reload"). A device router
 * key the router refuses (401, at connect's key check or on a request) is re-minted once per
 * process (spec §5.5). Values are edited in the web app's Account page or with /admin (CA-9), not
 * here.
 *
 * Applying the personal keys (#437, _shared/central-apply.ts): at session_start a new, empty session
 * switches once to the default model and thinking level the account (or this machine) sets; the
 * background refresh and /config reload take over fresh values and apply what is safe live
 * (compaction at once, voice and the model at the next session, memory at the next start). A
 * running conversation never switches model.
 *
 * A default set inside Kernal (pi's Ctrl+S in the model picker, a default thinking level) goes to the
 * account (_shared/default-sync.ts): pi writes it to settings.json, and this saves it with the
 * versioned PUT, so new sessions on every machine start with it. Per-session changes never do.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inSandbox } from "../_shared/env.ts";
import { busRequest } from "../connect/lib.ts";
import {
  KNOWN_SETTINGS, PROVIDER_ENV, activeProfile, describeSource, displayValue, providerKey, reloadConfig, remintRouterKeyIfDue,
  resolve, startBackgroundRefresh, webOrigin, type ResolvedConfig,
} from "../_shared/central-config.ts";
import { applyModelAtSessionStart, applyVoiceSettings, describeChanges, snapshot } from "../_shared/central-apply.ts";
import { pendingDefaults, registerDefaultSync, type SyncResult } from "../_shared/default-sync.ts";

/** /config's note on when a change reaches this Kernal. */
export const WHEN_NOTE = "Compaction changes apply at once; model, thinking and voice at the next session (/new or a restart: a running conversation never switches model); memory at the next start.";

export type Deps = {
  /** Tests: the start-up refresh (and the reload it may ask for), to await it. */
  onRefresh?: (done: Promise<void>) => void;
  /** Tests: the re-mint a refused router key starts, to await it. */
  onRekey?: (done: Promise<void>) => void;
  fetch?: typeof fetch;
  /** Tests: the command line the start-up model check reads (default process.argv). */
  argv?: readonly string[];
  /** Tests: what session_start applied. */
  onApplied?: (r: import("../_shared/central-apply.ts").StartApplyResult) => void;
  /** Tests: each run of the default sync (a Ctrl+S default to the account), and its settle time. */
  onDefaultsSynced?: (r: SyncResult) => void;
  defaultsSettleMs?: number;
};

/** The device's router key in use, or undefined when a local key (or none) is. */
function deviceRouterKey(): string | undefined {
  const v = resolve().values["router.key"];
  return v?.source === "device" ? String(v.value) : undefined;
}

/** What the account delivered into this process that connect registers with. */
function delivered(): (string | undefined)[] {
  return [deviceRouterKey(), ...Object.keys(PROVIDER_ENV).map(providerKey)];
}

const USAGE = "usage: /config [reload | profile]";

/** Who and what the resolution is for, one line. */
export function headerLine(r: ResolvedConfig): string {
  if (!r.api || !r.account) return "Signed out: this machine's settings only. Run kernal login to use your account's settings.";
  const profile = r.profile ? `profile ${r.profile}` : "no profile";
  const when = r.fetchedAt ? `${r.fromCache ? "cached" : "fetched"} ${r.fetchedAt}` : "not fetched yet (/config reload fetches them)";
  return `${r.account} on ${r.api}, ${profile}; settings ${when}.`;
}

/** The /config listing: one line per known key. */
export function renderConfig(r: ResolvedConfig): string {
  const lines = [headerLine(r)];
  for (const decl of KNOWN_SETTINGS) {
    const v = r.values[decl.key];
    if (!v) { lines.push(`  ${decl.key} = (unset)`); continue; }
    const lock = !v.locked ? "" : v.source === "default" ? ", locked" : ", locked: set by your Sysop";
    lines.push(`  ${decl.key} = ${displayValue(decl.key, v.value)}  (${describeSource(v)}${lock})`);
  }
  if (r.api) lines.push(`Change them at ${webOrigin(r.api)}/account, or with /admin.`);
  lines.push(WHEN_NOTE);
  return lines.join("\n");
}

/** /config profile. */
export function renderProfile(r: ResolvedConfig, requested = activeProfile()): string {
  if (!r.account) return `Signed out: no profiles${requested ? ` (KERNAL_PROFILE=${requested} is ignored)` : ""}. Run kernal login.`;
  const active = r.profile ? `Profile: ${r.profile}${requested ? "" : " (the account's default)"}` : "Profile: none (account-wide settings only)";
  const list = r.profiles?.length ? `Profiles of ${r.account}: ${r.profiles.join(", ")}` : `${r.account} has no profiles yet.`;
  return `${active}\n${list}\nStart Kernal with --profile <name> to use another one.`;
}

export default function (pi: ExtensionAPI, deps: Deps = {}) {
  if (!inSandbox()) {
    const bus = (pi as any).events;
    const reloadConnect = () => busRequest(bus, "kernal:connect", { op: "reload" }).catch(() => undefined);
    let rekeyed = false;
    const rekey = async () => {
      if (rekeyed || !deviceRouterKey()) return;
      rekeyed = true;   // once per process: a key refused again needs kernal login, not a loop
      if (await remintRouterKeyIfDue({ fetch: deps.fetch, force: true })) await reloadConnect();
    };
    const before = delivered();
    const settingsBefore = snapshot(resolve());
    const done = startBackgroundRefresh({ fetch: deps.fetch }).then(async () => {
      // #437: the refresh took over the personal keys' fresh values; voice goes to pi-listen now.
      const changes = describeChanges(settingsBefore, resolve());
      if (changes.length) applyVoiceSettings(resolve());
      if (delivered().some((v, i) => v !== before[i])) await reloadConnect();
      // connect's start-up key check found the device's key refused.
      const backends = await busRequest<{ id: string; rejected?: string }[]>(bus, "kernal:connect", { op: "state" }).catch(() => undefined);
      if (backends?.find((b) => b.id === "litellm")?.rejected) await rekey();
    });
    deps.onRefresh?.(done);
    pi.on("after_provider_response", (ev, ctx) => {
      if (ev.status !== 401 || ctx?.model?.provider !== "litellm") return;
      const refused = deviceRouterKey();
      // Not awaited: the reply is not held up. After the start-up work, which may have re-minted already.
      const p = done.then(() => (refused && deviceRouterKey() === refused ? rekey() : undefined));
      deps.onRekey?.(p);
    });
  }

  // #437: a default set with Ctrl+S (or the default thinking level) goes to the account.
  const defaults = inSandbox() ? undefined : registerDefaultSync(pi as any, { onSynced: deps.onDefaultsSynced, settleMs: deps.defaultsSettleMs });

  // #437: a new, empty session starts on the default model and thinking level the account (or
  // this machine) sets; pi chose its own from settings.json just before.
  pi.on("session_start", async (event: any, ctx: any) => {
    // A default set just before the last quit (Ctrl+S, then exit) goes to the account first, so the
    // new session does not start on the account's older one. Only when one is pending.
    if (defaults && pendingDefaults()) await defaults.run(ctx);
    const r = await applyModelAtSessionStart(pi, event, ctx, { argv: deps.argv });
    deps.onApplied?.(r);
    if (!ctx?.hasUI) return;
    const m = resolve().values["model.default"] ?? resolve().values["model.provider"];
    if (r.model) ctx.ui.notify(`Started on ${r.model}${m ? ` (${describeSource(m)})` : ""}${r.thinking ? `, thinking ${r.thinking}` : ""}. /connect changes it.`, "info");
    else if (r.thinking) ctx.ui.notify(`Thinking level ${r.thinking} (${describeSource(resolve().values["model.thinking"]!)}).`, "info");
    if (r.problem) ctx.ui.notify(`Default model: ${r.problem}.`, "warning");
  });

  pi.registerCommand("config", {
    description: "config [reload | profile] -- the settings in force here and where each comes from (your account, this machine, .env, shell)",
    getArgumentCompletions: (prefix: string) =>
      ["reload", "profile"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: any) => {
      const notify = (m: string, level = "info") => ctx?.ui?.notify?.(m, level);
      const sub = (args ?? "").trim();
      if (sub === "") return notify(renderConfig(resolve()));
      if (sub === "reload") {
        const before = snapshot(resolve());
        const r = await reloadConfig({ fetch: deps.fetch });
        applyVoiceSettings(r);
        const note = r.api && r.fromCache ? "Could not reach Outfitter; showing the cached settings.\n" : "";
        const changes = describeChanges(before, r);
        const changed = changes.length ? `\nChanged:\n${changes.join("\n")}` : "";
        return notify(`${note}${renderConfig(r)}${changed}\nThe model connections and Sentry pick up a change at the next start.`);
      }
      if (sub === "profile") return notify(renderProfile(resolve()));
      return notify(USAGE, "warning");
    },
  });
}
