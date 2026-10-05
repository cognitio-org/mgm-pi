# Central sign-in and settings: the contract

Epic #389 (children #390-#399). Status: contract. This document is what ten tasks build against
at the same time, so each section names its owner and every shape here is binding. A task that
needs to change a shape changes this file in its own PR and says so in the PR body under
"Contract changes"; the owners of the affected tasks review it.

Related: epic #378 (Local Host) authenticates with the device login from here (§12.3).

## 0. Summary

- **Login.** `kernal login` runs a device-code flow (RFC 8628 shape) against the link origin
  (`link.kernal.one`, public). The person approves on `app.kernal.one/device`, where IAP has already
  signed them in with Google. Kernal gets a 1-hour access token (`kda_`) and a rotating refresh
  token (`kdr_`), kept in the OS keychain, one login per machine.
- **Settings.** One schema of keys (§3.2). Levels fleet → group → user → profile → device → local,
  each value tagged with its source. The fleet level is the existing `fleetSettings` document,
  extended. Named profiles live on the server; a process picks one with `--profile`.
- **Keys.** Router (LiteLLM) keys per user and device, minted at login and never stored by
  Outfitter (§5); short-lived run keys for Drives (§9); optional personal provider keys in Secret
  Manager, write-only (§4).
- **Decoupling.** Device login and revoke are announced through a hooks registry
  (`central/device-lifecycle.ts`, §5.3), so CA-1 and CA-5 never edit each other's files. Each new
  store collection, route module and page lives in its own file, already wired by this PR (§13).

Terms (docs/glossary.md): **Kernal** the agent; **Drive** a cloud run; **Dongle** the old `outf_`
personal token; **Device** a machine where Kernal is signed in; **Account** a person's central
settings; **Profile** a named set of settings. UI text uses the web vocabulary file
(`packages/web/src/lib/vocabulary.ts`: `device`, `account`, `profile` entries exist).

JSON conventions: OAuth fields defined by RFC 8628/6749/7009 keep their snake_case names
(`device_code`, `access_token`, `expires_in`, `error`, `error_description`); everything else is
camelCase. Times are ISO-8601 UTC strings. Every error body is `{ "error": "<code>", ... }`.

## 1. Device-code login API (CA-1, task A, #390)

### 1.1 Ids

- **User id**: `userIdFor(email)` in `api/src/central/user-id.ts` (spec-owned): `u_` + first 24 hex
  of sha256(`"outfitter-user:" + lowercased trimmed email`). Used as LiteLLM `user_id` and in
  Secret Manager names. Never an email in either place.
- **Device id**: `dev_` + 16 characters from the base32 alphabet `a-z2-7`, random.
- **Device code record id**: a UUID.

### 1.2 Token formats (`api/src/central/device-tokens.ts`, task A)

| Token | Prefix | Body | Lifetime | Accepted by |
|---|---|---|---|---|
| Access token | `kda_` | 32 random bytes, base64url | 1 h | every `/api/*` route on link, web, all |
| Refresh token | `kdr_` | 32 random bytes, base64url | 30 days, sliding; rotated on every use | `POST /api/device/refresh`, `/revoke` only |
| Device code | `kdc_` | 32 random bytes, base64url | 10 min | `POST /api/device/token` only |
| User code | none | 8 letters from `BCDFGHJKLMNPQRSTVWXZ` | 10 min | the approve page |

All distinct from the Dongle's `outf_`. Only sha256 hex of each token is stored, like a Dongle
(`tokens.ts` `hashToken`). A user code is displayed `XXXX-XXXX`; input is normalized by
uppercasing and dropping everything outside the alphabet, then must be exactly 8 letters.

### 1.3 Link-role endpoints (public)

Registered on roles `link` and `all` only. server.ts's auth preHandler skips these four paths
(`isPublicDevicePath`, already wired); each route checks the credential in its body. Bodies are
JSON; anything malformed is `400 { "error": "invalid_request" }`.

**`POST /api/device/code`**

```json
{ "deviceName": "mbp-matthew", "platform": "darwin-arm64", "kernalVersion": "0.3.0" }
```

`deviceName` required, trimmed, 1-64 printable characters; the others optional, ≤ 64. Answer 200:

```json
{
  "device_code": "kdc_…",
  "user_code": "BCDF-GHJK",
  "verification_uri": "https://app.kernal.one/device",
  "verification_uri_complete": "https://app.kernal.one/device?code=BCDF-GHJK",
  "expires_in": 600,
  "interval": 5
}
```

`verification_uri` is `config.webOrigin` (OUTFITTER_WEB_ORIGIN) + `/device`, falling back to
`config.origin` (role all). The record stores the caller's IP (last `X-Forwarded-For` hop, the one
Cloud Run appends, else the socket address; the first hop is the caller's to forge). A user-code collision on insert retries with a new code.
Errors: `429 { "error": "rate_limited", "retryAfter": <s> }` (§1.9); `503 { "error":
"login_unavailable" }` when `config.loginAllow` is empty outside dev mode.

**`POST /api/device/token`**

```json
{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "kdc_…" }
```

- Pending, polled sooner than `interval` seconds after the last poll: `400 { "error": "slow_down",
  "interval": <new> }` and the stored interval grows by 5 s.
- Pending: `400 { "error": "authorization_pending" }`.
- Denied: `400 { "error": "access_denied" }`. Expired or past `expiresAt`: `400 { "error":
  "expired_token" }`. Unknown or already consumed: `400 { "error": "invalid_grant" }`.
- Approved: the code moves to `consumed` atomically (`transition(id, ["approved"], …)`; a loser of
  that race gets `invalid_grant`). The owner is checked against the allow-list again (§1.6;
  refused: `access_denied`). The device is created, `DeviceLifecycle.login({ device })` runs
  (§5.3), and the answer is 200:

```json
{
  "token_type": "Bearer",
  "access_token": "kda_…",
  "expires_in": 3600,
  "refresh_token": "kdr_…",
  "refresh_expires_in": 2592000,
  "device": { "id": "dev_…", "name": "mbp-matthew" },
  "account": { "email": "a@example.com", "userId": "u_…" },
  "delivery": { "routerKey": { "key": "sk-…", "baseUrl": "https://router.kernal.one/v1", "alias": "kernal-device-dev_…", "expiresAt": "…" } },
  "problems": []
}
```

`delivery` and `problems` appear only in this answer (never on refresh). `delivery` may be `{}`
(no minting configured); `problems` lists hook failures as one-line strings.

**`POST /api/device/refresh`**

```json
{ "grant_type": "refresh_token", "refresh_token": "kdr_…" }
```

- Matches the device's current `refreshHash`: rotate (new access and refresh token; the old access
  token moves to `prevAccessHash` and stays valid until its own expiry; the old refresh token
  moves to `prevRefreshHash`, valid for `REFRESH_ROTATION_GRACE_MS` = 60 s). Rotation is atomic on
  the expected refresh hash (`devices.rotate`); a loser re-reads and, if it now holds a grace
  token, is answered as below.
- Matches `prevRefreshHash` within its grace: rotate again from the current pair (answers 200).
- Matches `prevRefreshHash` after the grace (reuse): revoke the device with reason
  `refresh-reuse`, `400 invalid_grant`.
