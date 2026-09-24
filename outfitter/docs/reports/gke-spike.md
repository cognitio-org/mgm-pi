# GKE Agent Sandbox spike

The one-day spike from `docs/specs/gke-sandbox-provider.md` §8.2, plus S7 from
`docs/specs/gke-sandbox-provider-plan.md` §4. Each item records the numbers it produced and a verdict.
In progress; started 2026-09-24.

| # | Question | Verdict |
|---|---|---|
| S0 | Can this billing account create the cluster with Agent Sandbox? | **Pass** (2026-09-24) |
| S1 | Downward-API annotation-to-file latency under gVisor | **Pass** for the in-cluster part (2026-09-24) |
| S2 | The real image under gVisor | not run |
| S3 | Identity and network (WI token `email`, metadata path) | **Pass** (2026-09-24) |
| S4 | Cold start with image streaming | **Pass on a running node (3 s); not on a new one (70 s, node boot)** (2026-09-24). Streaming works from a tag's second pull |
| S5 | Cost reality | not run |
| S6 | API-to-cluster auth over the DNS endpoint | not run |
| S7 | Metadata block (`NET_ADMIN` init container, `iptables -m owner`) | **Fail: impossible on Autopilot** (2026-09-24) |

---

## S0: cluster creation (pass)

`deploy/gke-cluster.sh`, run by the owner on 2026-09-24.

- Credit guard: the five projects on billing account `01DEC0-9358E1-C1FF0D` (`allms-483119`,
  `matej-graduation`, `matej-huur`, `uni-finances`, `outfitter-509211`) had no GKE clusters, so the
  free-tier credit should cover the cluster fee. Confirm on the first invoice (S5).
- Version: the `regular` channel defaulted to 1.35.8-gke.1036000, below Agent Sandbox's
  1.36.3-gke.1767000, but listed 1.36.3-gke.1767000 and 1.36.4-gke.1082000 as valid. The cluster was
  created on `regular`, pinned to **1.36.4-gke.1082000**. `rapid` wasn't needed (spec §9.6).
- Result: Autopilot cluster `outfitter`, `us-central1`, RUNNING. DNS endpoint
  `gke-2b39f97f972e4b5aa58649cfda3195ffe3aa-97916961297.us-central1.gke.goog` with external traffic
  allowed. Maintenance window 21:00-05:00 UTC daily.
- CRDs present: `sandboxes.agents.x-k8s.io`, `sandboxclaims`, `sandboxtemplates` and
  `sandboxwarmpools` (all `extensions.agents.x-k8s.io`, apart from `sandboxes`).
- Nodes: none registered once the cluster was idle. Autopilot scales to zero with no workloads, so
  nothing is billed for compute until a pod runs. No Agent Sandbox controller pods are visible: the
  controller is Google-managed.
- Nodes are **public**: `privateClusterConfig` is unset. So spec §3.1's UNVERIFIED point holds: no
  Cloud NAT is needed, and none is added to the §3.7 cost.

Surprises, all fixed in `gke-cluster.sh`:

1. `create-auto` has no `--maintenance-window-*` flags (`create` does). The window is now a separate
   `clusters update`.
2. `create-auto` writes a kubeconfig entry and makes it current in the shared `~/.kube/config`. The
   script now points both it and `get-credentials` at `~/.kube/outfitter`.
3. The Cloud Billing API was off in `outfitter-509211`. Billing-account calls are billed to the quota
   project, so the credit check needs it. The script enables it (a dry run says how).

---

## S1: warm assignment latency (pass for the in-cluster part)

`deploy/gke/spike/s1.yaml` and `s1_measure.py`, 20 rounds; raw results in `s1-results.jsonl`. A
busybox probe under gVisor (250m/512Mi, pool of 1) logs its downward-API file
(`metadata.annotations['outfitter.dev/run-id']`) on every change, polling every 50 ms. Each round
creates a SandboxClaim whose `additionalPodMetadata.annotations` sets the value, and reads the
probe's log timestamp.

| Measure (seconds) | p50 | p90 | min | max |
|---|---|---|---|---|
| Laptop clock before `kubectl create` → value in file | 2.66 | 3.21 | 2.45 | 3.92 |
| of which `kubectl create`'s round trip from the laptop | 2.00 | 2.17 | | |
| `kubectl create` returned → value in file | **0.62** | **1.20** | 0.39 | 1.93 |

