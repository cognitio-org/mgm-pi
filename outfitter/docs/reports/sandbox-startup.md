# Faster agent sandbox startup on GCP — decision report

Research only; no code or cloud resources changed. Answers "how could Outfitter start agent
sandboxes faster" against the current Cloud Run Jobs design (`outfitter/image/Dockerfile`,
`outfitter/deploy/agent-job.sh`, `outfitter/packages/api/src/providers/cloudrun.ts`,
`outfitter/packages/agentd/src/run.ts`), with primary Google Cloud docs cited where found, and
secondary sources flagged as such. All prices are Tier‑1 (`us-central1`), all times are wall-clock
from wake request to a running agent unless noted. Today's date: 2026-09-22.

## Baseline (measured, this repo)

- One agent session ("Floppy") = one Cloud Run Job execution, 1 vCPU / 2 GiB, image ~680 MB
  (`amd64`), no ingress, dials out over WebSocket, idles out after 30 min
  (`outfitter/deploy/agent-job.sh`, `outfitter/EPIC.md` "Decisions taken").
- `agentd`'s own run state machine is `cloning → restoring → starting → running/idle →
  checkpointing → stopping` (`outfitter/packages/agentd/src/run.ts`): clone (skipped for repo-less
  sessions), then session-JSONL restore (`importSession`), then `spawnPi` with the guru's rendered
  flags, then pi's own extension loading before the first prompt is answered.
- **Cold wake, 2026-09-20, 681 MB image**: median 123 s across ten wakes (93–177 s range) = ~32 s
  Cloud Run scheduling + ~97 s image pull/container start + ~3.5 s agentd-to-`run.spec` + ~13 s
  session restore + ~15 s pi extension loading (`outfitter/EPIC.md` E2.9).
- **Warm/cached wake, 2026-09-22**: execution created 13:09:42 → container started 13:09:57 (15 s)
  → agentd main 13:10:39 (42 s to agentd) → idle 13:10:52, so ~70 s total. The image pull leg
  shrank a lot; the ~30 s of agentd/pi startup did not.
- Owner constraints: small personal/family deployment, $25/month budget alert, prefer
  serverless/managed, GCP only.

## 1. Staying on Cloud Run Jobs, but faster

| Lever | Finding | Source |
|---|---|---|
| Image streaming / lazy pull | **Not available for Cloud Run** (services or jobs). Artifact Registry's prewarming/streaming feature is explicitly scoped to "GKE clusters with Image Streaming enabled." | `docs.cloud.google.com/artifact-registry/docs/prewarm-images` (updated 2026-09-18) |
| Gen1 vs gen2 execution environment | Moot: **"Cloud Run jobs and worker pools only use the second generation execution environment, and this cannot be changed."** Gen1 is documented as having faster cold starts than gen2 for *services*, but that knob doesn't exist for Jobs. | `docs.cloud.google.com/run/docs/about-execution-environments` (updated 2026-09-21) |
| Startup CPU boost | Documented only under "Configure services" (cuts startup roughly in half for some workloads); the equivalent Jobs config page (`.../run/docs/configuring/jobs/cpu`, updated 2026-09-21) has no mention of it. Treat as **services-only**, not confirmed for Jobs. | `docs.cloud.google.com/run/docs/configuring/services/cpu` |
| Region choice | No Jobs-specific benchmark found, but Artifact Registry's own guidance is to co-locate the AR repo with the consuming Cloud Run region to cut latency and avoid cross-region egress. `agent-job.sh` already builds/pushes to `${REGION}-docker.pkg.dev`, so this is already correct — nothing to change. | `docs.cloud.google.com/artifact-registry/docs/repo-locations` |
| Keeping the image "warm" (cache across executions) | No documented Cloud-Run-specific warm-cache mechanism found. The 2026-09-22 observation (15 s container start vs. 97 s cold) suggests Cloud Run's infrastructure *does* sometimes reuse a cached layer/node, but this isn't something we control or can rely on — no min-instances-style guarantee exists for Jobs (next row). | Unconfirmed — flagged |
| Min-instances / warm pool | `docs.cloud.google.com/run/docs/configuring/min-instances` (updated 2026-09-21) is scoped to "a service" throughout; **Jobs have no min-instances or pre-warm equivalent — every execution cold-starts.** | same |
| Our own ~30 s (session restore + pi extension load) | Entirely within our control, no GCP lever needed. `run.ts`'s `restoring` phase (`importSession`, `chownWorkspace`) and pi's own extension init are the two named-and-measured chunks (13 s + 15 s in the 2026-09-20 breakdown). |
| Smaller image | Already worked hard: `outfitter/image/Dockerfile` is a 3-stage build (`kernal-builder`, `agentd-builder`, `runtime`), strips native binaries per-platform, uses `COPY --chown` instead of a `chown -R` (saved ~461 MB by itself per `docs/reports/image-trim.md`), and drops `pi-lsp`/`pi-powerline-footer`/`@codexstar/pi-listen`/`open-codebase-index` at the npm level. 2.16 GB → 681 MB. `docs/reports/image-trim.md`'s own "Why 600 MB isn't reachable" section says the Debian+Node base (~500 MB) plus the four required pi packages account for the rest — there isn't much image-size lever left. |

**What this buys**: no architecture change, near-zero incremental cost, low risk. Realistic target:
shave the pull-time variance (already down to ~15 s when cached) and the ~28 s of our own
restore/extension-load time down by maybe half with focused profiling — a plausible median in the
60–90 s range, not the sub-10s territory Cosmos-like wake wants. **Jobs structurally cannot get a
warm/pre-provisioned instance** — that's the one lever every other option in this report exists to
provide.

## 2. Cloud Run Services instead of Jobs (warm pool)

| Question | Finding | Source |
|---|---|---|
| Min-instances idle billing | Under **request-based billing** (default), idle CPU on a min-instance is billed at ~10x less than active CPU: **$0.0000025/vCPU-s idle vs $0.000024/vCPU-s active** (Tier‑1). Memory gets **no idle discount** ($0.0000025/GiB-s either way). Under **instance-based billing** ("CPU always allocated") there is no idle discount at all — full rate for the whole lifecycle. | `docs.cloud.google.com/run/docs/configuring/min-instances` (updated 2026-09-21), `cloud.google.com/run/pricing` |
| Max request timeout | Confirmed **60 minutes (3600 s)** max, 5-minute default. Google explicitly recommends reconnect-tolerant design past 15 minutes. | `docs.cloud.google.com/run/docs/configuring/request-timeout` |
| Session affinity | Real, documented feature: a cookie-based affinity (30-day TTL) that routes a client back to the same revision instance, explicitly called out as useful for **long-running connections such as WebSockets** — but it is **best-effort only**, broken by instance termination, max concurrency, or max CPU utilization. | `docs.cloud.google.com/run/docs/configuring/session-affinity` |
| `concurrency=1` + `min-instances` = dedicated pool | **Not a single Google-documented recipe** — flagged as inferred/composite. It's built from three separate official docs (concurrency doc recommends `concurrency=1` when a container can't share state across requests; min-instances keeps N warm; session affinity re-routes a reconnect), but no Google source names "one session per warm instance" as a pattern. Some execution risk if you build on it. | `docs.cloud.google.com/run/docs/about-concurrency` |
| WebSockets | Natively supported, no special config, up to 1000 connections/instance — but still bound by the 60-minute request timeout above. | `docs.cloud.google.com/run/docs/triggering/websockets` |
| Cloud Run worker pools | Real, new-in-2026 resource: continuous non-request-driven background work, **no public URL**, fixed/manual instance count, up to 10 sidecars with shared in-memory volumes. GA around April 2026 per secondary trade coverage (exact GA date not stated on the primary docs page itself). **Not a fit** for our WS-facing sandbox (no public endpoint) — Services remains the right primitive if staying on Cloud Run's request-based model. | `docs.cloud.google.com/run/docs/deploy-worker-pools` |
| Cost: 1 always-on idle instance (1 vCPU/2 GiB, 24/7) | **≈ $19.71/month** ($6.57 CPU + $13.14 memory, 730 h), before the free tier (240K vCPU-s / 450K GiB-s/month) and before any active-request charges. That alone consumes ~80% of the $25/month budget. | computed from the confirmed rates above |

**What this buys**: if the `concurrency=1`/session-affinity pattern holds up in practice, wake
latency drops to roughly the ~28 s of our own session-restore + extension-load work (no scheduling,
no image pull) — a real win over Jobs. But at our scale, one always-on warm instance already eats
most of the budget, and 2–3 (to cover the stated burst of 3 concurrent sessions) is $40–60/month —
over budget. A time-boxed min-instances (e.g. only during a declared "active hours" window, toggled
by Cloud Scheduler calling the Admin API) could bring one warm instance down to roughly
$6.57/month for an 8‑hour/day window, which is affordable — but adds a scheduler + toggle to build
and maintain, and a burst outside that window still cold-starts. The pattern itself also isn't a
documented Google recipe, so it needs a small prototype before trusting it in production
(particularly: does session affinity survive an instance getting evicted under min-instances churn).

## 3. Pre-warmed pool of our own (N idle Job executions)

Cloud Run Jobs have no min-instances-style idle-CPU discount (section 1's table) — there's no
"cheap idle" billing tier for a Job the way Services get one. A hand-rolled pool of N Job
executions that stay running and waiting for a `run.spec` would be billed at the **full active
rate** for every second they exist, because Jobs don't have an idle/allocated distinction to
discount. Using this repo's own cost model (`outfitter/EPIC.md`: "~$0.08/h" for 1 vCPU/2 GiB
active), one always-on "empty" job costs **≈ $58/month** — already over budget for a single
sandbox, before covering bursts of 2–3. This option is strictly worse than Cloud Run Services'
`min-instances` (section 2), which gets an idle-CPU discount Jobs cannot: **not recommended.**

Complexity and security are also both worse than they look:
- We'd need to build our own pool manager (spawn N, track which are claimed, respawn consumed
  ones, handle a pool member's own 30-min-idle-stop racing against "still waiting to be claimed"),
  duplicating what Cloud Run's `min-instances` already does for Services.
- **Pre-issued identity is a real regression.** Today, `RUN_TOKEN` and the per-session GitHub/LiteLLM
  secrets are minted at wake and delivered only over the authenticated agentd↔API WebSocket
  (`outfitter/packages/api/src/providers/cloudrun.ts`'s `containerOverrides`, `EPIC.md`'s "ADC
  everywhere" decision). A pool member booted *before* a session is assigned to it has no session
  to scope a token to yet — it would need to boot with no credentials at all and receive a
  session-scoped token only at hand-off (an extra protocol round-trip, and a new "unclaimed pool
  member" identity state that doesn't exist in `protocol.md` today). That's a meaningful protocol
  change for a cost-losing option.

## 4. GKE Autopilot + Image Streaming + GKE Agent Sandbox

| Question | Finding | Source |
|---|---|---|
| Cluster management fee | Flat **$0.10/cluster/hour** for both Autopilot and Standard, but **one free zonal cluster per billing account** via a $74.40/month credit. $0.10 × 730 h = $73/month — **the credit fully covers one always-on zonal cluster.** (A regional cluster is not fully covered.) | `cloud.google.com/kubernetes-engine/pricing` |
| GKE Image Streaming | Requires **Artifact Registry** (not Container Registry) + COS-based nodes — COS is Autopilot's default node image, so it **is compatible with Autopilot**. Google's own benchmark: a container reached `Running` in 8.82 s vs. 5 m 17 s without streaming (35x) on their test image; a 5.4 GB image dropped from 191 s to 30 s. At 680 MB, our image is well inside the range where streaming helps materially. | `docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming`; announcement: `cloud.google.com/blog/products/containers-kubernetes/introducing-container-image-streaming-in-gke` |
| Warm pods / pre-provisioning | Two patterns: (a) community "balloon pods" (low-priority placeholder pods holding node capacity, evicted when real work lands), documented by a GKE engineer, not an official product; (b) newer first-party **Capacity Buffers** (`CapacityBuffer` custom resource, declarative capacity reservation via virtual pending pods). Baseline new-node boot cited around 80–120 s when no buffer exists. | `docs.cloud.google.com/kubernetes-engine/docs/how-to/capacity-provisioning` |
| **GKE Agent Sandbox** | **Real, named, directly-relevant Google product.** Preview at KubeCon NA (Nov 2025), **GA ~May 2026** (Google Cloud Next '26); usage reported growing 7x in the four weeks after GA. A Kubernetes primitive purpose-built for isolated, single-replica AI-agent sandboxes, using **gVisor** for lightweight secure isolation, offered **at no extra charge** (normal GKE compute billing only). Google-cited startup latency: **<1 s with warm pools, a few seconds with suspend/resume, <5 s in a cost-optimized configuration.** | `docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox`; `docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox`; blog "Reduce your agent's costs by 75% with GKE Agent Sandbox" (2026-07-31): `cloud.google.com/blog/products/containers-kubernetes/reduce-your-agents-costs-with-gke-agent-sandbox` |
| Pod compute cost | Autopilot bills per pod resource request while running, same order of magnitude as Cloud Run's active compute rate (no exact Autopilot-vs-Cloud-Run delta confirmed here — flag as an estimate). At ~2 h/day active use this is a few dollars/month, similar to option 1's Jobs compute. |

**What this buys**: this is the closest match to what Outfitter is explicitly imitating ("Augment
Cosmos... event-driven agent wake-up," `EPIC.md` §1) — sub-5-second wake, at effectively **$0
incremental cluster cost** given the free credit, using a product Google built specifically for
this problem. It is also the most invasive option: it replaces `CloudRunProvider`
(`outfitter/packages/api/src/providers/cloudrun.ts`) with a Kubernetes-native provider, replaces
the Job-execution lifecycle in `run.ts` with a Pod/Sandbox lifecycle, and replaces the "no ingress,
outbound WebSocket only" networking model with GKE's own service networking. It also means adopting
a feature that reached GA only ~4 months before this report — smaller install base, more surprises
possible. `outfitter/EPIC.md` §E7 already flags "evaluate Cloud Run worker pools... for warm
agents" as future hardening work but has not evaluated GKE; this finding should update that
backlog item.

## 5. Compute Engine (Spot/preemptible + suspend/resume)

| Question | Finding | Source |
|---|---|---|
| Spot VM pricing | `e2-small` (2 shared vCPU/2 GB) Spot in `us-central1` ≈ **$0.0247/hr (~$18/month)** vs. on-demand ≈ $0.0494/hr; Spot discounts generally run 60–91% off on-demand. **Secondary-sourced** (aggregator); Google's own pricing page doesn't publish per-type numbers in prose — verify via the Pricing Calculator/Billing Catalog API before budgeting. | secondary: `economize.cloud/resources/gcp/pricing/compute-engine/e2-small`; primary (no exact figures): `cloud.google.com/products/compute/pricing` |
| COS + single-container boot time | No Google primary source with a precise number found. Community estimates cluster around 10–20 s — **flagged as speculation**, not fact. |
| GCE suspend/resume | Confirmed **GA feature (since March 2022, still current)**. Suspending pauses the VM like closing a laptop lid: you stop paying for vCPU/memory, but continue paying for the persistent disk holding the suspended state; the guest OS must support suspend; max suspend duration is **60 days** before auto-terminate. **Compatible with Spot VMs**, but if Compute Engine preempts the instance before a suspend completes, preemption wins and the suspend aborts. Resume-vs-cold-boot speed is not quantified in Google's docs — expected to be faster (skips OS init) but unconfirmed. | `docs.cloud.google.com/compute/docs/instances/suspend-resume-instance`, `docs.cloud.google.com/compute/docs/instances/suspend-stop-reset-instances-overview` |

**What this buys**: theoretically competitive latency (small VM + suspend/resume could rival a warm
pod), but it directly conflicts with the owner's stated preference for serverless/managed — this is
the only option here that requires us to run and patch actual VMs, build a new sandbox provider
with manual suspend/resume orchestration (no equivalent to Cloud Run's automatic idle-stop-on-exit),
and manage disk-backed suspended state with real per-GB cost and a 60-day hard limit. The most
important numbers (boot time, resume time) are unconfirmed by Google. **Not recommended** given the
stated constraints, unless GKE and Cloud Run are both ruled out later.

## 6. Newer/other Google offerings (as of 2026-09-22)

- **GKE Agent Sandbox** (section 4) is the headline 2025/2026 Google announcement specifically
  targeting AI-agent sandboxes — see above.
- **Cloud Run worker pools** (section 2) are new in 2026 but not applicable here: no public
  endpoint, meant for continuous background work, not per-session WebSocket-facing sandboxes.
- **Vertex AI Agent Engine "Code Execution"**: confirmed, billed since **2026-01-28** at
  $0.0864/vCPU-hr + $0.0090/GiB-hr (first 50 vCPU-hr / 100 GiB-hr free/month), idle time between
  turns not billed. It is oriented at **Python code interpretation**, not general custom Docker
  workloads — not a fit for a full pi + node + git + gh 680 MB amd64 image. Source:
  `cloud.google.com/vertex-ai/pricing`, `docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes`.
- **Gemini Enterprise Agent Platform "Custom container sandbox"**: a related, newer product that
  *does* let you point a `SandboxEnvironmentTemplate` at your own Artifact-Registry image with
  pre-warmed pools (`docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/custom-containers`).
  Worth bookmarking, but it's part of a larger enterprise platform with its own overhead and only
  one docs page found — too new/undocumented to recommend for a personal deployment right now.

## Comparison table

| Option | Time-to-first-answer (new session) | Monthly cost @ ~2h/day active, bursts to 3 | Effort | Key risk |
|---|---|---|---|---|
| **1. Cloud Run Jobs, tuned** (current + image/code trim) | ~60–90 s realistic (no min-instances possible; ~123 s median today, ~70 s when cached) | ~$5–10 active compute, likely mostly inside free tier (240K vCPU-s / 450K GiB-s/month) | Low (no architecture change) | Structurally can't reach warm-instance latency; diminishing returns |
| **1.5 Cloud Run Services, min-instances during active hours only** | ~28 s (session restore + pi extension load only, if affinity holds) | ~$6–8 for one instance, 8h/day window (scheduler-toggled); ~$20/instance for 24/7 | Medium (new provider path, Cloud Scheduler toggle, session-affinity prototype) | `concurrency=1` dedicated-pool pattern is not Google-documented; affinity is best-effort |
| **2. Cloud Run Services, always-on min-instances** | ~28 s | ~$20/instance/month 24/7; $40–60 for 2–3 concurrent | Medium | Same as above, plus eats most/all of the $25 budget |
| **3. Self-managed warm Job pool** | ~28 s (once claimed) | ~$58/month for even one always-on Job (no idle discount exists for Jobs) | High (custom pool manager, new pre-issued-identity model) | Costs more than option 2 for the same latency; strictly dominated |
| **4. GKE Autopilot + Image Streaming + GKE Agent Sandbox** | <1–5 s (Google-cited, warm pools/cost-optimized config) | ~$0 cluster fee (covered by free credit) + few $/month pod compute | High (new provider, new networking/isolation model, K8s ops) | Newest offering (GA ~4 months); full provider rewrite |
| **5. Compute Engine Spot + suspend/resume** | Unconfirmed, plausibly tens of seconds | ~$18/month per VM if always up; less if suspended most of the time (disk-only cost) | High (manual lifecycle, no serverless idle-stop) | Conflicts with "prefer serverless/managed"; core latency numbers unconfirmed |
| **6. Vertex AI Agent Engine Code Execution** | N/A — doesn't run custom Docker images | $0.0864/vCPU-hr + $0.009/GiB-hr, 50 vCPU-hr/100 GiB-hr free/month | N/A | Wrong shape (Python sandbox, not general container) |

## Recommendation

**Do both, in sequence, not in parallel.**

**Now (cheap first step, measurable within a day):** stay on Cloud Run Jobs and attack the ~28 s
of startup that's entirely ours — profile `run.ts`'s `restoring` phase (`importSession`) and pi's
own extension loading (the 13 s + 15 s legs from the 2026-09-20 breakdown) for anything that does
unnecessary I/O or network probing at load (`EPIC.md` E2.9 already names "pi's startup (kernal
extensions doing network discovery at load)" as the next lever). Re-run E2.9's wake-measurement
script before and after. This costs nothing, changes no infrastructure, and directly tests whether
the code-side ~30 s can shrink — the single biggest lever this repo actually controls, since image
streaming, startup CPU boost, gen1/gen2 choice, and min-instances are all **confirmed unavailable
to Cloud Run Jobs** (sections 1). Expect this to move the median from ~123 s toward something in
the 80–100 s range, not lower — Jobs cannot get a warm instance, full stop.

**Next (the real fix, worth planning once the above is measured):** GKE Autopilot with GKE Agent
Sandbox and Image Streaming is the only option that gets close to Cosmos-like near-instant wake
(<5 s, Google-cited) while staying inside the $25/month budget (the cluster fee is covered by the
standing free credit). It is a genuine rewrite of the sandbox provider and run lifecycle, and it's
built on a feature that only reached GA a few months ago, so it deserves a small, isolated spike —
one Autopilot cluster, one Agent Sandbox, the existing image, measuring wake time end-to-end —
before committing the provider-interface rewrite. Cloud Run Services with `min-instances` scoped to
an "active hours" window is a reasonable fallback if GKE's newness or the K8s rewrite cost turns out
to be too much: cheaper to build than GKE, but structurally can't go below ~28 s and eats real
budget for any 24/7 warmth. A self-managed warm pool of Cloud Run Jobs (section 3) is strictly
worse than that fallback on both cost and complexity — don't build it.
