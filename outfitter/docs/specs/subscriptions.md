# Personal subscription workers

Status: contract for the first slice. Issue for the Drive shell follow-up: cognitio-org/mgm-pi#473.

Each person spends their own Claude, Grok, Codex, and Google AI Pro/Ultra allowance from Kernal before the metered router. The router (`router.kernal.one`) stays the metered pool. It never receives a subscription secret. LiteLLM and pi's model client never receive one either.

## 0. Decisions

- A Floppy spends its owner's subscription for every turn, including when someone else steers it. The secret is mounted for `session.ownerEmail`'s run, the same way the router run key is minted for that owner.
- Workers are one shot. The CLI session is not saved or resumed. The coordinator keeps the Floppy transcript and Agent Engine memory.
- Sandboxed: read-only, no shell, no approval prompt, no Kernal MCP, fresh session.
- Full, on a laptop: project instructions, a memory brief, URL or local-command MCP servers, and the CLI's own approval prompts. File tools are the CLI's.
- Full, on a Drive: file edits inside the sandbox (Read, Write, Edit, Glob, Grep). Shell stays off. No skip-permissions flag. Shell and unattended approvals are #473.
- When a plan window is spent, walk `subscriptions.prefer` and use the next signed-in subscription, then the router. A vendor that is on but not signed in asks that person to connect. The matching API key stays unset.
- While `subscriptions.claude` is not `off`, hide the builtin `claude-code` and `claude-code-writer` agents. While `subscriptions.codex` is not `off`, hide `codex-exec` and `codex-exec-writer`. When the switch is `off`, those builtins stay.
- Gemini's worker is Google's `agy_acp_server` (`oauth-personal`), not `agy -p` and not `gemini --acp`. That runner is a later slice. The setting and the secret slot exist now.
- Cursor and the Claude Agent SDK are out of this work.
- The fleet level cannot turn a subscription on. A missing login never falls through to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `XAI_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`.

## 1. This slice

In this slice:

- Schema version 4 keys below, on the server and in Kernal's copy.
- A write-only per-account secret store for `claude`, `grok`, `codex`, and `gemini`.
- The Subscriptions page.
- `kernal subscriptions` for status, and `kernal subscriptions connect claude` (the vendor's own `claude setup-token`, then upload).
- A Kernal-owned one-shot Claude runner used when `subscriptions.claude` is `sandboxed` or `full`.

Not in this slice: baking CLIs into the Drive image, mounting secrets into a Drive, the Grok and Codex runners, `agy_acp_server`, session resume, and #473.

## 2. Settings (schema version 4)

Declared in `outfitter/packages/api/src/central/settings-schema.ts` and copied in `kernal/.pi/extensions/_shared/central-config.ts`. A new key gets `since: 4`. Bump `SETTINGS_SCHEMA_VERSION` and `KNOWN_SCHEMA_VERSION` to 4. Do not rename or retype an existing key.

| Key | Type | Values | Default | Levels |
|---|---|---|---|---|
| `subscriptions.claude` | enum | `off`, `sandboxed`, `full` | `off` | user, profile, device, local |
| `subscriptions.grok` | enum | `off`, `sandboxed`, `full` | `off` | user, profile, device, local |
| `subscriptions.codex` | enum | `off`, `sandboxed`, `full` | `off` | user, profile, device, local |
| `subscriptions.gemini` | enum | `off`, `sandboxed`, `full` | `off` | user, profile, device, local |
| `subscriptions.prefer` | string | see below | `claude,grok,codex,gemini` | user, profile, device, local |

`override` is `any`. Not secret. Not fleet: a fleet write is `400 level_not_allowed`. On the Kernal copy, `accountFirst: true` and `takesEffect: "session"`.

`subscriptions.prefer` is a comma-separated list of vendor ids, no spaces, no duplicates. Each id is one of `claude`, `grok`, `codex`, `gemini`. A subset is allowed and means "only these, in this order." Empty is invalid. `coerceSettingValue` rejects anything else (`invalid_value`). Kernal ignores a vendor that is `off` or not signed in when it walks the list.

## 3. Secrets

Sibling of personal provider keys (`central/provider-keys.ts`, `routes/keys.ts`, `store/keys.ts`). Not a new provider id. Provider-key values stay 8–512 printable ASCII with no whitespace. Subscription secrets are a different store because Grok and Codex auth files do not fit that rule.

Vendors: `claude`, `grok`, `codex`, `gemini`.

- `claude`: one line, 20–4096 printable ASCII characters, no whitespace. Delivered as `CLAUDE_CODE_OAUTH_TOKEN`.
- `grok`, `codex`, `gemini`: UTF-8 file contents, 1 to 262144 bytes, no NUL. `grok` is `~/.grok/auth.json`. `codex` is `~/.codex/auth.json`. `gemini` is the `agy_acp_server` profile (later). This slice stores them and does not run those CLIs.

Secret Manager name: `outfitter-user-<userId>-subscription-<vendor>`. Metadata id: `<userId>:subscription:<vendor>`. Metadata holds `version` (the Secret Manager version just written), `last4`, `setAt`, `setBy`. `last4` is the last 4 hex digits of sha256 of the exact stored bytes. The list and the page never return the value.

Compare-and-swap: `PUT` may send `ifVersion`. When the stored version differs, answer `409 { "error": "version_conflict", "version": <current> }` and do not write. Omit `ifVersion` on a first save. A Drive that refreshes a rotating file uses `ifVersion`. Claude's setup-token does not rotate.

### Routes

Person (web or device token), same auth as provider keys:

- `GET /api/me/subscription-secrets` → `[{ vendor, last4, setAt, version }]`
- `PUT /api/me/subscription-secrets/:vendor` body `{ "value": "<string>", "ifVersion"?: <number> }` → the view
- `DELETE /api/me/subscription-secrets/:vendor` → 204

Device token only, same role gate as `POST /api/device/provider-keys`:

- `POST /api/device/subscription-secrets` → `{ "secrets": { "<vendor>": { "value": "<string>", "version": <number> } } }`

Values are redacted in logs and in any admin dump that already redacts provider keys.

## 4. Subscriptions page

Route `/subscriptions`. Nav item beside Account. Vocabulary key `subscription`: one/many "Subscriptions", hint "your Claude, Grok, Codex, and Antigravity logins".

One card per vendor. Each card shows connected or not (`last4`, `setAt`), the mode control for that vendor's setting, and Connect / Disconnect. Under the cards, the prefer order. The page writes the settings keys through the existing config API and the secrets through §3. The typed secret is sent once and the field clears. Nobody can read a secret back on this page.

Connect for Claude can paste a setup-token. Grok, Codex, and Gemini cards can paste the file contents into the same API. The guided vendor login in this slice is `kernal subscriptions connect claude` only.

## 5. Kernal command and Claude runner

`kernal/bin/kernal` dispatches `subscriptions` to a new CLI next to `kernal-login`, the same way `login|logout|whoami` is dispatched, before pi starts.

- `kernal subscriptions` prints each vendor: mode, whether the binary is installed, whether an account secret or a local login is present, and whether the API-key env var is set (that var would shadow the subscription).
- `kernal subscriptions connect claude` runs `claude setup-token`, uploads the token with `PUT /api/me/subscription-secrets/claude`, and does not print the token.
- `kernal subscriptions disconnect <vendor>` deletes the account secret.

The runner is Kernal code. It does not edit `pi-subagents` and it does not widen the builtin Claude adapter. When `subscriptions.claude` is `sandboxed` or `full`, the coordinator's Claude worker is this runner, reached through the `subscription_worker` tool. A direct `subagent` launch of `claude-code` or `claude-code-writer` is blocked while that switch is on. A direct launch of `codex-exec` or `codex-exec-writer` is blocked while `subscriptions.codex` is on, and that block does not start Codex.

- One `claude -p` invocation. No `--resume`. No session id stored.
- The child environment drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. When an account secret exists, set `CLAUDE_CODE_OAUTH_TOKEN` to it. Otherwise leave the local Claude login alone.
- Sandboxed: read-only / plan mode, no shell, empty strict MCP config, user settings only.
- Full on a laptop: `--setting-sources user,project`, the CLI's own approval prompts, and a generated MCP config for servers that are a URL or a local command. Do not pass the router MCP server, `gcloud`, or any direct OAuth server. Prepend an Agent Engine memory brief to the prompt when the coordinator already has one. Do not give the child Outfitter memory credentials.
- If the mode is not `off` and there is no account secret and no local login, the runner returns a short "connect Claude" result and does not spawn `claude`.
- If Claude exits because the plan window is spent, the runner says so. The coordinator walks `subscriptions.prefer` and then uses the router. It does not export an API key to retry.

Hide `claude-code` and `claude-code-writer` from the subagent list while `subscriptions.claude` is not `off`. Hide `codex-exec` and `codex-exec-writer` while `subscriptions.codex` is not `off`, even though the Codex runner is a later slice. Hiding them is what stops a Console bill.
