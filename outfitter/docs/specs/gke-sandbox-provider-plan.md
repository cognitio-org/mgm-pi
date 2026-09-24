# Plan: building the GKE Agent Sandbox provider

Status: planning (2026-09-24), at `main` `1e21c9f`. Companion to `gke-sandbox-provider.md` (the
spec, written at `d545d5c`). The spec's design stands. This file records the owner's answers, what
has moved on `main` since the spec, and the revised order of work. Where the two disagree, this file
wins until the spec is amended (§6).

---

## 1. Owner decisions (2026-09-24)

| Spec §9 question | Decision | Consequence |
|---|---|---|
| 1. Warm hours | **Weekdays 08:00-20:00 `Europe/Zagreb`** | PR4 (warm assignment) is in v1. Warm cost about $14/month (spec §3.7) |
| 2. Spot for the warm pool | **On-demand for v1** | No mid-session preemption. Spot can be revisited once billing is known |
| 4. Keep Cloud Run | **Decide after PR5** | Both providers stay configured through PR5. The registry (PR1) and the contract suite are required, not optional |
| First step | **Spike and PR1 in parallel** | PR1 is code-only with no cloud spend. The spike waits for the owner to run `gke-cluster.sh` |

Two more decisions followed the spike's admission findings (`docs/reports/gke-spike.md`, 2026-09-24):

| Question | Decision | Consequence |
|---|---|---|
| GKE's `sandbox-hardening-policy` (drop ALL, no added caps, `runAsNonRoot`) rejects the image's root entrypoint, which the root/`agent` split from #45 needs | **Exempt only the sandbox namespace**: the binding's `matchResources` excludes `outfitter-sandboxes` and stays `Deny` everywhere else | The image is unchanged. The model still runs as `agent` with no capabilities under gVisor. PR3's `gke-iam.sh` re-applies the exemption on every run, because a GKE upgrade could restore the binding. `deploy/gke/hardening-exemption.json` appends, so the script must check the `NotIn` list first and patch only when the namespace is missing (`kubectl patch validatingadmissionpolicybinding sandbox-hardening-binding --type=json --patch-file=...`) |
| The per-uid metadata block is impossible on Autopilot (Warden rejects `NET_ADMIN`). Should the model's shell reach the metadata server? | **B: keep it reachable, as on Cloud Run today, with a guard** | The spec's link authentication (Google ID token plus run token) stays. The template's network policy must allow the metadata server, which Agent Sandbox blocks by default. New guard: a check that fails if `outfitter-agent@` holds any role beyond `roles/logging.logWriter`, because that account's permissions are the model's permissions. #41 finding 3 stays open on both providers |

Question 6 (release channel) is resolved without `rapid`: on 2026-09-24 `regular` defaulted to
1.35.8-gke.1036000 but listed 1.36.3-gke.1767000 and 1.36.4-gke.1082000 as valid, so `gke-cluster.sh`
stays on `regular` and pins the channel's newest valid version (spec §5.1). It refuses only if the
channel offers nothing at 1.36.3-gke.1767000 or later.

Still open: 3 (run token in pod annotations, needed by PR4 and still recommended), 5
(`GKE_MAX_ACTIVE=3`), 7 (v2 pod snapshots). None of these block PR1 or the spike.

---

## 2. What changed on `main` since the spec

Unchanged at HEAD: `provider-local/src/*`, `api/src/providers/index.ts`, `providers/cloudrun.ts`,
`providers-status.ts`, `agentd/src/auth.ts` and `api/test/cloudrun.test.ts`. The contract (§2.1-§2.3)
and the API client (§4) still hold. About 25 line citations have moved. PR1 fixes them as it touches
each file (§6).

These changes affect the plan:

