# Drive previews: open a Drive's dev server from the browser

Status: design, not built. Builds on #121 (background shell jobs). Owner decisions are at the end.

## Problem

A model in a Drive starts a dev server (`npm run dev`, `vite`, `next dev`, a docs preview) on a
port inside the sandbox. The person wants to open that page in their own browser, click around, and
see changes land (HMR). Today nothing can reach it:

- The GKE sandbox has no ingress at all: `networkPolicy.ingress: []`, "no Sandbox Router"
  (`deploy/gke/sandbox-template.yaml:26-28`). Egress is TCP 443/80 to public addresses, the
  metadata server, and DNS (`:29-48`).
- The Cloud Run job has no inbound port either.
- The only path in is agentd's own outbound WebSocket to the link role (`protocol.md`
  "agentd ⇄ api").

On the desktop there is no problem: the server is on `localhost` and the person opens it.

## Requirements

1. **One tool for the model, both modes.** On the desktop it returns `http://localhost:<port>`. In
   a Drive it returns an HTTPS URL. The model learns one call, the same as #121's one job API.
2. **Only the right people can open it:** the session's owner and anyone who can already open the
   session. A preview is never public by default, and never reachable by guessing a URL.
3. **The preview can't reach the person's Outfitter session.** The app is model-written code
   running in the person's browser. It must not be able to:
   - read or overwrite the `app.kernal.one` / `link.kernal.one` cookies;
   - send credentialed requests to them (CSRF);
   - read other previews.
   See "Origin model".
4. **Real dev servers work:**
   - HTTP/1.1 streaming;
   - WebSocket (vite/next/webpack HMR);
   - server-sent events;
   - absolute paths (`/assets/x.js`, `/_next/...`, `/@vite/client`). Path-prefix proxies break
     that last one, so each preview gets its own host.
5. **No new secret the model can read.** Anything in the sandbox is the model's (option B:
   everything the `agent` user can read or reach).
