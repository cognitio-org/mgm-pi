# Outside users, app.kernal.one, and the kernal.one landing page

2026-09-22. Three related changes: admitting users outside the `mgmonteleone.com` org through IAP,
serving the Outfitter web UI at `app.kernal.one`, and a public landing page at `kernal.one`.

## Outside users through IAP

**Asked for:** let in everyone at `serviam-it.hr` and one person, `matija.turk@gmail.com`.

**What gates access:** only IAP. `outfitter-api` verifies the IAP JWT (`src/auth.ts`) and has no
domain check of its own, so the change is entirely in IAP's policy and OAuth settings.

**Why the IAM binding alone isn't enough:** IAP on Cloud Run starts on a Google-managed OAuth
client, which admits org-internal users only
(https://cloud.google.com/iap/docs/custom-oauth-configuration). Anyone outside the org can be in
the IAP policy and still be refused at sign-in. So IAP now uses a custom OAuth client with an
External audience:

- Client `97916961297-ul9tkt3hh0l8i16imltqcarfrkat1k17.apps.googleusercontent.com`, created in the
  console (Google Auth Platform; the IAP OAuth Admin API behind `gcloud iap oauth-clients` was shut
  down in March 2026). Redirect URI `https://iap.googleapis.com/v1/oauth/clientIds/<id>:handleRedirect`.
- Its secret is in Secret Manager as `outfitter-iap-oauth-client-secret` (version 1 was a
  placeholder and is disabled; version 2 is the real one). Only the deployer (`service.sh`) reads
  it. `outfitter-api@` holds project-wide `secretmanager.secretAccessor` (a known, pre-existing
  gap, `docs/reports/api.md`), so it *could* read it, but no code does, and the operator settings
  page only touches its fixed allowlist of secret names (`src/operator.ts`), which excludes it.
- `deploy/service.sh`: `IAP_MEMBERS` (comma-separated IAM members, default
  `domain:mgmonteleone.com,domain:serviam-it.hr,user:matija.turk@gmail.com`) replaces the single
  `IAP_DOMAIN`; `IAP_OAUTH_CLIENT_ID`, when set, points IAP at the custom client. The org has no
  `iam.allowedPolicyMemberDomains` restriction, so the outside members bind without an org-policy
  change. serviam-it.hr is a Google Workspace domain (MX on aspmx.l.google.com), so `domain:` works.

**Access model is unchanged:** outside users get the same org-shared access as any signed-in user
(EPIC.md "Session visibility"). None are operators; that is still `OUTFITTER_OPERATORS` only.

**Applied live** before the redeploy, with the same gcloud commands the script runs; verified with
`gcloud iap settings get` / `get-iam-policy` and by the sign-in redirect carrying the new client ID.

## app.kernal.one

A Cloud Run domain mapping (Preview; available in us-central1, free, Google-managed certificate)
onto `outfitter-api`. Nothing in the service changes:

- `IAP_AUDIENCE` is the service path (`/projects/<n>/locations/<region>/services/outfitter-api`),
  not the hostname, so the JWT check holds on any hostname.
- `OUTFITTER_ORIGIN` matters only as the agent-token audience, which the link role verifies; the
  web role can keep its run.app origin.
- IAP's OAuth redirect always goes through `iap.googleapis.com`, so the OAuth client needs no new
  redirect URI.

Verified: `https://app.kernal.one/` answers 302 to accounts.google.com with the custom client ID.

## kernal.one landing page

`landing/`: static HTML/CSS/JS on nginx, Cloud Run service `kernal-web` (public, min instances 0,
128 MiB). `deploy/landing.sh` builds it with Cloud Build into the existing `outfitter` Artifact
Registry repo and deploys; `--map-domains` creates the mappings (`kernal.one`, `www.kernal.one`,
`app.kernal.one`). `www` answers 301 to the apex (nginx). DNS is Cloud DNS zone `kernal-one` in
project `cognitio-flow`: apex A/AAAA to Google's four frontend addresses, `www`/`app` CNAME
`ghs.googlehosted.com.`.

- **Design:** the Outfitter design system (`docs/design/README.md`): C64 blue-violet screen inside
  its lighter border in dark mode, GEOS paper in light mode, Silkscreen/IBM Plex self-hosted
  (OFL-1.1), square corners, hard shadows, phosphor green only for "live".
- **The screen is a C64 BASIC V2 subset** (`public/basic.js`, UI-independent; `public/app.js` is
  the terminal adapter). `LOAD "OUTFITTER",8,1` plays the disk loading and auto-types `RUN`, which
  opens `app.kernal.one`; `LOAD "$",8` + `LIST` shows a directory; `LOAD "KERNAL",8` + `RUN`
  prints Kernal's `/connect` summary; `SAVE` keeps programs in localStorage. Programs run in time
  slices so an endless loop never hangs the tab; Escape is RUN/STOP. Tests:
  `node --test outfitter/landing/test/`.
- **Sound:** floppy clips cut from two Pixabay-licensed recordings (`public/sounds/CREDITS.md`),
  and a synthesized modem handshake (`tools/modem.py`) on the first click. On by default because
  every play follows a click or Return (so autoplay rules never apply); the ♪ button mutes.
- **Headers:** CSP `default-src 'self'` with a sha256 for the one inline theme script (recompute
  it in `security-headers.conf` if that script changes), HSTS, nosniff, frame-ancestors none.

## Cost

Domain mappings and certificates are free. `kernal-web` scales to zero; Cloud Build runs are a few
seconds each. No load balancer.
