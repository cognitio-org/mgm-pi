# Spec: a swappable GKE Agent Sandbox provider

Status: ready to implement (2026-09-22). Owner decisions still open: see §9.
Audience: whoever implements this without having read anything else. Every claim about
this repo cites `file:line` at commit `d545d5c`. Every claim about Google is cited with a URL.
Anything not checked against a primary source is marked **UNVERIFIED** and is on the spike list (§8.2).

Background: `docs/reports/sandbox-startup.md` found that Cloud Run Jobs cannot keep a warm
instance (no min-instances, no image streaming), and that GKE Autopilot with GKE Agent Sandbox
is the only option that can get wake time down to seconds within the $25/month budget. This spec
adds GKE as a **second** provider, chosen by configuration. The Cloud Run provider stays as it
is and remains the fallback.

---

## 1. Goals, non-goals, success metrics

### Goals
1. A `gke` `SandboxProvider` that runs the **same** `outfitter-agent` image (no fork) as a GKE Agent
   Sandbox: gVisor, Autopilot, image streaming, and an optional warm pool.
2. Switch providers with configuration only (`SANDBOX_PROVIDER=cloudrun|gke|docker|inprocess`).
   Runs that started on one provider can still be stopped and reconciled after a switch.
3. Keep behaviour the same as Cloud Run: same run state machine, same `hello`/`run.spec`/`bye`
   protocol, same per-run `RUN_TOKEN` security property, same checkpoint and idle-stop behaviour, and
   the same Peripherals capacity row.
4. Keep cost inside the $25/month project budget, with a documented default.

### Non-goals (v1)
- Pod snapshots (checkpoint/restore of a live pi). See §3.8. This is a v2 lever with its own spike.
- Pre-spawning pi in warm pods. pi's flags depend on the guru, which is only known after the claim.
- Ingress to sandboxes, the Sandbox Router, per-sandbox Services, or any change to the "sandbox
  dials out" model.
- Changing the agentd/api wire protocol. The recommended design (§3.5) changes **no frames**.
- Multi-cluster, regional HA, or GPU sandboxes.

### Success metrics

The E2.9 breakdown (`outfitter/EPIC.md:259-270`) shows why wake time has to be split into two
parts. The provider only controls the part up to agentd's `hello`. Session restore (~13 s) and pi
extension loading (~15 s) are agentd/pi work, and they cost the same on every provider.

| Metric | Definition | Cloud Run today | GKE target, warm | GKE target, cold |
|---|---|---|---|---|
| **T_hello** (provider-attributable) | `POST /wake` → first `hello` accepted by AgentLink | ~100 s median (32 s schedule + 97 s pull + 3.5 s) | **p50 ≤ 3 s, p90 ≤ 5 s** | **p50 ≤ 20 s, p90 ≤ 35 s** |
| **T_running** | `POST /wake` → Run.state `running`/`idle` | 123 s median | T_hello + agentd/pi startup (~30 s today) | same |
| **T_answer** | `POST /wake` with prompt → first assistant `entry` | ~126 s | T_running + model latency | same |
| Cost | GCP invoice for the project | n/a | total ≤ $25/month at the default schedule (§3.7) | n/a |
| Parity | contract suite (§6.2) green for `cloudrun`, `gke`, `docker`, `inprocess` | n/a | 100 % | n/a |

T_answer under 5 s is **not** a v1 goal. It also needs the in-flight startup-trim work, plus either
pod snapshots or per-guru pre-spawned pi (§3.8). The spec must not promise it.

---

## 2. Provider abstraction

### 2.1 The contract today (exact)

**Updated by PR1** (gke-sandbox-provider-plan.md §5): §2.2-§2.4's gaps are closed and the citations
below point at PR1's actual code, not the pre-PR1 state this section originally described. The
interface itself (RunLaunch/SandboxHandle/SandboxStatus) is unchanged; `SandboxProvider` gained the
optional `capacity()` and `start()`'s return type, per §2.3.

`outfitter/packages/provider-local/src/types.ts:1-57`:

```ts
export interface RunLaunch {
  runId: string;
  apiOrigin: string;        // OUTFITTER_API
  runToken: string;         // RUN_TOKEN, per run, only its sha256 is stored (runs.ts)
  devToken?: string;        // OUTFITTER_DEV_TOKEN, dev only
  image?: string;           // LocalDockerProvider only
  env?: Record<string, string>;
}
export type SandboxHandle = string;            // opaque; "callers should not parse it"
export type SandboxStatus = "starting" | "running" | "exited" | "unknown";
export interface SandboxCapacity { active: number; warmReady?: number; warmDesired?: number; limit?: number; }
export interface SandboxStartResult { handle: SandboxHandle; warm?: boolean; }
export interface SandboxProvider {
  start(run: RunLaunch): Promise<SandboxStartResult>;
  stop(handle: SandboxHandle): Promise<void>;
  status(handle: SandboxHandle): Promise<SandboxStatus>;
  capacity?(): Promise<SandboxCapacity>;
}
```

Where it is used (post-PR1):

