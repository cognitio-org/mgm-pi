/**
 * The Tapes page of the local web admin (/admin tapes, kernal-admin): the same pin store and the
 * same review as `kernal --tape` and `/tape` (lib.ts), seen and decided in the browser.
 *
 * The page pins a version by its hash: the person pins exactly what the page showed, and a cloud
 * change that lands in between is refused ("it changed again") rather than pinned unseen. Playing a
 * tape here sets `kernal.tape` for new sessions; this session changes with /tape in the TUI.
 *
 * Approvals for Agent Engine calls and shared memory saves are not here: this page is served by the
 * laptop, which the agent can reach too. They are on Outfitter's own web page. Pinning only protects
 * against other people's edits to a shared tape, so the laptop is the right place for it.
 */
import { readSettings, updateSettings } from "../connect/settings.ts";
import { markdownToHtml } from "../kernal-context/report.ts";
import type { AdminTransport } from "../outfitter-admin/transport.ts";
import {
  CLOUD_ONLY_FIELDS, activeTape, diffTapes, installPackages, listCloudTapes, listPins, missingEnv, noteSeen, packagePlan, playing, readPin, repoWarning, shortHash, summaryLines,
  tapeExcludeTools, tapeHash, tapeNpmDir, TAPE_ID, transportFetch, writePin, type Pin, type Runner, type Tape,
} from "./lib.ts";
import { join } from "node:path";
import { repoInfo } from "../_shared/repo.ts";

export type Result = { status?: number; body: unknown };

export interface TapeAdminDeps {
  dir: string;
  transport?: AdminTransport;
  env?: NodeJS.ProcessEnv;
  settings?: () => Record<string, unknown>;
  writeSettings?: (change: (s: Record<string, any>) => void) => void;
  run?: Runner;
  /** The working directory (the session's), for the repo context. */
  cwd?: () => string;
  /** Tests: the repo of a directory (outfitter-agentengine/laptop.ts repoInfo). */
  repo?: (cwd: string) => Promise<{ repo?: string; note?: string }>;
}

const fail = (status: number, error: string): Result => ({ status, body: { error } });

/** A tape for the page: its fields, what it does here, the env names it expects (never values). */
function view(t: Tape, env: NodeJS.ProcessEnv) {
  return {
    id: t.id,
    name: t.name,
    model: t.model,
    fallbackModel: t.fallbackModel,
    thinking: t.thinking,
    tools: t.tools ?? [],
    excludeTools: tapeExcludeTools(t),
    tapeExcludeTools: t.excludeTools ?? [],
    memory: t.memory ?? "off",
    agentEngine: t.agentEngine === true,
    adminTools: t.adminTools ?? "off",
    packages: t.packages ?? [],
    envNames: t.envNames ?? [],
    repos: t.repos ?? [],
    missingEnv: missingEnv(t, env),
    allowExternalHtmlResources: t.allowExternalHtmlResources === true,
    cloudOnly: CLOUD_ONLY_FIELDS.filter((k) => t[k] !== undefined && t[k] !== false).map((k) => ({ field: k, value: t[k] })),
    updatedAt: t.updatedAt,
    hash: tapeHash(t),
    summary: summaryLines(t, env),
    systemPrompt: t.systemPrompt ?? "",
    appendSystemPrompt: t.appendSystemPrompt ?? "",
    systemPromptHtml: t.systemPrompt ? markdownToHtml(t.systemPrompt) : "",
    appendSystemPromptHtml: t.appendSystemPrompt ? markdownToHtml(t.appendSystemPrompt) : "",
  };
}

function pinView(p: Pin | undefined) {
  return p ? { hash: p.hash, short: shortHash(p.hash), pinnedAt: p.pinnedAt, cloudUpdatedAt: p.tape.updatedAt, seen: p.seen } : null;
}

function ownPackages(settings: Record<string, unknown>): string[] {
  return ((settings.packages as unknown[] | undefined) ?? []).filter((p): p is string => typeof p === "string");
}

