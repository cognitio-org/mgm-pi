# Plan: building the GKE Agent Sandbox provider

Status: planning (2026-09-24), at `main` `1e21c9f`. Companion to `gke-sandbox-provider.md` (the
spec, written at `d545d5c`). The spec's design stands. This file records the owner's answers, what
has moved on `main` since the spec, and the revised order of work. Where the two disagree, this file
wins until the spec is amended (§6).

---

## 1. Owner decisions (2026-09-24)

| Spec §9 question | Decision | Consequence |
|---|---|---|
| 1. Warm hours | **Weekdays 09:00-03:00 `Europe/Zagreb`** (up 09:00 Mon-Fri, down 03:00 Tue-Sat; was 08:00-20:00 until 2026-09-25) | PR4 (warm assignment) is in v1. Warm cost about $21/month (spec §3.7) |
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

## 6a. PR3 delivered (2026-09-24)

Matches the §3 PR3 row and §5.1 as amended (no `gke-switch.sh`: the switch is `config.env` +
release, as §2 already says). Notes for whoever builds on this:

- The logWriter-only guard (§1 "option B") lives once, as `assert_agent_sa_logwriter_only` in
  `env.sh`, called both from `gke-iam.sh` (owner-run, stand-alone) and from `gke-template.sh` (every
  release, when `GKE_CLUSTER` is set) — not duplicated between them.
- `check_deploy_skew` was extended in place, not given a parallel path: it now also reads the
  SandboxTemplate's `build-commit` label (`current_build_commit_gke`, via a shared `gke_kubeconfig`
  helper) whenever `GKE_CLUSTER` is set, for *every* caller — a stand-alone `./api.sh` or
  `./agent-job.sh` run now also refuses (or, `ALLOW_SKEW=1`, warns) on a stale template, not only a
  `release.sh` run. `gke_kubeconfig` never calls `get-credentials` under `DRY_RUN=1` (matching
  `gke-cluster.test.sh`'s convention), so `DRY_RUN=1 ./release.sh` never touches the cluster either.
- `gke-template.sh`'s release-time warm-up (spike S4: a tag's first pull costs ~28s once) is a
  throwaway cold claim, created with `kubectl create` (not `apply`: the deployer's Role grants no
  `patch` on claims). The script waits up to 60s for a Sandbox to be assigned, then up to 120s more
  for that Sandbox to report Ready, then deletes the claim regardless of how either wait came out —
  a slow first pull just means the next real wake pays it instead, not a failed release.
- `gke-teardown.sh`'s "no active runs" check has a real limitation, called out in its own header:
  deploy scripts have no Atlas access, so it checks for live `SandboxClaim`s in the namespace as the
  closest available proxy (every active gke run has exactly one) rather than the API's own run
  state. `GET /api/operator/runs?active=1` (PR5) is the authoritative check.
- `ci-setup.sh`'s new namespaced Role/RoleBinding for `outfitter-deployer` (get/create/patch the
  SandboxTemplate and pool, get/create/delete/list the warm-up claim, get/list/watch sandboxes) needs the cluster to already exist;
  run `gke-cluster.sh` first. Running `ci-setup.sh` before that just warns and skips that one block
  — re-run `ci-setup.sh` afterward.
- `service.sh` reads `GKE_CLUSTER`/`GKE_LOCATION`/`GKE_NAMESPACE`/`GKE_WARM_POOL`/`GKE_LAUNCH_MODE`/
  `GKE_MAX_ACTIVE` straight from `config.env` (checked in) rather than falling back to "whatever's
  already deployed" the way `TASKS_SA_EMAIL` does: since these are all in `config.env` now (unlike
  the mailbox settings, which are discovered from GCP resources, not configured), a plain redeploy
  can't silently drop them the way §4.4's fallback was written to guard against.
- The GitHub Actions deploy workflow installs `kubectl`/`gke-gcloud-auth-plugin` only when
  `config.env` has `GKE_CLUSTER` set (a small step reads it and sets a step output before
  `setup-gcloud` runs).

---

## 6b. Review round 1 fixes (2026-09-24)

PR3's first review round found three blocking issues (all fixed before merge) and several medium/
low ones. Recorded here since they change behaviour §6a described:

