# CI runners

Every Linux job runs on the runner named by the repository variable `LINUX_RUNNER` (ARM jobs:
`LINUX_ARM_RUNNER`). When the variable is unset, jobs use Blacksmith's 2 vCPU runners
(`blacksmith-2vcpu-ubuntu-2404`, `blacksmith-2vcpu-ubuntu-2404-arm`). The exception is Outfitter
CI's `test` job, which reads `LINUX_HEAVY_RUNNER` and defaults to `blacksmith-4vcpu-ubuntu-2404`.
The macOS release build runs on `blacksmith-6vcpu-macos-15`, with no variable. Checkouts use
`useblacksmith/checkout@v1`.

### Why 2 vCPU, and 4 for one job

A 4 vCPU runner costs about twice as much per minute, so it is only cheaper for a job that runs in
under half the time. Measured on the same commit on 2026-10-12, one run each:

| Job | 2 vCPU | 4 vCPU |
|---|---|---|
| Outfitter `test` | ~7m03s | 3m07s (44%: 4 vCPU cheaper) |
| kernal `test` | 2m36s | 1m27s (56%: 2 vCPU cheaper) |
| A2A TCK | 1m47s | 1m40s |
| Outfitter `images` | 1m24s | 1m15s |

Re-check with Blacksmith's usage dashboard once there is a few weeks of data. Moving a job between
sizes is a variable change (`LINUX_RUNNER`, `LINUX_HEAVY_RUNNER`).

Why: GitHub-hosted minutes on this private repo passed $100 in October 2026. Blacksmith's per-minute
price is lower than GitHub's, it includes free minutes each month, and it usually runs the same jobs
faster. A 4 vCPU runner costs about twice as much per minute as a 2 vCPU one. Check Blacksmith's
pricing page for current numbers.

## Setup (owner, once)

1. Install the Blacksmith GitHub app on `cognitio-org` and give it access to `mgm-pi`
   (https://www.blacksmith.sh). Until it is installed, jobs wait for a runner that never comes, and
   GitHub cancels them after 24 hours.
2. Re-run any red checks. No push is needed.

## Switching runners

Set it in Settings, Secrets and variables, Actions, Variables. No code change is needed:

| Want | `LINUX_RUNNER` | `LINUX_ARM_RUNNER` |
|---|---|---|
| Blacksmith (default) | unset | unset |
| GitHub-hosted | `ubuntu-24.04` | `ubuntu-24.04-arm` |
| Your own runner (e.g. a Hetzner VM) | that runner's label, e.g. `self-hosted` | its ARM label |

Set `LINUX_HEAVY_RUNNER` the same way to move Outfitter CI's `test` job; unset, it stays on
Blacksmith's 4 vCPU runner even when `LINUX_RUNNER` points elsewhere.

If you move off Blacksmith for good, also switch `useblacksmith/checkout@v1` back to
`actions/checkout@v5`, and move the macOS job in `release.yml` back to `macos-15`.

A self-hosted runner should be ephemeral (`--ephemeral`, one job per runner) and should have no
cloud credentials of its own. Deploys get Google access through Workload Identity, which trusts
this repo and its `outfitter-v*` tags, not the machine.

## What doesn't run

Outfitter CI ignores changes under `kernal/tests/`, `kernal/docs/` and `kernal/README.md`: the
Outfitter image and tests never read them. Any other Kernal change still runs Outfitter CI, because
the image bakes in Kernal's `.pi/`, `bin/` and `skills/`.