function memoryView(settings: Record<string, unknown>, env: NodeJS.ProcessEnv, dongle: boolean) {
  const k = (settings.kernal ?? {}) as Record<string, unknown>;
  const setting = ["off", "tool", "auto"].includes(k.memory as string) ? (k.memory as string) : undefined;
  return { setting: setting ?? "default", mode: dongle ? (setting ?? "auto") : "off", record: k.memoryRecord === true, dongle, tape: playing(env)?.id };
}

export function createTapeApi(d: TapeAdminDeps): Record<string, (body: any, query: URLSearchParams) => Promise<Result>> {
  const env = () => d.env ?? process.env;
  const settings = () => (d.settings ?? readSettings)();
  const write = d.writeSettings ?? ((change) => updateSettings(change as any));
  const setKernal = (patch: Record<string, unknown>) =>
    write((s) => {
      const k = s.kernal && typeof s.kernal === "object" && !Array.isArray(s.kernal) ? s.kernal : {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete k[key];
        else k[key] = value;
      }
      s.kernal = k;
    });
  const fetchTape = d.transport ? transportFetch(d.transport) : undefined;
  const validId = (id: unknown): id is string => typeof id === "string" && TAPE_ID.test(id);
  const here = () => (d.repo ?? ((c: string) => repoInfo(c)))((d.cwd ?? (() => process.cwd()))()).catch(() => ({ note: "repo unknown" }) as { repo?: string; note?: string });

  return {
    "GET /tapes": async () => {
      const pins = listPins(d.dir);
      const byId = new Map(pins.map((p) => [p.tape.id, p]));
      const cloud = d.transport ? await listCloudTapes(d.transport) : { ok: false as const, error: "no Dongle: set OUTFITTER_API and OUTFITTER_TOKEN in Connections or your .env" };
      const rows = (cloud.ok ? cloud.tapes : []).map((t) => {
        const pin = byId.get(t.id);
        byId.delete(t.id);
        const changed = !!pin && !!t.updatedAt && t.updatedAt !== pin.tape.updatedAt;
        const kept = changed && pin?.seen?.kept === true && pin.seen.updatedAt === t.updatedAt;
        return { ...t, pin: pinView(pin), state: !pin ? "unpinned" : changed ? (kept ? "kept" : "changed") : "pinned" };
      });
      // Pinned here but not in the list: offline, or gone from the cloud.
      for (const pin of byId.values()) rows.push({ id: pin.tape.id, name: pin.tape.name, model: pin.tape.model, updatedAt: pin.tape.updatedAt, pin: pinView(pin), state: cloud.ok ? "gone" : "pinned" } as any);
      return {
        body: {
          connected: cloud.ok,
          cloudError: cloud.ok ? undefined : cloud.error,
          active: activeTape(settings()) ?? null,
          playing: playing(env()) ?? null,
          tapes: rows,
          memory: memoryView(settings(), env(), !!d.transport),
          repo: await here(),
          dir: d.dir,
        },
      };
    },

    "GET /tapes/tape": async (_b, q) => {
      const id = q.get("id") ?? "";
      if (!validId(id)) return fail(400, "not a tape id");
      const pin = readPin(d.dir, id);
      const cloud = fetchTape ? await fetchTape(id) : { ok: false as const, error: "no Dongle" };
      if (!cloud.ok && !pin) return fail(404, `tape ${id}: ${cloud.error}`);
      const shown = cloud.ok ? cloud.tape : pin!.tape;
      const cloudHash = cloud.ok ? tapeHash(cloud.tape) : undefined;
      const state = !pin ? "unpinned" : !cloud.ok ? "offline" : cloudHash === pin.hash ? "pinned" : pin.seen?.kept && pin.seen.hash === cloudHash ? "kept" : "changed";
      const npmDir = tapeNpmDir(d.dir, id);
      const plan = packagePlan(pin?.tape ?? shown, npmDir, ownPackages(settings()));
      return {
        body: {
          state,
          cloudError: cloud.ok ? undefined : cloud.error,
          cloud: cloud.ok ? view(cloud.tape, env()) : null,
          pinned: pin ? { ...pinView(pin), tape: view(pin.tape, env()) } : null,
          changes: pin && cloud.ok && cloudHash !== pin.hash ? diffTapes(pin.tape, cloud.tape) : [],
          packages: { ready: plan.ready.map((p) => p.spec), missing: plan.missing.map((p) => p.spec), builtin: plan.builtin, refused: plan.refused, dir: npmDir },
          active: activeTape(settings()) === id,
          playing: playing(env())?.id === id,
          repo: await here().then((r) => ({ ...r, warning: repoWarning(shown, r.repo) })),
        },
      };
    },

    "POST /tapes/pin": async (body: { id?: unknown; hash?: unknown }) => {
      if (!validId(body.id) || typeof body.hash !== "string") return fail(400, "id and hash are required");
      if (!fetchTape) return fail(409, "no Dongle: pinning needs the cloud version");
      const cloud = await fetchTape(body.id);
      if (!cloud.ok) return fail(502, cloud.error);
      if (tapeHash(cloud.tape) !== body.hash) return fail(409, "the tape changed in the cloud again since this page loaded; review the new version");
      const pin = writePin(d.dir, cloud.tape);
      return { body: { message: `Pinned ${cloud.tape.id} at ${shortHash(pin.hash)}.`, pin: pinView(pin) } };
    },

    "POST /tapes/keep": async (body: { id?: unknown; hash?: unknown }) => {
      if (!validId(body.id) || typeof body.hash !== "string") return fail(400, "id and hash are required");
      const pin = readPin(d.dir, body.id);
      if (!pin) return fail(409, "this tape isn't pinned");
      if (!fetchTape) return fail(409, "no Dongle");
      const cloud = await fetchTape(body.id);
      if (!cloud.ok) return fail(502, cloud.error);
      if (tapeHash(cloud.tape) !== body.hash) return fail(409, "the tape changed in the cloud again since this page loaded; review the new version");
      noteSeen(d.dir, pin, cloud.tape, true);
      return { body: { message: `Kept the pinned version ${shortHash(pin.hash)} of ${body.id}.` } };
    },

    "POST /tapes/play": async (body: { id?: unknown }) => {
      if (body.id === null || body.id === "" || body.id === undefined) {
        setKernal({ tape: undefined });
        return { body: { message: "New sessions play no tape. A session playing one keeps it until /tape off or a restart." } };
      }
      if (!validId(body.id)) return fail(400, "not a tape id");
      if (!readPin(d.dir, body.id)) return fail(409, "pin the tape first: it only plays in a version you reviewed");
      setKernal({ tape: body.id });
      return { body: { message: `New sessions play ${body.id}. To play it in this session, run /tape ${body.id} in Kernal (it restarts into the same session).` } };
    },

    "POST /tapes/install": async (body: { id?: unknown }) => {
      if (!validId(body.id)) return fail(400, "not a tape id");
      const pin = readPin(d.dir, body.id);
      if (!pin) return fail(409, "pin the tape first");
      const npmDir = tapeNpmDir(d.dir, body.id);
      const plan = packagePlan(pin.tape, npmDir, ownPackages(settings()));
      if (!plan.missing.length) return { body: { message: "Nothing to install." } };
      if (!d.run) return fail(503, "installing is not available here");
      const res = await installPackages(plan.missing, npmDir, d.run);
      if (!res.ok) return fail(502, `npm install failed: ${res.output.split("\n").slice(-6).join(" ").slice(0, 400)}`);
      return { body: { message: `Installed ${plan.missing.map((p) => p.spec).join(", ")} (install scripts off). They load from the next start that plays ${body.id}.` } };
    },

    "POST /tapes/memory": async (body: { memory?: unknown; record?: unknown }) => {
      const patch: Record<string, unknown> = {};
      if (body.memory !== undefined) {
        if (!["off", "tool", "auto", "default"].includes(body.memory as string)) return fail(400, "memory is off, tool, auto or default");
        patch.memory = body.memory === "default" ? undefined : body.memory;
      }
      if (body.record !== undefined) {
        if (typeof body.record !== "boolean") return fail(400, "record is true or false");
        patch.memoryRecord = body.record ? true : undefined;
      }
      if (!Object.keys(patch).length) return fail(400, "nothing to change");
      setKernal(patch);
      return { body: { message: "Saved. Memory settings apply when Kernal next starts.", memory: memoryView(settings(), env(), !!d.transport) } };
    },
  };
}
