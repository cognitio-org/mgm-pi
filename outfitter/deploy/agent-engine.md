# Atlas Agent Engine: runbook

Outfitter uses Atlas Agent Engine for long-term memory (E9 PR3) and, from PR4, to call agents.
The design is in `docs/specs/atlas-agent-engine-and-a2a.md` (§2, §3, §8). This file covers setup as
it was actually done, rotation, and the rules that keep the memory project safe. Every step here is
**owner-run**: it changes billed resources, secrets or IAM. An agent never runs these (deploy/CLAUDE.md).

Shell setup for everything below:

```sh
P=(--profile outfitter --projectId 6aafddf75566cf48726735bb)   # atlas CLI, zsh array
# agentengine CLI: always the `outfitter-memory` context, named on each command (see
# `agentengine --help` for the flag), never whatever context happens to be current
# gcloud: always name the configuration
gcloud --configuration=outfitter ...
```

## Memory project (done 2026-10-01)

| What | Value |
|---|---|
| Agent Engine project | the Atlas project `outfitter` (`6aafddf75566cf48726735bb`), memory-only |
| CLI context | `outfitter-memory` |
| Config | `deploy/agent-engine/memory/project-config.yaml` (no secrets) |
| Memory server | v0.11.7; 10 search indexes READY; `repo` partition on semantic, episodic, procedural |
| Data | Flex cluster `outfitter-memory` (GCP `CENTRAL_US`), databases `mdb_memory_<projectId>`, `mdb_store_<projectId>` |
| DB user | `agent-engine-memory`, scoped `outfitter-memory:CLUSTER`, `readWrite` on those two databases only |
| Service account | `outfitter-memory-api`, role `AGENT_DEVELOPER`, secret expires **2026-12-30T01:51:48Z** |
| api config | `AGENT_ENGINE_MEMORY_PROJECT_ID`, `AGENT_ENGINE_MEMORY_SA_EXPIRES_AT` (config.env); secret `AGENT_ENGINE_MEMORY_SA` ← GSM `outfitter-agentengine-memory-sa` (service.sh) |

How it was set up, in order:

1. Payment method on the Atlas org (Flex needs one). Flex cluster `outfitter-memory`
   (`atlas clusters create outfitter-memory --provider GCP --region CENTRAL_US --tier FLEX $P`).
   The `outfitter` cluster stays M0 and holds only Outfitter's own database.
2. `agentengine create --memory-only` into the `outfitter` project, CLI context `outfitter-memory`.
3. DB user `agent-engine-memory` (`atlas dbusers create ... --scope outfitter-memory:CLUSTER`, roles
   `readWrite@mdb_memory_<id>,readWrite@mdb_store_<id>`). Checked with `mongosh` as that user that
   the `outfitter` cluster refuses it.
4. Project secrets, each piped from Secret Manager with `secret set --stdin`, never printed or put in
   shell history:

   | Agent Engine secret | GSM secret (`outfitter-509211`) | Holds |
   |---|---|---|
   | `MONGODB_URI` | `outfitter-agentengine-mongodb-uri` | `agent-engine-memory` on `outfitter-memory` |
   | `VOYAGE_API_KEY` | `ATLAS_AGENTS_KEY` | the Voyage key (embeddings, `voyage-4-large`) |
   | `LLM_API_KEY` | `outfitter-agentengine-extraction-key` | LiteLLM virtual key `outfitter-agentengine-extraction` |

   ```sh
   gcloud --configuration=outfitter secrets versions access latest --secret=outfitter-agentengine-mongodb-uri \
     | agentengine secret set MONGODB_URI --stdin
   ```

5. `project-config.yaml` edited **before the first start**: extraction of semantic, episodic and
   procedural only (never taxonomic: extracted taxonomic memories default to `org`), extraction via
   `gpt-5-nano` on `https://router.kernal.one/v1` with `LLM_API_KEY`, and the `repo` metadata
   partition. Then `memory configure` and `memory apply --wait`.
6. Service account `outfitter-memory-api` with role `AGENT_DEVELOPER` (enough for every memory
   route; `PROJECT_OWNER` would also map to Atlas Project Owner). Its `{client_id, client_secret}`
   JSON is in GSM `outfitter-agentengine-memory-sa`; its `active_secret.expires_at` is
   `AGENT_ENGINE_MEMORY_SA_EXPIRES_AT` in config.env.