6. **Lifetime follows the job and the Drive.** The preview dies when its job exits, is killed, or the
   Drive stops (#121's reaping). It never outlives the sandbox.
7. **Low spend** (`memory: outfitter-project`), and nothing per-preview in GCP.

## The job API this builds on (#121)

#121 gives the model `bg_run(command, kind: "server" | "batch", deadline?)` → `id`, plus status,
log tail, kill, and one completion notice. Previews add one optional field and one tool:

- **`bg_run(..., port?: number)`:** a hint that this server listens on `port`. It is not required.
- **`preview(port | jobId)`:** registers the port for the session and returns the URL:
  - desktop: `http://localhost:<port>`;
  - Drive: `https://<previewId>.<preview-domain>/`.
  It fails fast if nothing is listening yet (agentd connects to `127.0.0.1:<port>` once), and says so
  instead of returning a dead link. When the job exits or is killed, the preview is dropped and the
  notice says so.

The model tells the person the URL. The session page shows an "Open preview" chip for each live
preview (later: in the jobs row #121 describes under "Web, later").

## Options

| | A. Reverse proxy through Outfitter | B. Cloudflare Tunnel per Drive | B'. ngrok in the sandbox | C. GKE-native (Gateway/Ingress) |
|---|---|---|---|---|
| Path in | browser → preview host (own Cloud Run role) ← agentd's outbound tunnel socket | browser → Cloudflare edge ← `cloudflared` in the sandbox (outbound 443, `--protocol http2`) | browser → ngrok edge ← `ngrok` agent in the sandbox | browser → GCLB → Service → pod |
| Who can open it | Outfitter's own check: session access, via a grant from the web role | Cloudflare Access policy on the hostname (enforced at the edge; the model can't change it) | ngrok OAuth/IP policy, **set by the agent's own flags**: the model can drop it and go public | IAP on the backend |
| Secret in the sandbox | none (id token + run token already there) | a per-tunnel connector token: it can only run that one tunnel, and the api deletes the tunnel at stop | the account authtoken: the model can open any tunnel on our account (phishing on our domain) | none |
| Origin isolation | separate registrable domain, host per preview | same, on Cloudflare DNS | `*.ngrok.app` or a reserved domain | own domain |
| HMR / WebSocket | yes (proxied frames) | yes | yes | yes |
| Cloud Run limits | 60 min per request/socket; both reconnect (HMR clients do) | none | none | none |
| Works on Cloud Run provider | yes | yes | yes | **no** (GKE only) |
| Fixed cost | global external LB + wildcard cert: ≈ $18–25/month | $0 (Tunnel free; Access free to 50 users) | paid plan for OAuth + reserved domain (≈ $20+/month) | LB + cert, plus per-sandbox routes |
| New dependency | none | Cloudflare account, domain on Cloudflare, API token in the api | ngrok account (already used for LM Studio) | Gateway API, sandbox ingress opened |
| Build size | largest: preview role, tunnel protocol, agentd tunnel client (≈ 1–1.5k lines with tests) | medium: tunnel/DNS/Access lifecycle in the api, `cloudflared` in the image (≈ 40 MB) | small, but the auth hole makes it unshippable as is | large, and ingress into gVisor pods |

D. **Rejected:**
- **Tailscale Funnel:** public with no auth, or tailnet-only, which people don't have.
- **Sidecar on Cloud Run:** the Drive isn't a service.
- **Path prefix on one shared host** (`/p/<id>/`): breaks absolute paths, and every preview then
  shares one origin, so one preview's JS can read another's with the viewer's cookie.

## Recommendation: A, with B as the fallback if the load balancer's cost or ops are unwelcome

**A keeps auth, identity and lifetime inside Outfitter:**
- the same session-access rule as the page, and the same Dongle for the Chrome companion;
- no third party;
- no secret in the sandbox;
- works for both providers.

**Its cost:** a global load balancer (for the wildcard host) and the largest build. **B** is the
credible cheaper route. Its edge enforces Access, so a model can't open the preview to the world.
The price is a second identity system (Cloudflare Access login rather than IAP/Google via Outfitter)
and a Cloudflare dependency. ngrok (B') is out unless it is given per-run credentials the model
can't use to open other tunnels.

### A in detail

**Preview role.** `packages/api`'s image gains `OUTFITTER_ROLE=preview`, a third Cloud Run service,
`outfitter-preview`. It is `--allow-unauthenticated`, because its own cookie check is the gate (IAP
can't sit in front of it; see "Auth"). Why a separate role:
- **Scaling:** it pins `--max-instances=1` so the browser's request and agentd's tunnel socket meet in
  one process. Today a web-role message reaches a link-role socket only through Mongo, polled every
  1.5 s (`agentlink.ts:381-414`), and the link scales to 40 instances. That is fine for prompts,
  useless for HTTP.
- **Isolation:** the control link keeps its current scaling and protocol, and preview traffic can't
  push against the api's 256-frame pre-accept buffer or agentd's 128-frame seq window (`link.ts:38`).

One instance (concurrency 1000) is ample at Outfitter's size. A restart drops live previews:
agentd's tunnel reconnects with backoff, and the browser retries.

**Tunnel socket.** When the model calls `preview`, agentd opens a second WebSocket to
`wss://<preview-host>/tunnel?run=<runId>` with the same `Authorization: Bearer <id token>`, then
sends `hello {runId, runToken}`, checked exactly as `agentlink` checks it (and, after #216, the
sandbox identity only for gke runs). It carries binary frames, one multiplexed stream per browser
request:

| frame | direction | meaning |
|---|---|---|
| `open {sid, port, method, path, headers}` | preview → agentd | new HTTP request or WebSocket upgrade (`upgrade: true`) to `127.0.0.1:<port>` |
| `data {sid, bytes}` | both | body / WebSocket message bytes, ≤ 64 KiB each |
| `head {sid, status, headers}` | agentd → preview | response head (or `101` for an upgrade) |
| `end {sid}` / `reset {sid, reason}` | both | stream done / aborted (port closed, client gone, limit hit) |
| `credit {sid, bytes}` | both | flow control: each side sends at most 256 KiB unacknowledged per stream |
| `ports {open: [port]}` | agentd → preview | ports registered by `preview`, sent on connect and on change |

It isn't seq/ack-replayed. A dropped tunnel resets its streams, and browsers retry. It rotates at
55 minutes like the link (`link.ts:142`); open streams reset at rotation, and HMR clients reconnect
on their own. agentd only dials ports the model registered, only on `127.0.0.1`, never another
address, so the tunnel can't become a proxy into the cluster or the metadata server.

**Header hygiene.**
- Dropped inbound: the preview cookie, any `authorization` the browser added for us, `x-goog-*`, and
  hop-by-hop headers.
- `Host` is rewritten to `localhost:<port>`, since dev servers check it (vite `allowedHosts`).
- `X-Forwarded-Host/Proto` are set.
- Outbound, `Set-Cookie` with a `Domain` attribute is refused (host-only cookies only). A response
  `Content-Security-Policy` is left to the app.
- Every response gets `Cross-Origin-Resource-Policy: same-site` and never any CORS allowance for the
  Outfitter origins.

## Origin model (both A and B)

Previews live on a **separate registrable domain**, never under `kernal.one`, e.g.
`*.kernal-preview.app` (owner picks; see "Open decisions"), one host per preview:
`<previewId>.<domain>`, where `previewId` is 128 bits of randomness, not the session id. Why not a
`kernal.one` subdomain: every `*.kernal.one` host is **same-site** with `app.kernal.one`, so:
- `SameSite=Lax` cookies (IAP's included) ride along on requests a preview page makes to the api,
  so a model-written page could CSRF the person's session;
- a preview host could set `Domain=kernal.one` cookies (cookie tossing);
- `kernal.one` sends HSTS `includeSubDomains` (`deploy/README.md:554-556`), which only helps HTTPS,
  not isolation.

A separate registrable domain makes previews cross-site to Outfitter. A host per preview makes them
cross-origin to each other.

## Auth (A)

1. **The web role mints a grant.** The person clicks "Open preview" on the session page (IAP), or the
   companion calls the link with a Dongle. That role checks session access (the same rule as
   `GET /api/sessions/:id`) and mints a **grant**: an HMAC-signed `{previewId, email, exp: 60 s}`,
   key in Secret Manager, shared by the web, link and preview roles.
2. **The preview host sets its own cookie.** The browser goes to
   `https://<previewId>.<domain>/__outfitter/auth?grant=…`. The preview role verifies it and sets a
   **host-only**, `HttpOnly`, `Secure`, `SameSite=Lax` cookie `__Host-outfitter-preview`, bound to
   that `previewId` and email, 12 h. Then it redirects to `/`.
3. **Every request is checked.** Each request needs that cookie for its own host and a preview that is
   still live. Otherwise it gets a 302 to the session page, which re-mints a grant. The cookie is
   stripped before proxying, so the app never sees it.

A model can't mint grants: it has no IAP identity or Dongle, and the grant key never enters the
sandbox. A URL the model gives the person carries no grant. It lands on the session page, which
checks access and redirects, so it is phishing-neutral: the only thing it can open is this session's
preview, for someone who can already see the session.

**Sharing** a preview means sharing the session. Anonymous links are out of the MVP (an open
decision).

## Idle and lifetime

- **A preview needs its job.** Job exit, kill or deadline removes the port. The tunnel closes when no
  ports remain.
- **Viewing keeps the Drive up, within limits.** #121 says a job never holds a Drive open. A person
  actively using a preview is different: they are working, just not in the chat. Recommendation:
  - an authenticated browser request (not WebSocket keepalives or HMR pings) reports activity to
    agentd;
  - agentd treats it like `markActivity` (`run.ts:985-998`), which re-arms the idle-stop timer
    (default 30 min, `deploy/config.env:14`);
  - this extension is capped at `PREVIEW_IDLE_CAP` (default 2 h past the last chat turn), so a
    forgotten tab can't keep a sandbox billing.
- **Drive stop.** The run's `bye` makes the preview role drop the tunnel and mark the preview dead.
  The page offers Play to wake the Drive, but the job doesn't come back (#121: a job doesn't survive
  the next wake), so the model has to start it again.

## Phases

1. **MVP (A):**
   - the `preview` tool (desktop: localhost; Drive: tunnel), HTTP streaming, WebSocket, SSE;
   - the preview role with max-instances 1, grant + cookie auth, and the header rules;
   - one "Open preview" chip on the session page;
   - ops: preview domain, Cloud DNS zone, Certificate Manager wildcard cert (DNS authorization), a
     global external HTTPS LB with a serverless NEG to `outfitter-preview`. Cloud Run domain mappings
     don't do wildcards; ours are plain mappings today, and `gcloud beta run domain-mappings list`
     shows four.
   - Tests: tunnel framing and flow control, header stripping, grant expiry, the port allowlist, the
     `Set-Cookie Domain` refusal, and an e2e vite HMR round trip through the in-process provider.
2. **Later:** preview activity in the idle rules, several ports per job, the jobs row in the
   transcript, a companion "open in tab", and optionally time-boxed anonymous share links.

## Open decisions (owner)

1. **Option A** (own proxy, LB ≈ $18–25/month, largest build) **or B** (Cloudflare Tunnel + Access,
   ≈ $0, Cloudflare account and a second login)?
2. **The preview domain:** a new registrable domain (who registers it, where DNS lives: Cloud DNS for
   A, Cloudflare for B).
3. **Does browsing a preview count as activity for idle-stop,** and with what cap (proposed: yes,
   2 h)?
4. **Who can open a preview:** anyone with session access (proposed), or the session owner only? Are
   anonymous share links ever wanted?
5. **`--max-instances=1`** for the preview role, accepting that a restart drops live previews.
6. **Scope of the first cut:** Drive only, with the desktop tool just returning localhost (proposed),
   or also teleport-style previews of a laptop session from the web?

## Risks

- **A model-written app runs in the person's browser.** Origin isolation is what contains it. Getting
  the domain wrong (a `kernal.one` subdomain) turns the preview into a CSRF and cookie-tossing channel
  against the session.
- **Phishing:** a preview can render anything, including a fake Google login, on our preview domain.
  Mitigations: a non-brand domain, the grant flow (only session viewers ever reach it), and a small
  "Outfitter preview of <session>" banner (proxy-injected, or on the auth interstitial only, if
  injecting into apps proves fragile).
- **One preview instance** is a single point: a restart or deploy drops every preview for a few
  seconds. Acceptable at this size; revisit if usage grows.
- **Bandwidth through Cloud Run:** dev bundles are MBs per load, which is fine. Large media or
  downloads would be slow and billed as Cloud Run egress (≈ $0.12/GB).
- **Dev server host checks:** vite and next reject unknown `Host` headers. The rewrite to
  `localhost:<port>` handles most of them; some frameworks also check `Origin` on the HMR socket and
  need the rewrite there too.
- **Idle cost:** without the cap, a preview tab left open would keep a Drive billing indefinitely.
