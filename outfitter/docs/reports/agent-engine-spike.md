# Agent Engine and A2A spike (E9 PR0)

The spike from `docs/specs/atlas-agent-engine-and-a2a.md` (PR0, issue #306), run on 2026-10-01.
Four tracks were investigated in parallel:
- the Atlas tier and DB users (read-only CLI, `--profile outfitter`)
- Agent Engine SDK, CLI and memory-server internals
- an A2A server on Fastify, a Python client and the TCK
- pi-subagents tool inheritance

Nothing billed was created and no Atlas resource was changed. Scratch work stayed in `/tmp`.

| # | Question | Verdict |
|---|---|---|
| A1 | Shared Flex cluster for Outfitter and memory | **Fail.** Memory creates 10 search indexes, Flex allows 10, session search has 2. Owner chose two clusters |
| A2 | `readWrite` enough for the memory server's search indexes | **Pass.** It includes `createSearchIndexes`/`list`/`update`/`drop` |
| A3 | Automated Embedding on Flex; rate limits | **Pass.** All tiers; paid (incl. M0 with a payment method) gets 2,000 RPM / 16M TPM |
| A4 | M0 → Flex in place | Possible through `upgradeTenantUpgrade`, with downtime and an api restart. Moot after A1 |
| S1 | Memory SDK token injection (`fetchImpl`) | **Pass** |
| S2 | One read returning private and org memory | **No such value.** Reads AND `userId` with `visibility`, so two calls are needed |
| S3 | REST behind `workspace sessions stop` | **Found:** `POST …/workspaces/{w}/runtime-sessions/{id}/stop` (202) |
| S4 | Extraction LLM via a gateway | Config **supported** (`base_url`, https); runtime egress **verified live** (22 turns extracted via `router.kernal.one`, $0.0042) |
| S5 | Delete / forget | Server has soft DELETE; SDK facades don't; gateway proxying **verified live** (200) |
| T1 | `@a2a-js/sdk` 1.3.0 on Fastify | **Pass,** with our own request handler (below) |
| T2 | Python `a2a-sdk` 1.2.1 speaks v1.0 by default | **Pass** |
| T3 | TCK at MUST level | **Pass:** 81 passed, 0 failed (toy server, Bearer injected) |
| T4 | TCK verdict on a capped blocking `SendMessage` | No MUST failure; client read timeout is 30 s. Owner chose a 25 s cap |
| P1 | Do children inherit the foreman's `--tools`? | **No.** Tools come from the agent definition; the design works |
| P2 | Gates blocking unattended subagents in a Drive | **None** for launching |
| P3 | Background children and the git proxy | **Bug:** `GIT_CONFIG_*` stripped, so push fails (#317) |

## Atlas (A1–A4)
**Current state** (read-only):
- **Cluster:** `outfitter`, M0, GCP `CENTRAL_US`, MongoDB 8.0.32.
- **Search indexes on `outfitter.sessionChunks`:** `chunks_text` and `chunks_vec`, both STEADY.
- **DB users:** `mgm_db_user` has `atlasAdmin`, and `outfitter-api` has `readWriteAnyDatabase`.
  Both are unscoped, so they reach every cluster in the project.
- **IP access list:** `0.0.0.0/0` ("Temporary open") and `92.242.248.145/32`.
- **Billing:** one $0 PENDING invoice (Sept 2026); payment method not readable through the API.

**Limits** (https://www.mongodb.com/docs/atlas/atlas-search/about/feature-compatibility/,
https://www.mongodb.com/docs/atlas/reference/flex-limitations/):

| Limit | M0 | Flex |
|---|---|---|
| Search and vector indexes | 3 | 10 |
| Storage | 0.5 GB | 5 GB |
| Ops/sec | 100 | 500 |
| Connections | 500 | 500 |

- Flex is MongoDB 8.0 (auto-patched), so `$rankFusion` keeps working.
- Flex price: $8–30/month by ops/sec band (https://www.mongodb.com/pricing).
- **Memory's 10 indexes,** from memory-server 0.11.7 `ENGINE_SEARCH_INDEXES`: vector and text on
  each of `memory_semantic`, `memory_episodic`, `memory_snapshot`, `memory_taxonomic` and
  `memory_procedural`.
  - Declaring `short_term` adds two more, which never fits on Flex.
  - Indexes are create-only. A partition key added after first start is only logged as a mismatch.
- **Upgrade path (not used):** `atlas api clusters upgradeTenantUpgrade` with `providerSettings
  {providerName: FLEX, instanceSizeName: FLEX, backingProviderName: GCP}`.
  - It needs downtime and a payment method (402 otherwise).
  - The SRV host stays the same; search index definitions are rebuilt
    (https://www.mongodb.com/docs/atlas/scale-cluster/).

**Owner commands for the decided two-cluster setup** (run 2026-10-01):
```sh
P=(--profile outfitter --projectId 6aafddf75566cf48726735bb)   # zsh array
# 0. Payment method on org 6aafdde3306e4ae530995071: Atlas UI → Billing (or atlas.md §7 Marketplace)
# 1. Memory cluster (Outfitter's cluster stays M0)
atlas clusters create outfitter-memory --provider GCP --region CENTRAL_US --tier FLEX $P
atlas clusters describe outfitter-memory $P -o json      # wait for IDLE; note its SRV host
# 2. Scope the api's user to its own cluster and database (check the app after)
atlas dbusers update outfitter-api --role readWrite@outfitter --scope outfitter:CLUSTER $P
# 3. The memory DB user (the CLI prompts for the password):
atlas dbusers create --username agent-engine-memory \
  --role readWrite@mdb_memory_6aafddf75566cf48726735bb,readWrite@mdb_store_6aafddf75566cf48726735bb \
  --scope outfitter-memory:CLUSTER --desc "Agent Engine memory service (E9)" $P
atlas dbusers describe agent-engine-memory $P -o json    # confirm roles and scope
# 4. As agent-engine-memory, confirm the main cluster is unreachable (expect an auth failure):
mongosh "mongodb+srv://outfitter.hcsrovt.mongodb.net/outfitter" --username agent-engine-memory --eval 'db.runCommand({ping:1})'
```

## Agent Engine (S1–S5)
**Packages and binaries:**
- npm `@mongodb-js/agent-engine-sdk-memory` 0.11.7 and PyPI `agent-engine-sdk-memory` 0.11.7.
- The `agentengine` CLI is a Go binary on GitHub Releases of `mongodb/agent-engine-client-libraries`
  (v0.1.118). PyPI `agentengine` is unrelated.
- The memory server image is `ghcr.io/mongodb/agent-engine-client-libraries/memory-server:0.11.7`.
- Routes were captured by running the CLI against a local fake server.

**S1 `fetchImpl`:** `MemoryOptions.fetchImpl` is called on every attempt (`clients/memory.js:148`).
- Pass `baseUrl` with no token, and set `Authorization` in the wrapper. This also covers retries.
- 401 isn't retried by the SDK.

**Routes** (prefix `/api/v1/projects/{p}/memory`):
- `recordTurn` → `/turns`
- `buildContext` → `/context`
- `search` → `/search`
- writes → `/semantic`, `/episodic`, `/procedural`, `/taxonomic`

**S2 visibility:** reads AND `userId` with `visibility`, and there is no union (Python SDK README).
Recall makes two calls and merges them.

**Other memory findings:**
- **Search filters:** `searchSemantic`, `searchEpisodes` and `searchTaxonomic` take no metadata
  filter, and `search` filters only procedural. Repo-scoped search goes through `buildContext`.
- **Uniqueness:** semantic `(org_id, label)` is unique project-wide, and `saveSemantic` upserts.
  Procedure names are unique project-wide, deleted ones included. So the api namespaces keys.
- **Idempotency:** `recordTurn` has no `userId` (it comes from `bind`). Its default idempotency key
  is a random UUID per call, so pass `<sessionId>:<entryId>` (pi's entry ids are unique only per
  session).
- **Database names** are suffixed: `mdb_memory_<id>`, `mdb_store_<id>`.

**S3 runtime sessions:**
- `GET …/workspaces/{w}/runtime-sessions` and `POST …/runtime-sessions/{id}/stop`. The stop returns
  202 and keeps history.
- Invoke sends `X-Session-Id` as a header plus `session_id` in the body.
- The CLI's `invoke` also sends `X-Agent-Engine-Test-Session`, which Outfitter must not send.
- `execution_id` is on stream frames only "when available".

**Service accounts:**
- The token endpoint takes Basic or body credentials.
- The secret's expiry is `service_account.active_secret.expires_at`. It is readable only with a
  user session, so it is recorded at setup.

**S4 extraction LLM:**
- `extraction_llm.{provider, model, base_url, api_key_secret, auth_header}` sits under `memory:`.
- `api_key_secret` must be one of five fixed names (`LLM_API_KEY`, …). `base_url` must be https.
- The memory server bundles LiteLLM.
- Egress to an arbitrary https host is undocumented, but works: verified live with
  `router.kernal.one`.

**S5 delete:** the memory server has soft `DELETE /{type}/{id}`. The gateway proxies it (live check:
`DELETE …/memory/semantic/{id}` → 200).

## A2A (T1–T4)
**T1 Fastify:** reuse `@a2a-js/sdk`'s `JsonRpcTransportHandler`, `validateVersion`, `Extensions`,
SSE helpers, `AgentCard` and errors, with no Express.
- Don't use `DefaultRequestHandler`/`AgentExecutor`. Their in-process event bus breaks
  `SubscribeToTask`/`CancelTask` across Cloud Run instances, pins a blocking call to the run, and
  accepts client `contextId`s.
- Write our own `A2ARequestHandler` on `a2aTasks`.

**Fastify gotchas:**
- Replace the content-type parsers: `text/plain` is accepted by default; route wrong types to
  -32005.
- Map JSON syntax errors to -32700.
- `ignoreTrailingSlash`: the TCK posts to `/a2a/`.
- Read `A2A-Version` from the query parameter ourselves.
- Echo extensions through `ctx.addActivatedExtension`.
- Serve the card with Cache-Control, ETag and Last-Modified.

**T2 Python client:**
- `a2a-sdk` 1.2.1 sends `A2A-Version: 1.0` and v1.0 method names.
- It streams by default when the card allows it; use `ClientConfig(streaming=False)` for
  request/response.
- Default timeout is 5 s.

**T3 TCK** (a2a-tck 263b9cf):
- 81 MUST passed, 0 failed; all levels 93 passed after adding card caching headers.
- No auth option, so a pytest plugin injects Bearer.
- Tests are scripted by messageId prefix (`tck-*`), so CI needs a fake executor. A real agent can't
  follow the script.

**T4 blocking cap:**
- `CORE-EXECUTION-MODE-001` checks only the schema, so a WORKING reply passes.
- Six tests skip when a blocking send isn't terminal.
- The TCK client's read timeout is 30 s, so the owner chose a 25 s cap.

## pi-subagents (P1–P3)
- **P1 inheritance:** `--tools` and `--exclude-tools` are argv-only for the parent session
  (`agentd/src/guru.ts:126-129`).
  - Children are in-process SDK sessions with tools from the agent definition. Builtin `worker`
    has bash, edit and write.
  - Children use their own model (Kernal settings: `worker` = `litellm/claude-sonnet-5`) and don't
    load agentd's extensions.
  - Verified live with pi 0.87.0, pi-subagents 0.71.0 and a local LM Studio model.
- **P2 gates:** launch needs no confirmation (`policy/authority.js:11-20`), and the spawn budget is
  unlimited unless set.
  - The foreman needs `subagent_supervisor`, or a child's question blocks.
  - Leave out `subagents_enable`.
- **P3 #317:** 0.71.0 runs children in the background by default and strips `GIT_CONFIG_*`, which
  carries agentd's git proxy. So background children can't push. The foreman pushes for them.
- **Also:** a cloned repo's `.pi/agents/*.md` outranks builtin agents. So tapes reachable over A2A
  get no `subagent`, and the image sets `agentExcludeDirs` (done in PR8; residual gaps in spec §8).

## Live checks
Run 2026-10-01 with the memory service account (spec, Delivery):
- memory-runtime egress to LiteLLM: **verified**
- gateway DELETE proxying: **verified**
- `buildContext`'s filter on a source without `metadata.repo`: **verified** (it matches only through
  `$exists: false`)
- the gateway's `context-from-sources` route: **verified**
- exactly 10 indexes created on `outfitter-memory`: **verified**
- service-account tokens on `runtime-sessions`: **still open**, moved to PR4 (the memory project has
  no workspaces)