| Change on `main` | Impact |
|---|---|
| **Cloud fixes (#35) had already merged** (`b5ae821`). `hello` carries `protocolVersion`, and link refuses old agents with 4409 (`api/src/agentlink.ts:447-466`) | PR4 is no longer blocked. **New constraint:** a warm pod built from an older image is refused by a newer link, and 4409 is terminal. The template and warm pool must move to the new image **in `release.sh`, between the Job and link** (`deploy/release.sh:117-119`), not in a separate script someone forgets to run |
| **Release-tag deploys (#34)** and `deploy/CLAUDE.md` | Spec §5 is out of date. Settings go in `deploy/config.env`, not the caller's env. `service.sh:153` hard-codes `SANDBOX_PROVIDER=cloudrun`, so read it from `config.env` instead. Cluster, IAM and scheduler setup are **owner-run one-time scripts** (like `access.sh`). `gke-switch.sh` becomes "edit `config.env`, tag a release", not "rerun `api.sh`" |
| **`agent-job.sh` builds by commit tag** (`TAG=$(commit_tag)`, `image_exists` reuse) | Spec §5.2's `build-agent-image.sh` extraction and `--image-from-job` aren't needed. The template uses `outfitter-agent:$(commit_tag)` |
| **Token isolation (#45)**: pi and git must never see `RUN_TOKEN`/`RUN_ID`/`OUTFITTER_API` (`agentd/src/pi.ts:109-156`, `main.ts:52-53`) | Spec §3.5 Option B still fits (root-only 0400 files). `assignment.ts` must keep the values in memory, never write them to `process.env` (git children inherit it), and delete them from the environment on the env path |
| **Security review of #41, finding 3 (open)**: block the `agent` uid from the metadata server (`docs/reports/security-review-pr41.md:125-148`) | Handed explicitly to this provider, which was to add an init container with `NET_ADMIN` running `iptables ... -m owner --uid-owner agent -j REJECT`. **Superseded:** spike S7 found Autopilot rejects `NET_ADMIN`, and the owner chose option B (§1). The finding stays open |
| **Startup trim (#37)**: jiti and compile caches baked into `/tmp` (`image/Dockerfile:234-244`); `wake-bench.mjs` exists | The template must **not** mount an `emptyDir` over `/tmp` or `/run/outfitter`, or set `TMPDIR`. PR5 extends `wake-bench.mjs` (it has positional args, JSON output and a hard-coded `cloud_run_job` log query) and doesn't write a new one |
| **Failure details (#54)**: runs carry a user-facing `statusDetail` | A GKE start refusal (`GKE_MAX_ACTIVE`) sets `statusDetail`, not only `reason` |
| Git proxy (#104), browser share (#81/#105) | No new ingress or egress. The proxy is loopback-only; capture arrives on the existing socket |
| CI deployer `outfitter-deployer` has no `container.*` role | If `release.sh` updates the template (above), `ci-setup.sh` needs `container.clusterViewer` plus a namespaced Role for `get` and `patch` on `sandboxtemplates` and `sandboxwarmpools`. Owner-run |
| `provider-local` exports only `dist/src/index.js` | The contract suite (spec §6.2) must live in `provider-local/src/testing/` and be exported, or `api` tests can't import it |
| New `hello` frames need `protocolVersion: 1` | Every fake agent in new tests sends it |
| Nothing in `EPIC.md` tracks this | Add a story (E2.10 or E7.x) in PR1. E7 still lists `gce-spot` and `cloudrun-workerpool` |

---

## 3. Revised sequence

```
spike (owner runs gke-cluster.sh) ──┬── S3, S6, S7 ──> PR2 (GkeProvider, cold) ──┐
                                    └── S1 ─────────> PR4 (warm, agentd) ────────┤
PR1 (contract + registry) ──────────────────────────> PR2                        ├─> PR5 (bench, switch)
PR3 (template in release.sh, schedule, IAM) ─────────────────────────────────────┘
```

| PR | Scope (changes from spec §7 in **bold**) | Blocked by |
|---|---|---|
| **PR0 spike** | spec §8.2 S0-S6 **plus S7** (§4 below). Writes `docs/reports/gke-spike.md` | owner runs `gke-cluster.sh` |
| **PR1** | spec §7 PR1, **plus**: `SANDBOX_PROVIDER` read from `config.env`; the contract suite exported from `provider-local/src/testing/`; `statusDetail` on start refusals; the `gke` fields in `/api/operator/settings` (`routes/operator.ts:124-125`); an EPIC story; spec citations refreshed | nothing |
| **PR2** | spec §7 PR2, **plus** the template's network policy with the DNS fix from S3, and the `logWriter`-only guard on `outfitter-agent@` (option B, §1) | PR1; S2, S6 (S3 passed) |
| **PR3** | **Owner-run** `gke-cluster.sh` (drafted here), `gke-iam.sh`, `gke-schedule.sh` (modelled on `mailbox.sh`: `--update-headers`, OIDC audience = link's origin); **a `release.sh` step that applies the template and warm pool between the Job and link**; `check_deploy_skew` reads the template's `build-commit` label; the `ci-setup.sh` grants; `gke-teardown.sh`; guard tests in `deploy/test/` | can start with PR1; the `release.sh` step lands with or after PR2 |
| **PR4** | spec §7 PR4. Its "[rebase: cloud-fixes]" dependency is resolved; the constraint becomes **keeping `WIRE_PROTOCOL_VERSION` in lockstep**. `assignment.ts` follows #45's in-memory rule. Run `preloadSessionManager()` before the assignment wait | S1; question 3 answered |
| **PR5** | spec §7 PR5, **plus**: extend `wake-bench.mjs` (`--label`, `k8s_container` log query); add the `hello accepted` log line; the switch is a `config.env` change plus a release. **Then decide Cloud Run's future** (§1) | PR2-PR4 deployed |
| PR6 | per-Tape provider (optional), unchanged | PR5 decision |

---

## 4. Spike runbook (PR0)

Owner steps are marked **[owner]**. Everything else an agent can do once the cluster exists, working
on a branch; nothing here deploys.

0. **[owner]** `gcloud auth login mgm@mgms.eu` (the saved credentials had expired on 2026-09-24).
1. **[owner]** `cd outfitter/deploy && DRY_RUN=1 ./gke-cluster.sh`. It lists any other GKE cluster on
   billing account `01DEC0-9358E1-C1FF0D` (the free credit covers one), checks the channel version,
   and prints the create command. Read-only.
2. **[owner]** `./gke-cluster.sh` creates the cluster, then checks the Agent Sandbox CRDs. This is **S0**.
   Billing starts here: $0 cluster fee if the credit applies; pods are billed only while running.
3. S1-S6 as spec §8.2, with these adjustments:
   - **S2** runs the API locally against Atlas with `SANDBOX_PROVIDER=gke`, using a throwaway
     `gke.ts` prototype from the spike branch (not PR2's). `OUTFITTER_API` is link's custom domain
     (`deployed_origin outfitter-link`), which must be in `tokenAudiences`.
   - **S3** decodes the identity token **inside the pod**. A WI failure is refused with 4401 before the
     run is proven, so it only shows up API-side as "no heartbeat".
4. **S7 (new): metadata block under gVisor on Autopilot.** Does Autopilot admit an init container with
   `NET_ADMIN`? Does gVisor's netstack support `iptables -m owner --uid-owner`? Pass: as `agent`,
   `curl -H 'Metadata-Flavor: Google' http://169.254.169.254/...` is refused; as root, agentd still gets
   its ID token. If either fails, record it in the report. **Result (2026-09-24):** Autopilot's Warden
   rejects `NET_ADMIN`, so the block is impossible here; the owner chose option B (§1), and finding 3
   stays open.
5. Write `docs/reports/gke-spike.md` with numbers for S0-S7 and a go/no-go per spec §8.2: S2, S3 and S6
   gate PR2; S1 gates PR4; S4 decides whether cold mode is good enough outside 08:00-20:00.
6. **Keep the cluster** if the spike passes (it's the long-lived one). Otherwise delete it with
   `gcloud container clusters delete outfitter --location=us-central1 --project=outfitter-509211
   --account=mgm@mgms.eu` (or `gke-teardown.sh` once it exists).

---

## 5. PR1 work breakdown

Code-only. No GCP calls, no deploy. Each item has a test.

1. **`provider-local/src/types.ts`**: optional `capacity?()`, `SandboxCapacity` and `SandboxStartResult`
   (spec §2.3). A structural superset, so the existing providers compile unchanged.
2. **Contract suite**: `provider-local/src/testing/contract.ts`, exported as
   `@outfitter/provider-local/testing` (check the package's `exports` map and that `tsc` emits it).
   Cases C1-C8 (spec §6.2). Adapters for `inprocess`, `docker` (skipped without a docker binary),
   `cloudrun` (existing stubs) and `noop`.
3. **`CloudRunProvider`**: `capacity()` returns `{ active }` from `countRunningExecutions`; `status()`
   maps NOT_FOUND to `exited` (C6), with its own test.
4. **`api/src/providers/registry.ts`**: `SandboxProviders` with lazy, memoized factories (spec §2.4).
   `createProvider` stays as a wrapper around the default.
5. **`config.ts`**: `gke` in `SANDBOX_PROVIDERS` (`config.ts:116`), the `GKE_*` fields,
   `isCloudProvider()` used by `assertSandboxOrigin` (177-184) and `mailboxWarning` (189-200), and a
   boot failure for `SANDBOX_PROVIDER=gke` without `GKE_CLUSTER`.
6. **`Run.sandboxProvider`** (`store/types.ts:64-75`) and `providerNameFor()`. `runs.ts`'s `wake`
   (keeping `opts.mailDriven`), `stop`, `reconcileOnce` and `reconcileStoppingOnce` resolve the provider
   through the registry. If a provider is no longer configured: log once, skip the provider call, and
   still apply the state change. `start()` refusals also set `statusDetail`.
7. **Capacity row**: `server.ts:69-84` stops using `instanceof CloudRunProvider`; `probeSandbox(name, fn)`
   in `providers-status.ts`. `ProviderKind` gains `"gke"`, and the `cloudrun` row keeps `id: "cloudrun"`
   so its uptime history survives.
8. **`/api/operator/settings`** (`routes/operator.ts:124-125`) returns the gke fields when they are set.
9. **Deploy**: `SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-cloudrun}"` in `config.env`; `service.sh:153`
   reads it. Existing `shellcheck` and `guards.test.sh` stay green.
10. **Docs**: refresh the spec's moved citations (§2 above), and add the EPIC story.

Acceptance is spec §7 PR1's, plus two checks: `DRY_RUN=1 ./release.sh` on `main` after merge shows no
environment change for either service (`SANDBOX_PROVIDER` still resolves to `cloudrun`), and a deployed Cloud Run run records
`sandboxProvider: "cloudrun"`.

---

## 6. Spec amendments to fold in

PR1 edits `gke-sandbox-provider.md` to match: §5 rewritten for `config.env`, owner-run scripts and the
`release.sh` template step; §5.2 without the image extraction; §3.3 with the admission rules
from the spike (gVisor node selector and toleration, `automountServiceAccountToken: false`, the
namespace's hardening exemption), the DNS egress fix, and the `/tmp` and `/run/outfitter` warnings;
§4.2 with claims naming a warm pool, not a template; §3.5 with #45's in-memory rule; §6.2's suite
location; §6.3 against the real `wake-bench.mjs`; §7 dependencies as in §3 above; §8.2 with S7; §9
marked with the decisions in §1.
