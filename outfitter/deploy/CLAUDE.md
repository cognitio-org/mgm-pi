# Deploying Outfitter: rules for agents

- Don't run `release.sh`, `service.sh`, `api.sh`, `link.sh` or `agent-job.sh` from a session
  worktree. Merging to `main` only runs CI; pushing an `outfitter-v*` tag (`tag-release.sh`)
  deploys, through `.github/workflows/outfitter-deploy.yml` (README.md "Deploying"). The scripts
  refuse to run off `main` anyway.
- `DRY_RUN=1 ./release.sh` from a clean, up-to-date `main` checkout is safe: it only reads
  production's state and prints what would deploy. `MANUAL=1 ./release.sh` really deploys: only
  with the owner's explicit go-ahead.
- Settings go in `config.env`, not in someone's shell. Access (IAP, members, invokers) is
  `access.sh`, run by the owner, never by an agent.
- `tag-release.sh` (without DRY_RUN=1), `ROLLBACK=1`, `ALLOW_OFF_MAIN=1`, `ALLOW_SKEW=1`,
  `access.sh` and `ci-setup.sh` need the owner's explicit go-ahead in the conversation. Never create
  a GitHub Release for Outfitter: Releases here are Kernal's, and `kernal update` reads the latest.
