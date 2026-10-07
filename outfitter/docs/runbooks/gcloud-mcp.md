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

1. **Create the OAuth client.** Google Cloud console, project `outfitter-509211`, APIs & Services,
   OAuth consent screen. The user type must be **Internal** (an External app in Testing expires
   refresh tokens after 7 days). Then Credentials, Create credentials, OAuth client ID, type
   **Web application**. Authorized redirect URI: `https://router.kernal.one/callback` (the router
   builds its MCP OAuth callback as `<base url>/callback`). Copy the client ID and secret.
   Internal needs the project inside a Workspace organization; if the console only offers
   External, stop and ask: External is not acceptable here.
2. **Store the client secret** in Secret Manager as `outfitter-gcloud-mcp-oauth-client-secret`,
   straight from the console download or clipboard, never into a file in the repo:
   `pbpaste | gcloud --configuration=outfitter secrets create outfitter-gcloud-mcp-oauth-client-secret --data-file=-`
   (`secrets versions add` for a rotation). The name starts with `outfitter-`, so
   `secret-scope.sh`'s rules cover it.
3. **Check the router has GA-1** (#491): Google needs `access_type=offline` and `prompt=consent` on
   the authorize request or it issues no refresh token. Without it a grant dies after an hour.
4. **Register the server.**
   `DRY_RUN=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<client id> ./gcloud-mcp-router.sh`, then
   `CONFIRM=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<client id> ./gcloud-mcp-router.sh`.
   It reads the client secret and the router master key from Secret Manager (never printed), and
   registers the `gcloud` server as `oauth2` authorization code. Settle the config now: editing an
   existing server purges every user's grant, so the script only shows an existing server unless
   `FORCE_PURGE=1`. If GA-1 added a field for the authorize params, pass it in `EXTRA_FIELDS_JSON`.
5. **Grant IAM and the deny policy.** `DRY_RUN=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<client id> ./gcloud-mcp-iam.sh`,
   then the same without `DRY_RUN`. It enables `cloudcli.googleapis.com`, grants
   `roles/mcp.toolUser` to the operators (`OUTFITTER_OPERATORS`, override with `GCLOUD_MCP_SYSOPS`),
   and creates the deny policy `gcloud-mcp-gateway-only`: `mcp.googleapis.com/tools.call` is denied
   to everyone unless `request.auth.oauth.client_id` is the router's client. Writing deny policies
   needs `roles/iam.denyAdmin` on the project (Owner does not include it): grant it to yourself,
   run, remove it. The policy covers every Google remote MCP server in the project; the follow-on
   servers below use the same client, so they pass.
6. **Test** as a sysop (next section): connect, run `gcloud projects describe outfitter-509211`,
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