## Rules for the memory project

- **Never deploy an Agent Engine agent in `outfitter`.** Agents read every project secret
  (`MONGODB_URI`, `VOYAGE_API_KEY`, `LLM_API_KEY`). Agents live in the separate agents project (PR4).
- **Never run `agentengine atlas setup` against this Atlas project.** It creates a database user
  with `readWriteAnyDatabase`, which reaches Outfitter's own cluster. The memory project is set up
  by hand, as above.
- **Index budget is 10 of 10.** Flex allows 10 search and vector indexes per cluster, and the
  memory server creates exactly 10. Never declare `short_term` in `metadata_partition_index` (adds
  2). If a future version needs more, only `outfitter-memory` moves to M10.
- **The partition is create-only.** The memory server creates its indexes once and only logs
  "definition mismatch" for a key added later. Changing `metadata_partition_key` means dropping its
  10 indexes and restarting it; plan it, don't just edit the file.
- Keep `extraction.enabled` listed explicitly: removing the line enables every type, taxonomic
  included.

## Rotation

The api logs a warning 14 days before `AGENT_ENGINE_MEMORY_SA_EXPIRES_AT` (config.ts
`agentEngineWarnings`), and again once it has passed. A service account can't read its
own expiry, so the date in config.env is the only record: update it with every rotation.

**Service-account secret (`outfitter-memory-api`, 90 days; due by 2026-12-30):**

1. Rotate the secret in the Agent Engine console or CLI (as the owner, not with the service
   account). The response's `service_account.active_secret.expires_at` is the new expiry. The old
   secret stays valid for up to 7 days.
2. Add a version to GSM `outfitter-agentengine-memory-sa` with the new `{client_id, client_secret}`
   JSON, from stdin.
3. Set `AGENT_ENGINE_MEMORY_SA_EXPIRES_AT` in `deploy/config.env` to the new date, merge, and deploy
   by release tag (`tag-release.sh`), so Cloud Run picks up the new secret version.
4. Check the api log: no `Agent Engine memory` 401s and no expiry warning.

**Extraction key (`outfitter-agentengine-extraction`, LiteLLM; `max_budget: 5`, 30-day budget):**

1. Mint a new LiteLLM virtual key with `models: [gpt-5-nano]` and a budget.
2. Add a GSM version to `outfitter-agentengine-extraction-key`, then
   `... | agentengine secret set LLM_API_KEY --stdin` and re-apply memory so the server reloads it.
3. Once extraction works again (recorded turns produce memories), delete the old key in LiteLLM.
   Don't name it `outfitter-litellm-key-*`: secrets.ts reads those as tape ids.

**Database user (`agent-engine-memory`):**

1. `atlas dbusers update agent-engine-memory --password "<new, from a password manager>" $P`.
2. Build the new URI, add a GSM version to `outfitter-agentengine-mongodb-uri`, and
   `... | agentengine secret set MONGODB_URI --stdin`; re-apply memory.
3. Re-check its scope: `atlas dbusers describe agent-engine-memory $P -o json` shows only
   `outfitter-memory:CLUSTER` and the two `readWrite` roles.

**Voyage key (`ATLAS_AGENTS_KEY`):** new key on the Voyage account (it needs a payment method, or
it stays at 3 RPM), new GSM version, `secret set VOYAGE_API_KEY --stdin`, re-apply memory.

## Cost and usage

- Retrieval is billed per doc, and `memory: auto` recalls on every prompt, so `auto` is set per
  tape, by a person, in the web UI.
- The api logs one line a day per instance, `agent engine memory usage`, with that day's
  `search`, `context`, `save` and `recordTurn` counts, retrieved `docs` and `errors`. Sum them across
  instances in Cloud Logging and compare with the Agent Engine bill.
- Extraction tokens are billed by LiteLLM to the extraction key, outside Agent Engine's caps.

## Agents project (PR4)

PR4 documents the agents project (`outfitter-agents`), its service account and the
`outfitter-agentengine-agents-sa` secret here.