- **20 of 20 rounds adopted the warm pod.** None went cold; no timeouts.
- The pass bar (p90 ≤ 2 s from claim creation) is met by the in-cluster part: the true figure lies
  between the last row (p90 1.20 s) and the first (3.21 s), and the first is dominated by a fresh
  `kubectl` process, its auth plugin and TLS to the DNS endpoint every round. The API's long-lived
  client pays none of that. Laptop/node clock skew is under NTP and wasn't measured separately.
- So spec §3.5's Option B (annotation → downward-API file, no pod restart) works under gVisor, and
  PR4 isn't blocked by S1.
- Pool refill: a replacement warm pod was ready 2.3-3.0 s after the previous claim in 18 of 20
  rounds (5.9 s at worst) on an already-running node. A hint for S4: pod start under gVisor with a
  2 MB image is a few seconds; the real image is about 680 MB.
- First pod on an empty cluster: about 60 s from the pool's creation to `Started` (node scale-up;
  busybox pulled in 0.7 s). Autopilot kept the requests as given and added 1 GiB ephemeral storage.
- The pool was scaled to 0 afterwards.

## S3: identity and network (pass)

`deploy/gke/spike/s3.yaml`: a cold SandboxClaim in `outfitter-sandboxes` running as root, with
`serviceAccountName: outfitter-agent` (KSA annotated for `outfitter-agent@`, `deploy/gke/namespace.yaml`)
and the spec §3.3 network policy. Set up first: the hardening exemption for the namespace
(`deploy/gke/hardening-exemption.json`) and `roles/iam.workloadIdentityUser` on `outfitter-agent@` for
`outfitter-509211.svc.id.goog[outfitter-sandboxes/outfitter-agent]`.

| Check | Result |
|---|---|
| SA email from the metadata server, by name and by IP | `outfitter-agent@outfitter-509211.iam.gserviceaccount.com` |
| ID token for audience `https://link.kernal.one` | `iss` accounts.google.com, `aud` the link origin, `email` outfitter-agent@, `email_verified` true, 1 h lifetime |
| Deployed link, real token, made-up run id | closed **4404 "run not found"**: the token verified (the bearer check comes first) |
| Deployed link, bad token (control) | closed 4401 "unauthorized" |

- So Workload Identity in GSA-impersonation form gives agentd the same identity it has on Cloud Run,
  and `verifyAgentToken` needs no change. PR2 is unblocked on S3.
- **Spec §3.3's network policy blocks DNS as written.** The first run timed out on every name lookup
  (`metadata.google.internal`, `link.kernal.one`); only the metadata IP answered. The cluster runs
  Cloud DNS with NodeLocal DNSCache: pods query the kube-dns Service at `34.118.224.10`, and the node
  cache at link-local `169.254.20.10` answers. Allowing port 53 to both (as well as kube-dns pods) fixed
  it. agentd uses the name (`agentd/src/auth.ts:8`), so this is required, not cosmetic. Which of the two
  addresses carries the traffic wasn't narrowed down. The Service IP is cluster-specific, so PR3 reads it
  from the cluster rather than hard-coding it.
- `169.254.169.252:988` (the Dataplane V2 metadata path the spec expected) wasn't needed:
  `169.254.169.254:80` served everything.
- Cold start on a node that was already up: claim → Running 4.5 s, done at 10.6 s (`node:22-alpine`).
  On a fresh node: 82 s to Running.
- Root in `outfitter-sandboxes` with no securityContext was admitted, so the hardening exemption works
  and `sandbox-core-policy` doesn't object to root.

## S4: cold start of the real image

`deploy/gke/spike/s4.yaml` and `s4_measure.py`: 10 cold claims (pool `replicas: 0`) of the production
image `outfitter-agent:1e21c9f08eb9` in spec §3.3's shape (1 vCPU / 2 GiB / 4 GiB ephemeral), the real
entrypoint, S3's network policy. With no `RUN_ID`, agentd logs `missing required env var RUN_ID` and
exits 1, so "first log" marks Node and agentd loaded from the image. Raw results in `s4-results.jsonl`.

| Case | Scheduled | Image pull | Container started | agentd's first log |
|---|---|---|---|---|
| New node, first pull of the tag ever (1 round) | 52 s | 28.4 s | **93 s** | 93.7 s |
| New node, tag already seen by GKE (1 round, `s4-freshnode.jsonl`) | 47.6 s | **1.9 s** (streamed) | **70.6 s** | 72.1 s |
| Node up, image cached (9 rounds) | 2.0 s p50 | cached | **3.0 s p50** (3.3 s max) | 3.5 s p50 |

- **The pass bar (p50 ≤ 20 s) is met whenever a sandbox node with the image is already running:**
  3 s from claim to container, about ten times faster than the spec's cold target. The claim → scheduled
  step alone is about 2 s.