- Unknown, revoked, or past `refreshExpiresAt`: `400 invalid_grant`.
- **Allow-list re-check (#390):** before rotating, the owner must still be allowed (§1.6). If not,
  every device of that owner is revoked with reason `access-removed` (each fires
  `DeviceLifecycle.revoked`) and the answer is `400 access_denied`. Removing someone from
  IAP_MEMBERS therefore signs their Kernals out within an hour.

Answer 200 is the token answer above without `delivery` and `problems`. Kernal treats the newest
pair in its keychain as the only truth (§2.4).

**`POST /api/device/revoke`** (`kernal logout`)

```json
{ "token": "kdr_…" }
```

`token` may be a refresh or an access token of the device. Revokes the device (reason `logout`)
and fires `DeviceLifecycle.revoked`. Always `200 {}`, also for an unknown token (RFC 7009).

### 1.4 Mongo collections (`api/src/store/devices.ts`, task A; shapes are the contract)

**`deviceCodes`** (type `DeviceCode`): `{ _id, deviceCodeHash, userCode, status: pending | approved |
denied | consumed, deviceName, platform?, kernalVersion?, requestIp?, createdAt, expiresAt,
interval, lastPolledAt?, decidedBy?, decidedAt?, decidedIp?, deviceId?, expireAt: Date }`.
`expireAt` is Mongo-only (TTL), set to expiresAt + 1 h. Indexes: `{deviceCodeHash:1}` unique,
`{userCode:1}` unique, `{expireAt:1}` TTL 0.

**`devices`** (type `Device`): `{ _id: "dev_…", userId, ownerEmail, name, platform?,
kernalVersion?, kind: laptop | machine, createdAt, approvedBy, approvedIp?, loginIp?,
lastSeenAt?, lastSeenIp?, revokedAt?, revokedReason?: logout | revoked | operator |
access-removed | refresh-reuse, accessHash, accessExpiresAt, prevAccessHash?,
prevAccessExpiresAt?, refreshHash?, refreshExpiresAt?, prevRefreshHash?, prevRefreshValidUntil? }`.
Indexes: `{accessHash:1}` unique, `{prevAccessHash:1}` sparse, `{refreshHash:1}` unique sparse,
`{prevRefreshHash:1}` sparse, `{ownerEmail:1, revokedAt:1, createdAt:-1}`.

The collection interfaces (`DeviceCodesCollection`, `DevicesCollection`) are in that file and
already on `Store` (`store.deviceCodes`, `store.devices`). The index function
`ensureDeviceIndexes` is already called from `MongoStore.ensureIndexes`.

### 1.5 Web-role endpoints

Registered on roles `web` and `all`. All need a person: `req.identity` from IAP (or dev mode), never
`viaToken` (a Dongle or device token gets `403 { "error": "a person must approve this in the web
app" }`), so no signed-in Kernal can approve another.

- **`GET /api/device/pending?code=BCDF-GHJK`** → 200 `{ userCode, deviceName, platform?,
  kernalVersion?, requestIp?, requestedAt, expiresAt }` for a pending, unexpired code; else `404
  { "error": "unknown_code" }`. Rate-limited (§1.9).
- **`POST /api/device/approve`** `{ "userCode": "BCDF-GHJK", "approve": true }` → 200 `{ "status":
  "approved" | "denied", "deviceId"?: "dev_…" }`. The approver must be on the allow-list (§1.6) and
  becomes the device's owner (the person approving is the one signed in to IAP). `decidedIp` is the
  approver's IP. Not pending: `409 { "error": "not_pending" }`.
- **`GET /api/me/devices`** → 200 `DeviceRow[]`, the caller's active devices, newest first:
  `{ id, name, kind, platform?, kernalVersion?, createdAt, lastSeenAt?, lastSeenIp?, loginIp?,
  routerKey: { alias, createdAt } | null }`. `routerKey` comes from `store.routerKeys
  .findActiveForDevice` (CA-5's collection, read-only here). Never a hash.
- **`DELETE /api/me/devices/:id`** → 200 `{ id, revokedAt }`; reason `revoked`; fires
  `DeviceLifecycle.revoked`. Someone else's or unknown: `404 { "error": "device not found" }`.
- **`POST /api/operator/devices/revoke`** (`requireOperator`) `{ "email": "a@b" }` or `{ "domain":
  "@b.com" }` (tokens.ts `normalizeOwnerMatch`) → 200 `{ revoked: DeviceRow[] }`; reason
  `operator`. The same request also revokes the owner's Dongles today
  (`POST /api/operator/tokens/revoke` stays as it is).

### 1.6 Identity and the allow-list (task A, `auth.ts`)

`Identity` already has the optional `deviceId` field (this PR).

- **Device access tokens**: `identityFromRequest` (web/all) and `identityFromLinkRequest` (link)
  accept `Authorization: Bearer kda_…`. Lookup by sha256 via `devices.findByAccessHash`; valid when
  the device is not revoked and the hash is `accessHash` before `accessExpiresAt` or
  `prevAccessHash` before `prevAccessExpiresAt`. Identity: `{ email: ownerEmail, operator: false,
  viaToken: true, deviceId }`. Every refusal is the same generic 401 as a Dongle's. `lastSeenAt`
  and `lastSeenIp` are updated at most once a minute, best-effort.
- **Allow-list**: `config.loginAllow` (OUTFITTER_LOGIN_ALLOW, already in config.ts), entries in
  PREVIEW_ALLOW's format; match with `previews.ts` `parseAllowlist` (emails exact, `domain:` by
  suffix `@domain`, `group:` ignored), case-insensitive. Operators (`config.operators`) always
  count as allowed. Checked at approve, at the token exchange, at every refresh, and on every use
  of a device access token (the only re-check a machine token, §1.7, ever gets). Dev mode
  with an empty list allows everyone. Outside dev mode an empty list refuses every device login
  (`login_unavailable`) and leaves Dongles as they are today.
- **Dongles** (no new ones since CA-10; existing ones until they expire or are revoked): also refused (generic 401) when the owner is no longer allowed, on
  every use, whenever `loginAllow` is non-empty. This is the "tokens outlive the owner's access"
  fix.
- `deploy/service.sh` sets `OUTFITTER_LOGIN_ALLOW` the way it sets PREVIEW_ALLOW (IAP_MEMBERS
  plus the operators, `;`-separated) and `OUTFITTER_WEB_ORIGIN` on the link role; task A edits it.

### 1.7 Machine tokens (CI)

An operator creates one on the web: `POST /api/operator/machine-tokens { "name": "ci-e2e" }` →
201 `{ token: "kda_…", device: DeviceRow }`. It is a `Device` with `kind: "machine"`, owner = the
operator, an access token valid 90 days, no refresh token, shown on that operator's Devices page
and revoked the same way. No router key is minted for it. Task A may ship this in a follow-up PR;
the shape is fixed here.

### 1.8 Dongle fixes (#390)

1. **A Dongle can mint more Dongles.** `POST /api/me/tokens` refuses any `viaToken` caller (Dongle
   or device token) with `403 { "error": "tokens are created in the web app" }`, for both kinds.
2. **A Dongle gets operator rights on the `all` role** (`auth.ts` `identityFromRequest`, the
   `TOKEN_PREFIX` branch). Any token identity is `operator: false` on every role; only IAP and dev
   mode can be operators.
3. **Tokens outlive the owner's access.** The allow-list check of §1.6 on every Dongle use.
4. **Matej.** `deploy/config.env` `IAP_MEMBERS` gains `user:matej@mgms.eu` (owner runs
   `deploy/access.sh`; owner step).

Tests that pin today's behaviour (tokens.test.ts and friends) change with these fixes; task A
updates them.

### 1.9 Rate limits and anti-phishing

Per instance, in memory (like `VOICE_TOKENS_PER_MINUTE`; Cloud Run may run a few instances, which
only loosens them):
- `POST /api/device/code`: 10 per IP per 10 minutes.
- `POST /api/device/token`: the `slow_down` rule above; plus 120 per IP per minute.
- `GET /api/device/pending` and `POST /api/device/approve`: 20 per person per 10 minutes.

The approve page (§6) names the device, platform, Kernal version, the requesting IP and the time,
and warns in plain words when the request IP differs from the approver's. A prefilled
`?code=` never approves by itself: the person clicks Approve. Codes die after 10 minutes.

## 2. Kernal login (CA-2, task E, #391)

Module `kernal/.pi/extensions/_shared/outfitter-session.ts` (stub in this PR; signatures binding).

### 2.1 Server address

`outfitterApi()` = `OUTFITTER_API` (trimmed, no trailing slash) else `DEFAULT_OUTFITTER_API` =
`https://link.kernal.one`, baked into releases.

### 2.2 API

```ts
export const DEFAULT_OUTFITTER_API: string;
export interface SessionAccount { api: string; email: string; userId: string; deviceId: string; deviceName: string }
export interface SessionSecrets { accessToken: string; accessExpiresAt: string; refreshToken: string;
  routerKey?: { key: string; baseUrl: string; alias: string; expiresAt?: string } }
export type LoginState = { signedIn: false } | { signedIn: true; account: SessionAccount };
export interface SecretBackend { name: "keychain" | "secret-service" | "file";
  get(account: string): string | undefined; set(account: string, value: string): void; delete(account: string): void }
export function outfitterApi(env?: NodeJS.ProcessEnv): string;
export function loginState(opts?: { api?: string; email?: string }): LoginState;          // sync, no network
export function getAccessToken(opts?: { api?: string; email?: string; fetch?: typeof fetch }): Promise<string | undefined>;
export function getRouterKey(opts?: { api?: string; email?: string }): SessionSecrets["routerKey"] | undefined;  // sync
export function setRouterKey(key: NonNullable<SessionSecrets["routerKey"]>, opts?: { api?: string; email?: string }): void;
export function login(opts: LoginOptions): Promise<SessionAccount>;
export function logout(opts?: { api?: string; email?: string; fetch?: typeof fetch }): Promise<void>;
```

`getAccessToken` never throws; it returns undefined when signed out or when the server refused the
refresh (`invalid_grant`/`access_denied`: the login is then removed locally).

### 2.3 Storage

- **Index file** (no secrets): `${KERNAL_AUTH_DIR:-~/.kernal/auth}/accounts.json`, mode 0600, dir
  0700: `{ "version": 1, "accounts": [SessionAccount & { accessExpiresAt }], "defaults": { "<api>":
  "<email>" } }`. The same path for a release and a source checkout: one login per machine.
- **Secrets**: one item per account, item name `<api>|<email>`, value `JSON.stringify(SessionSecrets)`.
  Backends, chosen by `KERNAL_AUTH_BACKEND` or the first that works:
  - macOS Keychain, service `kernal-outfitter`, through `/usr/bin/security`. Writes go through
    `security -i` with the command on stdin, never with the secret on argv (argv is visible in `ps`).
  - Linux Secret Service via `secret-tool store --label="Kernal (Outfitter)" service
    kernal-outfitter account <item>` (secret on stdin) / `secret-tool lookup …`.
  - Fallback file `${KERNAL_AUTH_DIR}/<sha256(item)[:16]>.json`, mode 0600, written whole and
    renamed. Kernal says once that it is using a file.
- Never `.env`, never `process.env`.
- Several accounts may be stored; `defaults[api]` picks one unless a profile names its account
  (§2.6).

### 2.4 Refresh

- Refresh when under 2 minutes remain. Single-flight across processes: exclusive lock file
  `${KERNAL_AUTH_DIR}/<sha256(item)[:16]>.lock` (O_EXCL, stale after 30 s). Inside the lock,
  re-read the secrets and use the stored refresh token, never an in-memory copy; if another
  process already refreshed, use its pair.
- After a 401 on any request with an access token: re-read the keychain once and retry once.

### 2.5 CLI

`bin/kernal` already dispatches `kernal login | logout | whoami` to
`.pi/extensions/kernal-login/cli.ts` (stub in this PR; the directory has no index.ts, so pi never
loads it as an extension).
- `kernal login [--device-name <name>] [--no-browser]`: prints the URL and `XXXX-XXXX` code on
  stderr, opens `verification_uri_complete` unless `--no-browser`, `KERNAL_NO_BROWSER=1`, or no
  display (`$DISPLAY`/`$WAYLAND_DISPLAY` unset on Linux, an SSH session). Polls at `interval`,
  honours `slow_down`. Ctrl-C stops. Success prints `Signed in as <email> on <api> (device <name>)`
  and stores the router key from `delivery` with the tokens. Each `problems` line is printed as a
  warning. Exit 0 on success, 1 on failure.
- `kernal logout`: `POST /api/device/revoke` (best-effort, 5 s), then forget locally. Exit 0.
- `kernal whoami`: `<email> on <api> (device <name>)`, exit 0; `not signed in to <api>`, exit 1.
  `--json` prints `{ signedIn, account? }`.
- CA-10 adds the `.env` import offer to `kernal login` (§12.1).

### 2.6 Profiles on the command line

`bin/kernal` already turns `--profile <name>` / `--profile=<name>` anywhere on the command line into
`KERNAL_PROFILE` and drops the flag before pi sees it. `KERNAL_PROFILE` set in the shell works the
same way. CA-8 reads it (`central-config.ts` `activeProfile`).

### 2.7 outfitter-env.ts and the Dongle fallback

Task E changes `_shared/outfitter-env.ts`:

```ts
export interface OutfitterCredentials { api?: string; token?: string; source?: "session" | "dongle" }
export function outfitterCredentials(env?: NodeJS.ProcessEnv): OutfitterCredentials;  // sync, as today
export function outfitterBearer(creds?: OutfitterCredentials): Promise<string | undefined>;
```

- Signed in (`loginState()` for `outfitterApi()`): `{ api, token: <current access token, maybe
  stale>, source: "session" }`; `outfitterBearer()` = `getAccessToken()`.
- Else a Dongle (OUTFITTER_TOKEN, scrubbed from process.env as today): `{ api: OUTFITTER_API, token,
  source: "dongle" }` and a one-time stderr warning `OUTFITTER_TOKEN is deprecated: run kernal
  login`. `outfitterBearer()` = the Dongle.
- The consumers (teleport/outfitter-store.ts, outfitter-admin/transport.ts, outfitter-agentengine,
  _shared/fleet-settings.ts, sentry) switch from `creds.token` to `await outfitterBearer(creds)`
  where they send a request; checks like "has a Dongle" become `!!creds.token`. Task E makes these
  one-line edits in those files and nothing else there. `bin/kernal`'s `pi_memory_env` checks
  "OUTFITTER_API and OUTFITTER_TOKEN"; E extends it to "or a stored login" by testing for
  `~/.kernal/auth/accounts.json` (no node call needed).
- **CA-10 (#399) removed the Dongle branch**: signed out, `outfitterCredentials()` is
  `{ api: OUTFITTER_API, token: undefined }`, `source` is only ever `"session"`, a leftover
  `OUTFITTER_TOKEN` gets the one-time notice `Dongles are retired; run kernal login` (and is still
  scrubbed from process.env), and `pi_memory_env` tests only for `accounts.json`.

## 3. Central settings (CA-3, task C, #392)

### 3.1 Levels and rules

Levels, highest authority first: `fleet`, `group`, `user`, `profile`, `device`, `local`.
- `group` is reserved: everyone is in group `everyone` (shared with #378's access-group field); no
  group documents or writes yet; the resolver reads `group:everyone` if it ever exists.
- `local` is the machine (Kernal's own overrides file, `.env`, the shell). The server never stores
  or returns it, but the schema says whether it may set a key, so Kernal enforces the same rule.

Override rules (`OverrideRule`), applied over the levels a key's declaration allows, in order:
- `any`: the lowest level that sets the key wins. Higher values are defaults.
- `none`: the highest level that sets the key wins; lower levels are ignored. `locked` is true when
  the winner is `fleet` or `group`.
- `opt-out` (booleans only): the value is the AND of every level that sets it; source is the first
  level that set `false`, else the highest that set `true`. `locked` is true when the value is
  false (a lower level can't turn it on).
- No level sets it: the declaration's `default` (source `default`), else the key is absent.

### 3.2 Schema (`api/src/central/settings-schema.ts`; v1 is in this PR)

```ts
interface SettingDecl {
  key: string;                         // dotted: "model.default"
  type: "string" | "boolean" | "number" | "enum" | "url";
  values?: readonly string[];          // enum
  min?: number; max?: number;          // number
  integer?: boolean;                   // number: whole numbers only
  secret: boolean;                     // never cached, never in GET /api/config, never shown back
  delivery?: "login";                  // where a secret comes from
  levels: readonly SettingLevel[];     // who may set it
  override: "none" | "opt-out" | "any";
  default?: string | number | boolean;
  env?: readonly string[];             // Kernal maps these env vars onto the key at level "local"
  since: number;                       // schema version that added it
  retired?: boolean;
  description: string;
}
```

v1 keys (`SETTINGS_SCHEMA_VERSION = 1`):

| Key | Type | Secret | Levels | Override | Default | Env |
|---|---|---|---|---|---|---|
| `router.baseUrl` | url | no | fleet, local | none | `https://router.kernal.one/v1` | `LITELLM_BASE_URL` |
| `router.key` | string | yes, delivery login | device, local | any | | `LITELLM_AGENT_KEY`, `LITELLM_API_KEY` |
| `model.provider` | enum litellm/lmstudio/openrouter | no | fleet, user, profile, device, local | any | `litellm` | |
| `model.default` | string | no | same | any | | |
| `model.thinking` | enum off/minimal/low/medium/high/xhigh | no | same | any | | |
| `compaction.summaryModel` | string | no | same | any | | `KERNAL_SUMMARY_MODEL` |
| `compaction.masking` | boolean | no | same | any | true | |
| `memory.mode` | enum off/tool/auto | no | same | any | | |
| `voice.enabled` | boolean | no | same | any | false | |
| `voice.language` | string | no | same | any | `en` | |
| `localHost.shareModels` | boolean | no | user, profile, device, local | any | false | |
| `telemetry.sentry.enabled` | boolean | no | fleet, local | opt-out | false | |
| `telemetry.sentry.dsn` | url | no | fleet | none | | |
| `telemetry.sentry.tracesSampleRate` | number 0..1 | no | fleet | none | 0.05 | |
| `router.deviceKey.durationDays` | number 1..365, integer | no | fleet | none | 90 | |
| `router.deviceKey.maxBudgetUsd` | number 0..100000 | no | fleet | none | 50 | |
| `router.deviceKey.budgetPeriodDays` | number 1..365, integer | no | fleet | none | 30 | |
| `router.deviceKey.rpmLimit` | number 1..100000, integer | no | fleet | none | 120 | |
| `router.keys.models` | string, comma-separated | no | fleet | none | (unset: every model) | |
| `router.runKey.maxBudgetUsd` | number 0..100000 | no | fleet | none | 20 | |

v2 keys (`SETTINGS_SCHEMA_VERSION = 2`, #424), stored in the fleet document's `telemetry.sentry`
with the three Sentry keys above and set at the fleet level only while Sentry is on:

| Key | Type | Secret | Levels | Override | Default | Env |
|---|---|---|---|---|---|---|
| `telemetry.sentry.logs` | boolean | no | fleet, local | opt-out | false | |
| `telemetry.sentry.metrics` | boolean | no | fleet, local | opt-out | false | |
| `telemetry.sentry.agentTraces` | boolean | no | fleet, local | opt-out | false | |
| `telemetry.sentry.agentContent` | boolean (needs agentTraces) | no | fleet, local | opt-out | false | |
| `telemetry.sentry.profilesSampleRate` | number 0..1 | no | fleet | none | 0 | |

v3 keys (`SETTINGS_SCHEMA_VERSION = 3`, #440), the curated OpenRouter list. Each is a string of
comma-separated model ids. There is one add and one remove key per level, so the levels combine
instead of the lowest one replacing the list.

Kernal builds the list from its defaults, then applies each level's removes and adds in this order:
the fleet's adds, the user, the profile, then this machine. A nearer level wins: this machine can
add back a model your account removed. The fleet's removals are applied last and always win.
`OPENROUTER_MODELS` in `.env` replaces the defaults and every add; fleet removals still apply.

| Key | Type | Secret | Levels | Override | Default | Env |
|---|---|---|---|---|---|---|
| `openrouter.models.fleetAdd` | string (ids) | no | fleet | none | | |
| `openrouter.models.fleetRemove` | string (ids) | no | fleet | none | | |
| `openrouter.models.add` | string (ids) | no | user | any | | |
| `openrouter.models.remove` | string (ids) | no | user | any | | |
| `openrouter.models.profileAdd` | string (ids) | no | profile | any | | |
| `openrouter.models.profileRemove` | string (ids) | no | profile | any | | |
| `openrouter.models.localAdd` | string (ids) | no | local | any | | |
| `openrouter.models.localRemove` | string (ids) | no | local | any | | |

`router.key` is never stored by Outfitter: it is the device's CA-5 key, which Kernal reads from its
keychain (`getRouterKey`, §2.2). It is declared so `/config` and `/admin` can show its source.
Personal provider keys are not settings (§4). `telemetry.sentry.enabled`'s local level (and the
#424 signals') is this machine's config layer, `~/.kernal/config.local.json`, which `/sentry off`
and `/admin` both write; the legacy `kernal.sentry: false` in settings.json still counts as `false`.

The `router.deviceKey.*`, `router.keys.models` and `router.runKey.*` keys are the router key limits
(§5.2, owner decision of 2026-10-04): operators set them at the fleet level only (`PUT
/api/operator/config/fleet`) and nothing below can change them. The api reads them when it mints a
key, so a change applies to the next key minted, never to keys already out. They are added to v1
because no v1 schema has been released yet; Kernal ignores them (they are not in its
`KNOWN_SETTINGS`), and run.spec.settings leaves out every `router.*` key. The web account page
lists them read-only under "From the fleet", at their default when the fleet sets none. There is no
operator editor for fleet values in the web app yet (Settings → Telemetry edits only Sentry).

### 3.3 Storage

- **Fleet**: the existing `fleetSettings` document (`_id: "fleet"`). `FleetSettings` gains
  `values?: Record<string, SettingValue>` and `version?: number` (absent = 0). The three
  `telemetry.sentry.*` keys stay in `telemetry.sentry` and are read from there (no duplicate in
  `values`); every other fleet key is in `values`. Both writers (`PUT
  /api/operator/fleet-settings` and §3.5's fleet write) bump `version`. `GET /api/fleet-settings`
  stays as it is for older Kernals.
- **Group, user, profile, device**: collection **`settings`** (`api/src/store/settings.ts`, type
  `SettingsDoc`): `{ _id, level: group | user | profile | device, userId?, name?, isDefault?,
  deviceId?, values: Record<string, SettingValue>, version, createdAt, updatedAt, updatedBy }`.
  Ids from `settingsDocId`: `group:<groupId>`, `user:<userId>`, `profile:<userId>:<name>`,
  `device:<deviceId>`. Index `{level:1, userId:1, name:1}`. Collection interface `SettingsCollection`
  (`get`, `listProfiles`, `put(doc, expectedVersion)`, `delete(id, expectedVersion)`,
  `setDefaultProfile`) is on `Store` (`store.settings`).
- **Profiles**: names match `^[a-z0-9][a-z0-9-]{0,31}$`. At most one `isDefault` per user. A user
  starts with no profiles; with none, resolution skips the profile level.

### 3.4 `GET /api/config?profile=<name>&device=<id>`

Resolver: `api/src/central/settings-resolver.ts` `resolveConfig(store, fleet, { email, profile?,
deviceId? })` (stub resolving defaults in this PR; signature binding, used by CA-6 too). Throws
`UnknownProfileError` for a profile the user doesn't have.

- `profile` absent: the user's default profile, if any. Unknown: `404 { "error": "unknown_profile",
  "profiles": [...] }`.
- `device`: on link with a device token it defaults to, and may only be, the caller's own device
  (`req.identity.deviceId`); another id is `403`. On web it may name any of the caller's own
  devices (for the account page) or be absent.
- Answer 200 (`ConfigResponse`, in settings-schema.ts):

```json
{
  "schemaVersion": 1,
  "account": { "email": "a@example.com", "userId": "u_…" },
  "profile": "work",
  "profiles": ["personal", "work"],
  "deviceId": "dev_…",
  "values": {
    "model.default": { "value": "claude-auto-llm", "source": "profile", "sourceName": "work", "override": "any", "locked": false, "localAllowed": true },
    "telemetry.sentry.enabled": { "value": false, "source": "default", "override": "opt-out", "locked": true, "localAllowed": true }
  },
  "versions": { "fleet": 3, "user": 5, "profile": 2, "device": 0 },
  "resolvedAt": "2026-10-04T10:00:00.000Z"
}
```

Secret keys are never in `values`. `telemetry.sentry.dsn` is included only while Sentry is on (the
same rule as `clientFleetSettings`).

### 3.5 Reading and writing levels (versioned)

Every editable document answers with `ETag: W/"<version>"` and a write needs `If-Match: W/"<version>"`
(version 0 = "doesn't exist yet"). Missing If-Match: `428 { "error": "if_match_required" }`. Stale:
`409 { "error": "stale_version", "current": <document or null> }`; never a silent overwrite.

Body of every value write: `{ "values": { "<key>": <value> | null } }`, merged into the document
(`null` removes the key). Each key must be declared, not retired, not secret, allowed at that level,
and valid for its type: else `400 { "error": "invalid_value" | "unknown_key" | "level_not_allowed",
"key": "<key>" }`. Answers return the document view `{ id, level, name?, isDefault?, values,
version, updatedAt }`.

| Route | Who |
|---|---|
| `GET /api/config/schema` → `{ schemaVersion, settings: SettingDecl[] }` (non-retired) | any signed-in caller |
| `GET`/`PUT /api/config/user` | the user |
| `GET /api/config/profiles` → `SettingsDocView[]` | the user |
| `POST /api/config/profiles` `{ name, copyFrom? }` → 201 (409 `profile_exists`) | the user |
| `GET`/`PUT /api/config/profiles/:name` | the user |
| `PATCH /api/config/profiles/:name` `{ rename?, isDefault?: true }` (If-Match) | the user |
| `DELETE /api/config/profiles/:name` (If-Match) → 204 | the user |
| `GET`/`PUT /api/config/devices/:deviceId` (own active devices only, else 404) | the user |
| `GET`/`PUT /api/operator/config/fleet` (web/all, `requireOperator`) | operators |

Who "the user" can be: on web, an IAP person; on link, a device token. A Dongle may `GET
/api/config` and `GET /api/config/schema` only (until CA-10), never write. All routes live in
`api/src/routes/config.ts` (registered by this PR), on every role except the operator route.

The fleet write accepts every key whose levels include `fleet`; the three Sentry keys are written
into `telemetry.sentry` with the same validation as `parseSentryUpdate`, and the instance cache is
updated (`ctx.fleetSettings.set`).

### 3.6 Schema versions

A key is never renamed and never changes type. A new key gets `since: N+1` and bumps
`SETTINGS_SCHEMA_VERSION`; a dropped key stays declared with `retired: true` and is no longer
returned. Kernal ignores keys it doesn't know and keys whose value doesn't match the type it
expects, so an older Kernal keeps working against a newer server.

## 4. Personal provider keys (CA-4, task D, #393)

- **Providers** (v1): `openrouter`, `deepgram`, `openai`, `anthropic`, `gemini`. Kernal env names:
  `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
- **Secret Manager**: one secret per user and provider, named
  `outfitter-user-<userId>-<provider>` (`userId` from §1.1, never an email). Written with
  `SecretAdmin.addVersion`, removed with `SecretAdmin.disableAllEnabled`. Metadata in collection
  **`providerKeys`** (`api/src/store/keys.ts`, `ProviderKeyMeta`): `{ _id: "<userId>:<provider>",
  userId, provider, secretName, last4, setAt, setBy }`, index `{userId:1}`.
- **Value**: 8-512 printable ASCII characters, no whitespace; else `400 invalid_value`.
- **Write-only API** (web role for people; link role for device tokens, so `/admin` can write):
  - `GET /api/me/provider-keys` → `[{ provider, last4, setAt }]`
  - `PUT /api/me/provider-keys/:provider` `{ "value": "…" }` → 200 `{ provider, last4, setAt }`
  - `DELETE /api/me/provider-keys/:provider` → 204
  Unknown provider: `400 unknown_provider`. No route ever returns a value to the web.
- **Delivery to Kernal**: `POST /api/device/provider-keys` (link/all, device token only: a
  request without `req.identity.deviceId` gets 403) → 200 `{ "keys": { "openrouter": "sk-…" } }`.
  Kernal (CA-8) calls it at start-up in the background, keeps the values in memory only
  (`central-config.ts` `providerKey`), never in a cache file, and hands them to the backend that
  needs them without putting them in `process.env` where it can. `mcp.json`'s `${VAR}`
  substitution is the known exception.

## 5. Router keys per user and device (CA-5, task D, #394)

### 5.1 Configuration

- `config.litellmAdminKey` from the existing **`LITELLM_ADMIN_KEY`**, Secret Manager
  **`outfitter-litellm-admin`**, which `deploy/service.sh` has long mounted on both api services
  (web and link; the link role mints at the token exchange). The key is minted by
  `deploy/litellm-admin.sh` (#403): LiteLLM user `outfitter-svc` (proxy_admin) with
  `allowed_routes` limited to that script's `ALLOWED_ROUTES`, which list every route below. The
  same key also serves the provider status probe (`/health/liveliness`, `/model/info`, `/key/info`).
  Owner decision: mounted on both roles (accepted). Never on the agent job, never sent to a Drive or
  laptop. Unset: `createLitellmKeys` returns undefined and nothing mints (logins carry no router
  key, runs keep today's shared keys).
- `config.litellmBaseUrl` is where keys are minted and the `baseUrl` sent with each key.

### 5.2 Keys

All through LiteLLM's management API (`/user/new`, `/user/info`, `/user/list`, `/key/generate`,
`/key/delete`, `/team/list`, `/team/new`, `/spend/logs`); task D checks each field against
LiteLLM's docs and mocks LiteLLM in every test.
- **User**: `user_id = userId`, `user_email = email`. Created at first login (idempotent).
- **Device key**: `key_alias = kernal-device-<deviceId>`, `user_id`, `duration` (default `"90d"`),
  `max_budget` (default 50 USD), `budget_duration` (default `"30d"`), `rpm_limit` (default 120),
  `models` (default unset: every model the proxy allows), `metadata = { outfitter: "device",
  deviceId, deviceName }`.
- **Run key** (§9): `key_alias = outfitter-run-<runId>`, `user_id` of the session owner, `duration`
  = the run's seconds, `max_budget` (default 20 USD), `models` (as device keys), `metadata = {
  outfitter: "run", runId, sessionId }`.
- **Limits are central settings** (§3.2, fleet level only): `router.deviceKey.durationDays`,
  `.maxBudgetUsd`, `.budgetPeriodDays`, `.rpmLimit`, `router.keys.models` (both kinds) and
  `router.runKey.maxBudgetUsd`. `routerKeyLimits(fleet)` (`central/litellm-keys.ts`) resolves them
  through `resolveKey` at each mint (device login hook, `POST /api/device/router-key`, `RunKeys`);
  the defaults are the schema's, equal to the module constants. Model access per key is where
  #378's `local/...` question will be enforced.
- **Record**: collection **`routerKeys`** (`store/keys.ts`, `RouterKey`): `{ _id: alias, alias,
  kind: device | run | system, userId?, ownerEmail?, deviceId?, runId?, litellmTokenId?, models?,
  maxBudget?, budgetDuration?, createdAt, expiresAt?, deletedAt?, deleteFailedAt? }`; never the key.
  Indexes `{deviceId:1, deletedAt:1}`, `{userId:1, deletedAt:1}`, `{deletedAt:1, deleteFailedAt:1,
  expiresAt:1}`.

### 5.3 Device lifecycle hooks (spec-owned, in this PR)

`api/src/central/device-lifecycle.ts`:

```ts
interface LifecycleDevice { id; userId; ownerEmail; name; platform?; kernalVersion? }
interface DeviceDelivery { routerKey?: { key; baseUrl; alias; expiresAt? } }
interface DeviceLifecycleHook {
  name: string;
  onLogin?(e: { device: LifecycleDevice }): Promise<DeviceDelivery | void>;
  onRevoked?(e: { device: LifecycleDevice; reason: DeviceRevokedReason }): Promise<void>;
}
class DeviceLifecycle {
  register(hook: DeviceLifecycleHook): void;
  login(e): Promise<{ delivery: DeviceDelivery; problems: string[] }>;   // never throws
  revoked(e): Promise<void>;                                              // never throws
}
```

- server.ts builds one `DeviceLifecycle`, calls `registerLitellmDeviceHooks(lifecycle, litellmKeys,
  config)` (task D's function, stub in this PR), and puts it on `RouteContext.deviceLifecycle`.
- Task A calls `ctx.deviceLifecycle.login({ device })` at the token exchange, after the device is
  stored and before answering, and `ctx.deviceLifecycle.revoked({ device, reason })` after every
  revoke (logout, web, operator, access-removed, refresh-reuse). A imports nothing from D.
- Task D's hook: `onLogin` → `ensureLitellmUser` + `mintDeviceKey` → `{ routerKey }`; `onRevoked` →
  `deleteKey({ alias: "kernal-device-<id>" })`. D imports nothing from A except the types above.
- A hook that fails never fails the login or the revoke; `problems` says why (no secret in it).

### 5.4 Module interface (`api/src/central/litellm-keys.ts`, task D)

```ts
interface MintedKey { key: string; alias: string; tokenId?: string; expiresAt?: string }
interface KeyLimits { models?: string[]; maxBudget?: number; budgetDuration?: string; rpmLimit?: number }
interface LitellmKeys {
  ensureLitellmUser(user: { userId: string; email: string }): Promise<void>;
  mintDeviceKey(a: { userId; email; deviceId; deviceName } & KeyLimits): Promise<MintedKey>;
  deleteKey(ref: { alias: string } | { tokenId: string }): Promise<void>;
  mintRunKey(a: { userId; email; runId; sessionId; durationSeconds } & KeyLimits): Promise<MintedKey>;
  ensureTeam(teamAlias: string): Promise<string>;
  userSpend(userId: string, month: string): Promise<UserSpend>;
  allUsersSpend(month: string): Promise<Array<{ userId; email?; total }>>;
}
function createLitellmKeys(config, store, opts?: { fetch?; log? }): LitellmKeys | undefined;
function registerLitellmDeviceHooks(lifecycle, keys: LitellmKeys | undefined, config): void;
```

`ctx.litellmKeys` is set when configured. Tests inject one built on a fake `fetch`
(`buildTestApp(env, { litellmKeys })`, already supported). `mintDeviceKey` deletes the device's
previous key first. `deleteKey` treats "not found" as deleted; on any other failure it records
`deleteFailedAt` and throws.

### 5.5 Re-mint and clean-up

- **`POST /api/device/router-key`** (link/all, device token only) → 200 `{ routerKey }`: deletes
  the device's key and mints a new one. Kernal calls it when its key is within 7 days of
  `expiresAt` or the router answered 401 for the key (CA-8), then `setRouterKey`. After a 401 it
  first reads the keychain again (#443): a different key there means another Kernal signed in
  again (revoking this device and its key), so that key is adopted and nothing is minted. Only a
  keychain that still holds the refused key leads to a re-mint (once per process).
- **Sweep**: the link role's `/api/hooks/tick` (existing Cloud Scheduler tick) calls a
  `sweepRouterKeys()` exported by task D, which retries deletes in `listPendingDelete(50)`. Task D
  adds that one call to the tick handler.

## 6. Web: approve page and Devices page (CA-1 web, task B, #390)

- **`/device`** (`pages/DeviceApprovePage.tsx`, stub in this PR): reads `?code=`, or asks for the
  code (format `XXXX-XXXX`, normalized as §1.2). Shows `GET /api/device/pending`'s device name,
  platform, Kernal version, request IP and time, with the IP warning of §1.9 (compare with the
  approver's IP: B may add `ip` to `GET /api/me`'s answer, task A's file, as one additive field, or
  skip the comparison). Buttons Approve / Deny → `POST /api/device/approve`. Afterwards: "You can
  close this tab; Kernal is signed in." Errors use `SystemErrorDialog`/`SyntaxError` as the other
  pages do.
- **`/devices`** (`pages/DevicesPage.tsx`, stub): `GET /api/me/devices` table (name, platform,
  last seen, IP, router key yes/no), Sign out per row → `DELETE /api/me/devices/:id` with a
  confirm. It replaces the Dongles page in the nav: B removes the `/tokens` nav entry and drops
  `operatorOnly: true` from the `/devices` line in App.tsx; the `/tokens` route stays until CA-10.
  The page explains `kernal login` in one line.
- API calls: `web/src/api/devices.ts` (`devicesApi`, in this PR).

## 7. Web: account settings (CA-7, task H, #396)

`pages/AccountPage.tsx` (stub in this PR), route `/account`; H drops `operatorOnly: true` from the
`/account` nav line when the page works. H may split it into components under
`web/src/components/account/`.
- **Profiles**: list, create (optionally copying another), rename, make default, delete; edit each
  profile's values with controls generated from `GET /api/config/schema` (only keys whose levels
  include `profile`). A 409 shows "changed elsewhere, reload" and never overwrites.
- **Account-wide values** (the `user` level): same editor.
- **Where values come from**: `GET /api/config?profile=` drives a read-only "effective value" column
  with its source; `locked` values (fleet wins) are shown read-only with "set by your Sysop".
- **Keys**: personal provider keys, write-only: shows `…last4` and the date, Set/Replace/Remove.
- **Local models**: the `localHost.shareModels` toggle at the user level (per profile and per
  device optional).
- **Spend**: §8, this month by device and by model; operators also see every user.
- API calls: `web/src/api/account.ts` (`accountApi`, in this PR; its types mirror §3-§8).

## 8. Spend (task D for the API, task H for the page)

- **`GET /api/me/spend?month=YYYY-MM`** (web/all; default the current UTC month) → `UserSpend`:
  `{ month, currency: "USD", total, byDevice: [{ alias, deviceId?, deviceName?, kind: device | run,
  spend }], byModel: [{ model, spend }], fetchedAt }`. Read from LiteLLM (`/user/info`,
  `/spend/logs`), cached per user for 5 minutes per instance. No admin key configured: `503 {
  "error": "spend_unavailable" }`.
- **`GET /api/operator/spend?month=`** (`requireOperator`) → `{ month, total, users: [{ userId,
  email?, total }] }`.
- Both in `api/src/routes/keys.ts`.

## 9. Drives: run keys and settings in run.spec (CA-6, task I, #395; after C and D)

- **Run keys**: when `ctx.litellmKeys` is set and the session has an owner, `buildRunSpec`
  (agentlink.ts) mints `mintRunKey({ userId: userIdFor(owner), email: owner, runId, sessionId,
  durationSeconds })` and sends it as `spec.secrets.litellmKey` instead of the shared
  `outfitter-litellm-key-<guruId>`/`-default`. `durationSeconds` covers the run's idle stop plus a
  margin (I picks the formula, at most 24 h). A reconnect of a running run never mints again
  (agentd keeps its first spec). The key is deleted when the run reaches a terminal state (I finds
  the one place runs end) and LiteLLM's `duration` kills a missed one. A2A sessions keep their
  tape's dedicated key (unchanged). Without minting: today's behaviour.
- **Outfitter's own calls** (gurus, summaries, extraction, Agent Engine): a `system` team. I calls
  `ensureTeam("outfitter-system")` and documents in the PR body which existing key the owner moves
  into that team (owner step); where a person triggered the call, the request carries LiteLLM's
  `user` field set to their userId.
- **Settings**: `RunSpecMessage` (agentlink.ts) and agentd's `RunSpec` (agentd/src/protocol.ts) gain
  `settings?: { schemaVersion: number; profile: string | null; values: Record<string, { value; source; sourceName? }> }`,
  from `resolveConfig(store, fleet, { email: owner })` (the owner's default profile; no device
  level). agentd applies the keys it knows (at least `model.default` when the tape names no model,
  `compaction.*`, `memory.mode` as a fallback to the tape's own) and ignores the rest. Fleet
  telemetry keeps flowing through `spec.telemetry` unchanged.

## 10. Kernal reads central settings (CA-8, task F, #397; after E)

Module `kernal/.pi/extensions/_shared/central-config.ts` (stub in this PR; signatures binding):

```ts
type ConfigSource = "fleet" | "group" | "user" | "profile" | "device" | "default" | "local" | "dotenv" | "env";
interface ConfigValue { value; source: ConfigSource; sourceName?; override; locked: boolean }
interface ResolvedConfig { api: string | null; account: string | null; profile: string | null;
  schemaVersion: number; values: Record<string, ConfigValue>; fetchedAt: string | null; fromCache: boolean }
function activeProfile(env?): string | undefined;          // KERNAL_PROFILE
function resolve(profile?): ResolvedConfig;               // sync; resolved once per process and kept
function getValue<T>(key: string): T | undefined;
function refreshConfig(opts?: { profile?; fetch? }): Promise<ResolvedConfig | undefined>;
function setLocalOverride(key: string, value: SettingValue | undefined): void;
function providerKey(provider: string): string | undefined;   // §4, memory only
```

- **Start-up never waits on the network**: `resolve` reads the cache; a background `refreshConfig`
  fetches `GET /api/config?profile=` with `outfitterBearer()` and rewrites the cache. A changed value
  takes effect at the next start or on `/config reload`. The process keeps its profile.
- **Cache**: `~/.kernal/config-cache/<sha256(api + "|" + email + "|" + (profile ?? ""))[:16]>.json`
  (`KERNAL_CONFIG_CACHE_DIR` overrides), mode 0600: `{ api, email, profile, fetchedAt, response:
  ConfigResponse }`. Non-secret values only (the server sends no secrets there anyway). Older than
  30 days, or written for another api/account/profile: ignored.
- **Order** (later wins, within the key's override rule; local, dotenv and env all count as level
  `local`): central → this machine's overrides (`~/.kernal/config.local.json`, `{ "version": 1,
  "values": { key: value } }`) → `.env` (legacy; one warning per key per process: "<VAR> in .env is
  deprecated: /admin can save it to your account or this machine") → the shell environment.
  `router.key` resolves from the keychain (`getRouterKey`) at level `device`, below local.
- **Delivery**: the router base URL and key come from the resolution, not `LITELLM_AGENT_KEY` in
  `.env`. F makes connect read them: one minimal edit in `connect/index.ts` `loadEnv` (layer
  `router.baseUrl`/`router.key` under the env), nothing else in connect.
- **Signed out**: no central layer; everything works from local layers as today, and LM Studio
  works offline.
- **`/config`** (new extension `kernal/.pi/extensions/kernal-config/`): lists every known key, its
  value (secrets masked), source and lock; `/config reload` refreshes and re-resolves;
  `/config profile` prints the active profile and the account's profiles.
- **`/setup`** becomes: "run `kernal login`, then manage settings at <web origin>/account"; F edits
  the `/setup` text in connect only.
- `_shared/fleet-settings.ts` keeps working for Dongle-only laptops; signed in, sentry reads its
  three keys from central-config (F changes the sentry extension's source, task E having already
  switched its bearer).

### 10.1 Applying the personal keys (CA-11, #437)

`model.provider`, `model.default`, `model.thinking`, `compaction.summaryModel`,
`compaction.masking`, `memory.mode`, `voice.enabled`, `voice.language` (`accountFirst` in Kernal's
`KNOWN_SETTINGS`) are applied, not only shown. Their order differs from the one above (rule `any`
still, so nothing is locked):

1. this machine (`config.local.json`, source `local`);
2. the account, as the server resolved it: device → profile → user;
3. legacy local values (source `legacy`, `sourceName` says where; `/config` shows "<where>
   (legacy)"): settings.json `defaultProvider`/`defaultModel` (as a pair) and
   `defaultThinkingLevel`, unless equal to the release's `settings.shipped.json`;
   `kernal.compaction.summaryModel`/`masking`; `kernal.memory`; pi-listen's `voice.enabled`/
   `voice.language`; `KERNAL_SUMMARY_MODEL` in .env (still warned about), then in the shell;
4. fleet and group; then the default.

Where each applies (`_shared/central-apply.ts`): only a value from this machine or from Outfitter
is applied over what pi, pi-listen and compaction read for themselves; a legacy value or a default
changes nothing, so an unconfigured Kernal starts as before.
- **Model and thinking**: pi chooses its start-up model from settings.json before any extension's
  `session_start`, and has no hook to change that choice earlier, so `kernal-config` switches a
  new, empty session (`session_start` reasons `startup` and `new`) once with `pi.setModel` and
  `pi.setThinkingLevel` (pi's supported extension API). Never a session with messages (resume,
  fork, continue), never over `--model`/`--models`/`--provider`/`--thinking`, never in a Drive;
  pi's per-model `modelThinkingLevels` still wins over `model.thinking`. A change therefore reaches
  the next session; a running conversation never switches model. Writing settings.json before pi
  starts was rejected: it would turn every central value into a "legacy" one, so removing it from
  the account would leave the machine on it.
- **Compaction**: read on every use; this machine and the account from the resolution, the legacy
  places live (as before), then the fleet.
- **Memory**: decided at start. `outfitter-agentengine/laptop.ts` (`chosenMode`) and `bin/kernal`
  decide the same way; bin/kernal runs before pi, so central-config writes the signed-in resolution
  (non-secret: `values`, `sources`, and the personal keys' `fleet` values) to
  `<cache dir>/effective.json` (`effective.<profile>.json` with `--profile`), one key per line so a
  shell without node reads it with sed. Rewritten on each resolve, refresh and local save.
- **Voice**: written into pi-listen's settings (at kernal-voice's load, the start-up refresh,
  `/config reload` and `/admin` saves); pi-listen reads them at its next `session_start`.
- **Mid-session**: the start-up refresh takes over the personal keys' fresh values at once (the
  rest still waits for the next start or `/config reload`); `/config` says when each kind applies.
- **Drives**: agentd passes the owner's settings to Kernal as `KERNAL_RUN_SETTINGS` (values and
  each one's source level); inside a sandbox central-config reads them as the central layer, ranked
  with the fleet so the tape and its env stay in charge (agentd already turns `model.default`,
  `model.thinking` and `compaction.summaryModel` into the guru's model, thinking and env).

## 11. /admin (CA-9, task G, #398; after F)

`kernal/.pi/extensions/kernal-admin/*` only.
- Each value shows its source from `resolve()`: "fleet", "your account", "profile <name>", "this
  machine", ".env", "shell".
- **Edit target** per save: "Save to my account (profile <name>)" → `PUT
  /api/config/profiles/:name` (or `/api/config/user` with no profile) on the link origin with
  `outfitterBearer()`, with If-Match from the last `GET`; 409 shows "changed elsewhere, reload".
  "Only this machine" → `setLocalOverride`.
- Signed in, keys typed into `/admin` go to `PUT /api/me/provider-keys/:provider` (link), not `.env`.
- `locked` values are read-only with "set by your Sysop".
- Signed out: exactly today's behaviour (.env and settings.json).
- **Default model (CA-11, #437)**: signed in, the Model page and `/connect` (TUI: `ctx.ui.select`)
  offer the same two targets for a newly chosen default, through the same versioned PUT
  (`saveModelDefault`: `model.provider` and `model.default`); an account save also clears this
  machine's own `model.*` overrides, which would otherwise keep winning there. Both still write
  settings.json (pi's own default). Signed out, without a UI, or on Escape: settings.json only.
  Saves say when each key applies (`whenSaved`).
- **A default set inside Kernal goes to the account (owner decision 2026-10-04, #437)**: pi's model
  picker Ctrl+S ("set as default"), the default thinking level and pi's `/login` default model are
  written by pi itself to settings.json (`defaultProvider`+`defaultModel` as a pair,
  `defaultThinkingLevel`). Kernal (`_shared/default-sync.ts`, registered by kernal-config) saves
  each such change to the account (active profile, else the user level) through the same versioned
  PUT (`saveAccountDefaults`: GET for the version, PUT with If-Match; a 409 refetches the version
  and retries once), so new sessions on every machine start with it. pi 0.87's `model_select` /
  `thinking_level_select` carry no persist flag, so the change is detected in settings.json against
  a record of the three keys as last seen (`kernal-defaults-synced.json` next to settings.json):
  created from settings.json when missing, moved on after Kernal's own writes (`/connect`, the Model
  page: `noteOwnDefaultsWrite`) and after every sync. It is checked a moment after those events (pi
  queues its write), and at `session_start` and `agent_start` (a Ctrl+S that emits nothing, or one
  made just before quitting). No fs.watch. Per-session changes (Enter in the picker, cycling, a
  session's thinking level) never write settings.json and never reach the account. Signed out, in a
  Drive, or without kernal-admin: nothing is sent and the record moves on. A failure (offline, 401,
  a second 409, a refused value) never breaks the session; one notice says it stays on this machine.
  On success a `config.local.json` pin of the same key is removed (the notice says so), so the new
  default applies on this machine too. A backend outside `model.provider`'s choices is saved as
  `model.default = "<provider>/<id>"`.

## 12. Migration (CA-10, task J, #399; after E and F)

1. `kernal login`, after success, offers to upload the provider keys found in `.env`
   (`OPENROUTER_API_KEY`, …; never `LITELLM_AGENT_KEY`, which the device key replaces) to the
   account (`PUT /api/me/provider-keys/:provider`), then removes them from `.env` with connect's
   `writeEnvValues`. Asks once per key; never in `-p` mode.
2. Retire the paste-a-Dongle flow (owner decision 2026-10-05): the Tokens page no longer creates
   Dongles (it lists existing ones, marked retired, and still revokes them), Kernal no longer reads
   `OUTFITTER_TOKEN` (`outfitter-env.ts`; a leftover one gets one notice, "Dongles are retired; run
   kernal login", and is scrubbed from the environment), and `POST /api/me/tokens` refuses kind
   `dongle` (and a missing kind) with 410. A2A keys are unchanged. Existing Dongles keep
   authenticating until they expire or are revoked: auth does not reject them.
3. Update `kernal/.env.example`, the READMEs and the setup docs.
4. Rework #381, #382, #383 (Local Host) to authenticate with the device login: issue comments.
5. Drives use per-run keys only: `deploy/config.env` sets `OUTFITTER_RUN_KEY_FALLBACK=0`, so a
   failed mint is a retryable run.spec failure (§9), never the shared key.
6. Blocking the shared router keys is an owner step (§14) with `deploy/litellm-retire-keys.sh`:
   `system-key` moves Outfitter's own calls (`outfitter-litellm-key-default`) from `MGM-Pi` (a key of
   the owner's proxy_admin login) to an `outfitter-system` internal_user key in the
   `outfitter-system` team; `block` then blocks `MGM-Pi`, `agent-testing` and
   `litellm-autorouter-testing-c` (Matej's: he runs `kernal update && kernal login`). Not blocked
   for now: `UPSTREAM_LITELLM_API_KEY`, `ROUTER_ADMIN_KEY`, `local-test`, `cognitio-mgmsr`.

## 13. File ownership

Rules:
- A task creates and edits only the files in its row. "(stub)" files exist in this PR; the task
  replaces the stub body and keeps the exported names and signatures (adding is fine).
- **Spec-owned files** (no task edits them; a change goes through this spec in its own PR):
  `api/src/central/user-id.ts`, `api/src/central/device-lifecycle.ts`,
  `api/test/central-contract.test.ts` (a task whose change breaks one of its assertions updates
  that assertion and says so under "Contract changes"), the scaffold wiring lines
  this PR added to `routes/index.ts`, `routes/context.ts`, `store/types.ts` (the `Store` fields),
  `store/memory.ts`, `store/mongo.ts`, `server.ts`, `config.ts` (the three new fields),
  `web/src/App.tsx` (routes), `web/src/lib/vocabulary.ts`, `web/src/lib/glossary.ts`,
  `docs/glossary.md`, `web/src/api/client.ts` (`request` export), and `kernal/bin/kernal`'s
  `--profile` block and `login|logout|whoami` dispatch.
- **Contract types inside a task's own files** (store document shapes, `LitellmKeys`,
  `SettingDecl`, `ConfigResponse`, the Kernal module signatures): the owner may add optional fields
  and new functions; changing or removing one needs a spec change.
- **Shared files** a task may touch: one-line or one-block **additive** edits only, named here.
  Nothing else in them changes. If two tasks touch the same shared file, they touch different
  lines.
- New tests go in new test files named after the task's module (`test/device-login.test.ts`, ...).
  Existing tests are edited only where the task's behaviour change requires it.
- The vocabulary/glossary entries needed (`device`, `account`, `profile`) are already in; a task
  needing another one asks in its PR body and adds it as one additive line.

| Task | Owns (create/modify) | Additive edits allowed in shared files |
|---|---|---|
| **A** CA-1 api (#390) | `api/src/central/device-tokens.ts`, `api/src/central/device-login.ts` (new: flow logic, allow-list), `api/src/store/devices.ts`, `api/src/routes/device.ts`, `api/src/auth.ts`, `api/src/routes/tokens.ts` (Dongle fix 1), `api/test/device-*.test.ts`, tests pinning old Dongle behaviour (`tokens.test.ts`, `token-verification.test.ts`, `auth.test.ts`, `roles.test.ts` as needed) | `api/src/routes/me.ts` (optional `ip` field for B); `api/src/server.ts` (pass `config` to `identityFromLinkRequest` in the auth preHandler, one line, so Dongle fix 3 runs on link); `deploy/service.sh` (OUTFITTER_LOGIN_ALLOW, OUTFITTER_WEB_ORIGIN); `deploy/config.env` (Matej in IAP_MEMBERS); `docs/protocol.md` (a "Device login" section) |
| **B** CA-1 web (#390) | `web/src/pages/DeviceApprovePage.tsx`, `web/src/pages/DevicesPage.tsx`, `web/src/api/devices.ts`, `web/src/components/devices/*` (new), `web/src/lib/devices.ts` (new, pure helpers), `web/test/devices*.test.ts(x)` | `web/src/App.tsx`: remove the `/tokens` nav line, drop `operatorOnly` from the `/devices` line; `web/src/style.css` or `web/src/styles/*` (new rules at the end) |
| **C** CA-3 settings api (#392) | `api/src/central/settings-schema.ts`, `api/src/central/settings-resolver.ts`, `api/src/store/settings.ts`, `api/src/routes/config.ts`, `api/src/fleet-settings.ts`, `api/test/settings-*.test.ts`, `api/test/config-routes.test.ts` | `api/src/routes/operator.ts` (bump the fleet `version` in the existing PUT); `api/src/store/memory.ts` + `mongo.ts` `FleetSettings` classes only if the version bump needs it |
| **D** CA-4 + CA-5 api (#393, #394) | `api/src/central/litellm-keys.ts`, `api/src/central/provider-keys.ts` (new), `api/src/store/keys.ts`, `api/src/routes/keys.ts`, `api/test/litellm-keys.test.ts`, `api/test/provider-keys.test.ts`, `api/test/spend.test.ts` | `api/src/routes/hooks.ts` (one `sweepRouterKeys()` call in the tick); `deploy/README.md` (the secret's consumers; `LITELLM_ADMIN_KEY` was already mounted) |
| **E** CA-2 kernal login (#391) | `kernal/.pi/extensions/_shared/outfitter-session.ts`, `kernal/.pi/extensions/_shared/keychain.ts` (new, the backends), `kernal/.pi/extensions/kernal-login/*`, `kernal/.pi/extensions/_shared/outfitter-env.ts`, `kernal/tests/outfitter-session.test.ts`, `kernal/tests/login-cli.test.ts` | one-line `creds.token` → `await outfitterBearer(creds)` edits in `teleport/outfitter-store.ts`, `outfitter-admin/transport.ts`, `outfitter-agentengine/*`, `_shared/fleet-settings.ts`, `sentry/index.ts`; `bin/kernal` `pi_memory_env` check (§2.7) |
| **F** CA-8 config client (#397) | `kernal/.pi/extensions/_shared/central-config.ts`, `kernal/.pi/extensions/kernal-config/*` (new `/config`), `kernal/tests/central-config.test.ts`, `kernal/tests/config-command.test.ts` | `connect/index.ts` (`loadEnv` layering, `/setup` text); `sentry/index.ts` + `sentry/config.ts` (read the three sentry keys from central-config when signed in) |
| **G** CA-9 /admin (#398) | `kernal/.pi/extensions/kernal-admin/*`, `kernal/tests/admin*.test.ts` | none |
| **H** CA-7 web account (#396) | `web/src/pages/AccountPage.tsx`, `web/src/api/account.ts`, `web/src/components/account/*` (new), `web/src/lib/account.ts` (new), `web/test/account*.test.ts(x)` | `web/src/App.tsx`: drop `operatorOnly` from the `/account` line; styles as B |
| **I** CA-6 Drives (#395) | `api/src/central/run-keys.ts` (new), `api/test/run-keys.test.ts`, `api/test/run-spec-settings.test.ts`, `agentd/src/settings.ts` (new), `agentd/test/settings*.test.ts` | `api/src/agentlink.ts` (`buildRunSpec`: key + settings; `RunSpecMessage.settings`), the run-end call site (`runs.ts` or agentlink.ts, one block), `agentd/src/protocol.ts` (`RunSpec.settings`), `agentd/src/run.ts` (apply settings, one block); `docs/protocol.md` (run.spec `settings`) |
| **J** CA-10 migration (#399) | `kernal/.env.example`, `kernal/README.md`, `README.md` setup sections, `outfitter/deploy/README.md` Dongle text, `kernal/tests/migration.test.ts` | after E merged: the Dongle fallback in `_shared/outfitter-env.ts`; `kernal-login/cli.ts` (the import offer, one function call); `web/src/pages/TokensPage.tsx` (drop Dongle creation); `api/src/routes/tokens.ts` (refuse kind dongle) after A merged |

Merge order: this PR first. Then A, B, C, D, E in any order (B against A's spec'd API with mocked
fetch; D's hooks are called only once A lands). F after E (it needs `outfitterBearer`/session); G
after F; H after C and D (mocked API before); I after C and D; J after E and F. A task built before
its dependency merged rebases on main before review; its tests mock the dependency at the contract
in this document.

## 14. Owner steps (never performed by an agent)

1. Run `ROTATE=1 outfitter/deploy/litellm-admin.sh` (or plain `litellm-admin.sh` if
   `outfitter-litellm-admin` holds no scoped key yet) once the follow-up that added `/team/list` and
   `/user/list` to `ALLOWED_ROUTES` is merged: a key's routes are fixed when it is minted. The secret
   is readable by the api service account only (#384's approval).
2. Add `user:matej@mgms.eu` to IAP: merge A's `deploy/config.env` change, then run `deploy/access.sh`.
3. Deploy with `OUTFITTER_LOGIN_ALLOW` and `OUTFITTER_WEB_ORIGIN` set (A's `service.sh` change),
   through a release tag (`LITELLM_ADMIN_KEY` is already mounted). Optionally set the router key
   limits (§3.2) with `PUT /api/operator/config/fleet`; the defaults apply otherwise.
4. Point `link.kernal.one` at the link service if it isn't already (it's baked into releases).
5. Move Outfitter's own default key into the `outfitter-system` team:
   `deploy/litellm-retire-keys.sh system-key` (#399; DRY_RUN=1 first).
6. After everyone is on device keys and a release with `OUTFITTER_RUN_KEY_FALLBACK=0` is out:
   `deploy/litellm-retire-keys.sh block` (`MGM-Pi`, `agent-testing`,
   `litellm-autorouter-testing-c`; #399).

## 15. Decisions (made for this contract; the owner may revisit)

1. **User id derived from the email** (sha256, `u_` + 24 hex), not stored: identical on every
   instance with no migration or race. It is not secret; it only keeps emails out of LiteLLM and
   Secret Manager names.
2. **Tokens live on the device document** (one current pair, plus the previous one for a grace
   period), not in a separate tokens collection.
3. **Rotation grace**: a replaced access token stays valid until its own expiry and a replaced
   refresh token for 60 s, so concurrent Kernal processes and crashes don't sign the machine out;
   refresh-token reuse after the grace revokes the device (theft signal).
4. **One admin key variable**: the existing `LITELLM_ADMIN_KEY` (secret `outfitter-litellm-admin`,
   minted scoped by `litellm-admin.sh`) mounted on both api roles: the link role mints at the token
   exchange and re-mint, and runs start on both roles. Never on Drives or laptops. (Superseded the
   earlier separate `OUTFITTER_LITELLM_ADMIN_KEY`, 2026-10-04.)
5. **Device router keys expire after 90 days** and are re-minted by Kernal; budget 50 USD / 30 days,
   120 rpm, every model. Run keys: budget 20 USD, LiteLLM `duration` as the backstop. These are the
   defaults of fleet-only settings (§3.2, owner decision 2026-10-04), not constants.
6. **Login allow-list** is a new env var in PREVIEW_ALLOW's format, set by deploy from IAP_MEMBERS
   plus operators; empty outside dev refuses device logins but leaves Dongles alone, so a deploy
   without it changes nothing for existing users.
7. **Public device endpoints** are exempted by an exact path list in the shared preHandler.
8. **Profiles are optional**; with none, resolution skips the profile level. No reserved name.
9. **Fleet values stay in the `fleetSettings` document** (Sentry where it is, the rest in `values`).
10. **New store collections each live in their own module** (`store/devices.ts`, `settings.ts`,
    `keys.ts`) with memory and Mongo classes and an index function, so `memory.ts`/`mongo.ts` are not
    edited by the tasks.
11. **The nav entries for Devices and Account exist now, sysops-only**, so B and H each flip their own
    line instead of inserting next to each other.
12. **Personal key delivery is a POST on link, device tokens only**: a Dongle never receives keys.
13. **The login CLI runs with node before pi** (like `--teleport`), from a directory without
    index.ts so pi never loads it as an extension.