- **Blocking: the template must define no static `OUTFITTER_API`/`RUN_ID`/`RUN_TOKEN`.**
  agent-sandbox v1.0.3's `Allowed` env-injection policy rejects a claim env var whose name the
  template already defines (`Ready=False`, `EnvVarsInjectionRejected`) — every cold claim (PR2's
  `GkeProvider`, and this PR's own warm-up claim) would have failed admission.
  `deploy/gke/sandbox-template.yaml` now sets only `OUTFITTER_ASSIGNMENT_DIR`.
  `gke-template.test.sh` asserts the rendered template's env and the claim's env names don't
  intersect, and that no `${VAR}`-shaped placeholder survives rendering.
- **Blocking: the deployer needs a `kube-system` Role to read the `kube-dns` Service.**
  `container.clusterViewer` plus the `outfitter-sandboxes` Role never covered it; `ci-setup.sh` now
  also applies a `kube-system` Role/RoleBinding scoped to `get` on `resourceNames: ["kube-dns"]`.
- **Blocking: the warm-up claim needs `create` (or `patch`), and `list`/`watch` for `kubectl wait`.**
  Server-side apply is a PATCH; the deployer's Role only had get/create/delete. `gke-template.sh` now
  uses `kubectl create` for the claim, and the Role adds `list`/`watch` on sandboxclaims and
  `get`/`list`/`watch` on sandboxes (for waiting on the assigned Sandbox's Ready condition, §6a's
  warm-up note). `gke-template.test.sh`'s fake kubectl enforces exactly this Role's verbs per
  resource, denying anything else, so a regression back to `apply` on a claim fails the test.
- **Medium fixes**: the warm-up now waits for the Sandbox to report Ready (not just "a name was
  assigned"), deleting the claim through both a normal call and a registered exit-trap (interrupt
  safety); a pool-replica read error that isn't NotFound now refuses instead of falling back to 0;
  the `build-commit` label is applied last, after the pool patch and the warm-up; `gke-teardown.sh`
  fails loudly on a claims-list error instead of reading it as "no claims"; `gke-schedule.sh` has
  real `DRY_RUN=1` support; `current_build_commit_gke` fails loudly on a real lookup error (not just
  NotFound) whenever `GKE_CLUSTER` is set, matching `gcloud_exists`'s own contract, while GKE-off
  behaviour is untouched.
- **Low fixes**: dropped `roles/iam.securityReviewer` from `ci-setup.sh` (`roles/browser`, already
  granted, includes `resourcemanager.projects.getIamPolicy`); added
  `assert_agent_sa_no_unexpected_bindings` (checks who holds a role ON `outfitter-agent@` itself,
  the resource-level half of the option-B guard — folder/org-level grants are still a documented,
  unclosed gap); `gke-teardown.sh`'s IAM-binding removal now tolerates "already removed" for
  re-runs; `gke-iam.sh`'s hardening-exemption check parses the binding as JSON for exact list
  membership instead of `grep -w`; the GitHub Actions workflow installs `kubectl` only when GKE is
  configured; `gke-template.sh` checks `image_exists` before rendering (a clear error for a
  standalone run with nothing built yet); `gke-schedule.sh` uses `gcloud_exists` for its describe
  check; `release.sh` prints a short `./mailbox.sh`/`./gke-schedule.sh` name instead of the
  absolute path. Two new tests (`release-gke-off.test.sh`, `service-env-gke-off.test.sh`) prove
  GKE-off `DRY_RUN=1 ./release.sh` and `service.sh`'s `--set-env-vars` are byte-for-byte unchanged.

---

## 6c. Review round 2 fixes (2026-09-24)

A focused re-review of round 1's own fixes found three more blockers -- two of them introduced by
round 1 itself -- plus several medium/low issues. Fixed before merge; recorded here since some
change round 1's own §6b description.

- **Critical: the "Check whether GKE is configured" workflow step broke every release, GKE on or
  off.** It ran `source config.env` under `set -euo pipefail`; `config.env`'s `GKE_LOCATION` line
  referenced `${REGION}`, which only `env.sh` ever sets, so the step died on "REGION: unbound
  variable" before `setup-gcloud` ever ran. Fixed two ways: `config.env`'s `GKE_LOCATION` now
  defaults to `${REGION:-us-central1}` (safe to source standalone, no `env.sh`, under `set -u`), and
  the workflow step no longer sources `config.env` at all -- it calls a new
  **`deploy/gke-workflow-check.sh`**, which evaluates only the one `GKE_CLUSTER="${GKE_CLUSTER-...}"`
  line from `config.env` in isolation. `gke-workflow-check.test.sh` runs it under `env -i` (a
  genuinely clean environment, no `PATH` beyond the bare minimum, no `REGION`) to prove this.
- **High: `assert_agent_sa_no_unexpected_bindings` (round 1) would have refused on the real
  project.** `baseline.sh` grants `outfitter-api@` `roles/iam.serviceAccountUser` on
  `outfitter-agent@` (`CloudRunProvider` needs it to start Job executions as that account) -- a real,
  permanent, pre-existing binding the guard didn't expect. Added to the expected set; the doc comment
  now lists which script grants each of the three expected bindings.
- **High: the deployer's Role couldn't create the SandboxTemplate or pool on the first GKE
  release.** `kubectl apply --server-side` on an object that doesn't exist yet is authorized against
  `create`, not only `patch` -- a real apiserver behaviour round 1 missed, and nothing pre-creates
  either object. Added `create` to both (it can't be scoped by `resourceNames`, so this is
  unavoidably namespace-wide for the resource type, not just the `outfitter-agent` object).
  `gke-template.test.sh`'s fake now models "apply on a not-yet-existing object needs create"
  (`FAKE_FIRST_RELEASE`) and proves both that the first release works and that removing `create`
  breaks it (`FAKE_ROLE_NO_CREATE`).
- **Medium fixes**: the warm-up `kubectl create` is now genuinely best-effort -- a stale claim from
  an interrupted previous run is deleted by label first, and the new claim uses `generateName`
  (never a fixed name), so a create failure (quota, a rejected admission, anything) can no longer
  come from a name collision, and any other failure just skips the rest of the warm-up with a note
  instead of failing the release. `gke-teardown.sh`'s pool-scale-to-0 step now tolerates the pool not
  existing yet (cluster and `gke-iam.sh` done, no release yet), the same NotFound-only tolerance as
  the replicas read.
- **Low fixes**: `is_kubectl_notfound` (new, `env.sh`) replaces three separate `NotFound|not
  found|does not exist` regexes with an exact match on kubectl's actual `Error from server
  (NotFound)` prefix -- the looser regex matched kubectl's own `"gke-gcloud-auth-plugin" ... not
  found` error too, which must fail loudly, not read as "the object doesn't exist".
  `env_name_collides` (the round 1 blocking-fix test) now also catches block-style YAML
  (`- name: OUTFITTER_API` on its own line), not only flow style. The warm-up claim's
  `app.kubernetes.io/managed-by` label changed from `outfitter` to `outfitter-release`: PR2's
  `GkeProvider.countActive()` (`packages/api/src/providers/gke.ts`) counts claims labelled
  `managed-by=outfitter` toward `GKE_MAX_ACTIVE`, and the warm-up claim must not eat into that
  budget (verified by reading `gke.ts`; not modified). `register_cleanup`/`register_cleanup_cmd` now
  set the `EXIT` trap only once (guarded by `CLEANUP_TRAP_SET`), not on every call: bash (confirmed
  on 3.2, macOS's default `/bin/bash`) does not act on an inherited-but-not-locally-reset `EXIT`
  trap when a `$(...)` subshell exits, but calling `trap ... EXIT` *again* from inside one (which
  every earlier `register_cleanup` call did) makes that subshell treat its own exit as "time to
  clean up", deleting paths the top-level script had registered but not used yet --
  `check_deploy_skew`'s own `current_build_commit_gke` call is exactly such a subshell.
  `$BASHPID` was the obvious alternative and, like round 1's `$BASH_SUBSHELL` idea (tried and found
  unreliable specifically inside a firing trap, empirically, on bash 3.2), doesn't need to be
  reached for once the redundant `trap` call is removed. Finally, the SandboxTemplate/pool
  first-pull warm-up no longer uses `kubectl wait --for=jsonpath=<path>` with no comparison value
  (a newer kubectl feature this repo can't confirm the version of `gcloud components install
  kubectl` puts on any given machine or CI runner); it polls `kubectl get` in a bounded loop
  instead, needing only the `get` verb. `sandboxclaims`' `watch` verb was removed from the Role
  since nothing calls `kubectl wait` on a claim anymore.

---

## 6d. PR4 delivered (2026-09-24)

Matches the §3 PR4 row and spec §3.5's Option B. Notes for whoever builds on this (updated by §6e's
review-round fixes -- read that section too, it changes some of what's described here):

- **`packages/agentd/src/assignment.ts`** (new) is what `main.ts` now calls instead of reading
  `OUTFITTER_API`/`RUN_ID`/`RUN_TOKEN` from env directly. Env path (Cloud Run, docker, inprocess, a
  GKE cold claim): same checks, same order, same error text as before this file existed. `main.ts`
  now resolves this path *before* any run-independent setup or log line (§6e), so the timing matches
  too -- see §6e's first bullet for why "byte-for-byte, no behaviour change" wasn't quite true of the
  first cut.
- **File path (GKE warm)**: when `RUN_ID` isn't in env and `OUTFITTER_ASSIGNMENT_DIR` is, it polls
  (250 ms, injectable) `run-id`/`run-token`/`api` under that directory until **all three** are
  non-empty, not just `run-id`/`run-token`. This is *not* a real production race being fixed --
  gke.ts's warm mode sets all three annotations in one `additionalPodMetadata.annotations` patch,
  and the kubelet's downward-API refresh swaps the whole projected volume's `..data` symlink
  atomically, so the three files become visible together in practice (verified against the real
  kubelet layout in `assignment.test.ts`, §6e). Waiting on all three is cheap insurance against this
  module's own three independent `readFile` calls, nothing more. No default deadline, per the spec
  and the plan's acceptance bar: an unclaimed warm pod waits idle forever rather than dialling out or
  exiting. A presence-only heartbeat (§6e) logs every few minutes while still waiting.
- **Preload before the wait**: `main.ts` calls `preloadSessionManager()` (and `resolveRunAsUser()`,
  which also doesn't need the run) *before* the warm-pod wait -- a warm pod that waits idle to be
  claimed pre-pays that work for free instead of paying it only after a claim arrives. The env path
  is unaffected (resolution there is immediate and now happens even earlier, before this setup --
  §6e).
- **#143 (id-token and connect timing)**: `main.ts`'s `headers()` provider passed to `Link` times
  each `getIdToken` call and logs `startup: identity token fetched (<ms>ms)` (or, on failure,
  `identity token fetch failed (<ms>): <message>`, §6e); `link.onOpen` logs
  `startup: connected to the link`, paired with the existing `startup: connecting to the link` so
  the delta between the two `elapsedMs` values is the full connect cost. A reconnect's lines say
  `reconnect <n>: ...` instead of repeating `startup: ...` (§6e). **Deviation from the issue's
  stretch goal**: warm-path ID-token prefetch (fetching it before the assignment arrives) was not
  implemented -- the assignment is also what supplies `OUTFITTER_API` (the token's audience) on the
  warm path, and adding a second, deployment-fixed way to know the link origin ahead of time (e.g. a
  new `OUTFITTER_LINK_ORIGIN_HINT` env var) felt like a second source of truth for one value for a
  startup-latency win that hasn't been measured on a warm pod yet (S2's 9s figure is from a *cold*
  claim, where a fresh node's Workload Identity setup is plausibly a bigger factor than on an
  already-running warm pod). Left as a follow-up once PR5's benchmark has warm-pod numbers to justify
  it. The timing itself ships either way, so the next spike has the data.
- **Tests**: `packages/agentd/test/assignment.test.ts` (unit), `packages/agentd/test/link.test.ts`
  (unit, `onHeadersError`) and `packages/agentd/test/main.test.ts` (integration; spawns the real
  built `dist/src/main.js` against a bare `ws` server standing in for the link -- no real api needed
  for what this PR touches). `main.test.ts` skips itself with a clear message if `packages/agentd`
  hasn't been built yet, the same convention `packages/api/test/e2e.test.ts` uses for the same
  reason. §6e lists what the review round added to each.
- **Not touched**: `packages/api/src/providers/gke.ts` (owned by an in-flight auth fix elsewhere) and
  `deploy/gke/sandbox-template.yaml` (already correct from PR3 -- confirmed the file names/paths
  `assignment.ts` reads against it, no changes needed).

---

## 6e. Review round 1 fixes (2026-09-24)

PR4's first review round found one blocking issue and several medium/low ones, all fixed before
merge. Recorded here since some correct §6d's own description above.

- **High: `RUN_TOKEN` was still in `process.env` when `getPiVersion` and `resolveRunAsUser` spawned
  their children.** The first cut deleted it inside `resolveAssignment`, called from `main.ts` only
  *after* those two run-independent steps (moved earlier, deliberately, so a warm pod could pre-pay
  them -- see §6d). Both spawn children via `execFile`, which inherits `process.env` wholesale; the
  reviewer proved the leak with a `PI_BIN` probe script that wrote the real token to a file. Fixed in
  `main.ts`: `process.env` is snapshotted into a private `bootEnv` and `RUN_TOKEN`/
  `OUTFITTER_DEV_TOKEN` are deleted from the *real* `process.env` as the very first act of `main()`,
  before anything else runs; `resolveAssignment` is then called against the `bootEnv` snapshot, not
  `process.env`. On the env path, `resolveAssignment` is now also called before any of the
  run-independent setup or a single log line -- restoring the exact pre-`assignment.ts` fail-fast
  timing (same checks, same order, same error text, and now zero log lines before a fatal missing-var
  exit, matching what `main.ts` did before this file existed). Only the warm-pod wait still defers
  past that setup, since deferring it is the whole point there. A regression test
  (`main.test.ts`, the `PI_BIN` probe) proves `RUN_TOKEN` never reaches a spawned child's environment.
- **Low fixes**:
  - Early phase lines (e.g. `main entered`) now carry `runId` from boot on the env path, since it's
    already known then -- they used to omit it until the (on this path, instant) assignment resolved.
  - The identity-token fetch is now logged on failure too:
    `identity token fetch failed (<ms>): <message>` (the message is always safe -- `getIdToken` never
    puts a token in one). This closes **#157**: `link.ts`'s `open()` used to swallow a `headers()`
    rejection with no log line at all, indistinguishable from a slow network. `Link` gained an
    optional `onHeadersError` callback for this, tested directly in `link.test.ts`.
  - A repeated connection attempt (any reconnect after the first) now says `reconnect <n>: ...`
    instead of repeating `startup: ...` on every drop, for both the identity-token-fetch line and
    `connected to the link`.
  - `resolveAssignment`'s poll interval default changed from 100 ms to 250 ms.
  - A presence-only heartbeat (`onHeartbeat`, default every 5 minutes) reports which of
    `run-id`/`run-token`/`api` are present -- never a value -- while still waiting on the file path,
    so a stuck warm pod is visible in Cloud Logging without risking a token in it.
  - `assignment.test.ts`'s "no `RUN_ID`, no dir" test used to duplicate another test's input
    byte-for-byte; replaced with a test against a directory that genuinely doesn't exist on disk
    (not just an existing directory with missing files), and a new test builds the kubelet's actual
    downward-API layout (a `..data` symlink to a timestamped directory, the files themselves symlinks
    through it) and performs the same atomic rename the kubelet does, to verify the "wait on all
    three files" design directly against the real mechanism rather than only against a hand-rolled
    fake. This is also what grounds §6d's corrected claim that the three-file wait guards a test
    artifact, not an observed production race.

---

## 6. Spec amendments to fold in

PR1 edits `gke-sandbox-provider.md` to match: §5 rewritten for `config.env`, owner-run scripts and the
`release.sh` template step; §5.2 without the image extraction; §3.3 with the admission rules
from the spike (gVisor node selector and toleration, `automountServiceAccountToken: false`, the
namespace's hardening exemption), the DNS egress fix, and the `/tmp` and `/run/outfitter` warnings;
§4.2 with claims naming a warm pool, not a template; §3.5 with #45's in-memory rule; §6.2's suite
location; §6.3 against the real `wake-bench.mjs`; §7 dependencies as in §3 above; §8.2 with S7; §9
marked with the decisions in §1.
