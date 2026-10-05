// Central settings, CA-3 (#392, docs/specs/central-auth.md §3.4-§3.5): GET /api/config, the schema,
// profiles and versioned writes. Owned by task C. Registered once from routes/index.ts on every
// role (web: IAP people; link: device tokens and, until CA-10, Dongles); the fleet write
// (PUT /api/operator/config/fleet) only where operators exist (web, all).
//
// Every editable document answers with `ETag: W/"<version>"` and every write needs the matching
// `If-Match` (version 0: the document doesn't exist yet). A stale write is a 409 carrying the
// current document, never a silent overwrite. A Dongle reads (GET /api/config, the schema) and
// never writes: settings belong to a signed-in Kernal or a person on the web.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Identity } from "../auth.ts";
import { requireOperator } from "../auth.ts";
import { SENTRY_KEY_PREFIX, parseSentryUpdate, updateFleetSettings, withDefaults, type FleetSettings, type SentryFleetSettings } from "../fleet-settings.ts";
import { resolveConfig, UnknownProfileError } from "../central/settings-resolver.ts";
import {
  MAX_PROFILES,
  PROFILE_NAME_RE,
  applyValuePatch,
  parseValueWrite,
  publicSchema,
  type SettingValue,
  type SettingsDocView,
} from "../central/settings-schema.ts";
import { settingsDocId, type SettingsDoc } from "../store/settings.ts";
import { userIdFor } from "../central/user-id.ts";
import { modelOptions } from "../central/model-options.ts";

/** A Dongle: a token that is not a device login. */
function isDongle(identity: Identity): boolean {
  return identity.viaToken === true && !identity.deviceId;
}

/** `W/"5"` or `"5"` → 5; anything else → undefined. */
export function parseIfMatch(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const m = raw?.trim().match(/^(?:W\/)?"(\d{1,15})"$/);
  return m ? Number(m[1]) : undefined;
}

function etag(version: number): string {
  return `W/"${version}"`;
}

export function docView(doc: SettingsDoc): SettingsDocView {
  return {
    id: doc.id,
    level: doc.level,
    ...(doc.name !== undefined ? { name: doc.name } : {}),
    ...(doc.level === "profile" ? { isDefault: doc.isDefault === true } : {}),
    values: doc.values,
    version: doc.version,
    updatedAt: doc.updatedAt,
  };
}

/** The fleet document as a level view: `values` plus the Sentry keys as stored (the DSN is shown
 * while Sentry is off too, like the operator's own GET). #424's signals are stored only while on,
 * so a signal that is off is absent here, which reads as its default (off). */
export function fleetView(fleet: FleetSettings): SettingsDocView {
  const s = fleet.telemetry.sentry;
  return {
    id: "fleet",
    level: "fleet",
    values: {
      ...(fleet.values ?? {}),
      "telemetry.sentry.enabled": s.enabled,
      ...(s.dsn ? { "telemetry.sentry.dsn": s.dsn } : {}),
      "telemetry.sentry.tracesSampleRate": s.tracesSampleRate,
      ...(s.logs ? { "telemetry.sentry.logs": true } : {}),
      ...(s.metrics ? { "telemetry.sentry.metrics": true } : {}),
      ...(s.agentTraces ? { "telemetry.sentry.agentTraces": true } : {}),
      ...(s.agentContent ? { "telemetry.sentry.agentContent": true } : {}),
      ...(s.profilesSampleRate ? { "telemetry.sentry.profilesSampleRate": s.profilesSampleRate } : {}),
    },
    version: fleet.version ?? 0,
    ...(fleet.updatedAt ? { updatedAt: fleet.updatedAt } : {}),
  };
}

/** An empty view for a user or device document no one has written yet. */
function emptyView(id: string, level: "user" | "device"): SettingsDocView {
  return { id, level, values: {}, version: 0 };
}

