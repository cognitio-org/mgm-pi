# Agent-to-agent messaging and durable workflows on MongoDB

Research behind EPIC E5.5 (mailbox) and E5.6 (workflows), 2026-09-22. Question: for peer-to-peer
messaging between separate sessions and for multi-step multi-agent flows, how far does MongoDB
Atlas alone take us, and what else is needed on a scale-to-zero Cloud Run setup?

## Current wake path (what already exists)

`POST /api/sessions/:id/messages` (`packages/api/src/routes/sessions.ts`) finds the active run or
calls `RunManager.wake`, then `AgentLink.send`. If the run has no ready socket the message is
`$push`ed onto `Run.pending` in Mongo and drained with an atomic `findOneAndUpdate` pop on `hello`,
on the first ready `status`, or by the link role's queue poller (`agentlink.ts`, `store/mongo.ts`).
So Mongo already serves as the bus between the web and link services.

Gaps that keep it from being a durable mailbox:

1. `pending` belongs to the run. A run that fails before ready (`reconcileOnce`, `runs.ts`) strands
   its messages; nothing re-wakes.
2. At-most-once after drain: the pop happens before `socket.send`, and down-messages carry no
   seq/ack (`docs/protocol.md`, only up frames are acked).
3. `wake()` runs before the message is stored; a provider error 500s and the message is lost.
4. `wake()` is check-then-insert with no unique guard, so two concurrent senders can start two Jobs
   for one session.
5. `setInterval` pollers (`startDownQueuePoller`, reconcile loops) only tick while a request holds
   the container open; with min-instances 0 there is no guaranteed future poke.

## 1. MongoDB-native queue patterns

No official MongoDB "queue" guidance exists; the community/vendor consensus:

- Atomic claim: `findOneAndUpdate({status:"pending", runAt:{$lte:now}}, {$set:{status:"running",
  lockedBy, lockedUntil: now+lease}, $inc:{attempts:1}}, {sort:{priority:-1, createdAt:1}})`.
  `$currentDate` for server timestamps; index `(status, runAt, priority)`.
- Lease / visibility timeout: the claim sets `lockedUntil`; a reaper (or the claim query itself with
  `$or:[{status:"pending"},{status:"running", lockedUntil:{$lt:now}}]`) reclaims stale work. Long
  jobs heartbeat by extending `lockedUntil`.
- Retries and dead-letter: `attempts` + `maxAttempts`; on failure `runAt = now + backoff(attempts)`;
  exhausted → `status:"dead"`. TTL index on `completedAt`. Capped collections are unsuitable for
  queues (no growing updates, no ack).
