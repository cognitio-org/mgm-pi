# Agent Engine and A2A: shared memory, delegation both ways, a standard A2A server

Epic E9 (GitHub epic to open with this spec). Status: decisions confirmed with the owner (2026-10-01); ready to plan, starting with the PR0
spike. It
replaces the 2026-09-29 draft on `origin/outfitter/53ec3b3e`; "Changes from the 2026-09-29 draft"
lists what was wrong there.
- **Citations:** repo claims cite `file:line` at `423b877`. Agent Engine claims cite its docs
  (`D/` = `https://www.mongodb.com/docs/agentengine/`). A2A claims cite the v1.0 spec (`A2A §n`).
- **UNVERIFIED:** anything not checked is marked **UNVERIFIED** and is on the spike list (PR0).
- **Review:** an adversarial review (2026-10-01) is folded in.

## Context
**MongoDB Atlas Agent Engine** (Public Preview, launched 2026-09-29; "breaking changes" expected,
`D/reference/limitations.md`) hosts agents you write with its SDK (LangGraph in Python or
TypeScript, Google ADK in Python). It runs them in its own sandboxes and wraps every tool and LLM
call with policy, tracing and human review. It is not a control plane for agents running elsewhere:
- **It can't host or register Outfitter.** Agents are images built from SDK code
  (`D/reference/agent-contract.md`). There is no "external agent" resource.
- **Its A2A is not the open protocol.** It is a call path, brokered by the Orchestration Engine,
  between hosted agents in one project ("Cross-project routing is not yet implemented",
  `D/add-features/agent-to-agent.md`). There is no `/.well-known` card, no JSON-RPC, and no path in
  or out.
- **Its governance only covers hosted agents.** Policies, guardrails and HITL are enforced on calls
  through its `app.tool`/`app.llm` wrappers (`D/manage/governance/policy-engine.md`,
  `D/reference/agent-contract.md`).
- **What an outside system can use:**
  - the standalone memory service, over REST, MCP or `@mongodb-js/agent-engine-sdk-memory`
    (`D/add-features/memory-only.md`)
  - the invoke API for hosted agents (`D/deploy/invoke-agent.md`)
  - project-scoped service-account tokens: `client_credentials` only, 1 h, and "can act only on its
    own project" (`D/api-keys-service-accounts.md`)

