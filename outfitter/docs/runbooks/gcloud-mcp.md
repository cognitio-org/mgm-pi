# Runbook: gcloud through Google's remote MCP server

Epic #497 (GA-1 #491, GA-5 #495, GA-6 #496). Sysops run `gcloud` and `bq` against
`outfitter-509211` from a laptop Kernal session or a Drive, through Google's remote gcloud MCP
server (`https://cloudcli.googleapis.com/mcp`, Preview) and the LiteLLM router's per-user OAuth
vault. Commands run on Google's side as the signed-in person: their own IAM applies, and the
calls land in Data Access audit logs under their email. No Google credential ever enters a sandbox.

Decisions (owner, 2026-10-07): each person's own Google account; mutating commands are gated by
approval cards (GA-4), not a read-only IAM deny; personal/Outfitter account only, no work account.

## One-time owner setup

Do these in order. Scripts are owner-run and need `DRY_RUN=1` first, from `outfitter/deploy/`.

1. **Roll router-litellm #45 to the live router first.** It makes the router default
   `access_type=offline` and `prompt=consent` for accounts.google.com and keeps the stored refresh
   token when Google's refresh response omits it. Without it a grant can die after the first
   refresh. (Follow the router release lock: check the live release before rolling.)
2. **Create the OAuth client in its own project, not `outfitter-509211`.** A project has one OAuth
   consent screen, and `outfitter-509211`'s must stay **External**: IAP's custom client admits
   people outside the Workspace (serviam-it.hr, a gmail.com account). Switching it to Internal
   would lock them out of app.kernal.one. So (owner decision 2026-10-07):
   - Create a small project in the mgmonteleone.com organization with no billing account, e.g.
     `gcloud --configuration=outfitter projects create kernal-oauth --organization=175498176044`.
   - In its console: APIs & Services, OAuth consent screen, user type **Internal** (an External app
     in Testing expires refresh tokens after 7 days).
   - Then Credentials, Create credentials, OAuth client ID, type **Web application**, authorized
     redirect URI `https://router.kernal.one/callback` (the router builds its MCP OAuth callback as
     `<base url>/callback`). Copy the client ID and secret.

   A client from another project works for any project's APIs: IAM is checked on the project each
   command names. **But the call itself is billed to the client's project**, so enable the API
   there too, or Google answers 403 and the router shows `gcloud` with 0 tools (seen 2026-10-08):
   `gcloud --configuration=outfitter services enable cloudcli.googleapis.com --project=kernal-oauth`.
   Each follow-on server below needs its API enabled in `kernal-oauth` as well. Only the client
   lives in the new project. The secret, the router row and the deny policy all stay as below.
3. **Store the client secret** in `outfitter-509211`'s Secret Manager as `outfitter-gcloud-mcp-oauth-client-secret`,
   straight from the console download or clipboard, never into a file in the repo:
   `pbpaste | gcloud --configuration=outfitter secrets create outfitter-gcloud-mcp-oauth-client-secret --data-file=-`
   (`secrets versions add` for a rotation). The name starts with `outfitter-`, so
   `secret-scope.sh`'s rules cover it.
4. **Register the server.**
   `DRY_RUN=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<client id> ./gcloud-mcp-router.sh`, then
   `CONFIRM=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<client id> ./gcloud-mcp-router.sh`.
   It reads the client secret and the router master key from Secret Manager (never printed), and
   registers the `gcloud` server as `oauth2` authorization code. The authorize URL carries
   `?access_type=offline&prompt=consent` so Google issues a refresh token. Settle the config now:
   editing an existing server purges every user's grant, so the script only shows an existing
   server unless `FORCE_PURGE=1`. Keep `allow_all_keys` false (the script does), and never grant
   the server to teams, access groups or `default_key_generate_params`: that would hand it to
   non-operators. Users whose key has the `proxy_admin` role and no explicit server list see the
   whole registry, so keep the proxy_admin keys few.
