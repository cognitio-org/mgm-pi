# Runbook: per-user MCP grants on the router

Epic #482 (MO-7 #489). Covers the router's per-user OAuth vault for gateway MCP servers (Sentry,
gcloud): how a grant is made, what silently destroys or orphans grants, and what to check when
someone's tools stop working. Design: docs/specs/mcp-connections.md (Connections page, Drive
notice) and docs/specs/mcp-grant-refresh.md (refresh, and why there's no refresh job).

## How a grant works

- A person opens **Connections** in Outfitter (`/connections`) and clicks Connect. That opens the
  router's `/ui/connect` page, under IAP, which runs the upstream OAuth and stores the grant in
  `LiteLLM_MCPUserCredentials`, encrypted. Outfitter never sees a token.
- The grant is stored on the person's **IAP user** (`accounts.google.com:<sub>`). Drive run keys and
  device keys authenticate as the **Outfitter user** (`u_<hash>`). The router links the two by
  email (router-litellm PR #40), unless the server's identity binding is `enforce`.
- The router refreshes a grant when a request reads it within 60 s of expiry, using the server
  row's persisted DCR client. When the IdP refuses the refresh (`invalid_grant` /
  `invalid_client`), the grant is flagged **reconnect needed** (MO-4). The router stops using it,
  logs one error (server id, user id, reason), and the person sees "Reconnect" on Connections and a
  notice in their Drives.

## One-time setup

1. **Router config:** set `litellm_settings.enable_redis_auth_cache: true`. Without it the refresh
   lock is per-process, and two replicas can redeem one refresh token at once. With an IdP that
   rotates refresh tokens, that kills a healthy grant (docs/specs/mcp-grant-refresh.md §2).
2. **Register each OAuth MCP server through the admin DCR step,** so the router keeps its upstream
   client on the server row and can refresh grants: admin UI "authorize" on the server, or
   `POST /v1/mcp/server/oauth/{id}/register` as a proxy admin. Static clients (Google) go in at
   registration instead (`deploy/gcloud-mcp-router.sh`).
3. **Outfitter's admin key needs `/v1/mcp/user-credentials`** for the Connections page:
   `ROTATE=1 ./litellm-admin.sh` from `outfitter/deploy/` (owner-run, `DRY_RUN=1` first). Until
   then `/api/me/connections` answers 502 and Drives show no notice. Nothing else breaks.
4. **Keep the shared run-key fallback off:** `OUTFITTER_RUN_KEY_FALLBACK=0` in
   `deploy/config.env`. A Drive on the shared key runs as a user with no grants.
   `deploy/test/mcp-identity-check.test.sh` fails if it changes.

## Operations that destroy or orphan grants

| Operation | Effect | Guard |
| --- | --- | --- |
| Editing a token-relevant field of an MCP server (url, auth type or flow, endpoints, client id or secret, scopes) | **Purges every user's grant** for that server (`purge_user_oauth_credentials_for_server`). Everyone reconnects. | Change servers only through the reviewed scripts. `gcloud-mcp-router.sh` shows an existing server and changes it only with `CONFIRM=1 FORCE_PURGE=1`. Don't edit these fields in the admin UI. |
| Changing the router's encryption key (`LITELLM_SALT_KEY`, or the master key when no salt key is set) in place | Every grant becomes unreadable and reads as "not connected". The router logs `could not be decrypted (likely written under a previous LITELLM_SALT_KEY)`. | Never edit the env var by hand. Rotate only through `POST /key/regenerate` with `new_master_key`, which re-encrypts grants (`rotate_mcp_user_credentials_master_key`). Check which key the deployment encrypts with before rotating. Recovery from a bad rotation is everyone reconnecting. |
| Deleting a router user | Deletes nothing else, but that person's grant is orphaned if it was on that row | Don't delete IAP or Outfitter users to "clean up". |
| Shared-key fallback on | Drives run without the person's grants | `config.env` guard above. |

**Don't judge a server's credentials from `GET /v1/mcp/server`.** It redacts `client_id` and
`client_secret`, so a configured client looks empty (#484). Check behaviour instead: open
`/{server}/authorize` with a made-up `client_id`. A configured server redirects upstream with the
router's own client id.

## Identity rows

Every Outfitter user (`metadata.source == "outfitter"`) must have an empty `user_email`, a
`metadata.email`, and `user_id == userIdFor(metadata.email)`. At most one other user (the IAP user)
may hold that address as `user_email`. Otherwise the same-person link breaks, and Drives don't see
the browser-made grant.

```
cd outfitter/deploy
DRY_RUN=1 ./mcp-identity-check.sh   # what it checks; reads no secret
./mcp-identity-check.sh             # owner-run; prints violations by user id, exits 1 on any
```

## Troubleshooting

| Symptom | Check | Fix |
| --- | --- | --- |
| Drive says "Sentry isn't connected" | Connections shows Not connected | Connect, then start a new Drive run |
| Drive says "… needs reconnecting" | Connections shows Reconnect needed. Router error log: `MCP OAuth grant needs reconnect: server_id=… user_id=… reason=…` | Reconnect. If `reason=invalid_client` for many people at once, the server's upstream client changed or was revoked: fix the registration first (that purges grants, see above), then everyone reconnects |
| Connected in the browser, Drive still 401s | `./mcp-identity-check.sh`; the server's identity binding (`enforce` never shares across user ids) | Fix the identity row, or connect from the identity the Drive uses |
| Connections page errors (502) | api log `connections read failed`; the admin key's routes | Setup step 3 |
| Every grant "not connected" at once | Router log `could not be decrypted` | Encryption key changed: see above |
| A grant dies around a refresh with Redis off | `enable_redis_auth_cache` | Setup step 1 |

Admins can list one server's grants, with the reconnect flag and no secrets:
`GET /v1/mcp/server/{id}/user-credentials` (proxy admin or admin view-only).