export async function registerConfigRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const store = ctx.store;

  /** 403 for a Dongle (reads of GET /api/config and the schema are the only things it may do). */
  const refuseDongle = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isDongle(req.identity!)) return false;
    reply.code(403).send({ error: "a Dongle can't change settings: run kernal login" });
    return true;
  };

  /** The If-Match version, or a 428 already sent. */
  const ifMatch = (req: FastifyRequest, reply: FastifyReply): number | undefined => {
    const version = parseIfMatch(req.headers["if-match"]);
    if (version === undefined) reply.code(428).send({ error: "if_match_required" });
    return version;
  };

  const stale = (reply: FastifyReply, current: SettingsDocView | null) => reply.code(409).send({ error: "stale_version", current });

  const ownActiveDevice = async (email: string, deviceId: string): Promise<boolean> =>
    (await store.devices.listActiveForOwner(email)).some((d) => d.id === deviceId);

  const profileNames = async (userId: string): Promise<string[]> => (await store.settings.listProfiles(userId)).map((p) => p.name!);

  /** Shared body of every value PUT on a stored level (§3.5): If-Match, validation, merge, versioned put. */
  const writeValues = async (
    req: FastifyRequest,
    reply: FastifyReply,
    level: "user" | "profile" | "device",
    id: string,
    fresh: () => Omit<SettingsDoc, "values" | "version" | "createdAt" | "updatedAt" | "updatedBy"> | null,
  ) => {
    const expected = ifMatch(req, reply);
    if (expected === undefined) return reply;
    const parsed = parseValueWrite(level, req.body, { allowHttp: ctx.config.devMode });
    if ("error" in parsed) return reply.code(400).send(parsed);
    const current = await store.settings.get(id);
    if (!current && level === "profile") return reply.code(404).send({ error: "unknown_profile", profiles: await profileNames(userIdFor(req.identity!.email)) });
    if ((current?.version ?? 0) !== expected) return stale(reply, current ? docView(current) : null);
    const now = new Date().toISOString();
    const base = current ?? { ...fresh()!, createdAt: now };
    const next: SettingsDoc = { ...base, values: applyValuePatch(current?.values ?? {}, parsed.patch), version: expected, updatedAt: now, updatedBy: req.identity!.email };
    const res = await store.settings.put(next, expected);
    if (!res.ok) return stale(reply, res.current ? docView(res.current) : null);
    req.log.info({ settingsDoc: id, keys: Object.keys(parsed.patch), version: res.doc.version }, "central settings write");
    reply.header("etag", etag(res.doc.version));
    return docView(res.doc);
  };

  // ---------- reads any signed-in caller may make ----------

  app.get("/api/config/schema", async () => publicSchema());

  app.get("/api/config", async (req, reply) => {
    const identity = req.identity!;
    const q = req.query as { profile?: unknown; device?: unknown };
    const profile = typeof q.profile === "string" && q.profile !== "" ? q.profile : undefined;
    let deviceId = typeof q.device === "string" && q.device !== "" ? q.device : undefined;
    if (identity.deviceId) {
      // A signed-in Kernal reads its own device's settings and nobody else's.
      if (deviceId && deviceId !== identity.deviceId) return reply.code(403).send({ error: "another device's settings" });
      deviceId = identity.deviceId;
    } else if (deviceId && !(await ownActiveDevice(identity.email, deviceId))) {
      return reply.code(404).send({ error: "device not found" });
    }
    const fleet = withDefaults(await store.fleetSettings.get());
    try {
      reply.header("cache-control", "no-store");
      return await resolveConfig(store, fleet, {
        email: identity.email,
        ...(profile ? { profile } : {}),
        ...(deviceId ? { deviceId } : {}),
        allowHttp: ctx.config.devMode,
      });
    } catch (err) {
      if (err instanceof UnknownProfileError) return reply.code(404).send({ error: "unknown_profile", profiles: err.profiles });
      throw err;
    }
  });

  // #458: the models the Account page's dropdowns offer for model.default and
  // compaction.summaryModel, per provider: the router's (cached by ModelsService) and the curated
  // OpenRouter list for this person (and `profile`, when named). Options only: writes are still
  // validated by type, so an unlisted model can still be saved.
  app.get("/api/config/models", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const q = req.query as { profile?: unknown };
    const profile = typeof q.profile === "string" && q.profile !== "" ? q.profile : undefined;
    const fleet = withDefaults(await store.fleetSettings.get());
    try {
      const [router, resolved] = await Promise.all([
        ctx.modelsService.list(),
        resolveConfig(store, fleet, { email: req.identity!.email, ...(profile ? { profile } : {}), allowHttp: ctx.config.devMode }),
      ]);
      reply.header("cache-control", "no-store");
      return modelOptions(router, resolved.values);
    } catch (err) {
      if (err instanceof UnknownProfileError) return reply.code(404).send({ error: "unknown_profile", profiles: err.profiles });
      throw err;
    }
  });

  // ---------- the user level ----------

  app.get("/api/config/user", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const id = settingsDocId("user", userIdFor(req.identity!.email));
    const doc = await store.settings.get(id);
    const view = doc ? docView(doc) : emptyView(id, "user");
    reply.header("etag", etag(view.version));
    return view;
  });

  app.put("/api/config/user", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const userId = userIdFor(req.identity!.email);
    return writeValues(req, reply, "user", settingsDocId("user", userId), () => ({ id: settingsDocId("user", userId), level: "user", userId }));
  });

  // ---------- profiles ----------

  app.get("/api/config/profiles", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    return (await store.settings.listProfiles(userIdFor(req.identity!.email))).map(docView);
  });

  app.post("/api/config/profiles", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const body = req.body as { name?: unknown; copyFrom?: unknown } | null;
    const name = body?.name;
    if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) return reply.code(400).send({ error: "invalid_name" });
    if (body?.copyFrom !== undefined && typeof body.copyFrom !== "string") return reply.code(400).send({ error: "invalid_request" });
    const userId = userIdFor(req.identity!.email);
    const existing = await store.settings.listProfiles(userId);
    if (existing.some((p) => p.name === name)) return reply.code(409).send({ error: "profile_exists" });
    if (existing.length >= MAX_PROFILES) return reply.code(400).send({ error: "too_many_profiles", max: MAX_PROFILES });
    let values: Record<string, SettingValue> = {};
    if (typeof body?.copyFrom === "string") {
      const source = existing.find((p) => p.name === body.copyFrom);
      if (!source) return reply.code(404).send({ error: "unknown_profile", profiles: existing.map((p) => p.name!) });
      values = { ...source.values };
    }
    const now = new Date().toISOString();
    const id = settingsDocId("profile", userId, name);
    const res = await store.settings.put({ id, level: "profile", userId, name, values, version: 0, createdAt: now, updatedAt: now, updatedBy: req.identity!.email }, 0);
    if (!res.ok) return reply.code(409).send({ error: "profile_exists" });
    reply.code(201).header("etag", etag(res.doc.version));
    return docView(res.doc);
  });

  app.get("/api/config/profiles/:name", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const { name } = req.params as { name: string };
    const userId = userIdFor(req.identity!.email);
    const doc = PROFILE_NAME_RE.test(name) ? await store.settings.get(settingsDocId("profile", userId, name)) : null;
    if (!doc) return reply.code(404).send({ error: "unknown_profile", profiles: await profileNames(userId) });
    reply.header("etag", etag(doc.version));
    return docView(doc);
  });

  app.put("/api/config/profiles/:name", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const { name } = req.params as { name: string };
    const userId = userIdFor(req.identity!.email);
    if (!PROFILE_NAME_RE.test(name)) return reply.code(404).send({ error: "unknown_profile", profiles: await profileNames(userId) });
    return writeValues(req, reply, "profile", settingsDocId("profile", userId, name), () => null);
  });

  // Rename and/or make default. A rename writes the new document first (refused when the name is
  // taken), then deletes the old one at the If-Match version; a stale delete undoes the copy.
  app.patch("/api/config/profiles/:name", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const { name } = req.params as { name: string };
    const body = req.body as { rename?: unknown; isDefault?: unknown } | null;
    const rename = body?.rename;
    if (rename !== undefined && (typeof rename !== "string" || !PROFILE_NAME_RE.test(rename))) return reply.code(400).send({ error: "invalid_name" });
    if (body?.isDefault !== undefined && body.isDefault !== true) return reply.code(400).send({ error: "invalid_request" });
    if (rename === undefined && body?.isDefault === undefined) return reply.code(400).send({ error: "invalid_request" });
    const expected = ifMatch(req, reply);
    if (expected === undefined) return reply;
    const userId = userIdFor(req.identity!.email);
    const id = settingsDocId("profile", userId, name);
    const current = PROFILE_NAME_RE.test(name) ? await store.settings.get(id) : null;
    if (!current) return reply.code(404).send({ error: "unknown_profile", profiles: await profileNames(userId) });
    if (current.version !== expected) return stale(reply, docView(current));

    const now = new Date().toISOString();
    const makeDefault = body?.isDefault === true || current.isDefault === true;
    let doc: SettingsDoc;
    if (typeof rename === "string" && rename !== name) {
      const newId = settingsDocId("profile", userId, rename);
      const created = await store.settings.put(
        { ...current, id: newId, name: rename, ...(makeDefault ? { isDefault: true } : {}), version: 0, updatedAt: now, updatedBy: req.identity!.email },
        0,
      );
      if (!created.ok) return reply.code(409).send({ error: "profile_exists" });
      const removed = await store.settings.delete(id, expected);
      if (!removed.ok) {
        await store.settings.delete(newId, created.doc.version);
        return stale(reply, removed.current ? docView(removed.current) : null);
      }
      doc = created.doc;
    } else {
      const res = await store.settings.put({ ...current, ...(makeDefault ? { isDefault: true } : {}), updatedAt: now, updatedBy: req.identity!.email }, expected);
      if (!res.ok) return stale(reply, res.current ? docView(res.current) : null);
      doc = res.doc;
    }
    if (body?.isDefault === true) {
      await store.settings.setDefaultProfile(userId, doc.name!);
      doc = (await store.settings.get(doc.id)) ?? doc;
    }
    req.log.info({ settingsDoc: doc.id, renamedFrom: rename ? name : undefined, isDefault: doc.isDefault === true }, "central settings profile change");
    reply.header("etag", etag(doc.version));
    return docView(doc);
  });

  app.delete("/api/config/profiles/:name", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const expected = ifMatch(req, reply);
    if (expected === undefined) return reply;
    const { name } = req.params as { name: string };
    const userId = userIdFor(req.identity!.email);
    const res = PROFILE_NAME_RE.test(name) ? await store.settings.delete(settingsDocId("profile", userId, name), expected) : { ok: false as const, current: null };
    if (!res.ok) {
      if (!res.current) return reply.code(404).send({ error: "unknown_profile", profiles: await profileNames(userId) });
      return stale(reply, docView(res.current));
    }
    return reply.code(204).send();
  });

  // ---------- the device level (the caller's own active devices) ----------

  app.get("/api/config/devices/:deviceId", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const { deviceId } = req.params as { deviceId: string };
    if (!(await ownActiveDevice(req.identity!.email, deviceId))) return reply.code(404).send({ error: "device not found" });
    const id = settingsDocId("device", deviceId);
    const doc = await store.settings.get(id);
    const view = doc ? docView(doc) : emptyView(id, "device");
    reply.header("etag", etag(view.version));
    return view;
  });

  app.put("/api/config/devices/:deviceId", async (req, reply) => {
    if (refuseDongle(req, reply)) return reply;
    const { deviceId } = req.params as { deviceId: string };
    if (!(await ownActiveDevice(req.identity!.email, deviceId))) return reply.code(404).send({ error: "device not found" });
    const id = settingsDocId("device", deviceId);
    return writeValues(req, reply, "device", id, () => ({ id, level: "device", userId: userIdFor(req.identity!.email), deviceId }));
  });

  // ---------- the fleet level (operators; never on link) ----------

  if (ctx.config.role === "link") return;

  app.get("/api/operator/config/fleet", { preHandler: requireOperator }, async (_req, reply) => {
    const view = fleetView(withDefaults(await store.fleetSettings.get()));
    reply.header("etag", etag(view.version));
    return view;
  });

  // Every key whose levels include fleet. The Sentry keys go into `telemetry.sentry` with
  // parseSentryUpdate's rules (a DSN to turn it on); the rest into `values`. This instance applies
  // the change at once (ctx.fleetSettings.set), like PUT /api/operator/fleet-settings.
  app.put("/api/operator/config/fleet", { preHandler: requireOperator }, async (req, reply) => {
    const expected = ifMatch(req, reply);
    if (expected === undefined) return reply;
    const parsed = parseValueWrite("fleet", req.body, { allowHttp: ctx.config.devMode });
    if ("error" in parsed) return reply.code(400).send(parsed);
    const sentryPatch = Object.entries(parsed.patch).filter(([key]) => key.startsWith(SENTRY_KEY_PREFIX));
    const otherPatch = Object.fromEntries(Object.entries(parsed.patch).filter(([key]) => !key.startsWith(SENTRY_KEY_PREFIX)));

    const current = withDefaults(await store.fleetSettings.get());
    if ((current.version ?? 0) !== expected) return stale(reply, fleetView(current));
    let sentry: SentryFleetSettings = current.telemetry.sentry;
    if (sentryPatch.length > 0) {
      const merged: Record<string, unknown> = { ...current.telemetry.sentry };
      for (const [key, value] of sentryPatch) {
        const field = key.slice(SENTRY_KEY_PREFIX.length);
        if (value === null) delete merged[field];
        else merged[field] = value;
      }
      if (merged.enabled === undefined) merged.enabled = false;
      const checked = parseSentryUpdate({ telemetry: { sentry: merged } }, { allowHttp: ctx.config.devMode });
      if ("error" in checked) return reply.code(400).send({ error: "invalid_value", key: sentryErrorKey(checked.error), message: checked.error });
      sentry = checked.value;
    }

    const written = await updateFleetSettings(
      store,
      (cur) => {
        const values = applyValuePatch(cur.values ?? {}, otherPatch);
        const { values: _old, ...rest } = cur;
        return {
          ...rest,
          ...(Object.keys(values).length > 0 ? { values } : {}),
          telemetry: { sentry },
          updatedAt: new Date().toISOString(),
          updatedBy: req.identity!.email,
        };
      },
      expected,
    );
    if (!written.ok) return stale(reply, fleetView(written.current));
    ctx.fleetSettings.set(written.settings);
    req.log.info({ operator: req.identity!.email, keys: Object.keys(parsed.patch), version: written.settings.version }, "operator central fleet settings write");
    const view = fleetView(written.settings);
    reply.header("etag", etag(view.version));
    return view;
  });
}

/** Which Sentry key a parseSentryUpdate message is about. */
function sentryErrorKey(message: string): string {
  const named = /telemetry\.sentry\.(logs|metrics|agentTraces|agentContent|profilesSampleRate)\b/.exec(message);
  if (named) return named[0];
  if (message.includes("tracesSampleRate")) return "telemetry.sentry.tracesSampleRate";
  if (/dsn/i.test(message)) return "telemetry.sentry.dsn";
  return "telemetry.sentry.enabled";
}