- **A new node plus a first pull is 93 s**, no better than Cloud Run's ~100 s. That is the first wake
  after the cluster has scaled its sandbox nodes to zero (outside warm hours, or after idling).
- **Image streaming works from the second pull of a tag.** The very first pull ever took 28.4 s (a
  normal pull, while GKE prepared the image for streaming). On a fresh node about 13 minutes later, the
  same tag pulled in **1.9 s**, although the node had never had it. Every release's new tag pays the
  28 s once, so PR3's release step should pre-pull it: a throwaway claim right after the template update.
- **Even with streaming, a new node costs about 70 s**: 47.6 s to schedule (node provisioning), then
  about 21 s between scheduling and container start that isn't the pull (1.9 s). On a warm node that
  gap is 1 s, so the rest is the new node getting ready (runtime, networking, the metadata server). Node
  boot, not the image, is now what sets the cold floor.
- Autopilot scaled the idle sandbox node away about 13 minutes after the last pod finished.
- Autopilot kept the 1 vCPU / 2 GiB / 4 GiB requests as given (no rounding up), which answers part of S5.
- Implications for the plan: the warm pool covers 08:00-20:00. Outside it, cold T_hello depends on
  whether a sandbox node is still up: about 3 s if so, about 70 s if not (93 s for a tag's first pull). A small always-on capacity
  buffer, or a later warm-down than warm-pool scale-down, would keep a node around; each costs money and
  goes in §3.7 once S5's billing is in.

## Admission rules found while running S1 and S7

GKE installs two ValidatingAdmissionPolicies with the Agent Sandbox add-on (component
`agentsandbox` 1.36.12). They match only `agents.x-k8s.io` and `extensions.agents.x-k8s.io`
`sandboxes` and `sandboxtemplates`, not plain Pods.

- **`sandbox-core-policy`**, binding in addon mode `Reconcile` (fixed): `runtimeClassName` gvisor or
  microvm; `automountServiceAccountToken: false` stated explicitly; `nodeSelector
  sandbox.gke.io/runtime: gvisor` plus the matching `NoSchedule` toleration; memory request at least
  1 GiB per vCPU; no privileged containers, hostNetwork/PID/IPC, hostPath, hostPort, custom sysctls,
  unmasked procMount, or projected service-account tokens.
- **`sandbox-hardening-policy`**, binding in addon mode `EnsureExists` (so it can be edited; GKE only
  recreates it if deleted), `validationActions: [Deny]`: every container, init containers included,
  must drop `ALL` capabilities, add none, set `runAsNonRoot: true`, and set cpu and memory limits.

Consequences for the spec: the real image starts as root (`image/Dockerfile:248`), clones as root and
chowns `/workspace` (#55), and drops to `agent` with setuid. The hardening policy rejects all of that
in a SandboxTemplate. Spec §3.3's template needs one of: relaxing the hardening binding to
`[Warn, Audit]`, or an image that starts as non-root with no capabilities (which undoes #45's
root/agent split). Owner decision; see the plan.

Also found: a SandboxClaim references a **warm pool** (`spec.warmPoolRef`, required), not a template.
Cold claims go through a pool with `replicas: 0`. Spec §4.2's method mapping needs that change.

## S7: metadata block (fail, impossible on Autopilot)

A plain gVisor Pod (`deploy/gke/spike/s7.yaml`, so neither sandbox policy applies) with an init
container adding `NET_ADMIN` was rejected by Autopilot's own admission webhook:

> GKE Warden ... `autogke-default-linux-capabilities`: linux capability 'NET_ADMIN' on container
> 'block-metadata' not allowed; Autopilot only allows the capabilities: 'AUDIT_WRITE,CHOWN,
> DAC_OVERRIDE,FOWNER,FSETID,KILL,MKNOD,NET_BIND_SERVICE,NET_RAW,SETFCAP,SETGID,SETPCAP,SETUID,
> SYS_CHROOT,SYS_PTRACE'.

So `security-review-pr41.md` finding 3's per-uid `iptables` block can't be done on Autopilot, whatever
the sandbox policies say. It stays open for GKE as it is for Cloud Run. Whether gVisor honours
`-m owner` wasn't reached. The remaining routes: block the metadata server for the **whole pod**
(Agent Sandbox's managed network policy already does this by default) and authenticate agentd some
other way than a Google ID token; or a GKE Standard cluster, which permits `NET_ADMIN` but costs the
Autopilot convenience. Owner decision; see the plan.
