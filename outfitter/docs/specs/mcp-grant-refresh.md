# Proactive refresh for per-user MCP grants (MO-3)

Issue #485, epic #482. Status: spec. Decision: **build no refresh machinery now.** Ship visibility
(MO-4/5/6) and one config change. Build a keep-alive job only once a server is shown to need it
(§4), and then only the small version in §5.

This replaces the plan in #485's 2026-10-07 comment, whose custody model, server-side connect
exchange, keep-alive job and refresh on 401 recreated the surface that sank router-litellm#43.

## 1. What already works (checked 2026-10-08)

Our fork (1.103.1) and upstream 1.104.2 have byte-identical `authz_code_refresher.py`,
`oauth_token_store.py` and `runtime_refresh_coordinator.py`. Upstream has no background refresh, no
refresh on 401 and no dead-grant marking, so rebasing gains nothing.

- **Lazy refresh:** on any read within 60 s of expiry, the router refreshes with the server row's
  persisted DCR client (#484 correction). This covers every grant that's in use, Google's 1 h
  tokens included: a Drive's first tool call after an hour gets a fresh token.
- **Dead grants (MO-4, router-litellm `litellm_mcp_dead_grant`):** `invalid_grant` /
  `invalid_client` flags the grant, the router stops retrying, and the person sees "reconnect
  needed" on the Connections page (MO-5) and in a Drive (MO-6). A dead grant costs one reconnect
  and is never silent.

## 2. The one gap that is real today: the refresh lock

`runtime_refresh_coordinator()` uses Redis only when `user_api_key_cache` has it, and
`_attach_redis_usage_cache` (`proxy_server.py:4562`) attaches it there only with
`litellm_settings.enable_redis_auth_cache: true`. Our router sets only `router_settings`, so each
replica has its own lock. Two replicas can then redeem one refresh token at the same moment. With an
IdP that rotates refresh tokens, the loser gets `invalid_grant` and MO-4 marks a healthy grant dead.

**Do now (config, no code):** set `litellm_settings.enable_redis_auth_cache: true` on the router
(runbook, MO-7). It also shares the virtual-key cache across replicas, which LiteLLM recommends
anyway.

**Known residue, not fixed:** the lock key is the requesting user id. Since PR #40, a person's
Outfitter id and IAP id share one row, so a Drive and a browser refreshing in the same second could
both redeem. Fix this only if a dead grant is ever traced to it. The fix is to key the lock by
`_credential_owner(...)`, a few lines in `per_user_oauth_store.py`.

## 3. Out of scope, and why

| Idea | Why not now |
| --- | --- |
| Refresh on an upstream 401 | No server we run revokes tokens before their stated expiry. Lazy refresh plus MO-4 already turns a dead token into a visible "reconnect". |
| Custody / "managed" grants, server-side connect exchange | Only matters for a router-initiated refresh of a token some client also holds, under an IdP that rotates. We start no router-initiated refresh (§5 is opt-in, for non-rotating IdPs only). |
| Per-process token-cache TTL cap | A stale cached token surfaces as an upstream 401 and a reconnect. Revisit with refresh on 401. |

## 4. Facts to check before building anything (owner)

1. **Sentry:** the first real refresh is due about 2026-11-05 (#484). Check the router log that
   day: does it succeed, and does Sentry rotate the refresh token (a new `refresh_token` in the
   response)?
2. **Google (gcloud, #497):** is the OAuth consent screen *Internal* or *External: In production*?
   An *External: Testing* app's refresh tokens die after 7 days **however often they're used**. A
   keep-alive job can't help there, and publishing the app is the fix. Otherwise Google only revokes
   refresh tokens unused for 6 months.
3. For any new OAuth MCP server: its refresh-token idle lifetime and whether it rotates.

Build §5 only if a server's refresh tokens die when idle within a span people plausibly go without
using it (for example under 30 days), **and** it doesn't rotate refresh tokens.

## 5. If needed: the keep-alive job (the whole design)

- **Opt-in per server:** `grant_keepalive_days` on the MCP server row (unset = off). An admin sets
  it only for an IdP that doesn't rotate refresh tokens, so refreshing never invalidates a copy a
  client holds. No custody tracking.
- **Selection:** that server's OAuth rows with `updated_at` older than `grant_keepalive_days / 2`,
  and no `reconnect_required_at`. A successful refresh rewrites the row, which resets `updated_at`.
- **Run:** an hourly APScheduler job registered in `ProxyStartupEvent`. A Redis `SET NX` pod lock
  means one replica runs each tick, and there's no job without Redis. Rows refresh one at a time,
  through the normal `RefreshingTokenStore` path, so they share the request path's lock and MO-4's
  marking.
- **Failure:** a dead grant is marked by MO-4 and skipped from then on. Anything else is logged and
  retried on the next tick. No backoff store.
- **Guard:** if a keep-alive refresh returns a different `refresh_token`, the IdP rotates. Log an
  error naming the server, so the admin turns the opt-in off.

**Tests:** one Hypothesis property over arbitrary rows (server opt-in, age, flag) asserting that
the job refreshes exactly the opted-in, live, old-enough rows. One test that the pod lock lets a
single replica run per tick.

## 6. Order

1. MO-4 merged and deployed. `enable_redis_auth_cache: true` set.
2. MO-5 / MO-6 / MO-7 (Connections page, Drive notice, runbook).
3. The §4 checks. Then §5, or close #485 with "not needed" recorded here.