| Site | Use |
|---|---|
| `packages/api/src/providers/registry.ts` | `SandboxProviders` (lazy, memoized per-name factories) and `createProviders(config)`. `providers/index.ts`'s `createProvider(config)` is a thin wrapper around `createProviders(config).get(config.sandboxProvider)` (returns just the default provider), kept for anyone who only wants that; `main.ts` itself calls `createProviders(config)` directly and hands the *whole registry* to `buildApp`, not just the default |
| `packages/api/src/main.ts`, `server.ts` (`BuildAppOptions.provider`, `buildApp`) | `main.ts` passes `createProviders(config)` (a `SandboxProviders`) as `provider`; `buildApp` accepts either that or a bare `SandboxProvider` (tests' source-compat path, wrapped via `SandboxProviders.single`) and passes the resolved registry straight to `RunManager`, so a run started under a since-abandoned default is still stoppable/reconcilable in production, not only in tests |
| `packages/api/src/config.ts` (`SandboxProviderName`, `isCloudProvider`) | `SandboxProviderName = "inprocess" \| "docker" \| "cloudrun" \| "gke"`, validated by `envEnum` (default `inprocess`); `isCloudProvider(name)` is true for `cloudrun`/`gke` |
| `packages/api/src/main.ts` | `assertGkeConfigured(config)` added alongside `assertSandboxOrigin` -- boot fails for `SANDBOX_PROVIDER=gke` with no `GKE_CLUSTER` |
| `packages/api/src/runs.ts` (`RunManager.wake`, `providerNameFor`) | `wake` resolves the provider via the registry, stores `providerHandle` **and** `sandboxProvider` (which provider made the handle) |
| `packages/api/src/runs.ts` (`stop`, `reconcileOnce`, `reconcileStoppingOnce`) | each resolves its run's provider via `providerNameFor(run, config.sandboxProvider)` through the registry; an unconfigured provider is logged once and skipped, the state change still applies |
| `packages/api/src/store/types.ts` (`Run.sandboxProvider`) | records which `SandboxProvider` started the run; absent on legacy rows (`providerNameFor` infers `cloudrun` from a Cloud-Run-shaped `providerHandle`, else falls back to the deployment default) |
| `packages/api/src/server.ts` (`buildApp`) | capacity is resolved through the registry (`providers.get(providers.defaultName)`) and duck-typed on that provider's `.capacity` instead of `instanceof CloudRunProvider` |
| `packages/api/src/providers-status.ts` (`probeSandbox`), `store/types.ts` (`ProviderKind`) | `probeSandbox(name, capacityFn)` replaces `probeCloudRun`; `ProviderKind` includes `"cloudrun"` and `"gke"` |
| `packages/api/src/config.ts` (`assertSandboxOrigin`, `mailboxWarning`) | both now call `isCloudProvider(config.sandboxProvider)` instead of `=== "cloudrun"` |
| `deploy/service.sh` (`ENV_VARS=...`), `deploy/config.env` (`SANDBOX_PROVIDER`) | both roles get `SANDBOX_PROVIDER=${SANDBOX_PROVIDER},CLOUDRUN_JOB=...`, read from `config.env` (default `cloudrun`) instead of hard-coded |

### 2.2 Gaps a Kubernetes provider exposes

| # | Gap | Why it matters for GKE | Resolution |
|---|---|---|---|
| G1 | The handle does not record its provider | After switching `SANDBOX_PROVIDER`, stop/reconcile would send a Cloud Run execution name to the GKE client (or the reverse) | New `Run.sandboxProvider` field and a provider **registry** (§2.4) |
| G2 | One provider per process | Old-provider runs must stay stoppable after a switch | The registry builds every *configured* provider lazily |
| G3 | Capacity uses `instanceof CloudRunProvider` | GKE has capacity and warm-pool readiness | Optional `capacity()` on the interface (§2.3) |
| G4 | Warm vs cold start | Useful telemetry and benchmark dimension | Optional `start()` result field `warm?: boolean`. Purely informational |
| G5 | Launch env delivery | A warm pod has already booted; `SandboxClaim.spec.env` forces a cold start (verified, §3.5) | Provider-internal: cold uses claim env; warm uses claim annotations and a downward-API file (§3.5). `RunLaunch` is unchanged |
| G6 | Process exit is not sandbox gone | A Cloud Run execution ends when agentd exits. A Pod with `restartPolicy: Never` goes `Succeeded`, but the claim object stays | Claim `lifecycle.ttlSecondsAfterFinished` garbage-collects it; `status()` maps Finished to `exited`. No interface change |
| G7 | Suspend/resume | Upstream "Suspended" **deletes the pod** and keeps only PVCs (verified, §3.8). We have nothing to keep | Not in the interface. Idle: agentd exits, pod `Succeeded`, claim GC'd |
| G8 | Status mapping | Claim conditions differ from Execution fields | Table in §4.3 |

### 2.3 Interface changes (backward-compatible)

All additions are **optional** members. `LocalDockerProvider`, `InProcessProvider`, `NoopProvider`
and `CloudRunProvider` compile and behave exactly as before.

```ts
// provider-local/src/types.ts, additions only
export interface SandboxCapacity {
  /** Sandboxes currently starting or running, started by this deployment. */
  active: number;
  /** Warm, unclaimed sandboxes ready right now (GKE only). */
  warmReady?: number;
  /** Warm pool's desired size (GKE only; 0 outside active hours). */
  warmDesired?: number;
  /** Hard cap on concurrently active sandboxes, when the provider enforces one. */
  limit?: number;
}

export interface SandboxStartResult {
  handle: SandboxHandle;
  /** true = adopted a warm sandbox, false = cold start, undefined = provider can't tell. */
  warm?: boolean;
}

export interface SandboxProvider {
  start(run: RunLaunch): Promise<SandboxStartResult>;   // was Promise<{handle}>: a structural superset
  stop(handle: SandboxHandle): Promise<void>;
  status(handle: SandboxHandle): Promise<SandboxStatus>;
  /** Optional: capacity for the Peripherals dashboard. */
  capacity?(): Promise<SandboxCapacity>;
}
```

`CloudRunProvider` gains `capacity()` that returns `{ active }` from `countRunningExecutions`.
Keep `countRunningExecutions` so the existing tests stay green.

### 2.4 Provider selection and the registry

**Config** (`packages/api/src/config.ts`):

```ts
export type SandboxProviderName = "inprocess" | "docker" | "cloudrun" | "gke";
const SANDBOX_PROVIDERS = ["inprocess", "docker", "cloudrun", "gke"] as const;

// new Config fields
gkeCluster: string;      // GKE_CLUSTER, default "" (unset = gke not configured)
gkeLocation: string;     // GKE_LOCATION, default = gcpRegion ("us-central1")
gkeNamespace: string;    // GKE_NAMESPACE, default "outfitter-sandboxes"
gkeWarmPool: string;     // GKE_WARM_POOL, default "outfitter-agent"
gkeEndpoint: string;     // GKE_ENDPOINT, optional override of the DNS endpoint host
gkeLaunchMode: "cold" | "warm";   // GKE_LAUNCH_MODE, default "cold" until PR4's image is deployed
gkeMaxActive: number;    // GKE_MAX_ACTIVE, default 3; start() refuses above it
```

- `SANDBOX_PROVIDER` is the **per-deployment default** for new runs. `deploy/service.sh`'s
  `ENV_VARS=...` line reads it from `${SANDBOX_PROVIDER}` (set in `deploy/config.env`, default
  `cloudrun`) instead of hard-coding it.
- `SANDBOX_PROVIDER=gke` with an empty `GKE_CLUSTER` fails at boot with an explicit message: a new
  `assertGkeConfigured` (`config.ts`), called from `main.ts` alongside `assertSandboxOrigin`.
- `assertSandboxOrigin` and `mailboxWarning` (both in `config.ts`) change their `=== "cloudrun"`
  tests to a new `isCloudProvider(name)` (true for `cloudrun` and `gke`).

**Registry** (new `packages/api/src/providers/registry.ts`). It replaces the single `provider`
passed through `buildApp`:

```ts
export class SandboxProviders {
  constructor(
    readonly defaultName: SandboxProviderName,
    private readonly factories: Partial<Record<SandboxProviderName, () => Promise<SandboxProvider>>>,
  ) {}
  /** Lazily builds and memoizes. Throws `sandbox provider "<name>" is not configured here` if absent. */
  get(name: SandboxProviderName): Promise<SandboxProvider>;
  /** Test helper and back-compat: wrap one already-built provider as the default. */
  static single(name: SandboxProviderName, p: SandboxProvider): SandboxProviders;
}
export function createProviders(config: Config): SandboxProviders;
```

`createProviders` registers a factory for the default provider, plus any cloud provider whose
config is present: `cloudrun` when `gcpProject` and `cloudRunJob` are set, `gke` when `gcpProject`
and `gkeCluster` are set. The old provider therefore stays reachable after a switch. Each
per-provider factory (`registry.ts`'s `buildInProcess`/`buildDocker`/`buildCloudRun`/`buildGke`)
lazy-imports its own dependency (`@outfitter/provider-local`, `./cloudrun.ts`), so nothing is paid
until a run on that provider needs it; `buildGke` lazy-imports `./gke.ts` and builds the real
`GkeProvider` (PR2; it was a stub in PR1 that threw until then).
`createProvider` (`providers/index.ts`) stays as a thin wrapper around the registry's default for
anyone who only wants that provider. **Production doesn't use it**: `main.ts` calls
`createProviders(config)` directly and passes the whole registry to `buildApp`, which is what
makes a run started under a since-abandoned default provider still stoppable/reconcilable outside
of tests. `BuildAppOptions.provider` accepts either the registry or a bare `SandboxProvider`
(wrapped via `SandboxProviders.single`), so tests that only ever built one provider (`server.ts`'s
own test suite, `helpers.ts`'s `buildTestApp`) keep working unmodified.

**Recording the provider on the run** (`store/types.ts`, `Run`):

```ts
/** Which SandboxProvider started this run; providerHandle is only meaningful to that one.
 * Absent on runs created before this field existed: see providerNameFor(). */
sandboxProvider?: SandboxProviderName;
```

```ts
// runs.ts
export function providerNameFor(run: Run, fallback: SandboxProviderName): SandboxProviderName {
  if (run.sandboxProvider) return run.sandboxProvider;
  // Legacy rows: Cloud Run execution names are the only handles shaped like this.
  if (run.providerHandle?.startsWith("projects/")) return "cloudrun";
  return fallback;
}
```

`RunManager`'s constructor (`runs.ts`) takes `SandboxProviders`. For source compatibility with the
existing tests it also accepts a bare `SandboxProvider`, which it wraps with `SandboxProviders.single`.
- `wake(sessionId)` picks the provider name (v1: `config.sandboxProvider`; PR6: per Tape, §2.5), gets
  it from the registry and calls `start`. It stores `sandboxProvider` next to `providerHandle` in the
  same `update` call.
- `stop`, `reconcileOnce` and `reconcileStoppingOnce` resolve the provider via a shared
  `resolveProvider(run)` helper that calls `providerNameFor(run, config.sandboxProvider)` then the
  registry. If the registry throws (provider no longer configured), they log once (per provider
  name, not per reconcile tick), skip the provider call, and still apply the state change. This is
  the same best-effort semantics as a provider call that itself fails.
- Mongo: no index change. The new field is written on update only.

**Capacity** (`server.ts`'s `buildApp`, `providers-status.ts`): replace `cloudRunCount` with
`sandboxCapacity?: () => Promise<SandboxCapacity>`, taken from the **default** provider's optional
`capacity` (duck-typed: `provider.capacity ? () => provider.capacity!() : undefined`, no
`instanceof CloudRunProvider`). Generalize `probeCloudRun` to `probeSandbox(name, fn)`, which emits
one row with `kind: name` (`ProviderKind` gains `"gke"`) and `meta: { active, warmReady,
warmDesired, limit }` (only the fields the capacity actually set), plus `meta.runningExecutions =
active` so the web dashboard (E3.6) needs no change in PR1. Row ids: keep `id: "cloudrun"` for the
cloudrun kind (keeps its 7-day uptime history, and is also what every local dev provider reports
under, since there's nothing else to show) and use `id: "gke"` for gke.

### 2.5 Per-Tape (guru) override: recommended, deferred to PR6

| Option | Verdict |
|---|---|
| Per deployment only | **v1.** Enough to A/B the two providers. |
| Per Tape (`Guru.sandboxProvider?: SandboxProviderName`) | **Recommend (PR6).** Real use: a "builder" Tape that wants Cloud Run's 24 h job while chat Tapes use the warm GKE pool. Cheap: the Tape's value wins over `config.sandboxProvider`, validated in `routes/gurus.ts` against the configured set. |
| Per session or per wake | **Don't.** A session's runs would flip providers between wakes and nothing would gain. Operators can debug with a copy of the Tape. |

### 2.6 Switching providers safely

1. Deploy PR1 first. From then on, every new run records `sandboxProvider`.
2. Configure both providers in the environment (`CLOUDRUN_JOB` and `GKE_CLUSTER`) and flip `SANDBOX_PROVIDER`.
3. In-flight runs keep their provider for stop/reconcile through the registry. New runs use the new default.
4. Remove the old provider's env only after no active run records it (`deploy/gke-switch.sh --check`, §5).

---

## 3. GKE design

### 3.1 Cluster

| Choice | Value | Source / note |
|---|---|---|
| Mode | **Autopilot** | Owner prefers managed. Agent Sandbox supports Autopilot with one `--enable-agent-sandbox` flag. https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox |
| Location | `us-central1` (**regional**, which Autopilot requires) | Same doc: for Autopilot "the LOCATION must be a region". **Correction to the brief and the report:** Autopilot clusters are regional, not zonal. The free-tier credit still covers them: $74.40/month per billing account, "applied to zonal and Autopilot clusters". https://cloud.google.com/kubernetes-engine/pricing |
| Name | `outfitter` | one cluster per project |
| Version | 1.36.3-gke.1767000 or later (Agent Sandbox `v1beta1`) | install doc. **UNVERIFIED** whether the Regular channel has it today; use `--release-channel=rapid` if not |
| Control-plane access | **DNS-based endpoint** (`--enable-dns-access`) | Reachable from anything that can reach Google APIs, including Cloud Run, and authorised by IAM `container.clusters.connect`. No authorised-networks list needed for Cloud Run's changing egress IPs. https://cloud.google.com/blog/products/containers-kubernetes/new-dns-based-endpoint-for-the-gke-control-plane |
| Node egress | public nodes, **no Cloud NAT** | Avoids NAT cost. **UNVERIFIED** that Autopilot still defaults to public nodes; if nodes are private, Cloud NAT is required (small fixed cost; add to §3.7) |
| Image streaming | on by default for Autopilot | "Autopilot clusters automatically use Image streaming to pull eligible images." Needs the Container File System API (`containerfilesystem.googleapis.com`) and images in Artifact Registry (ours already are, `agent-job.sh:23`). https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming |
| Cluster fee | $0.10/h = $73/month, covered by the credit **only if this is the billing account's only credit-consuming cluster** | Check billing account `01DEC0-9358E1-C1FF0D` (`deploy/baseline.sh:13`) has no other GKE cluster |

### 3.2 Namespace, identities, RBAC

```
namespace  outfitter-sandboxes
KSA        outfitter-sandboxes/outfitter-agent   (annotated to impersonate GSA outfitter-agent@PROJECT)
GSA        outfitter-agent@PROJECT               (existing; roles/logging.logWriter only, baseline.sh:127-132)
GSA        outfitter-api@PROJECT                 (existing; the API's Cloud Run identity, both roles)
```

**Sandbox identity: Workload Identity Federation for GKE, GSA-impersonation form.** agentd
authenticates to the link with a Google ID token from the metadata server (`agentd/src/auth.ts:32`,
the `instance/service-accounts/default/identity?audience=...` path). The API requires
`payload.email === AGENT_SA_EMAIL` (`api/src/auth.ts:141-155`). To keep that path **unchanged**, the
KSA impersonates the existing GSA:

- KSA annotation `iam.gke.io/gcp-service-account: outfitter-agent@PROJECT.iam.gserviceaccount.com`.
- `roles/iam.workloadIdentityUser` on the GSA for member
  `serviceAccount:PROJECT.svc.id.goog[outfitter-sandboxes/outfitter-agent]`.
- **UNVERIFIED (spike S3):** that the GKE metadata server's `identity` endpoint returns a Google-signed
  ID token whose `email` is the GSA. This is expected in the impersonation form but not in the
  direct-principal (no-GSA) form. If it fails, `verifyAgentToken` would need a second accepted identity.
  That is a real design change, so S3 blocks PR2.
- Agent Sandbox's **default** network policy blocks the metadata server
  (https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox; upstream
  `sandboxtemplate_types.go`: "Blocks internal IPs (RFC1918), Metadata Server"). Our template therefore
  supplies its own policy (§3.3).

No new GCP roles for the sandbox. Secrets still arrive in `run.spec` over the authenticated socket
(`docs/protocol.md:84`), so the sandbox needs no Secret Manager access. That is the same as today.

**API identity to cluster.** `outfitter-api@` (used by both the web and link roles) needs:

| Grant | Why |
|---|---|
| IAM `roles/container.clusterViewer` on the project (for `container.clusters.get` and `container.clusters.connect`) | Authenticate to the DNS endpoint and read the cluster. **UNVERIFIED** that `clusterViewer` includes `clusters.connect`. If not, create a custom role `outfitterGkeConnect` with exactly those two permissions (same pattern as `outfitterSecretAdmin`, `baseline.sh:90-117`) |
| Kubernetes `Role` and `RoleBinding` in `outfitter-sandboxes` for `User: outfitter-api@PROJECT.iam.gserviceaccount.com` | Least privilege inside the cluster (below). **Not** `roles/container.developer`, which grants write to every namespace |

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: outfitter-api, namespace: outfitter-sandboxes }
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxclaims"]
    verbs: ["create", "get", "list", "delete"]
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxwarmpools"]
    verbs: ["get", "list", "patch"]        # patch = scheduled warm-pool resize (§5.3)
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get"]                          # status fallback (§4.3)
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: outfitter-api, namespace: outfitter-sandboxes }
subjects: [{ kind: User, name: outfitter-api@outfitter-509211.iam.gserviceaccount.com }]
roleRef: { kind: Role, name: outfitter-api, apiGroup: rbac.authorization.k8s.io }
```

The API gets no `pods` access. Warm-mode run tokens live in pod annotations (§3.5), and the fewer
principals that can read pods, the better.

### 3.3 SandboxTemplate (same image, no fork)

The image entrypoint is `node /opt/outfitter/agentd/dist/src/main.js` running as root
(`image/Dockerfile:202`). agentd drops to the `agent` user for pi (`PI_RUN_AS_USER=agent`,
`Dockerfile:160`; `protocol.md:56-64`). So the template must **not** set `runAsNonRoot: true`, unlike
Google's example. The root/`agent` split is what keeps pi from reading agentd's secrets and the
assignment files.

API group and version: `extensions.agents.x-k8s.io/v1beta1`. Field names were verified against
`kubernetes-sigs/agent-sandbox` tag `v1.0.3` (released 2026-09-17): `extensions/api/v1beta1/sandboxtemplate_types.go`,
`sandboxclaim_types.go`, `sandboxwarmpool_types.go`.

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: outfitter-agent
  namespace: outfitter-sandboxes
spec:
  envVarsInjectionPolicy: Allowed        # cold mode passes RUN_ID/RUN_TOKEN via claim env (forces cold start; fine)
  networkPolicyManagement: Managed
  networkPolicy:                          # replaces the default policy, which BLOCKS the metadata server
    ingress: []                           # default deny: no ingress at all (no Sandbox Router)
    egress:
      - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16] } }]
        ports: [{ protocol: TCP, port: 443 }, { protocol: TCP, port: 80 }]
      - to: [{ ipBlock: { cidr: 169.254.169.254/32 } }]          # GKE metadata server (WI tokens)
        ports: [{ protocol: TCP, port: 80 }]
      - to: [{ ipBlock: { cidr: 169.254.169.252/32 } }]          # Dataplane V2 gke-metadata-server; UNVERIFIED (S3)
        ports: [{ protocol: TCP, port: 988 }]
      - to: [{ namespaceSelector: {}, podSelector: { matchLabels: { k8s-app: kube-dns } } }]
        ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
  podTemplate:
    metadata:
      labels: { app.kubernetes.io/name: outfitter-agent, app.kubernetes.io/managed-by: outfitter }
    spec:
      runtimeClassName: gvisor
      serviceAccountName: outfitter-agent
      automountServiceAccountToken: false  # agentd never talks to the Kubernetes API
      restartPolicy: Never                  # agentd exit = run over (Cloud Run: --max-retries=0, agent-job.sh:50)
      terminationGracePeriodSeconds: 15     # agentd's SIGTERM checkpoint budget is 8 s (run.ts:657)
      containers:
        - name: agentd
          image: us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-agent:${TAG}
          resources:
            requests: { cpu: "1", memory: 2Gi, ephemeral-storage: 4Gi }
            limits:   { cpu: "1", memory: 2Gi, ephemeral-storage: 4Gi }
          env:
            - { name: OUTFITTER_API, value: "${OUTFITTER_LINK_ORIGIN}" }       # agent-job.sh:52 equivalent
            - { name: OUTFITTER_ASSIGNMENT_DIR, value: /etc/outfitter/assignment } # read by PR4 agentd only
          volumeMounts:
            - { name: assignment, mountPath: /etc/outfitter/assignment, readOnly: true }
      volumes:
        - name: assignment
          downwardAPI:
            defaultMode: 0400                # root-only; pi runs as `agent` and cannot read it
            items:
              - { path: run-id,    fieldRef: { fieldPath: "metadata.annotations['outfitter.dev/run-id']" } }
              - { path: run-token, fieldRef: { fieldPath: "metadata.annotations['outfitter.dev/run-token']" } }
              - { path: api,       fieldRef: { fieldPath: "metadata.annotations['outfitter.dev/api']" } }
```

Notes:
- `${TAG}` and `${OUTFITTER_LINK_ORIGIN}` are `envsubst` placeholders filled in by `deploy/gke-template.sh` (§5).
- **1 vCPU / 2 GiB** matches the Cloud Run job (`agent-job.sh:47-48`; EPIC "Decisions taken"). Autopilot
  bills requests. Requests equal limits, so there are no burst surprises. Ephemeral 4 GiB covers the clone
  and `/workspace`. **UNVERIFIED** that Autopilot won't round this shape up (S5).
- The egress policy is **stricter** than Cloud Run's: no RFC1918 destinations. Nothing we use needs them.
  LiteLLM, GitHub and the laptop's ngrok tunnel are all public. Spike S2 confirms clone, LiteLLM and the tunnel.
- An unset annotation gives an empty file, so the same template serves cold claims (env) and warm claims
  (annotations).
- The `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` annotation (the one system annotation
  claims may set, per `sandboxclaim_types.go`) goes on the pod template to discourage evicting busy sandboxes.

### 3.4 Warm pool

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata: { name: outfitter-agent, namespace: outfitter-sandboxes }
spec:
  replicas: 0                   # set by the Cloud Scheduler hook (§5.3); 0 = cold-only
  sandboxTemplateRef: { name: outfitter-agent }
  updateStrategy: { type: Recreate }   # enum Recreate|OnReplenish: replace idle warm pods when the template (image) changes
```

A claim adopts a warm sandbox if one has a Pod IP within `warmCandidateGracePeriod = 2s`. Otherwise
it creates one cold from the template (`extensions/controllers/sandboxclaim_controller.go:63-67, 571-573`
at v1.0.3). **A claim that sets `spec.env` or `spec.volumeClaimTemplates` always cold-starts**: see the
doc comments on `Env` and `VolumeClaimTemplates` in `sandboxclaim_types.go`, and on
`envVarsInjectionPolicy` in `sandboxtemplate_types.go` ("environment variables are baked into the Pod
before it is created; they cannot be injected into an already-running warm pool Pod"). That fact drives §3.5.

### 3.5 Getting RUN_ID / RUN_TOKEN into a pod that booted before the run existed

The property to keep (`docs/protocol.md:28-38`, `runs.ts:49-55`): the token is minted **per run, at
wake**, only its hash is stored, and it is never given to a sandbox before that sandbox belongs to that
run. A warm pod therefore boots with **no** token.

| Option | Warm? | agentd change | Link protocol change | Token exposure | Verdict |
|---|---|---|---|---|---|
| A. `SandboxClaim.spec.env` carries RUN_ID, RUN_TOKEN, OUTFITTER_API | **No** (forces cold) | none | none | claim, Sandbox and Pod spec. Same class as Cloud Run's `containerOverrides` env, which `run.executions.get` holders can read | **Ship first (PR2, `GKE_LAUNCH_MODE=cold`)** |
| B. Claim `additionalPodMetadata.annotations`; the controller patches the running warm pod's metadata (`sandboxclaim_controller.go:505-567`; `controllers/sandbox_controller.go:1487-1545` `updatePodMetadata`); the kubelet refreshes the downward-API files; agentd waits for them | **Yes** | `main.ts` reads env **or** the assignment dir (about 60 lines) | **none**: same `hello`, same `runToken` check | claim, Sandbox and Pod annotations (readable by namespace readers only: `outfitter-api@` through its claim/sandbox `get`, and project owners), plus a root-only 0400 file in the pod | **Recommended warm path (PR4)** |
| C. Warm agentd pre-connects to the link and waits for an `assign {runId, runToken}` frame | Yes | large | new pool socket, new pre-auth state, new frame | token only on the wire | **Reject.** An idle warm pod holding a WebSocket to `outfitter-link` keeps a request-billed Cloud Run instance busy around the clock (about 1 vCPU active: over budget on its own), runs into Cloud Run's 60-minute request cap, and needs a pod-bound credential (projected KSA JWT) so a sibling sandbox cannot take someone else's assignment |
| D. Per-run Secret mounted into the pod | No (a new volume means a new pod) | small | none | Secret | Reject: no warm benefit |

**Option B in detail. This is the smallest change that keeps the warm path.**

API side (GKE provider `start`, warm mode):

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: run-<runId>                      # runId is a UUID, so 40 chars: valid DNS-1123
  namespace: outfitter-sandboxes
  labels: { app.kubernetes.io/managed-by: outfitter, outfitter.dev/run-id: <runId> }
spec:
  warmPoolRef: { name: outfitter-agent }
  lifecycle:
    shutdownTime: <now + 24h>             # parity with --task-timeout=24h (agent-job.sh:49)
    shutdownPolicy: Delete
    ttlSecondsAfterFinished: 120           # GC the claim 2 min after the pod reaches Succeeded/Failed
  additionalPodMetadata:
    annotations:
      outfitter.dev/run-id: <runId>
      outfitter.dev/run-token: <runToken>
      outfitter.dev/api: <apiOrigin>
```

Cold mode sends the same claim without `additionalPodMetadata`, and with `spec.env` set to
`RUN_ID`, `RUN_TOKEN` and `OUTFITTER_API`.

agentd side (PR4, new `packages/agentd/src/assignment.ts`, used from `main.ts:47-53`):

```ts
/** Env first (Cloud Run, docker, inprocess, GKE cold). Otherwise wait for the downward-API files a
 * SandboxClaim's annotations produce (GKE warm). Polls, because gVisor's view of the kubelet's
 * atomic symlink swap is not reliably visible to inotify. Never logs the token. */
export async function resolveAssignment(env?: NodeJS.ProcessEnv, opts?: {
  pollMs?: number;                                  // default 100
  readFile?: (path: string) => Promise<string>;     // injectable for tests
  now?: () => number;
}): Promise<{ runId: string; runToken: string; apiOrigin: string; waitedMs: number }>;
```

- `RUN_ID` and `RUN_TOKEN` in env: return them immediately (today's path, unchanged).
- Else, `OUTFITTER_ASSIGNMENT_DIR` set: poll `run-id` and `run-token` every 250 ms until both are
  non-empty (trimmed). `apiOrigin` is the `api` file if non-empty, else env `OUTFITTER_API`. No timeout:
  an unclaimed warm pod waits until the pool shrinks and deletes it.
- Else: today's `requireEnv` error.
- Order in `main.ts`: do the run-independent work first (`getPiVersion`, `resolveRunAsUser`,
  `main.ts:60-76`), then wait. A warm pod has then paid for everything before `run.spec`. `createLogger`
  takes `runId` (`main.ts:69`), so create it after the assignment, or add the runId to the logger's
  context afterwards.
- Log phases `startup: waiting for assignment` and `startup: assigned` (with `waitedMs`). Register the
  token with `logger.addSecret` exactly as `main.ts:70` does now.
- **Before PR4's image is live, the warm pool must stay at `replicas: 0`.** Today's agentd exits 1 on a
  missing `RUN_ID`, so a warm pod would fail and the pool would churn.

**Open latency risk (spike S1).** The kubelet refreshes downward-API volumes after it sees the pod
change. The upper bound is the kubelet sync period (about 1 min by default); the typical delay is
seconds. **UNVERIFIED** on Autopilot with gVisor. If S1 measures p90 above 2 s, ship cold mode
(Option A) only and park PR4. The alternative, B-prime, is for agentd to read its own claim through a
projected KSA token with `resourceNames`-restricted RBAC. It needs a token mounted in the pod and a
fresh security review.

**Verified and implemented (PR4, `gke-sandbox-provider-plan.md` §6d).** S1 passed (p90 well under 2s
in-cluster; `docs/reports/gke-spike.md` S1), so PR4 shipped Option B as designed above, with a few
adjustments the design above didn't call out:

- `resolveAssignment` waits for `run-id`, `run-token` **and** `api` to all be non-empty (not just
  the first two) before returning. This is *not* guarding against a real production race: the
  kubelet's projected-volume refresh swaps the whole `..data` symlink to a fresh timestamped
  directory in a single atomic rename, so `run-id`/`run-token`/`api` become visible together, not
  staggered (verified against the real layout in `packages/agentd/test/assignment.test.ts`, which
  builds the actual `..data`-symlink structure and performs the same atomic rename). Waiting on all
  three is belt-and-suspenders insurance against this module's own three separate `readFile` calls
  landing on either side of that rename -- a scenario only reproduced as a deliberate test artifact
  (staggering the fake files' writes one at a time), never observed against the real mechanism.
- The poll interval is 250 ms (not the 100 ms sketched above).
- A presence-only heartbeat (never a value) logs every few minutes while still waiting, so a stuck
  warm pod is visible in its own logs without ever risking a token in them.
- `main.ts` resolves the env path (`RUN_ID` already in env) *before* any of the run-independent
  setup below, not after -- a review of an early cut of this PR found `RUN_TOKEN` still reachable
  in `process.env` when `getPiVersion`/`resolveRunAsUser` spawned their children, because the delete
  happened inside `resolveAssignment`, called only after those spawns. Only the warm-pod wait
  defers `resolveAssignment` past that setup now (`main.ts`'s own module doc has the detail).
- Both the identity-token fetch and the WebSocket connect are logged on failure too, not just
  success (`identity token fetch failed (<ms>): <message>`), via a new `onHeadersError` callback on
  `Link` (`packages/agentd/src/link.ts`, closes #157: it used to swallow a `headers()` rejection with
  no log line at all). A reconnect's phase lines say `reconnect <n>: ...` instead of repeating
  `startup: ...` every time the socket drops.

`packages/agentd/src/assignment.ts` is the actual implementation; its `resolveAssignment` signature
matches the sketch above except it also accepts injectable `sleep`, `deadlineMs`, `heartbeatMs` and
`onHeartbeat` (the first two are test-only knobs -- production never sets a deadline, matching "no
timeout by default" above).

### 3.6 Networking, logs, workspace

| Concern | Design | Parity with Cloud Run |
|---|---|---|
| Ingress | none. The template sets `networkPolicy.ingress: []`. The API creates no Service. **UNVERIFIED** whether the controller creates a headless Service per Sandbox anyway (`Sandbox.spec.service` exists in `sandbox_types.go`); harmless under default-deny ingress | same (Jobs have no ingress) |
| Egress | public internet on 443/80, the metadata server, kube-dns. No RFC1918 | slightly stricter |
| Link | agentd dials `wss://outfitter-link.../agent/ws?run=<id>` (`agentd/src/main.ts:30-36`). Unchanged | same |
| Logs | stdout JSON (`agentd/src/logger.ts`) goes to Cloud Logging as resource `k8s_container`, `resource.labels.namespace_name="outfitter-sandboxes"`. The GSA keeps `logging.logWriter`. Update the log queries in `docs/reports/cost-and-logs.md` | different resource type |
| Checkpoint / workspace | unchanged: git push for repo sessions, JSONL entries over the socket to Atlas, the workspace tarball from `WORKSPACE_SNAPSHOT_DIR` (`agentd/src/workspace.ts:160-177`, still local-only on both providers) | same |
| Idle | agentd sends `bye idle` and exits 0; the pod goes `Succeeded`; the claim is GC'd after `ttlSecondsAfterFinished` | same |
| Stop | `stop()` deletes the claim; the pod gets SIGTERM with a 15 s grace; agentd `handleSigterm` checkpoints (8 s budget) | same (`cancelExecution` also SIGTERMs) |
| Hard timeout | claim `lifecycle.shutdownTime` = now + 24 h | `--task-timeout=24h` |

### 3.7 Cost

Rates for us-central1: Autopilot general-purpose **$0.0445/vCPU-h, $0.0049225/GiB-h, ephemeral about
$0.00014/GiB-h**. These are **UNVERIFIED**: the primary pricing page did not render, and the figures
come from secondary sources (https://www.cloudzero.com/blog/gke-pricing/,
https://scaleops.com/blog/gke-cost-optimization/). Spot Pods are cheaper, but no current figure was
confirmed (**UNVERIFIED**). One 1 vCPU / 2 GiB / 4 GiB-ephemeral pod costs about **$0.055/h**.

| Scenario (1 warm replica, 1 vCPU/2 GiB) | Warm hours/month | Warm cost | + active use (2 h/day, about 60 h) | Cluster fee | Total |
|---|---|---|---|---|---|
| Cold only (`replicas: 0`) | 0 | $0 | $3.3 | $0 (credit) | **$3.3** |
| **Default: weekdays 08:00-20:00, owner's time zone** | about 260 | $14.3 | $3.3 | $0 | **$17.6** |
| Weekdays 09:00-18:00 | about 195 | $10.7 | $3.3 | $0 | $14.0 |
| Around the clock | 730 | $40.2 | $3.3 | $0 | **$43.5 (over budget)** |
| Around the clock on Spot (roughly 60-70 % off, UNVERIFIED) | 730 | about $13 | $3.3 | $0 | about $16; warm or claimed pods may be preempted |

Everything else in the project (Cloud Run api/link, Atlas M0, Secret Manager, Artifact Registry)
stays inside free tiers per `EPIC.md` "Cost model". The default leaves about $7 of headroom under the
$25 alert. `GKE_MAX_ACTIVE=3` caps burst compute at about $0.17/h. Guardrails are in §5.3.

Check on the first invoice: (a) whether the Agent Sandbox controller's own pods are billed on
Autopilot (**UNVERIFIED**; Autopilot normally does not bill GKE-managed system workloads); (b) that
the free credit is not already consumed by another cluster on the billing account.

### 3.8 Suspend/resume vs delete on idle: decision

- Upstream `operatingMode: Suspended` **terminates the pod and keeps PVCs**
  (`api/v1beta1/sandbox_types.go`, `SandboxOperatingModeSuspended`; `controllers/sandbox_controller.go:555-592`).
  We have no PVCs, so for us suspend is the same as delete. **Decision: delete on idle.** agentd exits
  and the claim is GC'd.
- Google's "a few seconds with suspend/resume" comes from **GKE Pod snapshots**: gVisor checkpoint/restore
  of memory, file descriptors and rootfs to GCS, restored by creating a new claim from the same template
  (https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-pod-snapshots,
  https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots). Constraints found:
  whole-pod snapshots are unsupported on **E2** machine types, so Autopilot needs a custom ComputeClass;
  network connections are closed on restore (agentd already reconnects, `link.ts`); a restored pod
  carries the **old run's** id and token in memory, which conflicts with §3.5. It is the one lever that
  could bring T_answer under 5 s (pi already loaded), and it needs a protocol decision on resuming the same
  run versus starting a new one. **v2, separate spike.**

---

## 4. API-side client

### 4.1 Transport

- **No new dependency.** Use `google-auth-library` (already in `packages/api/package.json`, lazily
  imported the same way as `src/secrets.ts:119`) for an access token (scopes `cloud-platform` and
  `userinfo.email`: without the email scope GKE names the account by its numeric unique ID and RBAC's
  email subject never matches, per GKE's RBAC docs and #153), and global
  `fetch` against the cluster's **DNS endpoint** (a `*.gke.goog` host). Its certificate is expected to be
  publicly trusted, so no cluster CA handling (**UNVERIFIED**, S6). Fallback: read
  `masterAuth.clusterCaCertificate` from the clusters API and pass it to an undici `Agent`.
- Endpoint discovery: `GKE_ENDPOINT` if set. Otherwise one GET of
  `https://container.googleapis.com/v1/projects/{project}/locations/{location}/clusters/{cluster}`, reading
  `controlPlaneEndpointsConfig.dnsEndpointConfig.endpoint`, memoized per process.
- Why not `@kubernetes/client-node`: four REST verbs on three resources don't justify a large dependency
  tree, and a thin `KubeClientLike` is easy to stub (it mirrors `JobsClientLike` in `cloudrun.ts:34-44`).

```ts
// packages/api/src/providers/gke.ts
export interface GkeProviderConfig {
  project: string; location: string; cluster: string; namespace: string;
  warmPool: string; endpoint?: string; launchMode: "cold" | "warm"; maxActive: number;
}
export interface KubeClientLike {
  get<T>(path: string): Promise<T | null>;                 // null on 404
  create<T>(path: string, body: unknown): Promise<T>;      // throws KubeError { status } (409 surfaced)
  delete(path: string): Promise<void>;                     // Background propagation; 404 is success
  list<T>(path: string, labelSelector?: string): Promise<T[]>;
  patch(path: string, body: unknown): Promise<void>;       // application/merge-patch+json
}
export interface GkeProviderDeps { kube?: () => Promise<KubeClientLike>; now?: () => Date }
export class GkeProvider implements SandboxProvider { /* start, stop, status, capacity */ }
```

Paths:
- `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxclaims` and `.../sandboxclaims/{name}`
- `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxwarmpools/{name}`
- `/apis/agents.x-k8s.io/v1beta1/namespaces/{ns}/sandboxes/{name}`

### 4.2 Method mapping

| Method | GKE call | Details |
|---|---|---|
| `start(run)` | POST `sandboxclaims` (body per §3.5, cold or warm by `launchMode`) | First check a fresh count of non-exited managed claims against `maxActive` and throw `gke: max active sandboxes (N) reached`. That fails the run the way a Cloud Run error does (`runs.ts:76-83`), and Cloud Tasks retries the mail wake. **This check is a soft cap, not admission control**: it's a count-then-create with no lock between the two, so concurrent wakes racing the same instant can all pass it before any of their claims exist, landing a little over `maxActive` (review round 1, M1/L1). A 409 on the same name: GET it and return its handle (idempotent) unless the existing claim already has `deletionTimestamp` set (terminating, so it can't be adopted -- that's a real failure). Returns handle `gke:<ns>/run-<runId>` and `warm` from one best-effort GET right after create (`status.sandbox.name` set and Ready), else `undefined`; cold mode skips the GET entirely and reports `warm: false` deterministically, since claim env always forces a cold start. **Does not** wait for Ready, the same way `CloudRunProvider.start` returns as soon as the execution exists (`cloudrun.ts:84-112`). Any thrown error has the run's token redacted from its message first -- Kubernetes admission can echo the request body (which carries `RUN_TOKEN` in cold mode's claim env) back in a 4xx |
| `stop(handle)` | DELETE `sandboxclaims/{name}` | 404 means already gone, which is fine. An empty handle is a no-op (as `cloudrun.ts:137`) |
| `status(handle)` | GET `sandboxclaims/{name}` | mapping in §4.3 |
| `capacity()` | LIST `sandboxclaims` with `labelSelector=app.kubernetes.io/managed-by=outfitter`, plus GET `sandboxwarmpools/{pool}` | `active` = claims not `exited` by §4.3; `warmReady` = pool `status.readyReplicas`; `warmDesired` = pool `spec.replicas`; `limit` = `maxActive` |

The handle format is `gke:<namespace>/<claimName>`. It stays opaque to callers: only `GkeProvider`
parses it. Provider identity lives in `Run.sandboxProvider` (§2.4), not in the handle.

Every Kubernetes error response is reduced to its `Status` object's `code` and `reason` fields
(never `message` or `details`, which a server can echo request content into) plus a fixed, curated
hint per reason, before it reaches a caller (review round 1, M2) -- e.g. `gke: 403 Forbidden (the
api's service account may not perform this action)`, never the raw response body. Every `fetch`
call (including endpoint discovery, §4.1) carries a 15s `AbortSignal.timeout`, so a hung cluster or
metadata server can't wedge a wake or a reconcile tick (L2).

### 4.3 Status mapping

Condition types and reasons are from `api/v1beta1/sandbox_types.go` at v1.0.3. The claim mirrors the
Sandbox's `Ready` condition (see the claim's printcolumn on `.status.conditions[?(@.type=='Ready')]`).
It is **UNVERIFIED** whether the claim also mirrors `Finished`, so there is a fallback that reads the Sandbox.

| Observation | SandboxStatus | Reconciler effect (`runs.ts:132-137`) |
|---|---|---|
| Claim 404, or `metadata.deletionTimestamp` set | `exited` | stop (no-op), then fail the run if its heartbeat is stale |
| Claim `Ready=True` | `running` | normal stale handling |
| Claim `Ready=False` with reason `PodSucceeded`, `PodFailed`, `ClaimExpired` or `SandboxSuspended` | `exited` | as the first row |
| `status.sandbox.name` set, claim not Ready, Sandbox (fallback GET) has `Finished=True` | `exited` | as the first row |
| No `status.sandbox.name` yet, or `Ready=False` with any other reason (`DependenciesNotReady`, `AdoptionConflict`, scheduling), and `metadata.creationTimestamp` is within `START_DEADLINE_MS` (10 min, `gke.ts`) | `starting` | **skipped**, like a cold Cloud Run execution |
| Same as the row above, but `metadata.creationTimestamp` is older than `START_DEADLINE_MS` | `unknown` | not skipped: stop (no-op) then fail the run, same as a status() error. **Review round 1, M4**: without this, a claim stuck `Ready=False` for a reason that never resolves on its own (`ImagePullBackOff`, unschedulable, a persistent `AdoptionConflict`) would report `starting` forever -- the reconciler skips that state outright, so the run would never fail, the claim would hold a `GKE_MAX_ACTIVE` slot, and the session's wakes would stay blocked until the claim's 24h `shutdownTime` |
| 401, 403, 5xx or a network error | throw | `runs.ts` turns it into `unknown` |

`provisioningGraceMs` (default 10 min, `config.ts:202`) stays as it is. GKE cold starts should be far
below it. `START_DEADLINE_MS` above is the same 10 minutes by default, chosen independently of
`provisioningGraceMs` (`status()` has no access to the run's `createdAt`, only the claim's own
`creationTimestamp`, which are close but not identical); S4's worst observed cold start (a brand new
node, first pull ever) was 145s, well under it.

### 4.4 Wiring

- `providers/registry.ts`: the `gke` factory lazy-imports `./gke.ts` and builds a `GkeProvider` from config.
- `routes/hooks.ts` (the warm-pool hook) imports `gke.ts` **statically**, unlike `registry.ts` --
  it needs the real `GkeProvider`/`KubeError`/`GkeEndpointError` exports to tell the provider and
  its error types apart, so a lazy import there would only move the same module-load cost to first
  request instead of avoiding it. `google-auth-library` itself stays lazy either way: importing
  `gke.ts` never imports it, only calling into `GkeProvider`'s methods does.
- `server.ts`: `sandboxCapacity` is the default provider's `capacity`, if it has one.
- `deploy/service.sh`: add `GKE_CLUSTER`, `GKE_LOCATION`, `GKE_NAMESPACE`, `GKE_WARM_POOL`,
  `GKE_LAUNCH_MODE` and `GKE_MAX_ACTIVE` to `ENV_VARS` **only when** `GKE_CLUSTER` is set in the caller's
  env or already set on the service (the same "survive a plain redeploy" pattern as `TASKS_SA_EMAIL`,
  `service.sh:137-150`). `SANDBOX_PROVIDER` becomes the caller's value, else the service's current
  value, else `cloudrun`.

---

## 5. Deploy scripts

Match the existing style: `#!/usr/bin/env bash`, `set -euo pipefail`, `source env.sh` (which pins
project, account and region, `deploy/env.sh:8-24`), idempotent describe-then-create, a header comment
that says "DOES NOT RUN ON ITS OWN" and gives the exact invocation, and `echo "== ... =="` step banners.
Kubernetes objects are applied with `kubectl apply --server-side`, which is idempotent by construction,
after `gcloud container clusters get-credentials outfitter --location us-central1 --dns-endpoint`.
YAML lives in `outfitter/deploy/gke/*.yaml` with `${VARS}` filled in by `envsubst`.

### 5.1 New scripts

| Script | Does | Idempotency |
|---|---|---|
| `deploy/gke-cluster.sh` | enables `container.googleapis.com` and `containerfilesystem.googleapis.com`; `gcloud beta container clusters create-auto outfitter --location=us-central1 --release-channel=${GKE_CHANNEL:-regular} --enable-agent-sandbox --enable-dns-access`, plus `--cluster-version` if the channel is below 1.36.3, plus a maintenance window outside active hours | `clusters describe` first; if it exists, `clusters update --enable-agent-sandbox` (a no-op when already on) |
| `deploy/gke-iam.sh` | namespace and KSA (kubectl); the WI binding `roles/iam.workloadIdentityUser` on `outfitter-agent@` for `PROJECT.svc.id.goog[outfitter-sandboxes/outfitter-agent]`; the API grants (§3.2); the RBAC Role and RoleBinding | `add-iam-policy-binding` and `kubectl apply` are idempotent |
| `deploy/gke-template.sh` | resolves the image (see §5.2), renders and applies `SandboxTemplate` and `SandboxWarmPool` (preserving the pool's current `replicas`) | `kubectl apply --server-side` |
| `deploy/gke-schedule.sh` | Cloud Scheduler jobs `outfitter-warm-up` and `outfitter-warm-down` (§5.3) | `scheduler jobs describe` first, then `update http` if present |
| `deploy/gke-switch.sh cloudrun or gke [--check]` | `--check` prints active runs per `sandboxProvider` (new operator-only `GET /api/operator/runs?active=1`, PR5). Without `--check`, re-runs `api.sh` and `link.sh` with `SANDBOX_PROVIDER` set | a pure redeploy |
| `deploy/gke-teardown.sh` | scales the pool to 0, waits for claims to drain (or `--force`), deletes the scheduler jobs, deletes the cluster, removes the IAM bindings. **Refuses** while any active run has `sandboxProvider=gke`, unless `--force` | each step skips if already absent |

There is **no** `deploy-all.sh` in this repo; the only deploy scripts are `agent-job.sh`, `api.sh`,
`baseline.sh`, `env.sh`, `landing.sh`, `link.sh`, `mailbox.sh` and `service.sh`. The order is documented in
`deploy/README.md` (baseline, api, link, agent-job, mailbox). Add a "GKE provider (optional)" section
there: gke-cluster, gke-iam, gke-template, gke-schedule, then `gke-switch.sh gke`. If someone later
adds a `deploy-all.sh`, it must run the GKE steps only when `GKE_CLUSTER` is set.

### 5.2 Relationship to `agent-job.sh`

Both providers run the **same image tag**. Extract the Cloud Build block of `agent-job.sh:19-40` into
`deploy/build-agent-image.sh`, which prints `IMAGE`; `agent-job.sh` calls it, with no behaviour change.
`gke-template.sh` either builds through it or, with `--image-from-job`, reads the Cloud Run job's current
image (`gcloud run jobs describe outfitter-agent` with a format of
`value(spec.template.spec.template.spec.containers[0].image)`), so the two stay in lockstep without a
rebuild. After every image rebuild both scripts must run, or GKE keeps serving the old tag.
`updateStrategy: Recreate` then replaces idle warm pods.

### 5.3 Cost guardrails

1. **Scheduled warm pool.** Two Cloud Scheduler HTTP jobs call a new link-role hook
   `POST /api/hooks/warm-pool {replicas}`. It is authenticated exactly like `/api/hooks/tick` (an OIDC token
   as `TASKS_SA_EMAIL`, `protocol.md:189-196`). The API patches the pool's `spec.replicas` using its RBAC
   `patch`. This reuses the existing scheduler SA and hook-auth code, and keeps the API the only thing
   that talks to the cluster. Defaults: `WARM_UP_CRON="0 8 * * 1-5"`, `WARM_DOWN_CRON="0 20 * * 1-5"`,
   `WARM_TZ="Europe/Zagreb"` (**owner to confirm**), `WARM_REPLICAS=1`.
2. **Soft cap** `GKE_MAX_ACTIVE` (default 3), enforced in `start()` (count-then-create, no lock
   between the two -- see §4.2's note under `start(run)`; a cost guardrail, not admission control).
3. **Pool ceiling**: the hook clamps `replicas` to 0..2. Going higher needs a code change.
4. **24 h `shutdownTime`** and **`ttlSecondsAfterFinished: 120`** on every claim, so nothing lingers.
5. **Budget**: the existing $25 alert (`baseline.sh:134-152`). `gke-cluster.sh` prints the §3.7 table and
   refuses (without `--i-know`) if another GKE cluster already exists on the billing account, because the
   credit covers only one.
6. **Kill switch**: `gke-switch.sh cloudrun`, then patch the pool to `replicas: 0`.

---

## 6. Testing

### 6.1 Unit tests: `packages/api/test/gke.test.ts` (mirrors `test/cloudrun.test.ts`)

Stub `KubeClientLike` in memory: no credentials, no network. Cases:
1. `start`, cold: POSTs a claim named `run-<id>` with `warmPoolRef`, `lifecycle` (shutdownTime = now + 24 h
   from the injected clock, `Delete`, TTL 120), `spec.env` with RUN_ID, RUN_TOKEN and OUTFITTER_API, and
   **no** `additionalPodMetadata`. The handle is `gke:outfitter-sandboxes/run-<id>`.
2. `start`, warm: the same claim with the three `outfitter.dev/*` annotations and **no** `spec.env`. This
   guards against the warm path silently turning cold.
3. `start` on a 409: returns the existing claim's handle and does not throw, unless the existing
   claim has `deletionTimestamp` set, in which case it rethrows (review round 1, L5).
4. `start` at `maxActive`: throws, and no POST is made.
5. `status`: one test per row of §4.3, including the Sandbox `Finished` fallback, the
   `START_DEADLINE_MS` cutover to `unknown` (M4), and error-throws (403 and 5xx must throw, never
   silently report `exited`).
6. `stop`: DELETE on the right path; a 404 is swallowed; an empty handle is a no-op.
7. `capacity`: counts only non-exited managed claims; reads the pool's `replicas` and `readyReplicas`.
8. The run token never appears in a thrown error message -- driven through a real error path (a
   stubbed 4xx response whose body contains the token), not just the (token-free) max-active case
   (review round 1, M2/M3).
9. M1: a failed `kube()` build is not cached -- the first call rejects, the second (retried) call
   succeeds against a working stub.
10. The 409 branch's follow-up GET returning `null` (the claim vanished between the 409 and the
    GET) rethrows rather than returning a handle for a claim that isn't there.

Plus `test/registry.test.ts`: lazy construction; getting an unconfigured provider throws;
`providerNameFor` legacy inference; and a `RunManager` with two `NoopProvider`s that stops a `cloudrun`
run after the default has switched to `gke`. `runs.test.ts` and `stop.test.ts` pass unmodified.

agentd (PR4): `test/assignment.test.ts`. Env wins. The dir path waits until both files are non-empty
(fake `readFile` and clock). An empty `api` file falls back to env. No dir and no env throws today's
error. The token is registered as a logger secret.

### 6.2 Provider contract suite (recommended: extract one)

New `packages/provider-local/test/contract.ts` exports
`runProviderContract(name, makeProvider)`, where `makeProvider` returns `{ provider, world }`. `world`
is a fake that lets the suite move a sandbox through started, running and "agent exited by itself".
Every provider's test file calls it.

| # | Contract |
|---|---|
| C1 | `start` resolves a non-empty string handle and delivers `runId`, `runToken` and `apiOrigin` to the sandbox by some channel |
| C2 | `status` of a freshly started handle is `starting` or `running`, never `exited` |
| C3 | once the agent exits by itself, `status` becomes `exited` (eventually, under the fake clock) |
| C4 | `stop` is idempotent: calling it twice, or on an already-exited handle, resolves |
| C5 | `status("")` and `stop("")` don't throw (the empty-handle guard in `cloudrun.ts:137,143`) |
| C6 | `status` of an unknown handle is `exited` or `unknown` and does not throw on "not found" |
| C7 | `capacity`, if present, returns `active >= 0` and counts a started, not-yet-exited sandbox |
| C8 | the run token does not appear in the handle |

Adapters: `inprocess` (a real child process running a tiny script), `docker` (skipped when there is no
docker binary), `cloudrun` (the existing stubs from `cloudrun.test.ts`; C3 is modelled by the stub
setting `completionTime`), `gke` (the §6.1 stub) and `NoopProvider` as a sanity check.

Known wrinkle: C6 on Cloud Run today throws on a 404 from `getExecution`, and the reconciler turns that
into `unknown`. Either relax C6 to "throws or returns exited/unknown", or make `CloudRunProvider.status`
map NOT_FOUND to `exited`. The second is the better behaviour; do it in PR1 with its own test.

### 6.3 End-to-end wake benchmark (comparable to E2.9)

`outfitter/deploy/wake-bench.mjs` (added by the startup-trim PR; extend it with a provider label).
- Input: `OUTFITTER_API` (the web origin) and `OUTFITTER_TOKEN` (a personal API token,
  `protocol.md:201-216`); `--session <id>` (an existing repo-less session) or `--create`; `--n 10`;
  `--label cloudrun|gke-warm|gke-cold`.
- Loop: make sure the session is stopped; `POST /wake` (t0); read the SSE stream
  (`GET /api/sessions/:id/stream`) and record `status` frames (t_provisioning, t_running); `POST /messages`
  with "reply with the single word ok"; wait for the first assistant `entry` (t_answer); `POST /stop`;
  wait for `stopped`.
- T_hello comes from logs, not SSE. The link role logs `hello accepted` with the runId (add that line in
  PR5 if it's missing), and agentd logs `startup:` phases with `elapsedMs` (`agentd/src/main.ts:57-58`).
  The script reads both with `gcloud logging read`, for both resource types.
- Output: one CSV row per wake plus the median and p90 per label, appended to `docs/reports/wake-bench.md`.
- Run matrix: `cloudrun` x10, `gke-cold` x10 (`replicas: 0`), `gke-warm` x10 (`replicas: 1`, 60 s between
  wakes so the pool can refill). Same session, same guru, same hour of day.

---

## 7. Rollout plan (independently mergeable PRs)

Legend: **[independent]** = no agentd or link-protocol changes; can merge at any time.
**[rebase: cloud-fixes]** = touches agentd, so it must rebase on the in-flight "cloud fixes" PR, which
adds a protocol version to `hello` and changes `agentd/src/run.ts` and `link.ts`.

| PR | Scope | Touches | Acceptance criteria |
|---|---|---|---|
| **PR0: spike** (not merged) | §8.2, one day | infra only | `docs/reports/gke-spike.md` answers S0-S6 with numbers; go/no-go recorded |
| **PR1: contract, selection, provider recorded on the run** [independent] | `provider-local/src/types.ts` (optional `capacity`, `SandboxStartResult`); `providers/registry.ts`; `providers/index.ts` wrapper; `config.ts` (`gke` in the enum, `GKE_*` fields, `isCloudProvider`, boot check); `Run.sandboxProvider`; `runs.ts` (registry, `providerNameFor`); generic capacity row in `server.ts` and `providers-status.ts`; `CloudRunProvider.capacity` and NOT_FOUND mapped to `exited`; the contract suite (§6.2) for inprocess, docker, cloudrun and noop; `service.sh` passes `SANDBOX_PROVIDER` through | api, provider-local, deploy | existing tests unchanged and green; new registry and contract tests green; a deployed Cloud Run run gets `sandboxProvider: "cloudrun"`; Peripherals still shows the Cloud Run row with the same count; `SANDBOX_PROVIDER=gke` without `GKE_CLUSTER` fails at boot with a clear message |
| **PR2: GkeProvider behind the flag, cold mode** [independent] | `providers/gke.ts`; `test/gke.test.ts`; contract adapter; registry entry; `/api/hooks/warm-pool` handler; `deploy/gke/*.yaml` checked in (not applied) | api | unit and contract tests green. Against the spike's cluster with `SANDBOX_PROVIDER=gke GKE_LAUNCH_MODE=cold`: wake, `running`, prompt answered, idle-stop, claim GC'd within the TTL. `/stop` during provisioning and during running both leave no claim. The reconciler fails a stale GKE run and deletes its claim |
| **PR3: infra scripts** [independent] | `deploy/gke-*.sh`; `deploy/build-agent-image.sh` extraction; README section; teardown | deploy | each script runs twice with no changes on the second run; `gke-teardown.sh` leaves no cluster, bindings or scheduler jobs; `shellcheck` clean; `agent-job.sh` output is unchanged |
| **PR4: warm assignment in agentd** [rebase: cloud-fixes] | `agentd/src/assignment.ts`; `agentd/src/main.ts` uses it; tests; image rebuild. **No** `hello` or frame changes | agentd, image | Cloud Run, docker and inprocess behave identically (env path). On GKE with `GKE_LAUNCH_MODE=warm` and `replicas: 1`, T_hello p50 is at most 3 s over 10 wakes. A warm pod that is never claimed stays up without exiting or dialling out. The token is absent from all logs (checked in Cloud Logging) |
| **PR5: benchmark and default switch** [independent; needs PR2-PR4 deployed] | `deploy/wake-bench.mjs` (added by the startup-trim PR; extend it); the `hello accepted` log line; `docs/reports/wake-bench.md` with the three-way matrix; `GET /api/operator/runs?active=1`; `gke-switch.sh --check`; scheduler enabled; EPIC.md E7 updated; `deploy/README.md` default flipped | api, scripts, docs | GKE meets the §1 targets, or the PR records why not. The first week's billing is within 30 % of §3.7. The switch is done with `gke-switch.sh gke`, in-flight Cloud Run runs stop cleanly afterwards, and the reverse switch is tested once |
| PR6 (optional): per-Tape provider [independent] | `Guru.sandboxProvider?`; validation in `routes/gurus.ts`; a select on the Tape form | api, web | a Tape pinned to `cloudrun` wakes on Cloud Run while the default is `gke` |
| v2 (not scheduled): pod snapshots | §3.8 | agentd and link protocol [rebase: cloud-fixes or its successor] | separate spec |

Ordering: PR1 and PR3 can go in parallel with the spike. PR2 waits for S3 (identity) and S6 (API
auth). PR4 waits for S1 (downward-API latency) and for cloud-fixes to merge. PR5 waits for PR2-PR4 to be deployed.

---

## 8. Risks, open questions, spike

### 8.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent Sandbox maturity (GA around May 2026 per the startup report; upstream `v1.0.3` from 2026-09-17; the API is still `v1beta1`) | medium | CRD or field churn breaks `gke.ts` | The controller version is pinned by the GKE version. Keep every CRD path and field in constants in `gke.ts`. The contract suite catches drift. Cloud Run stays one config flip away |
| gVisor compatibility (node 24, git, ripgrep, gh, pi's extensions, the setuid drop to `agent` in `run-as-user.ts`) | medium | agentd or pi fails, or file-heavy work (clone, restore) is slower | Spike S2 runs the image's CI smoke under gVisor (pi starts as `agent` and every extension loads; the EPIC CI note) and times a real clone and restore against E2.9's 13 s |
| Image streaming ineffective under gVisor (**UNVERIFIED**; the docs don't say) | medium | cold T_hello far above 20 s | S4 measures cold starts. The warm pool hides it during active hours anyway |
| Downward-API refresh latency under gVisor (§3.5) | medium | warm T_hello above target | S1. Fallback: cold mode only, or B-prime |
| The WI identity token doesn't carry the GSA `email` | low | `verifyAgentToken` rejects every GKE sandbox | S3 before PR2 |
| Our custom network policy is wrong for Dataplane V2's metadata path | medium | no ID token, so agentd can't connect | S3 tests both 169.254.169.254:80 and 169.254.169.252:988 |
| Autopilot minimums or compute class | low | the 1 vCPU / 2 GiB shape is rounded up | S5 reads the billed pod resources |
| Cluster auto-upgrades evict running sandboxes | medium | a run gets SIGTERM mid-turn, checkpoints and exits (same as a Cloud Run cancel); the next message re-wakes it | Maintenance window outside active hours. The `safe-to-evict: "false"` annotation (**UNVERIFIED** how far Autopilot honours it) |
| The free credit is already used by another cluster on the billing account | low | +$73/month, over budget | `gke-cluster.sh` checks and refuses without `--i-know` |
| API to cluster auth from Cloud Run (DNS endpoint, IAM role) | low | wakes fail | S6 |
| Two providers to maintain | certain | ongoing cost | The contract suite. Cloud Run remains the fallback, and possibly the home of heavy Tapes (PR6) |

### 8.2 One-day spike (before PR2)

Use the real project. The cluster is the long-lived artifact: keep it if the spike passes, and run
`gke-teardown.sh` if it doesn't.

| # | Question | How | Pass |
|---|---|---|---|
| S0 | Can this billing account create the cluster with Agent Sandbox? | draft `gke-cluster.sh` | cluster Ready; `kubectl get crd` lists the `agents.x-k8s.io` CRDs |
| S1 | Downward-API annotation to file latency under gVisor | a warm pool of 1 running a busybox loop that prints `/etc/outfitter/assignment/run-id` with timestamps every 50 ms; create a claim with `additionalPodMetadata.annotations`; measure claim-create to non-empty file, 20 times | p90 at most 2 s |
| S2 | The real image under gVisor | the §3.3 template, a cold claim with `RUN_ID`/`RUN_TOKEN` env against the **deployed link** (run the API locally with `SANDBOX_PROVIDER=gke` pointed at Atlas, and `POST /wake` on a dev session). Watch agentd's `startup:` phases, the clone, the restore, pi's extensions | reaches `idle`, answers one prompt, idle-stops, pod `Succeeded`; restore plus pi load within 1.5x the Cloud Run times |
| S3 | Identity and network | inside the sandbox, fetch `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=<link origin>&format=full` with header `Metadata-Flavor: Google`; decode `email` | email is `outfitter-agent@...`; the link accepts the hello |
| S4 | Cold start with image streaming | 10 cold claims (`replicas: 0`); claim-create to container-started from pod events | p50 at most 20 s |
| S5 | Cost reality | pod requests after Autopilot's mutation (`kubectl get pod -o yaml`), and the billing SKUs the next day | matches the §3.7 inputs |
| S6 | API to cluster auth | a one-off Cloud Run job running as `outfitter-api@` gets a token and GETs the claims list on the DNS endpoint | 200 with only the RBAC Role; no CA handling needed |

Go/no-go: S2, S3 and S6 must pass for PR2. S1 decides PR4 (warm) versus cold-only. S4 decides
whether cold mode is good enough outside active hours.

---

## 9. Open questions for the owner

1. **Warm hours and time zone**: weekdays 08:00-20:00 `Europe/Zagreb` (about $14/month warm), a narrower
   window, or cold-only ($0 warm, about 20 s cold T_hello if S4 passes)?
2. **Spot for the warm pool?** It saves about $8-10/month on the default schedule, but a claimed Spot pod
   can be preempted mid-session (it checkpoints on SIGTERM, like a stop). Recommendation: on-demand for v1.
3. **Run token in pod annotations (warm Option B)**: acceptable? Its exposure matches today's Cloud Run
   `containerOverrides` env (readable by project principals who can read the resource). The alternative
   without annotations is cold-only.
4. **Keep Cloud Run as a permanent second provider** for heavy Tapes (PR6), or retire it after a month on GKE?
5. **`GKE_MAX_ACTIVE` = 3**: does that match the expected burst ("bursts to 3" in the startup report)?
6. **Release channel**: accept `rapid` if `regular` doesn't have 1.36.3 yet?
7. **v2 pod snapshots**: worth a spike once v1 ships? It is the only route to T_answer under 5 s, and it
   needs a protocol decision on resuming the same run versus a new one.

---

## References

Repo (commit `d545d5c`):
- `outfitter/packages/provider-local/src/types.ts:4-32`: the contract
- `outfitter/packages/api/src/providers/index.ts:15-48`, `providers/cloudrun.ts:84-169`: selection and the Cloud Run provider
- `outfitter/packages/api/src/runs.ts:32-170`: wake, stop, reconcile
- `outfitter/packages/api/src/config.ts:4,104,146-165,169-181,191-192`: provider enum, `sandboxOrigin`, startup checks
- `outfitter/packages/api/src/server.ts:66-83`, `providers-status.ts:306-323`: capacity probe
- `outfitter/packages/api/src/store/types.ts:62-73,229`: `Run.providerHandle`, `ProviderKind`
- `outfitter/packages/api/src/agentlink.ts:275-330,621-637`: hello and runToken check, `bye`
- `outfitter/packages/api/src/auth.ts:141-155`: `verifyAgentToken` email check
- `outfitter/packages/agentd/src/main.ts:47-137`, `auth.ts:23-54`, `link.ts:20-29,112`: env, ID token, close codes, unspec timeout
- `outfitter/image/Dockerfile:155-202`: `PI_RUN_AS_USER`, root entrypoint
- `outfitter/deploy/env.sh`, `agent-job.sh`, `baseline.sh`, `service.sh:131-150`: deploy style, service accounts, env handling
- `outfitter/docs/protocol.md:22-64,189-196,239-254`: link auth, run token, close codes, hooks, state machine
- `outfitter/EPIC.md:62-129,259-270,529-537`: decisions, cost model, E2.9, E7

Google and upstream (fetched 2026-09-22):
- https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox (CRDs, default network posture, WI note)
- https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox (`--enable-agent-sandbox`, Autopilot needs a region, version 1.36.3-gke.1767000 or later, no extra charge)
- https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox (warm pools under 1 s, default deny)
- https://github.com/kubernetes-sigs/agent-sandbox at `v1.0.3`: `extensions/api/v1beta1/sandboxclaim_types.go` (env forces a cold start, `additionalPodMetadata`, `lifecycle`), `sandboxtemplate_types.go` (`envVarsInjectionPolicy`, `networkPolicy`), `sandboxwarmpool_types.go` (`replicas`, `updateStrategy`), `api/v1beta1/sandbox_types.go` (`operatingMode`, conditions), `extensions/controllers/sandboxclaim_controller.go`, `controllers/sandbox_controller.go`
- https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-pod-snapshots and https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots
- https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods (gVisor on Autopilot from 1.27.4-gke.800; metadata blocked without WI)
- https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming (on by default for Autopilot; Artifact Registry; Container File System API)
- https://cloud.google.com/kubernetes-engine/pricing (fee and free credit; confirmed through a search summary because the page did not render in full)
- https://cloud.google.com/blog/products/containers-kubernetes/new-dns-based-endpoint-for-the-gke-control-plane (`container.clusters.connect`)
- Secondary sources, rates UNVERIFIED: https://www.cloudzero.com/blog/gke-pricing/, https://scaleops.com/blog/gke-cost-optimization/
