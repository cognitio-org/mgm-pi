# Drive previews: open a Drive's dev server from the browser

Status: built (phases 1–3). Owner decisions of 2026-09-27 are folded in. Builds on #121 (background jobs, PR #221).

- **Phase 1:** the `preview` tool (#225, `kernal/.pi/extensions/kernal-background/preview.ts`) and
  agentd's preview listener, local proxy and ngrok runner (#226, `packages/agentd/src/preview*.ts`).
- **Phase 3:** the session page (`packages/web/src/components/PreviewChips.tsx`,
  `packages/api/src/routes/previews.ts`): a chip per previewed port that opens it in a new tab, and,
  for the floppy's owner or a sysop, "Share…" behind a confirm that makes the public link (1 h,
  24 h or 7 days, capped by `PREVIEW_SHARE_MAX_SECONDS`), shown with its expiry, a copy button and
  Stop. Share links are only ever made there.
- **Phase 2:** the api (`packages/api/src/previews.ts`, `ngrok-api.ts`): per-run credentials in
  run.spec, cloud endpoints with the secure and share policies, cleanup on close, bye and the tick's
  sweep. Deploy: `PREVIEW_DOMAIN` (config.env, default kernal.run), `PREVIEW_ALLOW` (IAP_MEMBERS plus
  the operators, set by service.sh), and the `outfitter-ngrok-google-oauth` secret.
- **Verified live on 2026-09-27** against the real account and `*.kernal.run`:
  - a credential with `bind:*.<run>.internal` binds only its own run's names;
  - ngrok accepts both policies as `previews.ts` builds them (JSON, the `oauth` action with our client
    and its required `openid` and `userinfo.email` scopes, `add-headers`);
  - the share notice, cookie and forward work;
  - the secure link signs in through our Google client;
  - `closeRun` leaves nothing behind.
