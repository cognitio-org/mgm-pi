// Central sign-in, CA-6 (#395, docs/specs/central-auth.md §9): what a Drive run gets from the
// central side. Owned by task I.
//
//   - Run keys. A run of a session with an owner gets its own short-lived LiteLLM key
//     (`outfitter-run-<runId>`, user_id of the owner, LiteLLM `duration` as the backstop) instead
//     of the shared `outfitter-litellm-key-<guruId>` / `-default`, so Drive spend has a person. The
//     key goes out in run.spec once and is deleted when the run ends (agentlink.ts's `bye`); a run
//     that ends some other way has a sandbox that is gone with the key in it, and the tick's sweep
//     (sweepRouterKeys) deletes the record once LiteLLM's own expiry has passed.
//   - The system team. Outfitter's own model calls (keys no person holds) belong to the LiteLLM
//     team `outfitter-system`; ensureSystemTeam creates it, and moving the existing keys into it is
//     an owner step.
//   - Settings. The owner's resolved settings (CA-3, their default profile, no device level) ride
//     run.spec as `settings`, so a laptop and a Drive read the same values (agentd/src/settings.ts).
//
// The shared key can stay as a fallback (config.runKeyFallback, OUTFITTER_RUN_KEY_FALLBACK; on when
// unset, off in production since CA-10, #399: deploy/config.env sets 0): a mint that fails, or a re-sent spec whose first key may still be in use, gets the shared key
// instead of failing the run. With the fallback off a failed mint is a transient run.spec failure
// (agentd retries the connection), and a re-sent spec whose first key may be in use gets an
// additional run key (`outfitter-run-<runId>-2`, ...) while the first stays live until the run ends.

import type { Config } from "../config.ts";
import type { FleetSettings } from "../fleet-settings.ts";
import type { RouterKey } from "../store/keys.ts";
import type { Run, Session, Store } from "../store/types.ts";
import { runKeyAlias, type LitellmKeys, type RouterKeyLimitsSource } from "./litellm-keys.ts";
import { resolveConfig } from "./settings-resolver.ts";
import type { SettingValue, ValueSource } from "./settings-schema.ts";
import { userIdFor } from "./user-id.ts";

/** The LiteLLM team for Outfitter's own model calls (§9). */
export const SYSTEM_TEAM_ALIAS = "outfitter-system";

/** A run key's LiteLLM `duration`. A run is bounded by its sandbox, not by its idle stop: a busy run
 * never idles, and the agent job's task timeout (deploy/agent-job.sh `--task-timeout=24h`) is the
 * longest any run can live. A key shorter than that could die under a run mid-turn, and a reconnect
 * never re-mints (agentd keeps its first spec), so the key covers the whole 24 h ceiling §9 allows.
 * The explicit delete at the run's end is what normally revokes it. */
export const RUN_KEY_DURATION_SECONDS = 24 * 60 * 60;

/** The most keys one run is minted (`outfitter-run-<runId>`, then `-2` up to `-<n>`): with the
 * fallback off, each re-sent spec of a still-provisioning run adds one. Past this the spec build
 * counts as a failed mint. */
export const MAX_RUN_KEYS = 8;

/** Where run.spec.secrets.litellmKey came from. "run": minted for this run (or, on a reconnect,
 * deliberately empty: agentd keeps the key of its first spec). "shared": the tape's or the
 * default shared key, today's behaviour. */
export type RunKeySource = "run" | "shared";

export interface RunKeyChoice {
  key: string;
  source: RunKeySource;
  /** The run key's alias when source is "run". */
  alias?: string;
}

/** Minting is on and the fallback is off, and no run key could be had. Not terminal:
 * handleConnection closes 1011 and agentd retries. The message never carries a key. */
export class RunKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunKeyUnavailableError";
  }
}

export interface RunKeyRequest {
  run: Pick<Run, "id" | "state">;
  /** Whether a spec for this run already went out (Run.startup.specSentAt); "unknown" for a run
   * without startup timings. */
  specSent: "yes" | "no" | "unknown";
  session: Pick<Session, "id" | "ownerEmail">;
  /** What the secrets broker resolved for the run (the tape's or the default key). */
  sharedKey: string;
  /** An A2A session keeps its tape's dedicated key (§9), unchanged. */
  a2a: boolean;
}

export interface RunKeysOptions {
  keys: LitellmKeys | undefined;
  store: Pick<Store, "routerKeys">;
  config: Pick<Config, "runKeyFallback">;
  /** The fleet's key limits at mint time (`router.runKey.maxBudgetUsd`, `router.keys.models`). */
  limits: RouterKeyLimitsSource;
  log?: (msg: string, err?: unknown) => void;
}

/** The states agentd reports only after it has applied its run.spec (agentlink.ts isReadyState). */
function specApplied(state: Run["state"]): boolean {
  return state === "running" || state === "idle" || state === "stopping";
}

export class RunKeys {
  private readonly keys: LitellmKeys | undefined;
  private readonly store: Pick<Store, "routerKeys">;
  private readonly fallback: boolean;
  private readonly limits: RouterKeyLimitsSource;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(opts: RunKeysOptions) {
    this.keys = opts.keys;
    this.store = opts.store;
    this.fallback = opts.config.runKeyFallback;
    this.limits = opts.limits;
    this.log = opts.log ?? (() => {});
  }

  /** True when run keys are minted at all (LITELLM_ADMIN_KEY set). */
  get enabled(): boolean {
    return this.keys !== undefined;
  }