The **A2A protocol** is at v1.0.1 (2026-05-28, https://github.com/a2aproject/A2A/releases).
- **Wire:** JSON-RPC, gRPC and HTTP+JSON bindings; an Agent Card at `/.well-known/agent-card.json`;
  task ids assigned by the server (A2A §3.4).
- **Identity:** it carries none in payloads. Delegation, on-behalf-of and RFC 8693 token exchange
  are not in the spec (open proposal #2028).
- **SDKs:** the official TS SDK is `@a2a-js/sdk` 1.3.0; the Python one is `a2a-sdk` 1.2.1.

What Outfitter has today that this builds on:
- **The op registry** (`packages/api/src/admin/ops.ts`), reached from a Drive through agentd's admin
  socket and from a laptop through `POST /api/admin/ops`. It has approval cards (E8.2,
  `admin/approvals.ts:44-82`) and an audit trail (`adminAudit`).
- **The Dongle** (`outf_` token, 90 days, `tokens.ts:9-41`), accepted on the public link role
  (`auth.ts:111-115`).
- **Sessions and mail:** `POST /api/sessions` (`routes/sessions.ts:416-457`) and
  `RunManager.wake` (`runs.ts:170-260`).
- **Not built yet:** a "turn finished" signal. E5.2 designed it (EPIC.md:499-536): pi's
  `agent_settled`, then failed/stopped, then a deadline sweep.
- **Memory in a Drive today is pi-memory Markdown on the sandbox disk.** It is lost when the sandbox
  is replaced, and `memory_search` needs a `qmd` binary the image doesn't ship.

Goal: Outfitter agents share long-term memory; they can ask Agent Engine agents for help; Agent
Engine agents (and any A2A client) can hand Outfitter a coding task and get the result back.

Decisions (confirmed with the owner, 2026-10-01):
- **Scope:** four parts: outbound calls to Agent Engine agents; inbound from Agent Engine; a
  standard A2A v1.0 server; memory for Drives.
- **Memory backend:** Agent Engine's memory service, not a store of our own.
- **Tapes:** trimmed to what the four parts need (Foreman plus an A2A worker tape). No persona
  tapes, and no tools that duplicate the MongoDB MCP server.
- **Cluster:** the main cluster moves from M0 to Flex and also holds Agent Engine's memory
  databases. Agent Engine connects with a hand-made user that can only reach those databases (§3.1).
- **Extraction LLM:** through the LiteLLM gateway, with a direct provider key only if PR0 shows the
  memory runtime can't reach it.
- **Users:** both users (Matthew, Matej) get A2A keys and memory from day one. No allowlist gate.
- **Blocking `SendMessage`:** waits up to 55 min, then returns the task still `WORKING` (§5.3).
- **`outfitter-delegate`:** lives in the agents project, with its A2A key as a workspace-scoped
  secret (§6).

Also adopted (proposed in this spec, accepted with the decisions above):
- **One inbound path.** Agent Engine reaches Outfitter as an ordinary A2A client of our server (an
  `@app.tool` using `a2a-sdk`), not through a second bespoke API.
- **Identity is the credential's owner, with a separate memory identity.** An inbound task runs as
  the Outfitter user who issued the A2A key, limited to that key's tapes and repos. It never reads
  or writes that user's memory (§5.4). No token exchange, no delegation chain.
- **Agent Engine credentials stay in the api.** Drives reach them through new ops on the admin
  socket, like GitHub and admin today; pi never holds them.
- **Drive-only in v1.** The `memory` and `agent_engine` tools work in Drives, not in laptop Kernal
  (§3.3).

## Changes from the 2026-09-29 draft
- **Architecture:** Agent Engine is not a control plane or policy bus over Outfitter, and it can't
  send A2A tasks to Outfitter natively. The draft's §1 diagram and §4.2 "cascading policy engine"
  are dropped.
- **Epic:** E8 is Sysop tools (EPIC.md:617). This is **E9**. EPIC has no phases.
- **A2A contract:** `POST /a2a/v1/tasks` with a client-chosen `taskId` is not A2A. v1.0 uses
  `SendMessage`/`GetTask`/…, and the server assigns ids (§5).
- **Tokens:**
  - The draft's token had `sub`/`act` reversed (RFC 8693 §4.1: `sub` is the principal, `act` the
    actor).
  - No issuer `auth.mongodb.com/agentengine` exists.
  - Neither Agent Engine nor A2A 1.0 does token exchange. Replaced by scoped A2A keys (§5.2).
- **Addresses:** `atlas://org/agents/name` URIs don't exist; agents are workspace ids.
  `link.kernal.run` is the preview wildcard, not the link origin.
- **Memory:**
  - The draft's index (`knnVector`, 1024 dims, `voyage-code-3`, `filter` mappings) was invalid, and
    Agent Engine creates its own indexes anyway. There was no "RTEB".
  - Per-turn `run.spec.memoryContext` can't work, because agentd applies run.spec once per run
    (protocol.md:681-683).
- **Governance claims:**
  - Sandbox egress allows all public 443/80 (`deploy/gke/sandbox-template.yaml:26-45`).
  - Tool calls reach Atlas as pi `entries` after they run (`agentlink.ts:1534`), not "before
    execution completes". Nothing is tamper-evident.
  - Spend limits are per-tape LiteLLM key budgets (`secrets.ts:235-238`); caps are E5.3.
- **Frames:** request/response frames are `{t, reqId, op, args}` and not seq'd
  (`protocol.ts:180-199, 501-509`). The draft's `seq`/`id`/`replyTo` shape didn't match. This spec
  adds ops, not frames.
- **Tapes:**
  - `litellm/gemini-auto-jev` appears nowhere, and `openrouter/...` models don't run in a Drive.
  - `subagents_enable`, `a2a_delegate`, `atlas_*` and `source_check` don't exist.
  - The Foreman's allowlist omitted `subagent`, so it couldn't delegate.
  - `register-tapes.mjs` can't reach `/api/gurus` in production (web role, behind IAP).
- **Dropped files:** the HTML viewer, `serve-spec.mjs` and `register-tapes.mjs` stay on the old
  branch.

## Design

### 1. Turn-settled signal (shared with E5.2)
Inbound tasks need to know when a turn is done. Build E5.2's three completion layers server-side
now, without the `outfitter_delegate` tool, so E5.2 and E5.6 reuse them.
1. **Settle.**
   - agentd already forwards every pi event, `agent_settled` included (`run.ts:1068`).
   - Entries arrive through a 250 ms JSONL poller (`pi.ts:363`), so the final assistant entry can
     lag the event. On `agent_settled`, agentd first flushes the tailer (`await this.tailer.poll()`,
     as checkpoint does at `run.ts:1262`), then sends the event with `lastEntryId` added.
   - The api records `Session.settledAt` and emits an in-process `settled(sessionId, lastEntryId)`.
   - A waiter completes on **the first settle after its mail was acked**. Other mail (the owner
     typing, `outfitter_send`) can also settle a turn, so a settle is never matched to a mail id.
2. **Stopped unsettled.** A run reaching `failed`/`stopped` while a waiter is open ends the waiter
   with the reason. It never overwrites a waiter that is already finished (e.g. canceled).
3. **Deadline.**
   - Each waiter has a `deadlineAt` (default 60 min), swept by `/api/hooks/tick`.
   - While the run is `provisioning`/`running` with activity in the last 10 min, the sweep pushes
     the deadline forward.
   - Hard cap 4 h. At expiry the api calls `runs.stop(runId, "deadline")` (`runs.ts:274`), then
     ends the waiter.

Don't use run state `idle` (EPIC.md:517-519: agentd is idle before any prompt).

### 2. Agent Engine connection (api)
- **Two Agent Engine projects, two service accounts.** A service account acts only on its own
  project, and agents in a project read all its secrets by default (`D/reference/limitations.md`
  "Secret Access").
  - **Memory:** `AGENT_ENGINE_MEMORY_PROJECT_ID` plus secret `outfitter-agentengine-memory-sa`. A
    memory-only project, with no agents, so nothing hosted can read its `MONGODB_URI`/Voyage/LLM
    secrets.
  - **Agents:** `AGENT_ENGINE_AGENTS_PROJECT_ID` plus secret `outfitter-agentengine-agents-sa`. This
    project holds the agents Outfitter calls, and `outfitter-delegate` (§6).
  - Each secret holds the client id and secret (`ae_sa_id_`/`ae_sa_sk_`, 2160 h default expiry).
  - Each part is off while its project id is unset, so dev and CI need no account.
- **Base URL:** `AGENT_ENGINE_BASE_URL`, default `https://agentengine.mongodb.com`.
- **Token:**
  - `POST /api/v1/oauth/token`, `grant_type=client_credentials`, sent as HTTP Basic.
  - Cached per project and refreshed 5 min before `expires_in` (3600).
  - One in-flight refresh per instance, since token requests are rate-limited (429).
- **Module:** `packages/api/src/agentengine/`:
  - `client.ts`: fetch, token, typed errors.
  - `memory.ts`: wraps `@mongodb-js/agent-engine-sdk-memory` in HTTP-direct mode with `projectId`.
    The token is fixed per `Memory` instance, so it injects `Authorization` through `fetchImpl`.
    **UNVERIFIED:** the `fetchImpl` option; the fallback is to rebuild the instance on refresh.
  - `agents.ts`: invoke, executions.
  - A `FakeAgentEngine` for tests.
- **Preview risk:** pin SDK versions exactly (0.11.7 at the time of writing, from npm) and keep
  every Agent Engine type inside this module.
- **Rotation:** a runbook in `deploy/agent-engine.md` for both service-account secrets (90 days).
  The api logs a warning 14 days before expiry, using `secret_expires_at` recorded at setup.

### 3. Memory
#### 3.1 Where it lives
- **One memory-only Agent Engine project** (`agentengine create --memory-only`,
  `D/add-features/memory-only.md`).
- **Its data sits in an Atlas cluster we supply** (`MONGODB_URI`), Flex at minimum
  (`D/add-features/memory.md`).
- **Decision: the main cluster `outfitter` moves from M0 to Flex and is shared.**
  - Agent Engine's data lives in its own databases on the same cluster: `MONGOMEM_DB_NAME` (default
    `mdb_memory_<project-id>`) and `MDB_AGENTIC_STORE_DB` (default `mdb_store`).
  - Outfitter keeps database `outfitter` (`MONGODB_DB`).
  - It's one cluster and one bill. The upgrade also lifts M0's three-search-index cap, which session
    search already presses on (indexes.ts:3).