- **Security review of the api side (#227), resolved:**
  - a sandbox's `preview.open` with `share` is refused (`share-not-allowed`), and the tool has no
    `share` option; share links come only from the person, on the session page (phase 3);
  - the share notice is acknowledged only by its own form, a same-origin `POST` to
    `/__kernal_preview_ack` (checked live), so a crafted `?ack` link or another site can't skip it;
  - every endpoint and credential carries `{purpose: "outfitter-preview", env: PREVIEW_ENV}` (env
    defaults to the GCP project), and the sweep touches nothing else, so hand-made or another
    environment's endpoints on the same account are never removed;
  - emails are compared lowercased at the edge (`lowerAscii()`, checked live), responses carry HSTS
    (`.run` isn't preloaded), each run gets at most 20 opens an hour, and concurrent opens share one
    endpoint.
- **Known gap: `domain:` entries.** IAP's `domain:example.com` means members of that Workspace
  domain; ngrok's edge can only match an email ending `@example.com`, which also admits a personal
  Google account registered with such an address. ngrok doesn't expose Google's `hd` claim to the
  policy. Accepted for now; list explicit `user:` entries in `IAP_MEMBERS` if that matters.
- **Settled open decisions:** share links default to 24 h, 7 days at most
  (`PREVIEW_SHARE_TTL_SECONDS`, `PREVIEW_SHARE_MAX_SECONDS`), with a first-visit notice page at
  ngrok's edge. Drives come first; the desktop tool returns localhost.

## Problem

A model in a Drive starts a dev server (`npm run dev`, `vite`, `next dev`, a docs preview) as a
background job. The person wants to open that page in their own browser, click around, and see
changes land. Today nothing can reach it:

- **GKE sandbox:** no ingress at all (`networkPolicy.ingress: []`, "no Sandbox Router",
  `deploy/gke/sandbox-template.yaml:26-28`). Egress is TCP 443/80 to public addresses, the metadata
  server, and DNS (`:29-48`).
- **Cloud Run job:** no inbound port either.

On the desktop there is no problem: the server is on `localhost`.

## Decisions (owner, 2026-09-27)

- **Approach:** ngrok, done safely (below). Our own reverse proxy (option A) and Cloudflare Tunnel
  were considered and not chosen.
- **Domain:** `kernal.run`, registered by the owner. A preview's URL is
  `https://<id>.kernal.run`, where `<id>` is 128 random bits (base32).
- **Idle-stop:** browsing a preview counts as activity, capped at 2 h past the last chat turn.
- **Access:** two modes, chosen per preview:
  - **secure:** anyone with session access;
  - **share:** an anonymous, time-boxed link.

## Requirements

1. **One tool, both modes.** On the desktop it returns `http://localhost:<port>`; in a Drive, an HTTPS
   URL. The model learns one call.
2. **Only the right people get in.** Secure previews check a Google identity at the edge. Share links
   are unguessable and expire. Nothing the sandbox controls can loosen either.
3. **The preview can't reach the person's Outfitter session.** A preview is model-written code in the
   person's browser, so it must be cross-site to `app.kernal.one` and `link.kernal.one`, and
   cross-origin to every other preview (see "Origin model").
4. **Real dev servers work:** HTTP streaming, WebSocket (HMR), SSE, and absolute paths. One host per
   preview avoids path-prefix breakage.
5. **Nothing in the sandbox can make a preview public, or open a tunnel for another run.**
   - The ngrok API key never enters the sandbox.
   - The sandbox's own credential is per run and can only bind that run's private endpoints.
6. **A preview's lifetime is bounded by its job and its Drive.** Nothing leaks after an api crash.

## The job API this builds on (#121)

PR #221's `background` tool (`kernal/.pi/extensions/kernal-background/`, `jobs.ts` and `index.ts`)
has `action: run | list | logs | kill`.

- **`run`:**
  - takes `command`, `kind: server | batch`, `name`, `cwd`, and, for a batch, `timeout_seconds`
    (default 30 min, at most 24 h);
  - returns an id (`bg1`), the pid and the log path;
  - a server has a hard cap of `KERNAL_BG_SERVER_MAX_HOURS` (default 12 h).
- **End of a job:** exactly one `pi.sendMessage` custom message (`customType: "kernal-background"`,
  followUp and triggerTurn) with the status, exit code, last 15 lines and log path. The model's own
  `kill` returns that result in the tool result instead; reaping at session end sends nothing.
- **Lifetime:** jobs are per pi process, each in its own process group. They are reaped at
  `session_shutdown` or process exit, and a watchdog follows pi's pid.

Previews add:
- **`background` `run` gains `port?: number`:** a hint only, so `preview(jobId)` works without the
  model repeating the number.
- **A separate `preview(port | jobId)` tool** in the same extension, not a `background` action:
  - `background` stays about process lifetime, with one schema on the desktop and in a Drive;
  - exposing a port to a person is a different capability, with its own policy;
  - `preview` can also serve a port started some other way.
  - Desktop: it probes `127.0.0.1:<port>` and returns `http://localhost:<port>`, or says nothing is
    listening.
  - Drive: it returns the secure URL (below).
- **A preview ends with its job.** JobManager's `onEnd` (exit, kill, timeout, server cap, reaping)
  tells agentd to drop the port. The job's end notice or `kill` result says the preview is gone.

The model can only create **secure** previews. A share link is made by a person, from the session
page (phase 3), never by the model: otherwise a model could publish the sandbox to the internet.

## Why not naive ngrok

The obvious setup: put the account's authtoken in the sandbox and run
`ngrok http 3000 --oauth google --oauth-allow-email …`. It fails requirement 5 twice:

- **The policy lives in the agent's flags.** Anything that can run `ngrok` in the sandbox can run it
  again without `--oauth` and get a public URL.
- **The authtoken is account-wide.** Anyone holding it can open any tunnel on our account, including
  on our own domain: phishing pages on `*.kernal.run`, or tunnels posing as other runs.

This design moves both out of reach:

- The **public** endpoint, and its Traffic Policy, is created by the api through the ngrok API.
- The sandbox only ever **binds a private internal endpoint**. Internal endpoints (`*.internal`)
  receive no internet traffic; they're reachable only through a cloud endpoint's `forward-internal`
  action, which only the api configures.
- The sandbox's credential is scoped to its own run's internal names, and deleted at run end.

## Design

### 1. Per-run ngrok credential (api)

When the api builds `run.spec` for a Drive (`agentlink.ts` `buildRunSpec`):

- **Create:** it calls the ngrok API to create a **credential** (an authtoken) restricted by ACL to
  binding internal endpoints under that run's own name, e.g. `bind:*.<runId>.internal`. It is
  delivered in `run.spec.secrets` as `ngrokAuthtoken` (`RunSpecSecrets`,
  `packages/agentd/src/protocol.ts:286`).
- **UNVERIFIED:** ngrok's documentation shows `bind:` ACL rules for public domains and labels. That a
  rule can restrict binds to an internal hostname pattern, and that ngrok enforces it, must be proven
  against our account before phase 2 (the owner's checklist, below).
- **Handling:** agentd holds the token as root, like the GitHub credential (protocol.md "Two Linux
  users inside the sandbox"). pi and the model run as `agent` and shouldn't be able to read it. Treat
  that as defence in depth, not the guarantee: if it leaks, the worst it allows is binding private
  endpoints for this run, which nothing can reach without an api-made cloud endpoint.
- **Delete:** when the run ends (`bye`, stop, or the reconciler failing it), the api deletes the
  credential. The sweeper (§5) catches misses.
- **Reconnect:** the same credential is reused, since a reconnect ignores a second `run.spec`.

### 2. In the sandbox (agentd)

The `preview` tool never sees the credential. It calls agentd's loopback listener, the same pattern as
`browser_capture`:

- The pi extension calls `http://127.0.0.1:<port>/…` with a per-run token header
  (`outfitter-browser.ts:21,104,135`).
- agentd binds 127.0.0.1 only, checks the token, and on Linux checks the peer uid
  (`browser-capture.ts:1-12,93`).

On `POST /preview {port}`, agentd:

1. **Checks the port** is 1024–65535 and has a listener on `127.0.0.1:<port>`, and that it is not
   agentd's own ports.
2. **Starts a small local reverse proxy** on a fresh loopback port.
   - It forwards only to `127.0.0.1:<registered port>`, never another address, so it can't reach the
     metadata server or the cluster.
   - It passes HTTP and WebSocket upgrades through unchanged, and rewrites `Host` to
     `localhost:<port>` (vite/next reject unknown hosts).
   - It counts **page requests** for idle-stop (§4).
3. **Starts, as root,** `ngrok http <proxy port> --url https://p<port>.<runId>.internal` with the
   per-run credential. The `agent` user can't signal a root process, so the model can't swap it for
   its own.
4. **Asks the api for the public side:** an up-frame `preview.open {requestId, port}`, answered by
   `preview.result {requestId, url | error}`.
   - It isn't seq/ack-replayed; like `browser.capture.request`, a dropped link retries it.
   - A `preview.close {port}` up-frame goes out when the job ends (JobManager `onEnd`, via the
     extension calling `DELETE /preview/<port>` on the loopback listener) or the port stops
     listening.
   - On `bye`, agentd kills every ngrok agent and proxy.

**Image:** the `ngrok` agent binary is added to the sandbox image (pinned version, checksum-verified).
It only needs outbound TCP 443, which `sandbox-template.yaml:32-33` already allows.

### 3. Public side (api only)

On `preview.open`, the api creates, through the ngrok API with the key from Secret Manager, a
**cloud endpoint** `https://<id>.kernal.run` with a Traffic Policy the sandbox can't see or change.
It records `{previewId, runId, sessionId, port, mode, expiresAt}` in the store and returns the URL.

**Secure mode:**
```yaml
on_http_request:
  - actions:
      - type: oauth
        config: { provider: google }          # production: our own Google OAuth client
  - expressions:
      - "!(actions.ngrok.oauth.identity.email in ['a@x', 'b@y'])"   # emails with session access
    actions:
      - type: deny
  - actions:
      - type: forward-internal
        config: { url: "https://p3000.<runId>.internal" }
on_http_response:
  - actions:
      - type: add-headers
        config: { headers: { strict-transport-security: "max-age=31536000; includeSubDomains" } }
```
- **The allowlist** is the same rule as `GET /api/sessions/:id` access. The api updates the endpoint's
  policy whenever the session's access changes.
- **OAuth client:** ngrok's managed Google app is for testing only; production uses our own OAuth
  client, whose consent screen names Kernal.
- **Why OAuth and not JWT validation:** ngrok's `jwt-validation` reads a token from a header or the
  body, not a cookie, so it can't gate a browser opening a link.

**Share mode.** A person clicks "Share link" on the session page and picks a TTL (default 24 h, at
most 7 days).
- The api creates a second cloud endpoint with a fresh random id: interstitial, then
  `forward-internal`, and the same HSTS header.
- **Interstitial, not a banner:** the first visit gets a `custom-response` page ("This is an
  AI-built preview from a Kernal session. Don't enter passwords or payment details.") with a
  Continue button that sets a host-only cookie. Later requests carrying the cookie pass straight to
  `forward-internal`.
  - The edge enforces it, and the sandbox can't remove it.
  - Injecting a banner into the app's HTML would be fragile (CSP, streaming, non-HTML responses) and
    would have to happen in the sandbox's proxy, which the model's server output could fight.
  - **UNVERIFIED:** that Traffic Policy expressions can read request cookies (`req.cookies`) for this
    check.
- **Lifetime:** the api deletes the endpoint at TTL, and always when the job or the Drive ends,
  whichever comes first.

### 4. Idle and lifetime

- **Browsing is activity.**
  - agentd's proxy counts every non-upgrade HTTP request as a page request. WebSocket frames and
    HMR pings are not counted.
  - At most once a minute, a page request calls the same path as `markActivity`
    (`packages/agentd/src/run.ts:985-998`), which re-arms idle-stop (default 30 min,
    `deploy/config.env:14`).
  - This extension stops 2 h after the last chat turn, so a forgotten tab or a polling page can't keep
    a Drive billing.
- **A preview needs its job.** Job end removes the port (`onEnd` → `preview.close` → the api deletes
  its cloud endpoints). When no ports remain, agentd stops the ngrok agent and proxy.
- **Drive stop.** `bye` makes the api delete every cloud endpoint for the run and then its
  credential. The job doesn't survive the next wake (#121), so after Play the model starts it again
  and calls `preview` again. The URL is new each time.

### 5. Cleanup and the sweeper

`POST /api/hooks/tick` (`packages/api/src/routes/hooks.ts:105`) gains a sweep. It lists the account's
cloud endpoints and credentials through the ngrok API and deletes any that:
- are tagged with a run that isn't live;
- are past their TTL;
- have no store record.

Every endpoint and credential the api creates carries metadata `{outfitter: <runId>}` so the sweep
can match them. So an api crash between "create" and "record", or a missed `bye`, leaks nothing for
longer than one tick.

### 6. Origin model

`kernal.run` is a separate registrable domain from `kernal.one`, so previews are **cross-site** to
Outfitter. A model-written page can't send the person's `SameSite=Lax` cookies (IAP's included) to
the api, and can't set `Domain=kernal.one` cookies. With one host per preview, previews are
cross-origin to each other.

`.run` isn't HSTS-preloaded. Every preview is HTTPS-only (ngrok cloud endpoints serve HTTPS), and each
policy adds a `Strict-Transport-Security` header. Preloading `kernal.run` is optional later.

### 7. Where keys live

| Secret | Where | Who can use it |
|---|---|---|
| ngrok API key | Secret Manager, read by the api only | creates and deletes endpoints and credentials |
| per-run ngrok credential | `run.spec.secrets`, held by agentd as root | binds `*.<runId>.internal` only (UNVERIFIED ACL) |
| Google OAuth client secret | ngrok, set by the owner on the account/endpoint | ngrok's OAuth action |

## Options considered

| | ngrok, safe (chosen) | A. Our own reverse proxy | Cloudflare Tunnel + Access | Naive ngrok |
|---|---|---|---|---|
| Public policy set by | the api, via the ngrok API | our code | Cloudflare Access (edge) | the sandbox's agent flags |
| Secret in the sandbox | per-run credential, own internal names only | none | per-tunnel connector token | account authtoken |
| Login | Google via ngrok OAuth | IAP / Dongle via a grant | Cloudflare Access | Google via ngrok OAuth |
| Build size | medium | largest (third Cloud Run role, tunnel protocol) | medium | small |
| Fixed cost | ngrok plan (≈ $20/month) | global LB + wildcard cert (≈ $18–25/month) | ≈ $0 | ngrok plan |
| Why not | chosen | largest build, a new always-on service | a second vendor and login, a Cloudflare DNS move | fails requirement 5 (see above) |

## Plan and cost

- **The plan needed:** ngrok **Pay-as-you-go** (≈ $20/month) covers our own domain, wildcard
  endpoints, and no ngrok interstitial.
- **The account we already have:** it serves the LM Studio tunnel (`TUNNEL_DOMAIN_LMSTUDIO`,
  `deploy/config.env:11`) and may already be on a plan; to verify.
- **Traffic:** billed by ngrok's data transfer allowance, not Cloud Run egress.

## Tradeoffs

- **ngrok terminates TLS** and sees all preview traffic.
- **A second login surface:** Google through ngrok's OAuth, not IAP. Session access is enforced by our
  allowlist, which must be kept in sync.
- **Allowlist sync:** a missed update leaves an ex-member able to open a still-live preview until it
  ends. Mitigations: the tick re-syncs allowlists for live previews, and previews are short-lived.
- **API rate limits:** each preview means several ngrok API calls (endpoint create, policy updates,
  deletes, the sweep). The limits must be checked against a busy hour.
- **A third party in the path:** an ngrok outage means no previews. Runs themselves are unaffected.

## Phases

1. **Tool and sandbox:**
   - the `preview` tool plus the desktop path (probe, localhost);
   - agentd's loopback route, local proxy, and ngrok runner;
   - the `preview.*` frames;
   - testable locally with a scratch ngrok token and a hand-made cloud endpoint.
2. **api ngrok integration:**
   - per-run credentials;
   - cloud endpoints with both policies;
   - allowlist sync, cleanup on job end, stop and run end;
   - the tick sweeper.
3. **Web:** an "Open preview" chip per live preview, and a "Share link" button with a TTL picker, a
   list of active links, and revoke.
4. **Owner setup, then a real Drive test:**
   - register `kernal.run`;
   - add the domain to ngrok, with a wildcard CNAME and verification;
   - create our Google OAuth client and put it in ngrok;
   - add the ngrok API key to Secret Manager.

## Owner verification before phase 2

A one-command script (written separately) that, against the real account:

1. **Proves the ACL:** creates a credential with `bind:*.<test>.internal`. Binding
   `https://x.<test>.internal` must succeed; binding `https://x.<other>.internal` and any public
   domain must fail.
2. **Proves `forward-internal`:** a cloud endpoint forwarding to that internal endpoint works, and
   the internal endpoint is unreachable directly.
3. **Proves cookie matching:** a Traffic Policy expression can read request cookies, for the share
   interstitial.
4. **Reports the plan:** the account's plan and features (own domain, wildcard, OAuth, no
   interstitial).
5. **Reports the API rate limits.**

## Open decisions

1. **Share-link TTL:** proposed default 24 h, maximum 7 days.
2. **Notice style for share links:** proposed an edge interstitial on first visit (above), rather than
   an injected banner.
3. **Drive-only at first,** with the desktop tool just returning localhost: proposed yes.

## Risks

- **An unverified ACL.** If ngrok can't restrict binds to a run's internal names, a leaked per-run
  credential could bind other runs' internal names. The fallback is to have the api bind on the
  run's behalf, which isn't possible with ngrok today; the design would need revisiting. That's why
  it's the first item on the checklist.
- **Phishing:** a share link can render anything, including a fake login. The interstitial, the
  non-brand domain, short TTLs, and share links being person-made only are the mitigations.
- **Allowlist drift** (above) and **ngrok availability.**
- **Idle cost:** bounded by the 2 h cap past the last chat turn.
