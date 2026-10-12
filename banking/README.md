# Local Enable Banking proof of concept

Read-only access to your own bank accounts through [Enable Banking](https://enablebanking.com/), on this Mac only. Grok can call it as a local MCP server after you link a bank in the terminal.

This folder does not move money. It does not talk to Outfitter, and it does not belong on a cloud Drive.

## What you do once in the control panel

1. Sign in at <https://enablebanking.com/sign-in/>.
2. Open <https://enablebanking.com/cp/applications> and add an application.
3. Leave the environment on **Sandbox**. Leave the default, which creates the private key in the browser.
4. Set the redirect URL to exactly:

   ```
   http://127.0.0.1:8787/callback
   ```

5. Register. The browser downloads a file named with the application id, for example `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pem`. That file is the private key.

The application name is what the bank shows on the consent screen. Use a name you will recognize, such as `Local banking PoC`.

## Put the key outside the git checkout

From this directory:

```bash
node src/cli.mjs init --app-id <application-id> --key ~/Downloads/<application-id>.pem
```

`init` creates `~/.config/enablebanking/` (mode 700), moves the key there (mode 600), and writes `config.env` (mode 600). It refuses a key that sits inside this git checkout. Delete any copy left in Downloads.

Then confirm the key and the redirect URL:

```bash
node src/cli.mjs check
```

`check` calls `GET /application`. It prints the application name and environment. It does not print the key or a JWT.

## Link a sandbox bank

```bash
node src/cli.mjs banks --country FI
node src/cli.mjs link --country FI --name "Mock ASPSP"
```

`link` listens on `127.0.0.1:8787` only, opens the bank login, and waits up to five minutes. Sandbox **Mock ASPSP** needs no password. When the bank redirects back, the login code is exchanged and discarded. The session is stored in `~/.config/enablebanking/session.json` (mode 600).

The saved account list has a masked IBAN (last four characters). The full IBAN is not written to disk.

```bash
node src/cli.mjs accounts
node src/cli.mjs balances
node src/cli.mjs details
node src/cli.mjs transactions --days 30 --limit 20
node src/cli.mjs transaction --id <id-from-transactions>
```

`details` reads the account record: holder role, masked identifiers, credit limit, and address when the bank sends them. `transaction` reads one row by the id printed in `transactions`. `transactions` reads at most 40 rows and at most 90 days. Consent defaults to 10 days (`link --days 10`, maximum 90, and never longer than the bank allows).

Other sandbox banks and their test logins are listed in the [Enable Banking sandbox docs](https://enablebanking.com/docs/api/sandbox/). Start with Mock ASPSP.

To drop the saved session:

```bash
node src/cli.mjs unlink
```

## Use it from Grok

This checkout's `.grok/config.toml` is gitignored and starts the server over stdio. The config contains no secrets. The server reads `~/.config/enablebanking/` itself.

Open a new Grok session in this worktree. The server name is `enablebanking`. The tools are `status`, `banks`, `accounts`, `balances`, `details`, `transactions`, and `transaction`.

Linking stays in the terminal. The model cannot start a bank login, see the login code, or call a payment endpoint.

For a Kernal session, add the same command to that project's `.pi/mcp.json` and keep that file out of git:

```json
{
  "mcpServers": {
    "enablebanking": {
      "command": "node",
      "args": ["<absolute-path-to>/banking/src/mcp.mjs"]
    }
  }
}
```

## Rules the program enforces

- The Enable Banking JWT is signed locally with RS256, lives for five minutes, and is not logged.
- HTTP redirects are not followed, so the `Authorization` header cannot be sent on to another host.
- The only API paths that can be called are application info, the bank list, consent start, session read, account details, balances, the transaction list, and one transaction. Payment paths are rejected.
- The callback is `http://127.0.0.1:<port>/callback` or `https://127.0.0.1:<port>/callback`. `localhost`, a tunnel, and any public host are rejected.
- The callback checks the `state` value from this process. A mismatch does not reveal the login code.
- The private key, `config.env`, and `session.json` must be mode 600, owned by you, and not symlinks. Their directory must not be readable by the group or by others.
- `ENABLEBANKING_ALLOW_PRODUCTION=1` is ignored if it is written in `config.env`. A production key also has to match `ENABLEBANKING_ENVIRONMENT=production`.
- Tool results mask IBANs. Account ids and the session id are not returned to the model.

## Real accounts, later

Sandbox keeps `http://127.0.0.1:8787/callback`. A production application has to use HTTPS. Run `node src/cli.mjs tls` once. It creates a local certificate whose authority can only name `127.0.0.1`, stores it in `~/.config/enablebanking/tls/`, and asks macOS to trust it. Register this URL on the production application:

```
https://127.0.0.1:8787/callback
```

A live bank needs a separate **Production** application and its own key. Install that key beside the sandbox one. This command does not touch `~/.config/enablebanking/`:

```bash
ENABLEBANKING_ALLOW_PRODUCTION=1 node src/cli.mjs init --environment production --app-id <application-id> --key ~/Downloads/<application-id>.pem
```

That writes `~/.config/enablebanking-prod/` with the https redirect. The allow flag stays in the shell and is not written to `config.env`. Later commands for that application need both:

```bash
ENABLEBANKING_CONFIG_DIR="$HOME/.config/enablebanking-prod" ENABLEBANKING_ALLOW_PRODUCTION=1 node src/cli.mjs check
```

The payment block stays in place. Consent at a real bank is the real consent screen, and the data that comes back is your real balances and transactions.

## Wise, local Kernal tools

A second stdio server reads one Wise profile. It is not registered on `router.kernal.one` and it does not belong on a Drive. A Kernal session on this Mac can load it from that project's `.pi/mcp.json`, which stays out of git:

```json
{
  "mcpServers": {
    "wise": {
      "command": "node",
      "args": ["<absolute-path-to>/banking/src/wise-mcp.mjs"]
    }
  }
}
```

The tools are `wise_status`, `wise_profiles`, `wise_balances`, and `wise_statement`. The model cannot start a login or call a payment endpoint.

```bash
node src/wise-cli.mjs status
node src/wise-cli.mjs balances
node src/wise-cli.mjs statement --balance 1 --days 30
```

The credential is the existing Secret Manager secret `projects/97916961297/secrets/kernal_wise_key` in project `outfitter-509211`. It is read with `gcloud --configuration=outfitter` into memory and is not written to disk. A raw API key is sent as `Authorization: Bearer` to `https://api.wise.com`. That path lists every profile and numbers balances from 1 across them. The profile index is stored in `~/.config/finance/wise/key/` (mode 600) and the key itself is not. JSON with `client_id` and `client_secret` is the OAuth path instead. `WISE_API_TOKEN` and `WISE_PERSONAL_TOKEN` are refused.

OAuth `link` listens on `127.0.0.1:8788` and opens the Wise sandbox login. The redirect URL to register on the Wise app is exactly `http://127.0.0.1:8788/callback`. The refresh token is stored in `~/.config/finance/wise/sandbox/`. `WISE_ALLOW_PRODUCTION=1` in the shell switches that OAuth host to `https://api.wise.com` and the directory to `~/.config/finance/wise/production/`. The flag is not read from a file. An API key always uses the production host, because a live account key does not work against the sandbox. A statement that Wise answers with an in-app approval stops. This program does not complete that challenge.

Reading the secret from a laptop needs a working Outfitter `gcloud` login (`gcloud auth login` as `mgm@mgms.eu` on the `outfitter` configuration). Until that login works, the local tools still start and `wise_status` reports the credential as unavailable.

## Finance MCP, Cloud Run

`src/finance-mcp.mjs` is the HTTP server for the same read-only tools. Wise is the first upstream. The next one is added in `buildUpstreams`. The process listens on `$PORT` (8080 in Cloud Run). `GET /health` is open. `POST /mcp` requires `Authorization: Bearer` matching `FINANCE_MCP_TOKEN`.

On Cloud Run (`K_SERVICE` is set) the process reads `projects/97916961297/secrets/kernal_wise_key` with the metadata server token and keeps the payload in memory for ten minutes. The Wise key is not mounted as an environment variable and is not the caller token. The balance index is written under `/tmp/finance/wise` on that instance, so the service runs with `--max-instances=1`.

```bash
DRY_RUN=1 bash deploy/finance-mcp.sh
bash deploy/finance-mcp.sh
```

The script creates service account `kernal-finance-mcp`, secret `kernal-finance-mcp-token`, and Cloud Run service `kernal-finance-mcp` in `outfitter-509211` / `us-central1`. It grants that account `secretAccessor` on `kernal_wise_key` and on the caller token. It does not register the server on `router.kernal.one`.

## Keep this off the Outfitter sandbox

Outfitter sessions are shared in the org, and a tool result is stored with the session. Do not add this MCP server to a Drive, to `render-mcp`, or to a sandbox image. A Drive run reaches the finance service only when that run's router key is granted the server id. Leave `wise` out of the shared `x-mcp-servers` list.

`~/.config/enablebanking/` should stay on this Mac. Don't put it in iCloud Drive, Dropbox, or the repository. A Time Machine backup of this user account will include the key.
