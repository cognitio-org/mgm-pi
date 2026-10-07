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
  `access.sh`, `ci-setup.sh` and `e2e-identity.sh` (without DRY_RUN=1) need the owner's explicit
  go-ahead in the conversation. `iap-probe.sh` is safe once the caller is an `E2E_TOKEN_MINTERS`
  principal: its only write is the live-test account's own user record, which `GET /api/me` makes on
  every sign-in. Never create
  a GitHub Release for Outfitter: Releases here are Kernal's, and `kernal update` reads the latest.
- `litellm-admin.sh` (without `DRY_RUN=1`) is owner-run: it reads the router master key and mints
  Outfitter's scoped admin key into `outfitter-litellm-admin`. `DRY_RUN=1` reads nothing secret.
- `litellm-retire-keys.sh` (`system-key`, `block`, `unblock`; without `DRY_RUN=1`) is owner-run
  (#399): it reads the router master key, mints the `outfitter-system` key into
  `outfitter-litellm-key-default`, and blocks the retired shared router keys. `DRY_RUN=1` reads
  nothing secret and writes nothing.
- `sentry-token.sh` (without `DRY_RUN=1`) is owner-run: it stores the Sentry upload token in
  `sentry-release-token` and grants `outfitter-builder@` access to that secret (README.md "Web source
  maps"). The token comes from the owner's clipboard; agents never handle it.
- `secret-scope.sh` (without `DRY_RUN=1`) is owner-run: it changes outfitter-api's project IAM
  (secret roles limited to `outfitter-*` secrets). `DRY_RUN=1` is safe.
- `gcloud-mcp-iam.sh` and `gcloud-mcp-router.sh` (gcloud MCP, epic #497; docs/runbooks/gcloud-mcp.md)
  are owner-run without `DRY_RUN=1`: the first grants `roles/mcp.toolUser` and writes an IAM deny
  policy; the second reads the router master key and registers the server (`CONFIRM=1`; editing an
  existing one purges every user's grant, `FORCE_PURGE=1`). `DRY_RUN=1` reads no secret.
- `atlas-search.sh` (session search indexes, #289) is owner-run without `DRY_RUN=1`: its vector
  index makes Atlas embed every chunk through Voyage (billed). `DRY_RUN=1` is safe.
- GKE (README.md "GKE provider (optional)"): `gke-cluster.sh` (without `DRY_RUN=1`), `gke-iam.sh`
  (without `DRY_RUN=1`), `gke-schedule.sh` and `gke-teardown.sh` (without `DRY_RUN=1`, and
  `--force`) are owner-run, same footing as `access.sh`/`ci-setup.sh` -- they start GKE billing,
  change project IAM, or delete the cluster. `DRY_RUN=1` against any of them, from a clean
  checkout, is safe. `gke-template.sh` is different: it's a `release.sh` step, so it runs
  automatically (never by hand from a session worktree) once `GKE_CLUSTER` is set in `config.env`.