- **Database user `outfitter-agentengine`**, created by hand, is the only credential Agent Engine
  gets. It is limited to cluster `outfitter` and has role `readWrite` on the two memory databases
  only.
  - It has no access to `outfitter`. That boundary is the only thing between the two datasets, so
    the owner step checks it (Verification).
  - It needs whatever Agent Engine uses to create its Search and Vector Search indexes on those
    databases. **UNVERIFIED** (PR0): whether `readWrite` is enough, or which narrower extra role is
    needed. Never `readWriteAnyDatabase` or `atlasAdmin`.
- **Never run `agentengine atlas setup` against this Atlas project.** It creates a user with
  `readWriteAnyDatabase` (`D/reference/limitations.md`), which would reach Outfitter's data. The
  memory project is set up by hand (Owner steps).
- **Network:** the project's IP access list is already `0.0.0.0/0` (atlas.md:37), so Agent Engine's
  data plane gets in without `atlas setup-ip-access`. Narrowing the list is E7. When it happens,
  add Agent Engine's ranges there.
- **Upgrade risks** (PR0, owner-run):
  - The M0 to Flex move is an Atlas tier change with a short interruption. **UNVERIFIED:** that
    Atlas does it in place and keeps the search indexes. Otherwise re-run `deploy/atlas-search.sh`
    after.
  - **UNVERIFIED:** autoEmbed (session search) works on Flex as on M0.
  - **UNVERIFIED:** the index budget on Flex covers session search's two indexes plus the ones
    memory creates.
  - Atlas billing must be enabled first (atlas.md:98). EPIC.md:87,121 ("Flex/M10 deferred") is
    updated.
- **Embeddings:**
  - Voyage, through our own `VOYAGE_API_KEY` project secret (default `voyage-4-large`, 1024 dims).
    This is not Atlas autoEmbed.
  - **The Voyage account needs a payment method.** Without one it keeps the 3 RPM / 10k TPM limit
    that session search hit (sysop-tools.md:88), and recall embeds on every turn.
- **Extraction:**
  - `memory.extraction.enabled: [semantic, episodic, procedural]`. List it explicitly: the default
    is none, and removing the line enables every type (`D/add-features/memory.md`).
  - Taxonomic is left out, because extracted taxonomic memories default to `org` visibility
    (`D/add-features/memory-types.md`).
- **Extraction LLM:**
  - `extraction_llm: {provider: openai, base_url: <LiteLLM gateway>, auth_header: authorization,
    api_key_secret: LLM_API_KEY, model: <LiteLLM model group>}` (`D/add-features/memory.md`).
  - `LLM_API_KEY` is a LiteLLM virtual key with its own budget. Its Secret Manager copy is
    `outfitter-agentengine-extraction-key`; not `outfitter-litellm-key-*`, which `secrets.ts:235`
    reads as a tape id.
  - **UNVERIFIED:** that the memory runtime has egress to the gateway. If not, use a direct provider
    key.
- **Filterable metadata:**
  - Declare `metadata_partition_key: [{name: repo, type: string}]` and
    `metadata_partition_index: {semantic: [both], episodic: [both]}` in `project-config.yaml`.
  - Needs memory server ≥ 0.0.81, then `memory apply --upgrade`
    (`D/sdk/python/packages/agent-engine-sdk-memory.md`).

#### 3.2 Identity, types and visibility
- **Identity:** the api binds each call with `memory.bind({userId, sessionId})`.
  - A Drive: `userId` = `sha256(ownerEmail)[:16]` (no email leaves Outfitter), `sessionId` = the
    Outfitter session id.
  - A2A sessions use a separate identity (§5.4).
  - The standalone service honours explicit ids (`D/reference/limitations.md`).
- **Types:**
  - `semantic`: facts, e.g. "repo X runs tests with `npm run test:unit`".
  - `episodic`: what happened in past sessions.
  - `procedural`: runbooks.
  - `taxonomic`: domain terms. Explicit save only; always `org`.
- **Visibility:**
  - Everything is `private` unless the agent saves with `shared: true`, which sets `org`.
  - Taxonomic always needs `shared: true`.
  - Outfitter has two users (Matthew, Matej); `org` is visible to both.
- **Repo scope:**
  - Semantic and episodic carry `metadata.repo`. Procedures carry a `repo:<R>` tag, since
    `saveProcedure` has tags, not metadata.
  - Extracted memories have no repo. So a session on repo R searches with `{$or:
    [{"metadata.repo": R}, {"metadata.repo": {$exists: false}}]}`, and a strict filter never hides
    them.

