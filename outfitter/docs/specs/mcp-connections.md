# Connections: OAuth MCP grants in Outfitter (MO-5, MO-6, MO-7)

Issues #487, #488, #489, epic #482. Status: contract. Every shape here is binding. A change to one
changes this file in the same PR. Refresh is out of scope (docs/specs/mcp-grant-refresh.md).

Depends on router-litellm `litellm_mcp_dead_grant` (MO-4). That branch adds the reconnect flag,
same-person reads and disconnect, and `DELETE /v1/mcp/user-credentials/{server_id}`.

## 1. Which servers

`CONNECTABLE_MCP_SERVERS` in `packages/api/src/central/mcp-connections.ts`:

| name (router server name) | label | who sees it |
| --- | --- | --- |
| `sentry` | Sentry | everyone |
| `gcloud` | Google Cloud | operators only (same rule as `deviceKeyMcpServers`) |

A test keeps this list equal to the gateway OAuth servers in `kernal/.pi/mcp.json`: entries with
`auth: "oauth"` and an `x-litellm-api-key` header, the same rule `image/render-mcp.sh` keeps.
Nothing else is configurable.

## 2. Router calls (api only, admin key)

Outfitter's admin key (`outfitter-litellm-admin`) gets **one** more allowed route,
`/v1/mcp/user-credentials` (prefix match, so it also covers `/{server_id}`). It gets nothing under
`/v1/mcp/server`, where an edit purges every grant. Re-minting the key with the new route is
owner-run: `ROTATE=1 ./litellm-admin.sh`.

- **Status:** `GET /v1/mcp/user-credentials?user_id=<userIdFor(email)>`. A row matches a server
  when its `server_name` or `alias` equals the name.
- **Disconnect:** `DELETE /v1/mcp/user-credentials/<server_id>?user_id=<userIdFor(email)>`, with
  `server_id` taken from the status row. With no row there's nothing to disconnect, and the call
  answers 204.

Tokens never leave the router. Its list carries none, and the api passes on only the fields below.

## 3. Api routes (web role only, signed-in person, never a Dongle)

`GET /api/me/connections` returns 200:

```json
{
  "connectUrl": "https://router.kernal.one/ui/connect",
  "connections": [
    { "name": "sentry", "label": "Sentry", "state": "connected", "connectedAt": "2026-10-06T16:47:00Z" },
    { "name": "gcloud", "label": "Google Cloud", "state": "reconnect_required",
      "connectedAt": "…", "reconnectRequiredAt": "…", "reconnectReason": "invalid_grant" }
  ]
}
```

- `state` is `connected`, `reconnect_required` or `not_connected`. The time fields are present
  only when known.
- `connectUrl` is the router root (`litellmBaseUrl` without `/v1`) plus `/ui/connect`. The router
  runs the whole OAuth dance there, under IAP, and stores the grant. Outfitter has no callback.
- Errors: 503 `{error:"connections_unavailable"}` (no admin key), 502
  `{error:"connections_upstream"}` (the router failed).

`DELETE /api/me/connections/:name` answers 204. An unknown or hidden name gets 404
`{error:"unknown_connection"}`. Router failure gets 502 as above.

Answers are cached per person for 60 s. A disconnect drops that person's cache entry.

## 4. Web: `/connections`

- Nav item "Connections", for everyone. It sits after Account, and Account links to it.
- One row per connection: label, state pill (Connected / Reconnect needed / Not connected), and
  connected time.
- **Connect** (Not connected) and **Reconnect** (Reconnect needed) open `connectUrl` in a new tab.
  **Disconnect** (Connected or Reconnect needed) asks for confirmation, then calls DELETE.
- A **Refresh** button re-reads, since the grant is made in another tab.
- Deep link: `/connections`. MO-6's notice points here.

## 5. Drive notice (MO-6)

`GET /api/sessions/:id` adds `connectionNotice?: { text: string; href: "/connections" }` when
the caller owns the session and a server the session's Drive uses is not `connected`:

- **Servers used:** `sentry` always; `gcloud` when `gcloudRun(...)` is true for the session (the
  rule its run key is minted with).
- **Text:** `"Sentry isn't connected: connect it in Connections."` For a dead grant: `"Sentry
  needs reconnecting: reconnect it in Connections."` With several servers, they are joined
  ("Sentry and Google Cloud aren't connected: …").
- The notice is read from the same 60 s cache as §3. A router failure means no notice, never an
  error. Nothing runs in the sandbox, nothing retries, and run start never waits on it.
- `SessionPage` shows it next to `mailNotice`, as a `dock-note is-warn` with a link.

## 6. Runbook and guards (MO-7)

- `docs/runbooks/mcp-grants.md` covers:
  - registering a server through the admin DCR step
  - not judging credentials from `GET /v1/mcp/server` (it redacts them)
  - server edits that purge every grant (`FORCE_PURGE=1` in `gcloud-mcp-router.sh`)
  - salt rotation only through the rotate helper
  - `enable_redis_auth_cache: true`
  - keeping shared-key fallback off
  - reading `reconnect_required` and the router's error log
  - re-minting the admin key (§2)
- `deploy/mcp-identity-check.sh` (read-only; owner-run since it reads Outfitter's scoped admin key,
  which already allows `/user/list`; `DRY_RUN=1` safe) lists router users and checks the
  identity-row invariants. For every user with
  `metadata.source == "outfitter"`:
  - `user_email` is empty
  - `metadata.email` is set
  - `user_id == userIdFor(metadata.email)`
  - at most one other user has that address as `user_email`

  It prints violations and exits 1 on any. It has a `deploy/test/*.test.sh` with a fake router,
  added to CI.
- `deploy/test` asserts that `config.env` keeps `OUTFITTER_RUN_KEY_FALLBACK` at `0`.
