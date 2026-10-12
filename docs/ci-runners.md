# CI runners

Every Linux job runs on the runner named by the repository variable `LINUX_RUNNER` (ARM jobs:
`LINUX_ARM_RUNNER`). When the variable is unset, jobs use Blacksmith
(`blacksmith-2vcpu-ubuntu-2404`, `blacksmith-2vcpu-ubuntu-2404-arm`). The macOS release build stays
on GitHub's `macos-15`.

Why: GitHub-hosted minutes on this private repo passed $100 in October 2026. Blacksmith costs about
$0.004 a minute against GitHub's $0.006, includes about 3,000 free minutes a month, and usually runs
the same jobs faster. Check Blacksmith's pricing page for current numbers.

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

A self-hosted runner should be ephemeral (`--ephemeral`, one job per runner) and should have no
cloud credentials of its own. Deploys get Google access through Workload Identity, which trusts
this repo and its `outfitter-v*` tags, not the machine.

## What doesn't run

Outfitter CI ignores changes under `kernal/tests/`, `kernal/docs/` and `kernal/README.md`: the
Outfitter image and tests never read them. Any other Kernal change still runs Outfitter CI, because
the image bakes in Kernal's `.pi/`, `bin/` and `skills/`.
