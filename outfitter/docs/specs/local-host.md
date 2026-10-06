# Local Host wave 2: the contract

Epic #378 (children #381-#384 in this wave). Status: contract. Three tasks build against this
document at the same time, so each section names its owner and every shape here is binding. A task
that needs to change a shape changes this file in its own PR and says so in the PR body under
"Contract changes"; the owners of the affected tasks review it.

Related: docs/specs/central-auth.md (device login, central settings, router keys: #389),
docs/specs/drive-previews.md (the ngrok pattern this reuses: #217).

## 0. Summary

- **Kernal service (task C, #381).** `kernal local enable` installs a LaunchAgent (systemd user unit
  on Linux) that runs `kernal local run`: discovery every 15 s on the laptop (no network), a tunnel
  to one model server while sharing is on and a server answers, and a heartbeat to Outfitter when
  something changes or every 5 minutes.
- **Registry (task A, #382).** `POST /api/local-hosts/heartbeat` on the link role, device tokens
  only, keeps one `localHosts` record per person per machine. A host is online, offline,
  not-sharing, stale (3 missed heartbeats) or revoked. `GET /api/local-hosts` lists the caller's own
  hosts and everyone's shared ones, with no secrets.
- **Tunnel credentials (task A, #383).** `POST /api/local-hosts/tunnel-credentials` hands the host
  an ngrok credential that can bind only `https://lh<hex>.internal`, plus a per-host bearer. The api
  alone makes the public cloud endpoint `https://lh-<random>.<LOCAL_HOST_DOMAIN>`, whose traffic
  policy allows only the four inference paths, checks the bearer and rate-limits.
- **Router (task B, #384).** Each model on an online, managed host becomes a LiteLLM deployment
  `local/<user>-<host>/<model-id>` pointing at the cloud endpoint with the bearer. Changes arrive
  through an events seam (`local-hosts/events.ts`); the tick re-reconciles everything, with
  `model_info.metadata` on the router as the source of truth.
- **Access (owner decision 2026-10-05).** Everyone signed in may use shared models, and Drives may
  too, under the same rule. Every local model is in the LiteLLM access group `local-hosts`; a fleet
  `router.keys.models` restriction gets that group appended (§3.6). The `accessGroup` field on each
  host is reserved, always `everyone` in this wave.

Terms: **host** a machine sharing its local models (one record per person per machine); **model
server** LM Studio, Ollama, llama.cpp, mlx-lm or vLLM on that machine; **managed** a tunnel running
on Outfitter's credentials (as opposed to interim `.env` ones).

JSON conventions as central-auth.md: camelCase, ISO-8601 UTC times, error bodies
`{ "error": "<code>", ... }`.

Shipped building blocks this builds on (do not rewrite them):

| Block | Where | Used by |
|---|---|---|
| Device login, `identity.deviceId`, `outfitterBearer` | `api/src/auth.ts`, `api/src/central/device-tokens.ts`; `kernal/.pi/extensions/_shared/outfitter-session.ts`, `outfitter-env.ts` | A (route auth), C |
| Device lifecycle hooks (`onRevoked`) | `api/src/central/device-lifecycle.ts` | A |
| User id `u_...` | `api/src/central/user-id.ts` | A, B |
| Central settings, `localHost.shareModels` | `api/src/central/settings-schema.ts`; `kernal/.pi/extensions/_shared/central-config.ts` (`refreshConfig`, `getValue`) | C |
| Discovery snapshot and `key` | `kernal/.pi/extensions/_shared/local-discovery.ts` (#456) | C (and the heartbeat body) |
| Tunnel provider, guard proxy, `interimCredentialsFromEnv`, `parseTunnelChoice` | `kernal/.pi/extensions/_shared/tunnel/` (#457) | C |
| ngrok API client, fake | `api/src/ngrok-api.ts`, `api/test/fake-ngrok.ts` | A |
| Drive-preview pattern (credential ACL + api-written cloud endpoint, metadata-stamped sweep) | `api/src/previews.ts` | A |
| Scoped router keys minted by `deploy/litellm-admin.sh` (`outfitter-svc`, `allowed_routes`); B gets its own key, `LOCAL_HOST_ROUTER_KEY` (§3.5), not `LITELLM_ADMIN_KEY` | `deploy/litellm-admin.sh`, `deploy/test/litellm-admin.test.sh`, `api/src/central/litellm-keys.ts` | B |
| LaptopProbe, E2.8 preflight | `api/src/laptop.ts`, `api/src/agentlink.ts` (`resolveRunModel`) | A |

## 1. Host registry and heartbeat (task A, #382)

### 1.1 Auth and roles

| Route | Role | Caller |
|---|---|---|
| `POST /api/local-hosts/heartbeat` | link, all | device token only |
| `POST /api/local-hosts/tunnel-credentials` | link, all | device token only |
| `GET /api/local-hosts` | every role | a person under IAP (web), or a device token (link) |
| `DELETE /api/local-hosts/:id` | every role | the host's owner (person or device token); an operator on web |

- No device id on the identity (a Dongle, a personal API token, IAP on a POST route): **403**
  `{ "error": "device_token_required" }`.
- The device record is gone or revoked: **404** `{ "error": "device not found" }`. A machine token
  (CI, `device.kind === "machine"`): **403** `{ "error": "machine_token" }`. Same helpers as
  `routes/keys.ts` (`refuseNonDevice`, `deviceOrRefuse`); A copies them into its route file, it
  doesn't import keys.ts's private functions.
- Who may share (owner decision): anyone signed in. No allow-list beyond the login's own.
- Bodies over `MAX_BODY_BYTES` (256 KiB): **413** (Fastify `bodyLimit` on the two POST routes).
- Rate limit: none in wave 2 beyond what the cadence produces (§1.4); A may add a per-device
  in-memory floor of one heartbeat per 5 s (answer **429** `{ "error": "too_many_heartbeats",
  "retryAfterSeconds": n }`).

### 1.2 `POST /api/local-hosts/heartbeat`: request

Types: `api/src/local-hosts/contract.ts` `HeartbeatRequest` (spec-owned).

```json
{
  "hostId": "h_3f9c0a1b2c3d4e5f60718293",
  "hostName": "Matthews-MacBook-Pro",
  "kernalVersion": "0.4.1",
  "platform": "darwin-arm64",
  "shareModels": true,
  "discoveryKey": "9a1c2e3f4b5d6a7c",
  "servers": [
    { "id": "http://localhost:1234", "kind": "lmstudio", "baseUrl": "http://localhost:1234/v1", "ok": true,
      "endpoints": ["/api/v0/models", "/v1/models"], "models": 2 }
  ],
  "models": [
    { "id": "qwen/qwen3-coder-30b", "server": "http://localhost:1234", "kind": "lmstudio", "loaded": true,
      "listed": true, "contextLength": 32768, "maxContextLength": 262144, "loadedContextLength": 32768,
      "type": "llm", "toolUse": true, "quantization": "4bit" }
  ],
  "tunnel": { "provider": "ngrok", "managed": true, "state": "up",
              "url": "https://lh3f9c0a1b2c3d4e5f60718293.internal", "server": "http://localhost:1234",
              "credentialId": "cr_2abc..." },
  "reason": "change"
}
```

- `servers`, `models`: exactly `DiscoverySnapshot.servers` / `.models` from
  `discoverLocalModels()`; `discoveryKey` is its `key`. The api keeps the fields listed in
  `HeartbeatServer` / `HeartbeatModel` and drops anything else.
- `tunnel.state`: `up` | `down` | `stopped` | `off` (`off`: the service runs none). `tunnel.server`
  is the one model server the tunnel forwards to (§4.6); `tunnel.url` the URL the agent bound;
  `tunnel.credentialId` the id from the credentials answer (managed only).
- `reason`: `start` | `change` | `interval` | `stop`.

Validation (A; anything failing is **400** `{ "error": "invalid_heartbeat", "field": "<path>" }`):
`hostId` matches `^h_[0-9a-f]{24}$`; `hostName` 1-64 printable characters (trimmed, control
characters refused); `kernalVersion` ≤ 32, `platform` ≤ 32; `servers` ≤ 16 and `models` ≤ 256
entries; strings ≤ 512; numbers finite and ≥ 0; `kind` one of the six `ServerKind`s;
`tunnel.provider` `ngrok` | `cloudflare`. Server URLs are stored as text and **never fetched** by the
api. A model whose id isn't routable (`naming.ts routableModelId`) is kept (it shows in the listing)
but gets no router entry, and the answer's `problems` says `model id not routable: <first 60 chars>`.

### 1.3 Heartbeat: what the api does, and the answer

1. `userId = userIdFor(identity.email)`, `id = localHostId(userId, hostId)` (`naming.ts`).
2. Load the record. **New** record: `routerPrefix` = the first of
   `routerPrefixCandidates(email, hostName, id)` that is free under §3.1's user-aware rule (upsert
   throws `LocalHostPrefixTakenError` on a race: try the next); `accessGroup: "everyone"`;
   `createdAt`. **Existing** (a tombstone from §1.8 included): `routerPrefix`, `accessGroup`,
   `managed`, `lastBearerVersion`, `createdAt` are kept; `deviceId` becomes the caller's device (a
   re-login on the same machine takes the host over), and `revokedAt` and `deletedAt` are cleared (a
   revoked device's tokens no longer work, so any accepted heartbeat comes from a newer login). A
   clears a field by unsetting it, never by storing `undefined`/`null` (the Mongo client keeps
   `undefined` as `null`, and `listSharing` filters on the field being absent).
3. Write `hostName`, `kernalVersion`, `platform`, `shareModels`, `discoveryKey`, `servers`, `models`,
   `tunnel`, `updatedAt`, `lastSeenAt` = now.
4. If `routerFingerprint(previous) !== routerFingerprint(next)` (or there was no previous record):
   `await ctx.localHostEvents.changed({ reason: "heartbeat", host: next, previous })` and add its
   `problems` to the answer.
5. `shareModels: false` on a record that has `managed.endpointId`: delete the cloud endpoint now
   (§2.5) and unset `endpointId`/`publicUrl` (the credential stays; turning sharing back on makes a
   new endpoint on the next credentials call).

**200** `HeartbeatResponse`:

```json
{
  "accepted": true,
  "id": "lh_8d0b7c6a5e4f3a2b1c0d9e8f",
  "status": "online",
  "nextHeartbeatSeconds": 300,
  "credentials": "current",
  "routerPrefix": "mgm-matthews-macbook-pro",
  "routerModels": ["local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b"],
  "problems": []
}
```

- `status`: `hostStatus(next)` (§1.5).
- `nextHeartbeatSeconds`: `HEARTBEAT_INTERVAL_SECONDS` (300).
- `routerModels`: `routerModelName(routerPrefix, m.id)` for each routable model in
  `sharedModels(next)`, when status is `online` and `tunnel.managed`; else `[]`. It is what task B
  will register, computed here from the same functions, not read back from the router.
- `credentials` (`CredentialsHint`), first match wins:
  1. `none`: `shareModels` false. (A revoked record never gets here: the revoked device's tokens
     are refused in §1.1, and a newer login's heartbeat clears `revokedAt` in step 2.)
  2. `unavailable`: no `ctx.localHostNgrok` or no `config.localHostDomain`.
  3. `fetch`: no `managed`, or no `managed.endpointId`, or `tunnel.managed` with
     `tunnel.credentialId !== managed.credentialId`.
  4. `current`.

### 1.4 Cadence (task C sends, task A expects)

- Discovery runs every **15 s** locally; it costs no network beyond localhost.
- A heartbeat goes out when any of these changed since the last one that was answered 200:
  `discoveryKey`, `shareModels`, `tunnel.state`, `tunnel.url`, `tunnel.server`,
  `tunnel.credentialId`; at most one per **10 s** (changes inside that window are folded into one).
- Otherwise, while `shareModels` is true: one every `nextHeartbeatSeconds` (300 s by default).
  While it is false: none after the one that reported the change.
- No "busy" or per-request state (owner decision 2026-10-04): each model's `loaded` flag travels at
  this rate, and loading/unloading/downloading a model changes `discoveryKey`, which sends one.
- Each heartbeat request waits up to **30 s** (the api may wait `LISTENER_TIMEOUT_MS`, 20 s, for
  its listeners before answering); a timeout counts as a network failure below.
- At start: one with `reason: "start"`. On SIGTERM/SIGINT and `kernal local disable`: one with
  `reason: "stop"` and `tunnel.state: "stopped"` (3 s timeout, best effort), so the router entries
  go at once instead of after the stale window.
- Failure (network, 5xx): retry with backoff 5 s, 10 s, 20 s ... capped at 300 s; the tunnel keeps
  running meanwhile. **401**: refresh the access token once (`getAccessToken`), then retry; still
  401, treat as signed out (§4.8). **403** / **404** from §1.1: stop the tunnel, record the error in
  the state file, retry in 15 minutes.

### 1.5 The `localHosts` collection and status rule

`api/src/store/local-hosts.ts` (in this PR; task A owns it from here). `LocalHost`:

| Field | Type | Notes |
|---|---|---|
| `id` (`_id`) | `lh_` + 24 hex | `localHostId(userId, hostId)` |
| `userId`, `ownerEmail` | string | from the device token's identity |
| `hostId` | `h_` + 24 hex | Kernal's id |
| `deviceId` | string | device of the last heartbeat |
| `hostName`, `kernalVersion?`, `platform?` | string | as reported |
| `accessGroup` | string | `"everyone"` (reserved) |
| `routerPrefix` | string | unique, fixed at creation |
| `shareModels` | boolean | as reported |
| `discoveryKey` | string | as reported |
| `servers`, `models` | arrays | `HeartbeatServer[]`, `HeartbeatModel[]` |
| `tunnel` | `HeartbeatTunnel` | as reported |
| `managed?` | `LocalHostManaged` | `credentialId`, `credentialIssuedAt`, `endpointId?`, `publicUrl?`, `bearerSecret`, `bearerVersion`, `bearerHash` (§2) |
| `lastBearerVersion?` | number | the highest `bearerVersion` ever minted for this record; revoke, the idle sweep and DELETE never clear it (§2.3) |
| `createdAt`, `updatedAt`, `lastSeenAt` | ISO | |
| `revokedAt?` | ISO | device revoked (§2.5) |
| `deletedAt?` | ISO | tombstone of a DELETE (§1.8): holds the prefix for the same user |

Indexes (`ensureLocalHostIndexes`): `{ routerPrefix: 1 }` unique; `{ userId: 1, lastSeenAt: -1 }`;
`{ deviceId: 1 }`; `{ shareModels: 1, lastSeenAt: -1 }`. Records are small (≤ 256 models); no TTL:
a host stays in its owner's listing (as stale) until they delete it, and others see it for
`OTHERS_STALE_LISTED_SECONDS` (§1.7). A tombstone (§1.8) is never removed, so a prefix never passes
to another person.

Status, `hostStatus(host, now)` (spec-owned), first match wins:

1. `revoked`: `revokedAt` set.
2. `stale`: `now - lastSeenAt > STALE_AFTER_MISSED × 300 s + 60 s` (= 960 s).
3. `not-sharing`: `shareModels` false.
4. `offline`: `tunnel.state !== "up"`, or the server named by `tunnel.server` isn't `ok`.
5. `online`.

`sharedModels(host)`: the models whose `server === tunnel.server`. `routerFingerprint(host, now)`: a
hash of status, `tunnel.managed`, `managed.publicUrl`, `managed.bearerVersion`, `accessGroup`,
`routerPrefix`, `hostName` and each shared model's id, kind, loaded, contextLength, type, vision,
toolUse. Both are in `store/local-hosts.ts` and pinned by `test/local-hosts-contract.test.ts`.

### 1.6 Access group

`accessGroup` is always `"everyone"` in wave 2 and nothing reads it for decisions yet. A later issue
narrows who may see and use a host; it then maps the field onto a LiteLLM model access group
(`local-hosts-<group>`, §3.6) and filters the listing. No migration is needed for that.

### 1.7 `GET /api/local-hosts`

**200** `LocalHostListResponse` `{ "hosts": LocalHostView[] }` (contract.ts):

- The caller's own hosts, any status (revoked included, tombstones excluded), newest `lastSeenAt`
  first; then everyone else's hosts with `shareModels` true, not revoked, status `online` or
  `offline`, or `stale` while `now - lastSeenAt < OTHERS_STALE_LISTED_SECONDS` (7 days)
  (`listSharing()`), newest first. `accessGroup` filtering is a later issue (every value is
  `everyone`).
- `LocalHostView`: `id`, `hostName`, `owner { email, mine }`, `status`, `shareModels`,
  `accessGroup`, `routerPrefix`, `kernalVersion?`, `platform?`, `lastSeenAt`,
  `tunnel { provider, managed, state }`, `servers [{ id, kind, ok }]`, `models [LocalHostModelView]`
  with `routerModel` (when routable), `kind`, `loaded`, `contextLength`, `vision`, `toolUse`,
  `type`, and `shared` (on the tunnel's server).
- Never in the view: `managed` (credential, endpoint, bearer secret name or hash), `tunnel.url`,
  `tunnel.credentialId`, `deviceId`, `userId`, `discoveryKey`.
- Readers: #385 (Kernal + web UI) and #388 (Desk page: who shares which models, which are loaded),
  and `kernal local status` (optional; it has the heartbeat answer already).

### 1.8 `DELETE /api/local-hosts/:id`, stop sharing, and LaptopProbe

- `DELETE /api/local-hosts/:id` (owner or operator; anyone else **404**; a tombstone **404**):
  delete the cloud endpoint and the ngrok credential (§2.5, failures retried by the sweep through
  metadata), disable the bearer secret's versions (`secretAdmin.disableAllEnabled`), then turn the
  record into a **tombstone**: set `deletedAt`, `shareModels: false`, `servers: []`, `models: []`,
  `tunnel.state: "off"`, unset `managed` (keeping `routerPrefix`, `userId`, `lastBearerVersion`),
  then `changed({ reason: "deleted", host: <the record before> })` so task B removes the router
  entries. **204**. The tombstone keeps the prefix for its user (§3.1): Tapes and Drives that name
  `local/<prefix>/<model>` can never reach another person's laptop. Tombstones are not listed
  (§1.7), have no router entries (not sharing) and are not counted by `listSharing()`.
- If the laptop still runs with sharing on, its next heartbeat revives the tombstone (same `id`,
  same prefix, step 2 of §1.3). "Stop sharing" for good is the setting: #385's UI turns
  `localHost.shareModels` off (device or user level, central settings) and then calls DELETE. On the
  laptop, `kernal local disable` stops the service (§4.2).
- **LaptopProbe** (A, `laptop.ts`): `LaptopProbeConfig.localHosts` is wired in this PR. A adds
  `isOnlineFor(model: string): Promise<boolean>`: for a name that `parseRouterModelName` accepts,
  `findByRouterPrefix` → `hostStatus === "online"` and the model is in `sharedModels`; cached
  `cacheMs` per prefix. Any other name falls back to `isOnline()` (the legacy tunnel). In
  `resolveRunModel`, a wanted model that `parseRouterModelName` accepts counts as local (as if it
  were in `config.localModels`). A changes the one preflight line in `agentlink.ts`
  (`await this.laptopProbe.isOnline()` → `await this.laptopProbe.isOnlineFor(wanted)`).

## 2. Per-host tunnel credentials (task A, #383)

### 2.1 Configuration

- `NGROK_API_KEY` (existing, Secret Manager `outfitter-ngrok-api-key`, mounted on both roles).
- `LOCAL_HOST_DOMAIN` → `config.localHostDomain` (in this PR); unset or empty falls back to
  `PREVIEW_DOMAIN` (`kernal.run` in the deployed services); both unset → provisioning off. Cloud endpoints are `https://lh-<26 base32>.<domain>`. Sharing the preview domain
  is safe: the preview sweep only touches endpoints whose metadata says `purpose:
  "outfitter-preview"`, and this feature's say `purpose: "outfitter-local-host"`.
- `ctx.localHostNgrok` (in this PR): `opts.ngrok ?? createNgrokApi(NGROK_API_KEY)` when the key is
  set. Provisioning is on when it and `config.localHostDomain` are both set; otherwise heartbeats
  answer `credentials: "unavailable"` and the credentials route **503**
  `{ "error": "local_host_tunnels_off" }`.
- Metadata on every ngrok resource (JSON string): `{ "purpose": "outfitter-local-host", "env":
  config.previewEnv, "id": "<lh_...>", "userId": "<u_...>", "createdAt": "<iso>" }`. The sweep
  only ever touches resources whose `purpose` and `env` match (previews' `ours()` rule).

### 2.2 Names (`naming.ts`, spec-owned)

| Thing | Value |
|---|---|
| internal endpoint | `internalUrl(id)` = `https://lh<24 hex>.internal` |
| credential ACL | `credentialAcl(id)` = `["bind:lh<24 hex>.internal"]` |
| cloud endpoint | `https://${newPublicSlug()}.${localHostDomain}`, random, made once per endpoint |
| bearer | `newBearer()` = `lhb_` + 43 base64url (256 bits) |
| bearer secret | `bearerSecretName(id)` = `outfitter-localhost-<24 hex>` (inside the `outfitter-` prefix `deploy/secret-scope.sh` lets the api manage) |

### 2.3 `POST /api/local-hosts/tunnel-credentials`

Request `{ "hostId": "h_..." }`. The record must exist (send a heartbeat first): **404**
`{ "error": "host_unknown" }`; sharing off: **409** `{ "error": "sharing_off" }`; revoked: **403**
`{ "error": "host_revoked" }`; a different user's record can't be addressed (the id derives from
the caller). Provisioning off: **503** as §2.1.

What the api does, in order (a failure at any step deletes what the step made and answers **502**
`{ "error": "ngrok_failed" }`; no secret in the message):

1. **Bearer**: if the record has no `managed`, mint one: `addVersion(bearerSecretName(id),
   bearer)`, `bearerVersion = (lastBearerVersion ?? 0) + 1` (also stored as `lastBearerVersion`),
   `bearerHash`. `bearerVersion` is **monotonic per record**: a revoke or DELETE unsets `managed`
   but never `lastBearerVersion`, so a re-mint under the same secret name always gets a higher
   number than any bearer before it. Existing `managed`: read it back with `accessLatest` (it is
   stable across credential refetches, so the router entries don't churn). Consumers that cache the
   bearer (B) key the cache on `bearerHash` and check `sha256(value) === bearerHash`, never on the
   version alone.
2. **Credential**: always mint a new one, `createCredential({ description: "outfitter local host
   <id>", metadata, acl: credentialAcl(id) })` (ngrok shows a token once only); then delete the
   previous `managed.credentialId` (idempotent). An agent still running on the old token is cut off
   when ngrok drops it, which is when it reconnects with the new one anyway.
3. **Cloud endpoint**: if `managed.endpointId` is absent, `createCloudEndpoint({ url, trafficPolicy:
   cloudPolicy(...), description, metadata })` (§2.4).
4. Store `managed` (`credentialId`, `credentialIssuedAt`, `endpointId`, `publicUrl`,
   `bearerSecret`, `bearerVersion`, `bearerHash`), then, if `publicUrl` or `bearerVersion` changed,
   `changed({ reason: "credentials", host, previous })`.

**200** `TunnelCredentialsResponse`:

```json
{
  "provider": "ngrok",
  "authtoken": "2abc...",
  "credentialId": "cr_2abc...",
  "url": "https://lh8d0b7c6a5e4f3a2b1c0d9e8f.internal",
  "publicUrl": "https://lh-q3k5x7....kernal.run",
  "trafficPolicy": "{\"on_http_request\":[...]}",
  "bearer": "lhb_...",
  "allowPaths": ["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/models"],
  "rateLimit": { "requests": 120, "windowSeconds": 60 },
  "issuedAt": "2026-10-05T12:00:00.000Z",
  "expiresAt": "2026-10-12T12:00:00.000Z"
}
```

Kernal maps it onto `NgrokCredentials` as `{ provider, authtoken, url, trafficPolicy,
bearerToken: bearer }`. `expiresAt` = `issuedAt + CREDENTIALS_REFETCH_SECONDS` (7 days) is advisory:
the credential works until rotated or revoked; Kernal refetches when it is under a day away. Kernal
keeps the answer **in memory only** (never on disk); a service restart fetches again. The answer
carries `Cache-Control: no-store`, and the route never logs its body.

### 2.4 Traffic policies (A writes both; JSON, which is valid YAML)

**Cloud endpoint** (only the api writes it; the laptop can't reach or change it):

1. `rate-limit`: `capacity: 120`, `rate: "60s"`, `algorithm: "sliding_window"`, `bucket_key:
   ["conn.client_ip"]`, `name: "outfitter-local-host"`.
2. Deny 401 unless `req.headers['authorization'][0] == 'Bearer <bearer>'` (same expression shape as
   Kernal's `policy.ts`; the bearer is checked against `^lhb_[A-Za-z0-9_-]{43}$` before it is
   spliced in).
3. 404 JSON `{"error":{"message":"not found","type":"not_found"}}` unless `req.url.path in [...]`
   the four `LOCAL_HOST_ALLOW_PATHS`.
4. `forward-internal` to `internalUrl(id)`.
5. `on_http_response`: `x-robots-tag: noindex, nofollow`, `referrer-policy: no-referrer`.

**Internal endpoint** (`trafficPolicy` in the answer, applied by the laptop's agent): steps 2 and 3
again (no rate limit: the cloud endpoint already did it). The guard proxy on the laptop
(`_shared/tunnel/proxy.ts`) checks the same bearer and paths a third time, so a wrong or missing
policy never opens LM Studio's `/api/v0/*` management routes.

A may add `updateCloudEndpoint(id, { trafficPolicy })` (`PATCH /endpoints/{id}`) to `ngrok-api.ts`
and `test/fake-ngrok.ts` (additive) for bearer rotation; without it, rotation deletes and recreates
the endpoint (a new `publicUrl`).

### 2.5 Rotation, revocation and clean-up

- **Device revoked** (`deviceLifecycle.register({ name: "local hosts", onRevoked })`, A, one line
  in server.ts): for each record `listForDevice(device.id)`: delete its credential and endpoint,
  `disableAllEnabled(bearerSecret)`, set `revokedAt`, unset `managed`, then `changed({ reason:
  "device-revoked", ... })`; `lastBearerVersion` stays. A later heartbeat from another device of the
  same user on that machine clears `revokedAt` (§1.3) and gets `credentials: "fetch"`, which mints a
  new bearer with `bearerVersion = lastBearerVersion + 1` (§2.3 step 1), never 1 again.
- **Host deleted**: §1.8.
- **Sharing off**: §1.3 step 5 (endpoint deleted; credential kept, harmless: it can only bind an
  internal endpoint nothing forwards to).
- **Sweep** (A's `LocalHostListener.sweep`, registered in server.ts):
  1. Records stale for more than `ENDPOINT_IDLE_SECONDS` (24 h) with an `endpointId`: delete the
     endpoint, unset `endpointId`/`publicUrl` (the next credentials call makes a new one; until then
     heartbeats answer `fetch`).
  2. ngrok cloud endpoints and credentials whose metadata is ours (`purpose`, `env`) and older than
     5 minutes (previews' `ORPHAN_GRACE_MS`) that no record references (`endpointId` /
     `credentialId`): delete.
  3. Returns `{ endpointsIdle, endpointsOrphaned, credentialsOrphaned }`.
- Bearer rotation on demand is not in wave 2 (no route); revoke + re-login covers a leak.

### 2.6 Where the bearer lives

The bearer is in exactly three places: Secret Manager `outfitter-localhost-<hex>` (the api's copy,
read by A when it reissues credentials and by B when it writes a router entry; B caches it in
memory keyed on `bearerHash`), the cloud endpoint's
traffic policy (at ngrok), and the router's deployment `litellm_params.api_key` (LiteLLM stores it
encrypted with its salt key). The laptop holds it in memory for its own guard proxy. Mongo has only
`bearerHash`. Nothing logs it; `problems` and errors never include it.

## 3. Router reconciliation (task B, #384)

### 3.1 Model names

`local/<routerPrefix>/<modelId>` (`naming.ts routerModelName`):

- `routerPrefix` = `<userSlug>-<hostSlug>`, fixed per record at creation (§1.3): `userSlug` is the
  email's local part before `+`, lowercased, runs of non-`[a-z0-9]` to `-`, ≤ 16 characters
  (`user` if empty); `hostSlug` the host name without `.local`/`.lan`/`.home`/`.localdomain`, same
  rule, ≤ 20 (`host` if empty). ≤ 46 characters, `[a-z0-9-]`.
- **Collision rule (user-aware).** A candidate is free when `findByRouterPrefix` returns nothing, or
  returns a record of the **same `userId`** that is a tombstone (`deletedAt`); A then removes that
  tombstone in the same step (`delete`, before the upsert) so the prefix moves to the user's new
  record. A record of another user, live or tombstone, or a live record of the same user, takes the
  next candidate: append 4, then 8, hex characters of the record id. So a prefix, once held, only
  ever names the same person's machines; `<user>-<host>` being ambiguous (`mgm-matthews`+`macbook`
  vs `mgm`+`matthews-macbook`) is first-come at creation only.
- `modelId` verbatim when `routableModelId` (1-160 of `[A-Za-z0-9._:@+/-]`, no empty, `.` or `..`
  segment); otherwise the model gets no entry.
- Kernal users see them as `litellm/local/<prefix>/<id>` (the router provider's prefix);
  `parseRouterModelName` accepts both.

### 3.2 Desired state

For every record from `listSharing()` with `hostStatus === "online"`, `tunnel.managed`, and
`managed.publicUrl` and `managed.bearerSecret` set: one deployment per routable model in
`sharedModels(host)`. Everything else (stale, offline, not-sharing, revoked, deleted, unmanaged
hosts) has none. Every downloaded model is registered (owner decision), loaded or not.

### 3.3 `POST /model/new` payload

```json
{
  "model_name": "local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b",
  "litellm_params": {
    "model": "openai/qwen/qwen3-coder-30b",
    "api_base": "https://lh-q3k5x7....kernal.run/v1",
    "api_key": "<bearer>",
    "timeout": 600,
    "stream_timeout": 600,
    "max_retries": 0,
    "extra_body": { "chat_template_kwargs": { "enable_thinking": false } }
  },
  "model_info": {
    "id": "lh-8d0b7c6a5e4f3a2b1c0d9e8f-1a2b3c4d5e6f",
    "mode": "chat",
    "max_input_tokens": 32768,
    "supports_vision": false,
    "supports_function_calling": true,
    "access_groups": ["local-hosts"],
    "description": "On Matthews-MacBook-Pro (mgm@mgms.eu), LM Studio, loaded. A request to a model that isn't loaded loads it first, which can take minutes.",
    "metadata": {
      "outfitter": "local-host",
      "env": "<config.previewEnv>",
      "hostId": "lh_8d0b7c6a5e4f3a2b1c0d9e8f",
      "ownerUserId": "u_...",
      "modelId": "qwen/qwen3-coder-30b",
      "fingerprint": "<routerFingerprint(host)>",
      "payloadVersion": 1
    }
  }
}
```

- `model_info.id` = `routerDeploymentId(host.id, modelId)`: deterministic, so a retry or a second
  instance finds the entry instead of adding another. This needs the router to keep a
  caller-supplied `model_info.id` (§7 owner check).
- `metadata.payloadVersion`: a constant in B's code, bumped whenever B changes the payload's shape
  (for example the thinking switch), so existing entries are updated although the host's fingerprint
  didn't change.
- `model`: always `openai/<modelId>` (every supported server speaks OpenAI's API at `/v1`).
- `api_base`: `managed.publicUrl + "/v1"`. `api_key`: `secretAdmin.accessLatest(bearerSecret)`.
  B may cache it in memory keyed on `managed.bearerHash`, and uses a value only when
  `sha256(value) === bearerHash` (a mismatch re-reads once; still a mismatch, it fails that host and
  leaves its entries alone). Never key it on `bearerVersion` alone.
- `mode`: `"embedding"` when `type === "embeddings"`, else `"chat"`.
- `max_input_tokens`: `contextLength` when known (omit otherwise). `supports_vision`: `vision ===
  true`; `supports_function_calling`: `toolUse === true`.
- `timeout` / `stream_timeout` 600 s as today's `local-qwen-mlx` deployment; `max_retries: 0` (a
  retry of a slow load doubles it). `extra_body` turns thinking off by default, as today; B checks
  the field names against the deployed LiteLLM version and today's template and documents any
  difference in its PR.
- `description` says whether the model was loaded at the last heartbeat (LM Studio's JIT load can
  start a 20 GB load or evict the loaded model: the LM Studio docs' auto-evict setting goes in B's
  README note).

### 3.4 When, and idempotency

- **On change**: B's `LocalHostListener.onChange` reconciles that one host: desired entries vs the
  router's entries with `metadata.hostId === host.id` (from `/model/info`); add missing
  (`/model/new`), update those whose `metadata.fingerprint` or params differ (`/model/update`, same
  `model_info.id`), delete extras (`/model/delete` `{ "id": ... }`). Reasons `deleted` and
  `device-revoked` mean "desired = none".
- **Sweep** (B's `LocalHostListener.sweep`, every tick): the same for all hosts at once: one
  `/model/info`, every entry whose `model_info.metadata.outfitter === "local-host"` and
  `metadata.env === config.previewEnv` compared with the desired state of `listSharing()` plus the
  hosts those entries name. This is what removes the entries of a host that went **stale** (no
  heartbeat arrives to announce it), and what repairs anything an onChange left half done. Entries
  without that metadata (hand-made ones, `local-qwen-mlx`) are never touched. Returns `{ added,
  updated, deleted, failed }`.
- `model_info.metadata` on the router is the **source of truth**: B keeps nothing in Mongo and never
  writes `localHosts`.
- Duplicates (two instances adding the same id at once): the sweep keeps one per `model_info.id` and
  deletes the rest. B serialises per host within an instance (a promise chain keyed by host id).
- Changes must not interrupt requests already running: an update keeps the deployment id; a delete
  happens only for a deployment whose model or host is gone (the model was deleted or moved off the
  tunnelled server, or the host is no longer online), whose requests fail anyway.
- If the router does not keep the caller's `model_info.id` (an entry B added comes back from
  `/model/info` under another id), B must not delete and re-add in a loop: it logs an error naming
  the problem once per instance, leaves such entries alone and counts them `failed`.
- The sweep has an overall deadline (B's choice, under the tick's request timeout) and stops at the
  first call that doesn't answer; what is left waits for the next tick.
- B's listener runs only where `LOCAL_HOST_ROUTER_KEY` is set **and** the role is not `web` (§3.5).
  Elsewhere it is not registered, and the heartbeat's `routerModels` still says what would be
  registered.

### 3.5 Admin-key routes

B calls exactly `/model/new`, `/model/update`, `/model/delete` (POST) and `/model/info` (GET).

**Owner decision (2026-10-05): a separate key.** These routes do **not** go on the existing
`outfitter-litellm-admin` key (`LITELLM_ADMIN_KEY`, both roles, mints keys), nor on
`outfitter-litellm-key` (the shared router key). B uses a dedicated key:

- Secret Manager `outfitter-litellm-admin-key` in `outfitter-509211`, env `LOCAL_HOST_ROUTER_KEY`
  → `config.localHostRouterKey` (in this PR). Its LiteLLM key belongs to `outfitter-svc` (a
  `proxy_admin`, which `/model/*` needs) under its own alias prefix, with `allowed_routes` exactly
  `/model/info`, `/model/new`, `/model/update`, `/model/delete`: it can't mint or delete keys.
- Mounted only on the **link** role (`outfitter-link`), the narrowest role that runs router sync:
  heartbeats (§1.1) and the tick (`/api/hooks/tick`, Cloud Scheduler) both arrive there. Never on
  web (`outfitter-api`), never on a Drive. Both roles run as the same service account, which may
  read every `outfitter-*` secret, so the mount, not IAM, is what keeps it off web; a separate
  service account for link is a follow-up if that matters.
- B registers its listener only when `config.localHostRouterKey` is set and `config.role !== "web"`.
  A DELETE or a device revoke handled on web therefore has no router listener; its entries go at the
  next tick's sweep on link (≤ 5 minutes; those hosts' requests fail at ngrok meanwhile).
- `deploy/litellm-admin.sh` mints it with `KEY=local-hosts` (its own `ALLOWED_ROUTES`, secret, alias
  and `purpose` metadata); `deploy/service.sh` mounts it on link; `deploy/test/litellm-admin.test.sh`
  checks that this key's routes equal the routes `router-sync.ts` calls, and that the main key's
  routes equal the rest of the api's (no `/model/new|update|delete` on it). B's calls must match the
  test's pattern: a private `call`/`ok` method invoked as `this.call("POST", "/model/new", ...)`.
- The key itself can still rewrite **any** deployment (`allowed_routes` is route-level): the "only
  entries carrying our metadata" rule lives in B's code. **Follow-up (#466):** a guard in our router fork
  so this key's `/model/new|update|delete` may only touch `model_name` `local/*` entries whose
  `model_info.metadata.outfitter == "local-host"`.
- Owner steps in §7.

### 3.6 Who may use local models

Owner decision 2026-10-05: everyone signed in, and Drives under the same rule (a run key gets the
`local/...` models its owner's device keys get).

- Every entry carries `model_info.access_groups: ["local-hosts"]` (`LOCAL_HOST_ACCESS_GROUP`).
- `router.keys.models` unset (the default): keys are minted with no `models` list, which LiteLLM
  reads as every model. Nothing to do.
- `router.keys.models` set: B changes `routerKeyLimits` (`central/litellm-keys.ts`, one block) to
  append `"local-hosts"` to that list for both device and run keys unless already present. LiteLLM
  resolves an access-group name in a key's `models` to every deployment in that group. B verifies
  this against the deployed LiteLLM version (OSS model access groups); if that version only supports
  wildcards, it appends `"local/*"` instead and says so under "Contract changes". Keys minted before
  the change keep their list until re-minted (Kernal re-mints device keys weekly; run keys are per
  run).

## 4. Kernal service (task C, #381)

### 4.1 Files

`kernal/.pi/extensions/kernal-local/` (new, **no `index.ts`**, so pi never loads it as an
extension): `cli.ts` (entry: argv[2] is the subcommand), `commands.ts` (enable, disable, status,
run), `loop.ts` (the algorithm, injectable clock/fetch/discovery/tunnel), `service.ts` (LaunchAgent
and systemd unit text, install/remove through an injectable runner), `protocol.ts` (C's copy of
contract.ts's wire types), `state.ts` (state file, lock, log rotation). Tests:
`kernal/tests/local-*.test.ts`. Never touch the real `~/Library/LaunchAgents`, `~/.config/systemd`,
`~/.kernal` or `launchctl`/`systemctl` in tests (home-guard already isolates HOME; the runner is
injected).

### 4.2 CLI

```
kernal local enable [--profile <name>]   install + start the service (idempotent; rewrites the unit)
kernal local disable                     stop + remove it (sends the "stop" heartbeat first)
kernal local status [--json]             service, sign-in, sharing, tunnel, models, last heartbeat
kernal local run                         the foreground loop (what the service runs; Ctrl-C stops it)
```

Exit codes: 0 done, 1 failed, 2 usage. `enable` refuses (exit 1, with the reason) when no runtime
can run the loop (§4.3). It does not turn sharing on: it prints the current `localHost.shareModels`
and how to change it (`/config`, the web account page, or `config.local.json`).

### 4.3 Runtime (decision)

The loop imports only `node:` built-ins and relative `.ts` files (`_shared/local-discovery.ts`,
`_shared/tunnel/*`, `_shared/outfitter-session.ts`, `_shared/keychain.ts`, `_shared/central-config.ts`
and what they import), never an npm package or a native addon; C's tests walk the import graph from
`cli.ts` and fail on anything else. So it runs under either:

1. **Node ≥ 22.18** (type stripping on by default): `KERNAL_LOCAL_NODE` (absolute path recorded by
   `enable`), else `node` on PATH if its version qualifies. A source checkout always has it.
2. **The release bundle's pi binary as Bun**: `BUN_BE_BUN=1 "$ROOT/pi/pi" <cli.ts> ...`. pi is a
   Bun-compiled binary; with `BUN_BE_BUN=1` it runs scripts as `bun` does, TypeScript included. The
   Chrome companion's installer already relies on this (`scripts/install.sh`
   `install_chrome_companion`). A bundle needs no Node.

`bin/kernal` gets one dispatch block (C's only shared-file edit there), next to
`login|logout|whoami`:

```bash
  local)
    shift
    exec_local_runtime "$ROOT/.pi/extensions/kernal-local/cli.ts" "$@" ;;
```

where `exec_local_runtime` (C, in bin/kernal) tries 1 then 2 and otherwise prints "kernal local
needs Node 22.18+ or a release bundle" (exit 1). Because the service runs `bin/kernal`, `.env` is
sourced first as for every other command (interim tunnel values, `OUTFITTER_API`).

### 4.4 Host id, files and logs

- `hostId` = `h_` + first 24 hex of sha256(`kernal-local-host:` + machine id): macOS
  `IOPlatformUUID` (`/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`), Linux `/etc/machine-id`
  (else `/var/lib/dbus/machine-id`); without either, a random id kept in `host-id` in the state
  directory. Stable across reinstalls and re-logins; the api scopes it per user.
- `hostName`: `os.hostname()` without `.local`, ≤ 64 characters.
- Home: `KERNAL_HOME_DIR` / `MGM_HOME_DIR` fallback (`kenv`), default `~/.kernal`.
- State directory `<home>/local-host/` (0700):
  - `state.json` (0600, **no secrets**), written atomically on every change (not every poll):
    `{ "version": 1, "pid", "startedAt", "runtime": "node 22.19.0" | "bun 1.2.x", "hostId",
    "signedIn": { "email" } | null, "shareModels": { "value", "source" }, "server",
    "discoveryKey", "models": { "total", "loaded" }, "tunnel": { "provider", "managed", "state",
    "url", "publicUrl", "since", "reason" }, "heartbeat": { "lastAt", "ok", "status",
    "nextAt", "routerModels", "problems", "error" }, "updatedAt" }`;
  - `run.lock` (the running loop's pid; a second `run` exits 0 with "already running" when that pid
    is alive);
  - `host-id` (only when there is no machine id).
- Log `<home>/logs/local-host.log`, one line per event (`<iso> <level> <message>`), rotated at
  5 MiB keeping 3 (`.1` ... `.3`). Every line goes through `_shared/redact.ts`; tokens, the bearer
  and the authtoken are never logged. launchd/systemd capture of stdout/stderr (crashes only) goes
  to `<home>/logs/local-host.out.log`.

### 4.5 Service units

**macOS**: label `one.kernal.local-host`, file `~/Library/LaunchAgents/one.kernal.local-host.plist`:

```xml
<dict>
  <key>Label</key><string>one.kernal.local-host</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>{KERNAL}</string><string>local</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KERNAL_HOME_DIR</key><string>{HOME_DIR}</string>
    <key>PATH</key><string>{NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>KERNAL_LOCAL_NODE</key><string>{NODE}</string>          <!-- only when enable found one -->
    <key>KERNAL_PROFILE</key><string>{PROFILE}</string>          <!-- only with --profile -->
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{HOME_DIR}/logs/local-host.out.log</string>
  <key>StandardErrorPath</key><string>{HOME_DIR}/logs/local-host.out.log</string>
</dict>
```

`{KERNAL}` is the stable launcher: `<home>/current/bin/kernal` in an install (survives `kernal
update`, whose old bundles get pruned), the checkout's absolute `bin/kernal` in a source checkout.
Install: write the plist, `launchctl bootout gui/<uid>/one.kernal.local-host` (ignore failure),
`launchctl bootstrap gui/<uid> <plist>`. Remove: `bootout`, delete the plist. Status: `launchctl
print gui/<uid>/one.kernal.local-host` (state, pid). The keychain is reachable from a LaunchAgent
in the user's GUI session, so device tokens work as in a terminal.

**Linux**: `~/.config/systemd/user/kernal-local-host.service`:

```ini
[Unit]
Description=Kernal Local Host (share this machine's local models)
After=network-online.target

[Service]
ExecStart=/bin/bash {KERNAL} local run
Restart=always
RestartSec=30
Environment=KERNAL_HOME_DIR={HOME_DIR}
Environment=KERNAL_LOCAL_NODE={NODE}
Environment=PATH={NODE_DIR}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Install: `systemctl --user daemon-reload`, `systemctl --user enable --now kernal-local-host.service`.
Remove: `disable --now`, delete, `daemon-reload`. It runs while the user is logged in;
`loginctl enable-linger` (not done by Kernal) keeps it running without a session. Secret Service
(the keychain backend) needs the session's D-Bus; without it the file backend applies as in a
terminal.

### 4.6 The loop (`kernal local run`)

```
start: take run.lock; write state; log runtime; heartbeat reason "start" once signed in
every 15 s (POLL):
  signedIn = loginState() has an account for outfitterApi()
  every 10 min, at start, and on SIGHUP: refreshConfig() (signed in only)
  shareModels = getValue("localHost.shareModels") (works signed out too: the local level)
  snap = discoverLocalModels({ env, ollamaShowCache })            # one map kept for the process
  server = the tunnel's model server: KERNAL_LOCAL_HOST_SERVER (a server root URL) if it answers,
           else the first ok server in the order lmstudio, ollama, llamacpp, mlx-lm, vllm, openai
  want = shareModels && server && hint !== "none"
  if want:
    creds = managed (signed in, last hint not "unavailable"):
              cached answer; fetched when none is cached (always after a service restart: the
              answer lives in memory only, while the api may still answer "current"), when hint is
              "fetch", when expiresAt is < 24 h away, or after the tunnel failed with kind
              "credentials"
            else interimCredentialsFromEnv(env)                   # tunnel only, no router entries
    if no creds: state.tunnel = { state: "off", reason: "no tunnel credentials" }
    elif no tunnel, or its server/credentials changed, or it is down: (re)open it with
            openTunnel({ choice: parseTunnelChoice(env.KERNAL_LOCAL_TUNNEL), credentials: [creds],
                         localUrl: server.id, allowPaths/rateLimit from the answer })
            on failure: backoff 5 s, 10 s ... 5 min
  else: stop the tunnel if one runs (ngrok bills endpoint hours)
  if signedIn and (changed (§1.4) or interval due): heartbeat; apply its answer
     (nextHeartbeatSeconds, credentials hint: "fetch" → refetch now, "none" → stop tunnel)
on wake (a POLL tick that arrives > 2 × POLL late): restart the tunnel, discover and heartbeat now
on tunnel onDown: state down + reason, restart with backoff, heartbeat (state changed)
on SIGTERM/SIGINT: stop heartbeat ("stop", 3 s), stop tunnel, release lock, exit 0
```

- **One server per host in wave 2** (decision): the guard proxy forwards to one upstream, so the
  router reaches the models of that one server; the heartbeat still lists every server's models
  (the listing shows the rest as not shared). Routing by model across servers is a follow-up.
- The guard proxy's keep-alive replaces the removed `keepalive.mjs`. `tunnel.sh` and `keepalive.mjs`
  are gone (#387). A second tunnel on the same reserved domain still fails (ngrok ERR_NGROK_334
  shows as the tunnel's reason).
- The tunnel choice is `KERNAL_LOCAL_TUNNEL` (`auto` | `ngrok` | `cloudflare`, through
  `parseTunnelChoice`) until #386 adds a central `localHost.tunnel` setting. Outfitter provisions
  ngrok only in this wave, so **managed credentials always mean ngrok**: when the loop uses managed
  credentials it opens ngrok whatever `KERNAL_LOCAL_TUNNEL` says (and logs once that the choice was
  overridden). `cloudflare` is interim and local-only in wave 2: it runs only on `.env` credentials,
  reports `tunnel.managed: false`, and so gets no router entries. Managed Cloudflare tunnels are
  #386.

### 4.7 `kernal local status`

Reads `state.json` and the unit's state (no network). Prints: service (installed, running, pid,
runtime); account (email or "signed out"); sharing (value and source); tunnel (provider, managed or
interim, state since, public URL, reason); server and models (total, loaded); last heartbeat (time,
status, next due, problems); router models (from the last answer). `--json` prints `state.json`
merged with `{ service: { installed, running, pid, unit } }`.

### 4.8 Signed out

No heartbeats and no managed credentials (a managed tunnel that was running stops: its credential
belongs to the signed-out account). Interim `.env` credentials (`NGROK_AUTHTOKEN`,
`TUNNEL_DOMAIN_LMSTUDIO`, `LOCAL_TUNNEL_TOKEN`) still run a tunnel when `shareModels` is on locally,
which is what the removed `tunnel.sh` did without Outfitter. Sign-in is noticed within one POLL (a file
read). The service never needs the router master key.

## 5. The events seam (spec-owned, in this PR)

`api/src/local-hosts/events.ts`: `LocalHostEvents` with `register(listener)`,
`changed(change) → { problems }` and `sweep(now) → { [listener]: counts }`. `LocalHostChange` is
`{ reason: "heartbeat" | "credentials" | "deleted" | "device-revoked", host, previous? }`.

- Built in `server.ts` and passed to routes as `ctx.localHostEvents` (in this PR); the tick
  (`routes/hooks.ts`) already calls `ctx.localHostEvents.sweep()` and reports `localHosts` in its
  answer (in this PR).
- A listener's `onChange` gets `LISTENER_TIMEOUT_MS` (20 s) before `changed()` reports
  `"<name>: still updating"` and returns; the work continues, and its later failure is logged. A
  listener caps each upstream call in `onChange` well under that (B: about 4 s per router call), so
  a slow upstream shows as its own error.
- Listeners register in `server.ts` at the marked lines, one line per task:
  - A: `localHostEvents.register(localHostTunnelListener({ store, ngrok: localHostNgrok, config,
    secretAdmin, log }))` and `deviceLifecycle.register(localHostDeviceHook({ ... }))`;
  - B: `if (config.localHostRouterKey && config.role !== "web")
    localHostEvents.register(localHostRouterListener({ store, config, secretAdmin, fetch, log }))`
    (§3.5).
- A calls `changed()`; B never calls it. B never imports A's modules (only `store/local-hosts.ts`,
  `local-hosts/naming.ts`, `local-hosts/contract.ts`, `local-hosts/events.ts`); A never imports
  B's.

## 6. Tests each task adds

- **A**: `api/test/local-hosts-registry.test.ts` (validation, record creation and takeover, prefix
  collision, status, the answer's hints and `routerModels`, `changed()` called only on fingerprint
  changes, listing filters and the view's missing secrets, DELETE, LaptopProbe `isOnlineFor` and
  `resolveRunModel`), `api/test/local-hosts-credentials.test.ts` (FakeNgrok: ACL, endpoint URL and
  metadata, both policies' rules, bearer stable across refetches and in Secret Manager only,
  revoke/delete/sharing-off clean-up, the sweep's idle and orphan rules, 503 when off),
  `api/test/local-hosts-routes.test.ts` (roles, device-only refusals, body limit).
- **B**: `api/test/local-hosts-router.test.ts` against `test/fake-litellm.ts` (extended additively
  with `/model/*`): payload shape, add/update/delete per host, the sweep removing stale hosts'
  entries, never touching entries without our metadata or of another `env`, duplicate clean-up,
  `routerKeyLimits` with and without `router.keys.models`; `bash deploy/test/litellm-admin.test.sh`.
- **C**: `kernal/tests/local-service.test.ts` (plist/unit text, install/remove commands through the
  injected runner, runtime choice), `kernal/tests/local-loop.test.ts` (fake clock, discovery,
  tunnel provider and fetch: cadence, hints, signed-out, wake, backoff, stop heartbeat),
  `kernal/tests/local-cli.test.ts` (status output, usage errors, import-graph check).

## 7. Owner steps (never performed by an agent)

1. Before B's entries can work, check the deployed router (our fork) and record the answers on
   #384: (a) `STORE_MODEL_IN_DB=True` is set (`/model/new|update|delete` need DB-backed models);
   (b) a `/model/new` with a caller-supplied `model_info.id` keeps it (one test add, then
   `/model/info`, then `/model/delete`); if it doesn't, B's ids never match and B stops with a
   logged error instead of looping (§3.4); (c) an access-group name in a key's `models` resolves to
   that group's deployments (§3.6).
2. After B merges: `KEY=local-hosts ./outfitter/deploy/litellm-admin.sh` (creates
   `outfitter-litellm-admin-key` with the `/model/*`-only key; `DRY_RUN=1` first to see the plan),
   then a release (or `./outfitter/deploy/link.sh`) so the link role mounts it. The main key needs
   no rotation for this feature.
3. Optional: set `LOCAL_HOST_DOMAIN` in `deploy/service.sh` if local hosts should not share
   `kernal.run` with previews (a new wildcard domain needs reserving in ngrok first). With nothing
   set, they use `PREVIEW_DOMAIN`.
4. Optional: a fleet `router.keys.models` value, if any, is re-minted onto keys over a week (§3.6).
5. Release a Kernal version with C, then on each sharing machine: `kernal login`, turn on
   `localHost.shareModels`, `kernal local enable`. `tunnel.sh` and `keepalive.mjs` are removed (#387).

## 8. Decisions (made for this contract; the owner may revisit)

1. **One record per person per machine**, keyed by `localHostId(userId, hostId)`; a re-login on the
   same machine takes the record over, so router names survive it.
2. **Router prefix fixed at creation** (`<user>-<host>`, hex suffix on collision): renaming the
   machine doesn't rename models people put in Tapes.
3. **Stale after 3 missed 5-minute heartbeats** (16 minutes); a clean stop removes entries at once.
4. **Bearer in Secret Manager**, stable across credential refetches; the ngrok credential is
   re-minted on every fetch (ngrok shows a token once) and kept in memory only on the laptop.
5. **Cloud endpoints on `PREVIEW_DOMAIN` by default**, random labels, deleted after 24 h stale and
   when sharing turns off; the preview sweep can't touch them (different `purpose`).
6. **One tunnelled server per host** in wave 2, chosen by a fixed kind order or
   `KERNAL_LOCAL_HOST_SERVER`.
7. **Router metadata is the source of truth** for B, with deterministic deployment ids; Mongo holds
   no router state.
8. **Access through the `local-hosts` model access group**, appended only when a fleet models list
   restricts keys.
9. **Loop runtime**: Node ≥ 22.18 when present, else the bundle's pi binary with `BUN_BE_BUN=1`;
   the loop's imports are limited to built-ins and relative files so both work.
10. **Heartbeats only while sharing** (plus one on each change), so a machine with the service
    enabled and sharing off sends nothing periodic.
11. **A separate router key for model writes** (owner decision 2026-10-05, §3.5):
    `outfitter-litellm-admin-key`, `/model/*` routes only, mounted on link only. Follow-up #466: a
    router fork guard limiting its writes to `local/*` entries with our metadata.
12. **Prefixes never pass between people** (§3.1, §1.8): DELETE leaves a tombstone, and only the
    same user can take a tombstoned prefix.
13. **`bearerVersion` is monotonic per record** (`lastBearerVersion`, §2.3); caches key on
    `bearerHash`.
14. **The sharer's email is visible to every router key holder**: each entry's `description` (and
    the listing's `owner.email`) names the host and its owner's email, which `/model/info` and
    `/v1/models` metadata show to anyone with a router key. It fits "everyone signed in shares";
    the owner may switch the description to the user slug instead (B's one-line change).
15. **No new laptop-held router keys.** The laptop holds an ngrok authtoken (bind-scoped to its one
    internal endpoint) and its bearer, both in memory only (§2.3); neither can call the router or
    the api. The owner decision "no new laptop-held keys" meant router keys, and none is added.
16. **Managed tunnels are ngrok in wave 2** (§4.6); `cloudflare` stays interim/local-only until
    #386.

## 9. File ownership

Rules (as central-auth.md §13):

- A task creates and edits only the files in its row. "(stub)" files exist in this PR; the task
  replaces the stub body and keeps the exported names and signatures (adding is fine).
- **Spec-owned files** (no task edits them; a change goes through this spec in its own PR):
  `api/src/local-hosts/contract.ts`, `api/src/local-hosts/naming.ts`, `api/src/local-hosts/events.ts`,
  `api/test/local-hosts-contract.test.ts` (a task whose change breaks one of its assertions updates
  that assertion and says so under "Contract changes"), and the scaffold lines this PR added to
  `store/types.ts` (the `localHosts` field), `store/memory.ts`, `store/mongo.ts`, `routes/index.ts`,
  `routes/context.ts`, `routes/hooks.ts` (the sweep call), `config.ts` (`localHostDomain`,
  `localHostRouterKey`),
  `server.ts` (events, ngrok client, LaptopProbe `localHosts`, the ctx fields, `App.localHostEvents`)
  and `test/stop.test.ts`.
- **Contract types inside a task's own files** (`LocalHost`, `LocalHostsCollection`, `hostStatus`,
  `sharedModels`, `routerFingerprint` in `store/local-hosts.ts`): A may add optional fields and
  methods; changing or removing one, or changing the status/fingerprint rules, needs a spec change.
- **Shared files**: one-line or one-block additive edits only, as listed. If two tasks touch the
  same shared file, they touch different lines.

| Task | Owns (create/modify) | Additive edits allowed in shared files |
|---|---|---|
| **A** #382 + #383 api registry and credentials | `api/src/store/local-hosts.ts`, `api/src/routes/local-hosts.ts` (stub), `api/src/local-hosts/registry.ts` (new: heartbeat, listing, delete, device hook), `api/src/local-hosts/tunnel-credentials.ts` (new: minting, policies, sweep listener), `api/src/laptop.ts`, `api/test/local-hosts-registry.test.ts`, `api/test/local-hosts-credentials.test.ts`, `api/test/local-hosts-routes.test.ts`, `api/test/laptop.test.ts` (as needed) | `api/src/server.ts` (the two "Task A" lines at the marker); `api/src/agentlink.ts` (the one preflight line, §1.8); `api/src/ngrok-api.ts` + `api/test/fake-ngrok.ts` (`updateCloudEndpoint`, optional); `docs/protocol.md` (a "Local hosts" section) |
| **B** #384 router reconciliation | `api/src/local-hosts/router-sync.ts` (new: the listener, `/model/*` client), `api/test/local-hosts-router.test.ts`, `deploy/litellm-admin.sh` (the `KEY=local-hosts` key, §3.5) | `api/src/server.ts` (the one "Task B" line at the marker); `api/src/central/litellm-keys.ts` (`routerKeyLimits`, one block, §3.6) + one test in `api/test/litellm-keys.test.ts`; `deploy/test/litellm-admin.test.sh` (both keys' route checks); `deploy/service.sh` (the link-only `LOCAL_HOST_ROUTER_KEY` mount); `api/test/fake-litellm.ts` (`/model/*` handlers); `deploy/README.md` (the secrets table and the router key section) |
| **C** #381 Kernal service | `kernal/.pi/extensions/kernal-local/*` (new), `kernal/tests/local-*.test.ts` (new), `kernal/docs/local-host.md` (new: user guide) | `kernal/bin/kernal` (the `local)` dispatch block and `exec_local_runtime`); `kernal/README.md` (one "Share local models" section); `kernal/.env.example` (`KERNAL_LOCAL_TUNNEL`, `KERNAL_LOCAL_HOST_SERVER`) |

Web pages (#385, #388) are wave 3 and build on §1.7.

Merge order: this PR first. Then A, B and C in any order: B's tests seed `MemoryStore.localHosts`
and call its listener directly, so they don't need A; C's tests mock the api at §1-§2. A task built
before another merged rebases on main before review.