  /** run.spec.secrets.litellmKey for one spec build. Never throws except RunKeyUnavailableError
   * (fallback off). */
  async keyForRun(req: RunKeyRequest): Promise<RunKeyChoice> {
    const shared: RunKeyChoice = { key: req.sharedKey, source: "shared" };
    // Without minting, for an A2A session, or with nobody to attribute the run to: today's key.
    if (!this.keys || req.a2a || !req.session.ownerEmail) return shared;
    const alias = runKeyAlias(req.run.id);
    // A reconnect of a run whose agentd already applied its spec: that spec's key is the one in use
    // and this spec is ignored, so nothing is minted and no key is sent again.
    if (specApplied(req.run.state)) return { key: "", source: "run", alias };

    const email = req.session.ownerEmail;
    try {
      const records = await this.runKeyRecords(req.run.id);
      if (records.some((r) => !r.deletedAt)) {
        // A spec was built for this run before. If it may have gone out, an agentd still
        // provisioning could be using its key, and agentd applies only its first spec: that key
        // stays live until the run ends. A fresh agentd gets the shared key while the fallback
        // lasts, or else an additional key below. If no spec went out (the socket was lost while
        // one was being built), the earlier keys reached nobody and are deleted. A failed delete
        // stays owed (deleteFailedAt) for the sweep: the new key is a new record, never this one.
        if (req.specSent !== "no" && this.fallback) return shared;
        if (req.specSent === "no") {
          for (const record of records) {
            if (record.deletedAt) continue;
            await this.keys.deleteKey({ alias: record.alias }).catch((err: unknown) => {
              this.log(`run keys: could not delete ${record.alias} of run ${req.run.id}; the sweep retries`, err instanceof Error ? err.message : String(err));
            });
          }
        }
      }
      const mint = records.length + 1;
      if (mint > MAX_RUN_KEYS) throw new Error(`run ${req.run.id} already has ${MAX_RUN_KEYS} keys`);
      const userId = userIdFor(email);
      await this.keys.ensureLitellmUser({ userId, email });
      const limits = (await this.limits()).run;
      const minted = await this.keys.mintRunKey({
        ...limits,
        userId,
        email,
        runId: req.run.id,
        sessionId: req.session.id,
        durationSeconds: RUN_KEY_DURATION_SECONDS,
        mint,
      });
      return { key: minted.key, source: "run", alias: minted.alias };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.fallback) {
        this.log(`run keys: minting for run ${req.run.id} failed; using the shared key`, message);
        return shared;
      }
      throw new RunKeyUnavailableError(`could not mint this run's LiteLLM key: ${message}`);
    }
  }

  /** Every key record of a run, in mint order (`runKeyAlias(runId, 1)`, `2`, ...). Records are
   * never removed (a deleted key keeps its record with deletedAt), so the first missing alias ends
   * the list. */
  private async runKeyRecords(runId: string): Promise<RouterKey[]> {
    const records: RouterKey[] = [];
    for (let mint = 1; mint <= MAX_RUN_KEYS; mint++) {
      const record = await this.store.routerKeys.findByAlias(runKeyAlias(runId, mint));
      if (!record) break;
      records.push(record);
    }
    return records;
  }

  /** Deletes every key the run has. Called when the run ends; never throws (a failed delete is
   * recorded and retried by the tick's sweep). */
  async revoke(runId: string): Promise<void> {
    if (!this.keys) return;
    let records: RouterKey[];
    try {
      records = await this.runKeyRecords(runId);
    } catch (err) {
      this.log(`run keys: could not look up the keys of run ${runId}; the sweep deletes them at expiry`, err instanceof Error ? err.message : String(err));
      return;
    }
    for (const record of records) {
      if (record.deletedAt) continue;
      try {
        await this.keys.deleteKey({ alias: record.alias });
      } catch (err) {
        this.log(`run keys: could not delete ${record.alias} of run ${runId}; the sweep retries`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Creates the `outfitter-system` team if missing and returns its id; undefined without minting
   * or when LiteLLM refused. Called once per instance at start-up. */
  async ensureSystemTeam(): Promise<string | undefined> {
    if (!this.keys) return undefined;
    try {
      return await this.keys.ensureTeam(SYSTEM_TEAM_ALIAS);
    } catch (err) {
      this.log(`run keys: could not ensure the ${SYSTEM_TEAM_ALIAS} team`, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }
}

/** run.spec.settings (§9): the owner's resolved values without the resolver's rule metadata. */
export interface RunSpecSettings {
  schemaVersion: number;
  profile: string | null;
  values: Record<string, { value: SettingValue; source: ValueSource; sourceName?: string }>;
}

/** Keys a Drive never takes from run.spec.settings: the router is pinned by the api
 * (secrets.litellmBaseUrl, secrets.litellmKey) and fleet telemetry keeps flowing through
 * run.spec.telemetry. */
export function runSettingExcluded(key: string): boolean {
  return key.startsWith("router.") || key.startsWith("telemetry.");
}

/** The owner's settings for a run, from their default profile (no device level), or undefined when
 * they can't be resolved just now: settings are a preference, never a reason to fail a run. */
export async function runSpecSettings(
  store: Pick<Store, "settings">,
  fleet: FleetSettings,
  ownerEmail: string,
  opts: { allowHttp?: boolean; log?: (msg: string, err?: unknown) => void } = {},
): Promise<RunSpecSettings | undefined> {
  try {
    const resolved = await resolveConfig(store, fleet, { email: ownerEmail, allowHttp: opts.allowHttp === true });
    const values: RunSpecSettings["values"] = {};
    for (const [key, v] of Object.entries(resolved.values)) {
      if (runSettingExcluded(key)) continue;
      values[key] = { value: v.value, source: v.source, ...(v.sourceName ? { sourceName: v.sourceName } : {}) };
    }
    return { schemaVersion: resolved.schemaVersion, profile: resolved.profile, values };
  } catch (err) {
    opts.log?.("run settings: could not resolve the owner's settings; the run starts without them", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