- Worked examples: [job queue](https://oneuptime.com/blog/post/2026-03-31-mongodb-job-queue/view),
  [workers and concurrency](https://oneuptime.com/blog/post/2026-03-31-mongodb-queue-workers-concurrency/view),
  [delayed queue](https://oneuptime.com/blog/post/2026-03-31-mongodb-delayed-queue/view).

| Library | Status |
|---|---|
| [agenda](https://github.com/agenda/agenda) | Revived: v6.2.6 (July 2025), TS rewrite, ESM-only, change-stream notifications, retry/backoff. |
| [@pulsecron/pulse](https://www.npmjs.com/package/@pulsecron/pulse) | Agenda fork from its dormant period; last publish ~a year ago. |
| [mongodb-queue](https://github.com/chilts/mongodb-queue) | Visibility timeout, ack, ping, dead queue. Archived Oct 2024. Copy the design, don't depend on it. |
| [durabl](https://github.com/hexsprite/durabl) | 2025-26, MIT: claim, leases, retries, dedupe, change-stream push, step orchestrator. 0.x, no users. Ideas only. |
| BullMQ / pg-boss | Redis / Postgres only. |

## 2. Change streams and Atlas tiers

- Requirements: replica set (every Atlas cluster is one). Resume with the persisted `_id` token;
  valid only within the oplog window, else `ChangeStreamHistoryLost` (286) forces a rescan.
  `fullDocument:"updateLookup"` returns the current doc. Each open stream holds one connection.
  [Manual](https://www.mongodb.com/docs/manual/changeStreams/).
- M0 (free): change streams supported, max **5 open streams**, 500 connections, 100 ops/s, 0.5 GB
  ([limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)). Multi-document
  transactions work ([MongoDB staff](https://www.mongodb.com/community/forums/t/is-there-any-way-to-use-transactions-with-m0-sandbox/7847)).
- Flex ($0.011/h, capped $30/mo): 10 streams, 500 ops/s, 5 GB
  ([limits](https://www.mongodb.com/docs/atlas/reference/flex-limitations/)). Driver change streams
  work; Atlas Database Triggers do not.
- M10 (~$57/mo): 100 streams, Database Triggers supported.
- Atlas App Services (Device Sync, Data API, GraphQL, hosting, HTTPS endpoints) reached EOL
  2025-09-30 ([notice](https://www.mongodb.com/community/forums/t/atlas-device-sync-end-of-life-and-deprecation/296687)).
  Triggers and Functions survive in the Atlas UI ([docs](https://www.mongodb.com/docs/atlas/atlas-ui/triggers/))
  but Database Triggers need M10+. Post-EOL Triggers pricing not verified.
- Cost of listening: a change-stream listener on Cloud Run needs instance-based billing plus
  min-instances ([billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings));
  roughly $10/mo idle, ~$50/mo always-on CPU (derived from
  [pricing](https://cloud.google.com/run/pricing), not quoted). Not worth it at this scale.

## 3. Durable-execution engines vs. MongoDB

| Engine | Store | Embeddable in Node? | License | Mongo as sole store? |
|---|---|---|---|---|
| [DBOS Transact TS](https://github.com/dbos-inc/dbos-transact-ts) | Postgres only ([docs](https://docs.dbos.dev/typescript/integrating-dbos)); SQLite only in Go | Yes | MIT | No |
| [Restate](https://docs.restate.dev/server/overview) | Own Rust server, RocksDB | No | Server BSL, SDKs MIT | No |
| [Inngest](https://www.inngest.com/docs/self-hosting) | Own binary; SQLite/Postgres + Redis | No | Server SSPL, SDK Apache-2 | No |
| [Hatchet](https://github.com/hatchet-dev/hatchet) | Postgres server | No | MIT | No |
| [Trigger.dev](https://trigger.dev/docs/self-hosting/overview) | Postgres + Redis + ClickHouse + object store | No | Apache-2 | No |
| Cloudflare Workflows / Durable Objects | Cloudflare-only | No | n/a | No |
| [Mastra workflows](https://mastra.ai/reference/storage/mongodb) | `@mastra/mongodb` (`mastra_workflow_snapshot`), suspend/resume | Yes | Apache-2 | Yes, but in-process scheduling, no external wake |
| [LangGraph JS](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-mongodb) | `MongoDBSaver` v1.1.x, official ([Atlas docs](https://www.mongodb.com/docs/atlas/ai-integrations/langgraph-js/)) | Yes | MIT | Checkpoints only; no scheduler/retry/wake |
| [Vercel Workflow DevKit](https://github.com/vercel/workflow) | Pluggable "Worlds"; community [`@workflow-worlds/mongodb`](https://github.com/mizzle-dev/workflow-worlds) (MIT, listed in [worlds-manifest.json](https://github.com/vercel/workflow/blob/main/worlds-manifest.json)) | Yes | Apache-2 | Yes via community world; queueing mechanism and scale-to-zero behaviour unverified |

Net: nothing is "Temporal on Mongo". Only the DevKit's community world, Mastra and LangGraph
checkpointers sit on Mongo alone, and none of them provides the wake/retry layer.

## 4. Hand-rolled saga / outbox on Mongo

Sources: [transactional outbox with MongoDB](https://github.com/xeno097/transactional-outbox-pattern-with-mongodb),
[Jayasekara on the Mongo outbox](https://blog.insiderattack.net/atomic-microservices-transactions-with-mongodb-transactional-outbox-1c96e0522e7c).

- `workflows` document `{_id, type, version, status, cursor, steps:[{id, status, attempts, input,
  output, idempotencyKey, runAt, lockedUntil}], fanout:{expected, done}}`. Advance only with
  `findOneAndUpdate({_id, version:v}, {$set:…, $inc:{version:1}})`; losers re-read and retry.
- Idempotency: side effects keyed by `idempotencyKey` (unique index); a rerun after a crash is a
  no-op.
- Outbox: state change + `outbox` row in one transaction; a dispatcher marks rows `sent`;
  at-least-once, consumers dedupe.
- Fan-in: `$inc:{"fanout.done":1}`; the updater observing `done == expected` schedules the gather.
- Scheduling on scale-to-zero: a Cloud Scheduler tick (3 jobs free, then $0.10/job/mo,
  [pricing](https://cloud.google.com/scheduler/pricing)) hitting `/tick`, plus per-event Cloud
  Tasks (§5), instead of an always-on listener.

## 5. GCP glue

- **Cloud Tasks**: 1M ops/mo free, then $0.40/M ([pricing](https://cloud.google.com/tasks/pricing));
  exponential-backoff retry per queue or task ([retries](https://docs.cloud.google.com/tasks/docs/configure-retry-task));
  schedule up to 30 days ahead, 1 MiB payload, dispatch deadline 15 s–30 min
  ([quotas](https://docs.cloud.google.com/tasks/docs/quotas)); named tasks dedupe (1-hour tombstone).
  HTTP targets with OIDC call the API on Cloud Run
  ([Cloud Run + Tasks](https://docs.cloud.google.com/run/docs/triggering/using-tasks)). This is the
  "wake and retry" layer: Mongo holds truth, Tasks guarantees a future HTTP poke.
- **Pub/Sub push**: 10 GiB/mo free, backoff 0–600 s, dead-letter topics
  ([retry policy](https://docs.cloud.google.com/pubsub/docs/subscription-retry-policy)). Fan-out of
  events, no addressing, no precise delay, no per-message dedupe — a different tool. Its slot in
  this design remains E7's replacement for held agentd sockets.
- **Cloud Workflows**: viable but a second orchestrator; skip.

## Decisions (2026-09-22)

- Seam 1 (E5.5): mailbox on Mongo alone with claim/lease/ack, insert-before-wake, partial unique
  index against double-wake, Cloud Tasks for the wake retry, Cloud Scheduler `/tick` as reaper.
  No change streams.
- Seam 2 (E5.6): hand-rolled workflows on the same primitives (version CAS, idempotency keys,
  outbox, one Cloud Task per step). Revisit the Workflow DevKit Mongo world later.
- Default delivery is `follow_up`; `urgent` maps to `steer`.
- Cloud Tasks yes; Pub/Sub is not this layer.

## Unverified

Atlas Triggers billing after the App Services EOL; exact Cloud Run always-on rates (computed);
the DevKit Mongo world's queueing mechanism and production use.