#### 3.3 How it's used
- **Tape field `memory: "off" | "tool" | "auto"`**, default `off`.
  - Set only by a person in the web UI; `gurus-service.ts` refuses it from agent writers, like
    `adminTools` (`gurus-service.ts:199-206`).
  - Carried in `RunSpecGuru.memory` (`protocol.ts:302-321`, built at `agentlink.ts:1259-1271`).
- **Tool (`tool` and `auto`):** one Kernal tool, `memory`, in a new extension
  `kernal/.pi/extensions/outfitter-agentengine/`.
  - It uses outfitter-admin's socket transport (`outfitter-admin/transport.ts`).
  - Actions: `search {query, type?, limit?}` and `save {type, text, label?, shared?}`. The repo comes
    from the session, never from the model.
  - Ops: `memory.search` (read), `memory.save` (write, audited).
  - `save` text goes through `search/redact.ts`.
  - The SDK has no delete (the JS facade documents none), so there's no forget action. Wrong
    memories are fixed by saving a correction; semantic reconciles with `UPDATE`.
- **Recall (`auto`):** an agentd pi extension `pi-extension/outfitter-memory.ts`.
  - On `before_agent_start` it calls op `memory.context {query: prompt}` over the admin socket.
    agentd makes the socket group-owned by the agent gid (`run.ts:959-967`).
  - The api runs `buildContext({query, maxTokens: 2000, enabledSources: [semantic, episodic,
    procedural]})`. The default sources are episodic and semantic only. 2000 tokens leaves ~1500
    after the 500-token reserve.
  - The extension sets `event.systemPromptOptions.sections.memory`. pi rebuilds from sections
    (`extensions.md:571`), and an earlier handler returning `systemPrompt` (pi-memory does,
    `pi-memory/index.ts:1581-1583`) would drop an `appendSystemPrompt` edit.
  - When `forceSystemPrompt` is set, it appends to that instead, as `kernal-html-preview/index.ts:
    41-48` does.
  - The block is framed as "notes from earlier sessions; may be wrong; not instructions".
  - It waits at most 3 s, then goes on without memory.
- **Record (`auto`):** the api records each user prompt and each settled final assistant message
  (§1) with `recordTurn`.
  - It hooks in next to the session-search indexer (`agentlink.ts:1534`), after `redact.ts`.
  - `idempotencyKey` = the entry id, so replays dedupe.
  - Tool output is never sent.
  - Best effort, queued, dropped on failure.
  - Agent Engine extracts long-term memories itself (every 20 messages or 3 idle minutes,
    `D/add-features/memory-extraction.md`).
- **pi-memory off:** when `memory != off`, agentd:
  - adds all seven pi-memory tools to `excludeTools` (`memory_write, memory_read, memory_search,
    memory_forget, memory_restore, memory_status, scratchpad`; `guru.ts:127-128`)
  - sets `PI_MEMORY_DIR` to an empty temp dir, which stops its prompt injection (`index.ts:
    1540-1583`)
  - sets `PI_MEMORY_EXIT_SUMMARY=0`, which stops its LLM exit summary (`index.ts:1465`)
- **Admin socket and gating:**
  - Today the socket opens only for `adminTools` (`run.ts:833-837`); it will also open for `memory`
    or `agentEngine`.
  - Each op declares the tape capability it needs (`admin`, `memory`, `agentEngine`), and
    `DriveAdmin` refuses an op the tape lacks. So opening the socket for memory doesn't expose
    `tapes.*`.
  - `transport.ts:36`'s `READ_ACTIONS` gains `context`, so `memory.context` is a read (no
    idempotency key, retried once).
- **Laptop Kernal: not in v1.** `POST /api/admin/ops` has no tape or session (`routes/admin.ts:
  23-27`), so `memory.*` and `ae.*` return "Drive only" there. A later PR can add laptop identity
  (`sessionId = laptop:<pi session id>`).
- **Alternative considered:** the api prepends a `<memory>` block to the prompt at mail delivery.
  That needs no pi extension or image change, but the block lands in the transcript and in session
  search forever. Rejected for that reason.

