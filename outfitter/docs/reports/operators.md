# Outfitter operator role and settings page

EPIC.md E2.14 / E3.7. Adds an **operator** role (a fixed config list of emails) that can manage
Secret Manager secrets and see deploy-level settings, and a `/settings` web page for it. Any
signed-in user still creates sessions and edits gurus — this is an additional capability, not a
replacement for the existing org-shared policy.

## What

### Operator role (`packages/api/src/config.ts`, `src/auth.ts`)

- `OUTFITTER_OPERATORS`: emails separated by `;`, `,` or whitespace, compared case-insensitively
  after trimming (`isOperator`). `;` is what `deploy/service.sh` actually uses — `gcloud run deploy
  --set-env-vars` splits its whole value on commas, so a comma-separated list there would be sliced
  into separate env vars.
- `Identity` gains `operator: boolean`. It's computed in exactly one place: `identityFromRequest`
  (the "web"/"all" role's auth resolver), for every path it returns through — dev mode, an `outf_`
  token, and an IAP assertion alike.
  - Dev mode (`OUTFITTER_DEV=1`, identity `dev@localhost`) is always an operator, so local
    development needs no `OUTFITTER_OPERATORS` at all.
  - `identityFromLinkRequest` (the "link" role's only credential) never grants the operator role,
    even when the token's owner is on `OUTFITTER_OPERATORS` — that role only ever serves teleport,
    and has no `/api/operator/*` route registered anyway (`routes/index.ts`).
  - `identityFromApiToken` itself always returns `operator: false`; only `identityFromRequest`
    upgrades it, via the shared `isOperator` check, so there's no second place that could disagree.
- `requireOperator`: a Fastify preHandler that 403s `{error:"operator role required"}` unless
  `req.identity.operator` is true. Every `/api/operator/*` route uses it, on top of the ordinary
  auth preHandler in `server.ts` that sets `req.identity` in the first place.
- `GET /api/me` returns `operator`, which the web UI's `App.tsx` uses to show the Settings nav link.

### Secret Manager access behind an interface (`src/secrets.ts`, `src/operator.ts`)

`secrets.ts` already had `SecretsBroker` (read-only, hands a *run* its one secret). A second,
smaller interface, `SecretAdmin`, sits alongside it for the operator settings page's needs:

```ts
interface SecretAdmin {
  info(secretName): Promise<{ set; masked?; updatedAt? }>;
  addVersion(secretName, value): Promise<void>;      // creates the secret if missing
  disableAllEnabled(secretName): Promise<void>;        // never destroys
  accessLatest(secretName): Promise<string | undefined>;
}
```

- `GcpSecretAdmin`: Secret Manager over ADC via the REST API (same approach as the existing
  `GcpSecretsBroker` — no `@google-cloud/secret-manager` dependency needed).
- `MemorySecretAdmin`: in-memory, for tests — `buildTestApp`'s `secretAdmin` option defaults to it,
  the same pattern `secretsBroker` already uses.

`src/operator.ts` defines the managed secret list:

- Static: `outfitter-litellm-key-default` (next run), `outfitter-github-pat` (next deploy),
  `outfitter-litellm-admin` (next deploy), `outfitter-ngrok-api-key` (next deploy),
  `outfitter-local-tunnel-token` (next deploy — mounted as `LOCAL_TUNNEL_TOKEN` by
  `deploy/service.sh`'s `--set-secrets`, read once at boot by `LaptopProbe`).
- Dynamic: `outfitter-litellm-key-<guruId>` for every guru that currently exists (next run — read
  live via `GcpSecretsBroker.secretsForRun` at run start).

`appliesAt` reflects how each secret is actually consumed: "next run" for anything read live
through `SecretsBroker`, "next deploy" for anything mounted as a container env var
(`deploy/service.sh`'s `--set-secrets`, read once at process boot).

### Routes (`src/routes/operator.ts`, "web"/"all" role only)

- `GET /api/operator/settings` — deployment values (LiteLLM base URL, sandbox provider/job, tunnel
  domain, the operator list) plus one row per managed secret: `{ id, secretName, label, purpose,
  set, masked?, updatedAt?, appliesAt }`. Never a full value — `masked` is the last 4 characters,
  and only when the stored value is over 12 characters long.
- `PUT /api/operator/secrets/:secretName {value}` — rejects an unmanaged name (400, including a
  per-guru name for a guru that doesn't exist), trims the value, rejects empty or
  whitespace-containing values (400), then `addVersion`s it.
- `DELETE /api/operator/secrets/:secretName` — `disableAllEnabled`s it (recoverable from the GCP
  console, never destroyed). Refuses `outfitter-litellm-key-default` with 409 when **no** guru has
  its own key — every run would otherwise lose its key outright. (If at least one guru already has
  its own key, the delete proceeds; runs relying on the default fallback are a pre-existing
  operational choice this doesn't newly protect against.)
- `POST /api/operator/secrets/:secretName/test {value?}` — tests the given value, or the stored one
  when omitted, against the right provider, 5s timeout:
  - LiteLLM keys (`outfitter-litellm-key-*`, `outfitter-litellm-admin`) → `GET <root>/key/info`
  - `outfitter-github-pat` → `GET https://api.github.com/user`
  - `outfitter-ngrok-api-key` → `GET https://api.ngrok.com/endpoints`
    (`Authorization: Bearer`, `Ngrok-Version: 2`)
  - `outfitter-local-tunnel-token` → `GET https://<TUNNEL_DOMAIN_LMSTUDIO>/v1/models`

  Reuses `providers-status.ts`'s `fetchJson` (now exported) instead of a copy, per the story's
  instruction. Returns `{ ok, detail }`, where `detail` is the provider's own error text
  (`message`/`error`/`detail`/`msg`, including a nested `error.message`) when it refuses, or the
  network failure reason on a timeout/connection error.

Every write/disable is logged through the Fastify request logger as `{ operator: <email>,
secretName }` — never the value.

### Web (`packages/web/src/pages/SettingsPage.tsx`, `App.tsx`, `api/client.ts`)

- `App.tsx` fetches `GET /api/me` once on mount and shows a **Settings** nav link only when
  `operator` is true.
- `/settings`: read-only deployment values, then a secrets table. Each row shows the masked value
  (or "Not set"), when a change applies, and Replace / Test stored / Disable buttons. Replacing
  opens an inline `type="password"` input plus Test and Save — the same care as `TokensPage.tsx`:
  no value ever goes in a URL, and the input is cleared immediately after a successful save.
  A non-operator who opens `/settings` directly gets the API's 403, rendered as "Operator role
  required".

### Deploy / IAM (`deploy/service.sh`, `deploy/baseline.sh`)

- `service.sh` sets `OUTFITTER_OPERATORS` on the **web** role only, defaulting to
  `mgm@mgms.eu;matej@mgms.eu` (overridable by exporting it before running `./api.sh`).
- `baseline.sh` grants `outfitter-api` a new **project-scoped custom role**,
  `outfitterSecretAdmin`, instead of a predefined one — none fit:
  - `roles/secretmanager.secretVersionAdder` can add versions but can't create a secret or disable
    a version.
  - `roles/secretmanager.admin` can do everything needed, but also secret deletion and IAM policy
    changes, which the API never does.

  The custom role has exactly: `secretmanager.secrets.create`, `secretmanager.secrets.get`,
  `secretmanager.versions.add`, `secretmanager.versions.disable`, `secretmanager.versions.list`.
  `baseline.sh` is idempotent: it describes the role first and updates it in place on a re-run,
  matching the pattern the rest of the script already uses for the two service accounts.

**Not run by me** — `baseline.sh` is a script the user runs by hand. The exact command to apply
this change to an already-baselined project:

```bash
PROJECT=outfitter-509211 REGION=us-central1 ./baseline.sh
```

(safe to re-run in full; every step, including the new custom role and its binding, is
idempotent — existing resources are left alone and only the new role/binding are added.)

If `./api.sh` was already run once for this project, re-run it too (after `baseline.sh`) so the web
role's revision actually gets `OUTFITTER_OPERATORS` in its environment:

```bash
PROJECT=outfitter-509211 REGION=us-central1 ./api.sh
```

## Security choices

- Operators are a config list, not a store-backed role — simplest thing that works for two people,
  consistent with EPIC.md's Decisions table entry. Changing the list needs a redeploy
  (`OUTFITTER_OPERATORS`), which is an intentional, deliberate action rather than a self-service
  UI toggle (a UI to manage operators would itself need to be operator-gated, and bootstrapping
  that is circular for a two-person list).
- `requireOperator` runs *after* the existing IAP-or-token auth preHandler, so an unauthenticated
  caller still gets a plain 401 before ever reaching the operator check.
- Values are never returned in full. `masked` only shows the last 4 characters, and only past 12
  characters, so a short secret (where 4 characters would reveal most of it) shows only "set".
- `DELETE` disables rather than destroys — recoverable from the Secret Manager console if an
  operator disables the wrong thing.
- The default-LiteLLM-key delete guard is a narrow, literal check (no guru has its own key) rather
  than a full dependency analysis across every guru — matches the story's instruction exactly, and
  a broader check would need per-run observability this service doesn't have.
- Every write is logged with the operator's email and the secret name, never the value, through the
  existing Fastify logger (no new log sink).
- The custom IAM role is the narrowest of the three options considered (see Deploy / IAM above) —
  no secret deletion, no IAM policy changes, scoped to this one project.
- The `/api/operator/secrets/:name/test` endpoint never persists the tested value; it's a
  same-request probe with a 5s timeout and no retry.

## Tests

- `packages/api/test/config.test.ts`: `OUTFITTER_OPERATORS` parsing (`;`, `,`, whitespace, empty
  default).
- `packages/api/test/auth.test.ts`: `isOperator` matching (case/whitespace), dev identity is always
  an operator, `identityFromRequest` computes `operator` correctly for both an operator and a
  non-operator token owner, `identityFromLinkRequest` never grants it.
- `packages/api/test/operator.test.ts`: `GET /api/me`'s operator flag for dev/operator/non-operator
  callers; 403 for a non-operator on every `/api/operator/*` route (built with a non-dev identity —
  an `outf_` token whose owner isn't on `OUTFITTER_OPERATORS`, dev mode off, same trick
  `tokens.test.ts` uses to fake an arbitrary caller); the link role never even registers these
  routes; `GET /api/operator/settings`'s secret list (names, `appliesAt`, masking above/below 12
  characters); `PUT` validation (unmanaged name, unknown per-guru id, empty/whitespace value,
  trimming); `DELETE`'s default-key refusal and its "disable, don't destroy" behaviour; the test
  endpoint's "no value set" and 400-for-unmanaged-name cases.
- `packages/api/test/operator-test-endpoint.test.ts`: `testSecretValue`/`detailFromJson` per kind
  (litellm/github/ngrok/tunnel) against a fake `fetch`, plus the network-failure and
  tunnel-not-configured paths — same approach as `providers-status.test.ts`'s exported probes, so
  no real network calls happen in CI.
- `packages/web/test/client.test.ts`: `me()` surfaces `operator`; `operatorSettings`,
  `putOperatorSecret`, `disableOperatorSecret`, `testOperatorSecret` (explicit value and
  omitted-value cases) hit the right URL/method/body.

`cd outfitter && npm run build && npm test` — all green: agentd 140/140, api 196/196 (1
pre-existing skip), provider-local 2/2, web 33/33.

## What's left

- `baseline.sh`'s new IAM binding hasn't been applied to the real `outfitter-509211` project — the
  command above needs to be run by hand, and `./api.sh` re-run so `OUTFITTER_OPERATORS` actually
  reaches the deployed web role.
- No end-to-end verification against a real Secret Manager (`GcpSecretAdmin` is exercised only via
  `MemorySecretAdmin` in tests, matching how `GcpSecretsBroker` is tested elsewhere in this
  codebase).
- The Settings page doesn't yet show anything for the E2.5b MCP OAuth refresh tokens EPIC.md
  mentions as a future secret kind — out of scope for this story, but the `SecretAdmin`/managed-list
  design should extend to it without changes to the interface itself.
- No UI to edit `OUTFITTER_OPERATORS` itself (by design — see Security choices); it's a redeploy.