5. **Grant IAM and the deny policy.** `DRY_RUN=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<client id> ./gcloud-mcp-iam.sh`,
   then the same without `DRY_RUN`. It enables `cloudcli.googleapis.com`, grants
   `roles/mcp.toolUser` to the operators (`OUTFITTER_OPERATORS`, override with `GCLOUD_MCP_SYSOPS`),
   and creates the deny policy `gcloud-mcp-gateway-only`: `mcp.googleapis.com/tools.call` is denied
   to everyone unless `request.auth.oauth.client_id` is the router's client. Writing deny policies
   needs `roles/iam.denyAdmin`, which Owner doesn't include and which can only be granted on the
   **organization** (a project grant fails with "Role roles/iam.denyAdmin is not supported for this
   resource"). Grant it, wait a minute, run, then remove it:
   `gcloud --configuration=outfitter organizations add-iam-policy-binding 175498176044 --member=user:mgm@mgms.eu --role=roles/iam.denyAdmin --condition=None`
   and the same with `remove-iam-policy-binding` afterwards. The policy covers every Google remote MCP server in the project, and it blocks
   every other caller too: a service account, Application Default Credentials, or another client
   (Gemini CLI, an MCP Inspector) can no longer call Google remote MCP servers in this project. The
   follow-on servers below use the same client, so they pass. It is attached to the project only;
   attaching it to the folder or organization is a follow-on.
   **First thing to check if every MCP call is denied after this step:** the condition compares
   `request.auth.oauth.client_id` with the full `<n>-<x>.apps.googleusercontent.com` id, and that
   value format is unverified against a live call. The policy fails closed and is reversible:
   `gcloud --configuration=outfitter iam policies delete gcloud-mcp-gateway-only --attachment-point=cloudresourcemanager.googleapis.com/projects/outfitter-509211 --kind=denypolicies`,
   then rerun the script with the corrected id.
6. **Outfitter release.** mgm-pi #508 needs the server registered before the release, because
   `/key/generate` silently drops unknown `mcp_servers` names. Push the `outfitter-v*` tag
   (`tag-release.sh`) only after step 4.
7. **Kernal release**, so laptops have the client side.
8. **Test** as a sysop (next section): connect, run `gcloud projects describe outfitter-509211`,
   wait over an hour, run it again (refresh works). Tick #495 and #491 only after that.


## Connecting (each sysop)

- **Laptop:** in a Kernal session run `/mcp-auth gcloud`, sign in with your own Google account
  (the one in `OUTFITTER_OPERATORS`), approve the cloud-platform scope. Check with `/mcp status`.
- **Web / Drive:** the Connections page (#487) has a Connect button for `gcloud`. The Drive needs no
  OAuth code: the router uses your stored grant when your run key calls the server. Until that page
  lands, connect once from a laptop; the grant is per user, so it carries over.
- Only operators see the server (GA-2 #492); tapes expose it with `adminTools: operator` (GA-3 #493).

## What the server refuses

`gcloud auth`, `config`, `init`, `survey`, `iam service-accounts`, `billing`, and `alpha`/`beta`
variants; for `bq`: `init`, `shell`, `pyshell`. (Google's own list is "examples, non-exhaustive":
https://docs.cloud.google.com/sdk/use-gcloud-mcp. The `billing` refusal is from the epic; Google's
page does not list it.) Anything else is subject to your IAM and org policy. Tools: `run_gcloud_command`,
`run_bq_command`; a project is required on every call.

## Usage tips

- Write flags as `--flag=value`, not `--flag value`.
- Long operations: add `--async` and poll with `operations describe`.
- Keep output small: `--limit=N`, `--format=...`, `--filter=...`. Big listings eat context.
- Always name the project: `--project=outfitter-509211`.
(These tips come from the epic owner's notes; Google's page only states the project requirement.)

## Approvals and audit

- Mutating commands raise an approval card (GA-4 #494) before they run; read-only ones don't.
- Audit: Cloud Logging, Logs Explorer, `protoPayload.serviceName="cloudcli.googleapis.com"`. The
  principal is the person's email. If entries are missing, enable Data Access logs for the service
  under IAM & Admin, Audit Logs. (Service name taken from the epic; not stated on Google's page.)
  Router-side, the call is also in the router's spend/audit logs under the person's user id.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Works for an hour, then "sign in again" | No refresh token: the router didn't send `access_type=offline` and `prompt=consent` (GA-1 #491), or the client is External/Testing (7-day expiry). Fix the router, then `/mcp-auth gcloud` again. |
| `gcloud` connects with **0 tools** (`server_outcomes` says `forbidden`, 403) | The cloudcli API isn't enabled in the OAuth client's project (`kernal-oauth`), which the call is billed to. Enable it there (step 2), then reconnect. |
| 403 `mcp.tools.call` denied | Missing `roles/mcp.toolUser` (rerun `gcloud-mcp-iam.sh`), or the deny policy rejected the client: the router must use exactly the client id given to `gcloud-mcp-iam.sh`. Propagation takes a few minutes. |
| 403 "API not enabled" | `cloudcli.googleapis.com` is off: rerun `gcloud-mcp-iam.sh`. |
| Everyone asked to sign in again | The server row was edited (`FORCE_PURGE=1`) or recreated; the router purges all grants on any identity change (url, endpoints, client id/secret, scopes). Reconnect once each. |
| `redirect_uri_mismatch` | The client's redirect URI isn't exactly `https://router.kernal.one/callback`. |
| `access_denied` / "org_internal" | The signed-in account isn't in the Workspace organization (Internal client). Use a Workspace account; the owner decision is each person's own account. |
| Server not in the list | You aren't an operator (GA-2), or the server isn't registered: `./gcloud-mcp-router.sh` shows it. |

## Fallback

On a laptop, the local CLI always works: `gcloud --configuration=outfitter <command>` (and
`bq` with `CLOUDSDK_ACTIVE_CONFIG_NAME=outfitter`). Not planned, on purpose: gcloud plus a token
inside a Drive (the model could read it), or admin roles on `outfitter-agent` (the pod can reach
the metadata server).

## Follow-ons

Google's per-service remote MCP servers give structured tools instead of shell-like commands, and
can reuse this OAuth client, the router mode and the deny policy (same client id), one router row each (grants are per server, so each needs its own sign-in):
- Cloud Logging, `https://logging.googleapis.com/mcp`
- Cloud Monitoring, `https://monitoring.googleapis.com/mcp`
- Cloud Run, `https://run.googleapis.com/mcp`
- GKE, `https://container.googleapis.com/mcp` (GA)

Each also needs its API-side MCP enabled and `roles/mcp.toolUser`. The exact endpoints and enablement
are unverified here; check https://docs.cloud.google.com/mcp/supported-products before registering,
and note that adding a server is a new router row, so existing grants are untouched.