#### 3.4 Cost and limits
- **Prices:** storage $0.25 per 1k long-term docs, retrieval $0.50 per 1k docs retrieved (preview
  pricing, https://www.mongodb.com/products/platform/atlas-agent-engine).
- **Other costs:** the Flex cluster, Voyage tokens and extraction LLM tokens. Extraction tokens are
  outside Agent Engine's caps.
- **Recall retrieves on every turn**, so `auto` is set per tape.
- PR3 logs a daily count of `memory.*` calls and retrieved docs, to compare with the bill.

### 4. Outbound: calling Agent Engine agents
- **Allowlist:** collection `aeAgents {id (slug), workspaceId, name, description, enabled}` in both
  stores, managed by sysops in a web UI page (Settings → Agent Engine agents). Agents call only
  listed, enabled entries; there's no discovery call to trust.
- **Tape field `agentEngine: boolean`**, web UI only, like `memory`.
- **Tool `agent_engine`**, in the same Kernal extension:
  - `list`: the enabled agents with descriptions (op `ae.list`, read).
  - `invoke {agent, message, wait?}` (op `ae.invoke`, write, audited with agent and execution id).
    - Uses `invokeStream` (`D/deploy/invoke-agent.md`): the execution id comes from the first frame,
      and it reads until `done`/`error` or `wait` seconds (default 120, max 280). Then it closes
      and returns `{status, executionId, response?}`.
    - A sync `invoke` would only return the id at the end, and aborting it "closes only your side".
    - Sends `X-Session-ID: outf-<session8>-<agent>`, so one Outfitter session reuses one Agent
      Engine session and its sandbox pair. Sessions without an id take new sandboxes, and a full
      pool fails with `pool full`.
    - Sends `X-Mdb-Agent-Engine-Custom-Outfitter-Session: <session8>` only, with no email.
  - `get {executionId}` (op `ae.get`, read): `GET /api/v1/projects/{p}/executions/{id}
    ?workspace_id=…`.
  - `resume {executionId, decision, notes?}` (op `ae.resume`, new class `approve`): for executions
    suspended for human review.
    - Always raises the E8.2 card. It shows the agent, `suspend_context` (clipped, escaped, labelled
      as remote text) and the decision.
    - The decision must be one of the execution's `allowed_decisions`.
    - The body is `{decision, reviewer_notes}`, and the custom headers are resent
      (`D/deploy/human-in-the-loop.md`).
    - An agent never approves another agent's pause on its own.
- **Op classes** (`ops.ts:27`) gain `approve`, which always needs `approved`. `approvalNeeded`
  (`ops.ts:509`) and the card renderer (`drive.ts:52-61`) learn it.
- **Results are untrusted text:** clipped to 8 KB and marked `[from Agent Engine agent <id>]`.
- **Cost:**
  - Runtime is billed per vCPU-second, and a session holds its sandboxes until
    `agent_idle_ttl_seconds` (default 600).
  - When the Outfitter session closes, the api stops the Agent Engine session through the REST call
    behind `agentengine workspace sessions stop` (PR0 finds it, e.g. with the CLI's verbose flag).
    Failing that, the idle TTL applies. `executions/{id}/cancel` on a finished execution releases
    nothing.

### 5. Inbound: a standard A2A v1.0 server
#### 5.1 Surface
- **Where:** the link role (the public origin). The routes are registered in every branch of
  `routes/index.ts`. They sit outside `/api/*`, so they skip the IAP preHandler (`server.ts:
  154-155`) and authenticate themselves.
- **Agent Card** at `/.well-known/agent-card.json`, served with `Access-Control-Allow-Origin: *`:
  - `name: "Outfitter"`, `description`, `version` = the release, `provider`.
  - `supportedInterfaces: [{url: <link>/a2a, protocolBinding: "JSONRPC", protocolVersion: "1.0"}]`.
  - `defaultInputModes: ["text/plain", "application/json"]`, `defaultOutputModes: ["text/plain",
    "application/json"]`.
  - `capabilities {streaming: true, pushNotifications: false, extendedAgentCard: true, extensions:
    [outfitter-task]}`.
  - `securitySchemes {outfitterKey: {httpAuthSecurityScheme: {scheme: "Bearer"}}}` and
    `securityRequirements: [{schemes: {outfitterKey: {list: []}}}]`.
  - One skill `{id: "coding", name, description, tags: ["coding", "git"]}`. The description tells
    clients to send `returnImmediately: true`.
  - The **extended card** (`GetExtendedAgentCard`, authenticated) lists the tapes the key may use as
    skills (`id` = tape id). The public card never reveals tape names.
- **Methods (JSON-RPC at `/a2a`):** `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`,
  `CancelTask`, `SubscribeToTask`, `GetExtendedAgentCard`.
  - Push-notification methods return `PushNotificationNotSupported` (-32003).
- **Version:** `A2A-Version: 1.0`, as a header or a query parameter (A2A §3.6.1). A missing version
  means 0.3 and gets `VersionNotSupported` (-32009).
- **Implementation:** `@a2a-js/sdk` 1.3.0's handler and types behind our own Fastify route.
  **UNVERIFIED:** how its server mounts outside Express. The fallback is its types plus our own
  dispatch (PR0).

#### 5.2 A2A keys
- **A new token kind on `ApiToken`** (`store/types.ts:601-621`): `kind?: "dongle" | "a2a"` and
  `a2a?: {tapes: string[] (tape ids), repos: string[], maxConcurrent: number}`.
- **Same format as a Dongle:** `outf_` + 32 bytes, hash-only, 90-day TTL, owner revocation. The
  owner creates keys on the web UI's Dongles page with a tape and repo picker. `routes/tokens.ts`
  and the page show the kind.
- **Each kind works on its own routes only.** Enforced in `identityFromApiToken` (`auth.ts:87`),
  which both roles use:
  - an A2A key works only on `/a2a` (the card itself is public)
  - a Dongle on `/a2a` gets 401
  - an A2A key on `/api/*` gets 401
- **Allowed tapes:** key creation, and every task start, refuse any tape with `adminTools` not
  `off`, `agentEngine: true` or `memory: auto`. Tapes are re-read at task start, since the web UI
  can change them later.
  - An admin tape can run `tapes.*` writes without approval (`ops.ts:6-9`), which a remote caller
    must never reach.
- **Scope:**
  - A task naming a tape or repo outside the key's lists is `REJECTED` with a one-line reason.
  - Repos also need the GitHub App's installation, as today.
- **Limits:**
  - `maxConcurrent` (default 2) non-terminal tasks per key, and 60 requests/min per key. Both are
    atomic claims in the store, since Cloud Run runs several link instances.
  - 64 KB request body; prompt text up to `MAIL_MAX_TEXT` (32,000, `mail.ts:37`), beyond which
    -32602.
- **Rotation:** the key held by `outfitter-delegate` (§6) expires in 90 days. The Dongles page shows
  "expires in N days", and the runbook covers replacing the Agent Engine secret.

#### 5.3 Tasks
- **Authorization:** every lookup (`GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, a
  `taskId` or `contextId` in a message) filters on the caller's `tokenId`. Anything else gets
  `TaskNotFound` (-32001) or -32602.
  - `contextId` is an opaque id stored on `a2aTasks`, never the session UUID, so no web-created
    session can be named.
  - A mismatched `taskId`/`contextId` pair is rejected (A2A §3.4.3).
- **Choosing tape and repo:**
  - Extension `https://kernal.one/a2a/ext/outfitter-task/v1` (`required: false`), with params in
    `message.metadata[<uri>] = {skill, repo?, baseBranch?}`.
  - Clients activate it through the `A2A-Extensions` header (A2A §4.6); the server echoes it back.
  - Without it, the task uses the key's first tape and no repo.
- **Branch:** always `outfitter/a2a-<task8>`, never from the client.
  - `branchAllowed` always allows the session branch (`branch-policy.ts:43-46`), and the session
    route stores a given branch as is (`routes/sessions.ts:445`).
  - So a client-chosen `main` would pass the git proxy.
- **New task** (no `taskId`, no `contextId`):
  - The api creates a session as the key's owner. The create logic moves out of
    `routes/sessions.ts:416-457` into a service that both routes call.
  - Name: `A2A: <first line>`. Prompt: the text parts, with `data` parts appended as fenced JSON.
    `raw`/`url` parts get `ContentTypeNotSupported` (-32005).
  - Posts the mail and returns the task in `SUBMITTED`, with a new UUID `id` and a new `contextId`.
- **Follow-up** (`contextId` given, no `taskId`): if the context's last task is terminal, a new task
  on the same session. Otherwise `REJECTED` ("one task at a time per context").
- **Message to an existing task:**
  - A task in `INPUT_REQUIRED`: answers the pending request (below).
  - A terminal task: `UnsupportedOperation` (-32004), as for `SubscribeToTask` on one (A2A §3.1).
  - A working task: rejected with -32602 ("task is working; wait or cancel"). No mid-turn steering
    in v1.
- **What can be answered over A2A:**
  - Only `input` and `editor` UI requests.
  - `confirm` and `select` stay with the owner in the web UI. They include pi-subagents' "Authorize
    subagent…" / "Grant subagent spawn budget?" and MCP tool approvals. While one is pending the
    task stays `WORKING` with status text "waiting for the owner".
  - Admin cards live in `adminApprovals`, never in `Run.pendingUiRequest`, and are likewise
    owner-only (`approvals.ts:97-115`). They show as `WORKING`, "waiting for owner approval".
- **Store:** collection `a2aTasks {id, contextId, sessionId, tokenId, ownerEmail, mailId, state,
  statusText?, result?, createdAt, updatedAt, deadlineAt}`.
  - In both memory.ts and mongo.ts, with ISO-string dates.
  - Mongo indexes: `{tokenId, state}`, `{tokenId, contextId}`.
- **States:**

| A2A state | When |
|---|---|
| `SUBMITTED` | session and mail created |
| `WORKING` | run `provisioning`/`running`, or waiting for the owner |
| `INPUT_REQUIRED` | `Run.pendingUiRequest` with method `input`/`editor` |
| `COMPLETED` | settle (§1), then the checkpoint push landed (below) |
| `FAILED` | stopped unsettled, the push failed, or the deadline expired (§1) |
| `CANCELED` | `CancelTask`: `runs.stop(runId, "a2a")`; a `SUBMITTED` task's mail is marked dead so no later wake delivers it |
| `REJECTED` | scope, tape, concurrency or per-context rule |

- **Completion:**
  - On settle, the api sends the existing `{t: "checkpoint"}` down-frame (`protocol.ts:444`). A
    checkpoint otherwise only happens at idle-stop or stop.
  - `COMPLETED` needs the resulting checkpoint to report `pushed`. After 2 min without it, the task
    is `FAILED` ("result not pushed").
  - The artifact is added before the final status.
- **Result artifact:**
  - A `text` part: the final assistant message.
  - A `data` part: `{branch, head, compareUrl, prUrl?}`. `prUrl` comes from a GitHub broker lookup of
    an open PR for the head branch; `Run.githubIdempotency` has no op names
    (`store/types.ts:324-326`).
- **Streaming:** `SendStreamingMessage`/`SubscribeToTask` poll the task row every 2 s, which works
  across link instances.
  - Order (A2A §3.1.2): the Task, then a `statusUpdate` per change (the latest tool name as status
    text while working), then `artifactUpdate`, then the final `statusUpdate`, then close.
  - No token streaming in v1.
- **Blocking `SendMessage`** (no `returnImmediately`):
  - A2A requires waiting until a terminal or interrupted state (A2A §3.2.2).
  - The link allows 3600 s (`deploy/service.sh:246-258`), so the call waits up to 55 min, then
    returns the task still `WORKING`.
  - That breaks the MUST; the deviation is documented in the card description and in the PR's TCK
    notes.

#### 5.4 Memory for A2A sessions
- **Identity:** an A2A session uses `userId = a2a:<tokenId>`, never the owner's.
  - A remote caller's prompt must not be extracted into the owner's long-term memory and recalled
    into their later sessions.
  - The owner's private memories must not be recalled into a session whose output goes back to the
    caller.
- **Mode:** key tapes may have `memory: off` or `tool` only (§5.2); `recordTurn` never runs for A2A
  sessions.
- **Limits:** `memory.save` from an A2A session can't set `shared` or write taxonomic. Memory saved
  under one key stays with that key.

### 6. Inbound from Agent Engine
An Agent Engine agent reaches Outfitter as an A2A client of §5. No Outfitter code runs in Agent
Engine beyond one tool module.
- **Deliverable:** `outfitter/integrations/agent-engine/`, containing:
  - `outfitter_tools.py`: `@app.tool` functions `outfitter_start(task, skill, repo?)` and
    `outfitter_status(task_id)`, using `a2a-sdk` with `returnImmediately: true`. A coding task runs
    far longer than one tool call should hold a sandbox.
  - A sample LangGraph agent `outfitter-delegate`. Its `agent.yaml` lists both tools under
    `sandboxes.tool.tools` (tools run in the agent sandbox otherwise). The tool sandbox gets
    `network.egress_mode: allow_list` for the link host and `secrets: [OUTFITTER_A2A_KEY]`.
  - A README.
- **Secret scope:** the key is set with `agentengine secret set --workspace-scope`
  (`D/reference/limitations.md`), so other agents in the agents project can't read it.
- **Governance on that side is Agent Engine's:** `AUTHORIZED_TOOLS`, call and token caps, and
  `interrupt()` for human review before `outfitter_start`. That is where Agent Engine governance and
  Outfitter meet.
- **Optional hardening:** a per-key source-IP allowlist of Agent Engine's egress IPs (`34.196.57.85`,
  `54.227.181.25`, `D/network-egress.md`).
- **Tests:** `agentengine dev` runs it locally against dev Outfitter; one deploy is owner-run
  (billed).

### 7. Tapes
The owner creates them through a Sysop session (`outfitter_tapes`), then sets `memory` and
`agentEngine` in the web tape editor. Agents can't set those fields (§3.3). The definitions live in
the `outfitter-admin` skill's references.
- **`foreman`:** plans and delegates, doesn't edit.
  - Model `DEFAULT_CLOUD_MODEL` (`litellm/claude-auto-llm`, `config.ts:372`), thinking `high`,
    `memory: auto`, `agentEngine: true`.
  - Tools: `read, grep, find, ls, subagent, bg_wait, git, github_issue, github_pr, memory,
    agent_engine`.
    - `subagent` and `bg_wait` are pi-subagents' parent tools (`src/extension/index.js:703`,
      `runs/background/wait-tool.js:28`).
    - `edit`/`write`/`bash` are left out on purpose.
  - **UNVERIFIED:** whether the tape's `--tools` allowlist carries into child pi processes, which
    need `edit`/`bash`. pi-subagents also sits at 0.70.1 installed against 0.71.0 in the lockfile.
- **`a2a-coder`:** the default skill for inbound tasks.
  - Default model, the standard coding tools, `memory: tool`, no admin tools, no `agentEngine`.
  - Prompt: finish without asking, commit to the task branch, open a PR only when the task says so,
    end with a summary.
- **Dropped:**
  - the four persona tapes
  - `atlas_cluster`/`atlas_vector` (the MongoDB MCP server does this for people)
  - `atlas_governance` (no Agent Engine API governs outside agents)
  - `atlas_a2a`/`a2a_delegate` (replaced by `agent_engine` and §5)

### 8. Security
- **Credentials:**
  - Agent Engine service accounts live only in the api (Secret Manager), one per project. Drives
    reach them only through ops the tape enables, as the session owner.
  - A2A keys are hash-only, scoped by tape and repo, rate-limited, and never work on `/api/*`.
- **A remote caller:**
  - acts only through tapes without admin tools or `agentEngine`
  - only on branch `outfitter/a2a-*`
  - only on its own tasks and contexts
  - never answers confirms or approvals
  - never touches the owner's memory
- **Prompt injection:** A2A input, Agent Engine output and recalled memory are untrusted text and
  are labelled as such. A tape's tools bound what a task can do in the owner's name.
- **Memory poisoning:**
  - Org memory needs an explicit `shared: true` save from a non-A2A Drive, and extraction never
    writes taxonomic.
  - Both users see org memory. The recall block says it may be wrong.
- **Database isolation:** the cluster is shared, so the boundary is the database user (§3.1).
  - `outfitter-agentengine` has `readWrite` on the memory databases only, and `agentengine atlas
    setup` is never run.
  - The owner verifies the user can't read `outfitter` before the URI goes into Agent Engine.
  - If that user's password leaked, the damage is limited to memory data. It's stored only in the
    memory project's secrets.
- **PII:** no emails go to Agent Engine (hashed user ids, session-prefix headers).
- **Egress stays as it is** (all public 443). Restricting it is E7.
- **Audit:** `ae.invoke`, `ae.resume`, `memory.save` and `aeAgents` changes write `adminAudit` rows.
  A2A tasks keep their `a2aTasks` row plus the session.

## Non-goals
- Agent Engine governing Outfitter runs (no such API), or hosting Outfitter.
- RFC 8693 token exchange and delegation chains (in neither A2A 1.0 nor Agent Engine). Revisit if
  A2A #2028 lands.
- A2A push notifications (the webhook SSRF surface), gRPC and HTTP+JSON bindings, and card signing.
- Outbound calls to arbitrary A2A agents. `agent_engine` could grow an `a2a` target later.
- `memory` and `agent_engine` on laptop Kernal (later PR).
- Dollar spend caps (E5.3).

## Delivery
One GitHub epic (E9) with a child issue per PR, `area` labels, and status comments. EPIC.md gains
E9 and marks E5.4 ("reuse pi-memory … GCS", EPIC.md:539) superseded.

| PR | Contents | Depends on |
|---|---|---|
| PR0 | Spike: the UNVERIFIED list. Owner runs the billed parts. | |
| PR1 | Turn-settled signal (§1): agentd flush plus `lastEntryId`, api waiters and deadline sweep | |
| PR2 | Agent Engine client, two-project config, fake, rotation warning (§2). Tape fields `memory`/`agentEngine` (types, validation, web editor, `RunSpecGuru`, protocol.md). Op capability gating, `approve` class, socket opening, `READ_ACTIONS` | PR0 |
| PR3 | Memory: ops, Kernal `memory` tool, agentd `outfitter-memory.ts` (image copy and prewarm `Dockerfile:240-243, 317-318`, `main.ts:247-249`, `guru.ts:115-117` `--extension`), `recordTurn`, pi-memory shutdown, `deploy/agent-engine.md` | PR1, PR2 |
| PR4 | Outbound: `aeAgents` (both stores, web page), `agent_engine` tool, resume card | PR2 |
| PR5 | A2A keys (`auth.ts`, tokens routes, Dongles page), `a2aTasks` and indexes, session-create service, card, routes in `routes/index.ts`, core methods, branch rule, A2A memory identity | PR1, PR2 |
| PR6 | Streaming, `INPUT_REQUIRED`, checkpoint-gated completion, TCK run against dev | PR5 |
| PR7 | `integrations/agent-engine/` tool module and sample agent | PR6 |
| PR8 | `foreman` and `a2a-coder` definitions, skill references, EPIC.md | PR3, PR4, PR6 |

PR3/PR4 run in parallel with PR5/PR6. Deploy config (`deploy/service.sh`, `config.ts`) for new
secrets lands with the PR that reads them.

**Spike list (PR0):**
- `@a2a-js/sdk` server on Fastify.
- Whether `a2a-sdk` (Python) 1.2.x speaks v1.0 by default.
- `fetchImpl` on the memory SDK.
- Memory-runtime egress to the LiteLLM gateway.
- `buildContext` visibility: which value returns private and org together.
- The REST call behind `workspace sessions stop`.
- pi-subagents child tool inheritance.
- TCK flags and bearer support, and its verdict on the 55-min cap.

### Owner steps (billed or console)
1. **Atlas:**
   - Enable billing (atlas.md:98).
   - Upgrade cluster `outfitter` from M0 to Flex. Then check session search
     (`deploy/atlas-search.sh` with `DRY_RUN=1`) and the app.
   - Create DB user `outfitter-agentengine`, limited to cluster `outfitter`, with `readWrite` on the
     memory databases only.
   - With `mongosh` as that user, confirm that reading `outfitter` is refused.
2. **Voyage:** get a Voyage API key on an account with a payment method.
3. **LiteLLM:** mint a virtual key for extraction, with a budget.
4. **Memory project:**
   - `agentengine auth login`, then `create --memory-only` and `project create`.
   - Set secrets `MONGODB_URI`, `VOYAGE_API_KEY`, `LLM_API_KEY`.
   - Edit `project-config.yaml` (extraction types, `extraction_llm`, metadata partition).
   - `memory configure`, then `memory apply --wait`. Never `agentengine atlas setup`; the access
     list is already open.
5. **Agents project:** create it. Create one `PROJECT_OWNER` service account per project, and store
   them in `outfitter-agentengine-memory-sa` and `outfitter-agentengine-agents-sa`.
6. **For PR4:** deploy at least one agent in the agents project, and list it on the Agent Engine
   agents page.
7. **For PR7:** create an A2A key for `a2a-coder`, set it workspace-scoped, and deploy
   `outfitter-delegate`.

## Verification
- **Unit:**
  - The Agent Engine client against the fake (refresh, 429, typed errors, two projects).
  - Op gating per capability; the `approve` class always asks.
  - The A2A state table, including CANCELED not being overwritten and a canceled SUBMITTED task's
    mail marked dead.
  - Key kinds (an A2A key on `/api/*` gets 401; a Dongle on `/a2a` gets 401).
  - Redaction before `recordTurn` and `memory.save`; the `$or` repo filter.
- **Security:**
  - An A2A key can't name a tape with admin tools, `agentEngine` or `memory: auto`, at creation or
    at task start after an edit.
  - A foreign `taskId`/`contextId` gets not-found; a session UUID as `contextId` gets not-found.
  - Branch is always `outfitter/a2a-*`, and `main` in metadata is ignored.
  - An A2A reply to a `confirm`, a subagent approval or an `admin:` card is refused.
  - A Drive without `agentEngine` can't call `ae.*`; without `memory`, can't call `memory.*`.
  - The public card lists no tapes.
- **A2A conformance:** `a2a-tck` against dev with the JSON-RPC transport at MUST level. The PR lists
  every failure with its reason (the blocking cap is expected).
- **End to end:**
  1. **Memory:** session A saves "repo X runs `npm run test:unit`". A new session B on repo X
     (`memory: auto`) has it in the prompt and uses it.
     - The other user doesn't get it unless saved `shared`.
     - A memory saved from an A2A session never reaches the owner's recall.
  2. **Outbound:** a `foreman` session invokes a listed agent and gets its answer. A suspended
     execution raises the card, and resuming it completes.
  3. **Inbound A2A:** `a2a-cli` (or an `a2a-sdk` script) sends a bug-fix task with a key scoped to
     `a2a-coder` and one repo.
     - It streams `SUBMITTED → WORKING → COMPLETED`, and the artifact's branch and head exist on
       GitHub.
     - Another repo gets `REJECTED`. `CancelTask` stops the run.
  4. **Agent Engine inbound:** the deployed `outfitter-delegate` starts a task with `outfitter_start`
     and reports the result from `outfitter_status`.

## Open questions for the owner
None. All five were decided on 2026-10-01 (see Context). What's left is technical and on the PR0
spike list.

## References
- Agent Engine docs: https://www.mongodb.com/docs/agentengine/ (index `llms.txt`). Pages:
  - `reference/limitations.md`, `reference/agent-contract.md`
  - `add-features/memory.md`, `memory-only.md`, `memory-types.md`, `memory-extraction.md`,
    `agent-to-agent.md`
  - `deploy/invoke-agent.md`, `deploy/human-in-the-loop.md`, `deploy/atlas-setup.md`
  - `manage/governance/*.md`, `api-keys-service-accounts.md`, `network-egress.md`
  - `sdk/javascript/packages/agent-engine-memory.md`,
    `sdk/python/packages/agent-engine-sdk-memory.md`
- A2A v1.0: https://a2a-protocol.org/v1.0.0/specification/ and the proto at
  https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto.
  https://github.com/a2aproject/A2A/blob/main/docs/whats-new-v1.md covers the changes. The TCK is
  https://github.com/a2aproject/a2a-tck.
- RFC 8693 §4.1 (`act`), RFC 8707.
- Repo: EPIC.md E5.2 (499-536), E5.4 (539) and E8 (617-634); `docs/specs/sysop-tools.md`;
  `docs/protocol.md`.
