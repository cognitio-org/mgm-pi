# Browser IDE: look at and edit a Drive's files in VS Code in the browser

Status: design, not built (epic #245). Builds on Drive previews (`docs/specs/drive-previews.md`,
#217, merged 2026-09-27). Owner decisions of 2026-09-28 are folded in.

## Problem

A person watching a Drive can read files through the session page's file viewer (agentd `read`,
`diff`), but can't browse the tree freely, edit a file, or run a command next to the model. On the
laptop that's just opening the folder in an editor. In a Drive there is no way in: the GKE sandbox
has no ingress (`deploy/gke/sandbox-template.yaml:27-28`, `networkPolicy.ingress: []`).

The goal is **VS Code in the browser** (code-server) on the Drive's own `/workspace`, opened from
the session page, with the same safety properties Drive previews already have.

## Decisions (owner, 2026-09-28)

- **Engine:** code-server (Coder's build of VS Code for the browser), not a separate product.
- **A Tape option, off by default.** A Tape that doesn't ask for the IDE starts exactly as it does
  today. The owner's concern: code-server must not slow down Drives that don't use it.
- **One image, one template; code-server downloaded into IDE Drives.** A separate IDE image was
  set aside, and so was baking code-server into the shared image (every Tape would carry it). See
  "Options considered".
- **Who:** the floppy's owner and sysops (admins) open the IDE; nobody else, and no share links.
- **Idle:** editing keeps a Drive running for as long as someone keeps editing. IDE activity is not
  capped by time since the last chat turn. An open but untouched tab doesn't count (§5).
- **Extensions:** allowed, from Open VSX.
- **Memory (after the spike):** IDE Drives use **today's 4 GiB template and warm pool**, like every
  other Drive (`deploy/config.env` `GKE_SANDBOX_MEMORY=4Gi`, since #187). code-server needs about
  1 GB under gVisor (spike S5), which leaves about 2.8 GiB for pi and the model's commands, more than
  the ~1.8 GiB that 2 GiB Drives had when builds were OOM-killed (#187). No second template, and IDE
  Drives start warm. The spike's S1 (bake-in cost) wasn't needed.

## Requirements

1. **No cost to Tapes that don't use it.** No change to their image, startup path, memory or warm
   pool.
2. **Same Drive, same files.** The IDE sees and edits the `/workspace` the model works in, as the
   same Linux user (`agent`), so neither leaves files the other can't write.
3. **Only the floppy's owner and sysops open it.** code-server's terminal is a shell in the sandbox.
   The IDE's own endpoint admits only them, and has no share link.
4. **The IDE gives the model nothing new.** The model can't start, list, close or relabel the IDE
   through agentd or the api. It *can* reach code-server on loopback, as the same user; that is no
   more than the shell it already has (see "Security notes", which says what that does and doesn't
   close).
5. **GKE only.** The fleet is moving fully to GKE (owner decision, 2026-09-27); Cloud Run isn't a
   target.
6. **Lives as long as someone uses it.** The IDE dies with its Drive. Real editing keeps the Drive
   up; an open tab nobody touches doesn't.

## What already exists (Drive previews)

The whole public side is built and merged (#225, #226, #227, #235):

- **agentd** (`packages/agentd/src/preview.ts`): given a loopback port, it probes it, starts a
  `LocalPreviewProxy` (`preview-proxy.ts`) that forwards only to `127.0.0.1:<port>`, starts a root
  ngrok agent binding `https://p<port>.<run label>.internal` with the run's ACL-restricted
  credential, and sends `preview.open`.
- **api** (`packages/api/src/previews.ts`): creates the public `https://<id>.kernal.run` cloud
  endpoint with a Traffic Policy the sandbox can't see: Google sign-in, then an email allowlist,
  then `forward-internal`. Records a `Preview`, closes it with the job or run, sweeps orphans.
- **web:** the session page lists open previews as chips, and owners/sysops can make share links
  (`routes/previews.ts:42`).

code-server is "a server on a loopback port", so the IDE reuses the **pieces**: the proxy, the ngrok
runner, the run's credential and internal domain, the api's cloud-endpoint and sweep code. It does
**not** go through the model-facing preview listener or its `preview.open` frame, so the model's
`preview` tool can't see, close or impersonate it (§3).

The IDE needs previews to be on: agentd starts its preview machinery only when `run.spec` carries
`preview` and `secrets.ngrokAuthtoken` (`run.ts:722`). The api sends `run.spec.ide` only in that
case, and the session page shows no IDE button otherwise.

## Design

### 1. The Tape option

- `Guru.browserIde?: boolean`, default off, absent on existing Tapes. Same shape as
  `allowExternalHtmlResources` (`store/types.ts:418`, `routes/gurus.ts:109`, `GuruForm.tsx:57`).
- Copied onto the run when its first `run.spec` is built (`agentlink.ts:1117` pattern), so editing
  the Tape mid-run changes nothing for a live Drive.
- Sent to agentd as `run.spec.ide = { version, artifacts: { amd64: sha256, arm64: sha256 } }`, only
  when on **and** previews are configured for the run. Absent: agentd does nothing new.
- Label in the Tape form: **"VS Code in the browser"**, with a one-line note: "Lets the floppy's
  owner open this Drive's files in an editor with a terminal."

### 2. Getting code-server into the sandbox

**Downloaded at Drive start, for IDE Drives only.**

- **When:** agentd starts the install as soon as a run's `run.spec` carries `ide` (a warm pod gets it
  at assignment), niced, in parallel with pi's start. It takes about 20 s on GKE (spike S2: 18.8 to
  23.3 s over six installs), so it's usually done before anyone clicks. `ide.open` (§3) waits for it
  or retries it. Other Drives never download anything.
- **What:** the pinned code-server release for the pod's architecture
  (`https://github.com/coder/code-server/releases/download/v<version>/code-server-<version>-linux-<arch>.tar.gz`).
- **How:** as root, niced. The HTTP body goes through a SHA-256 hash and then into GNU `tar`, so
  there's no tarball on disk:
  - **Copilot excluded:** `--exclude` for the bundled Copilot extension and SDK
    (`*/lib/vscode/extensions/copilot`, `*/lib/vscode/node_modules/@github`; GNU tar matches
    excludes before `--strip-components`). That's about 270 MB, some 40% of the unpacked tree, for AI features the IDE
    turns off. The spike found everything works without them, though it tested the trim by deleting
    after unpacking, not with `--exclude`; phase 1's test covers that.
  - **The hash covers the whole download,** excluded entries included, because it sits before tar.
    The whole body is read and hashed even if tar stops early, and a tar or pipe error fails the
    install.
  - **Owned by root:** `--no-same-owner --no-same-permissions`, then mode 755 on the top directory,
    so `agent` can run code-server but not change it.
  - **Unverified bytes stay in a root-only temp dir.** tar unpacks before the hash is known; that's
    acceptable only because nothing runs from the temp dir. It's renamed to `/opt/code-server` only if
    the hash matches `run.spec.ide.artifacts[arch]`.
  - One attempt at a time; a failure is reported and `ide.open` retries.
- **Pin:** version and per-arch checksums live in api config (`IDE_CODE_SERVER_VERSION`,
  `IDE_CODE_SERVER_SHA256_AMD64`, `_ARM64`), so a bump is a config change, not an image rebuild.
  Dependabot can't see it; phase 1 adds a small scheduled CI job that opens an issue when a newer
  code-server release exists (nothing like it exists for the ngrok pin yet, `Dockerfile:149-155` just
  says "bump deliberately").
- **Egress:** TCP 443 to public addresses is already allowed by the sandbox network policy.
- **Size (spike, 4.139.1, amd64):** 222 MB compressed, 670 MB unpacked (arm64: 217 and 641 MB).
  Without Copilot, about 350 MB unpacked.
- **Checksums are ours:** the release publishes none, so the pin records SHA-256s we compute when we
  bump it (`docs/reports/browser-ide-spike.md`).

Hosting a trimmed tarball ourselves (about 112 MB instead of 222) would halve the download, at the cost of
a mirror to maintain; not in v1. It's also the fallback if GitHub rate-limits us.

### 3. Starting the IDE (agentd)

A person clicks **"Open in VS Code"** on the session page. The model never starts it.

**Frames** (not seq/ack-replayed, like `read`, which correlates on `reqId`, `protocol.ts:407`):

- down `ide.open {reqId}`: start (or reuse) the IDE.
- up `ide.status {reqId?, state, detail?, internalUrl?}`, sent as it progresses:
  `installing` → `starting` → `ready` (with `internalUrl`) or `error` (with `detail`). Also sent
  unprompted as `stopped` if code-server or its tunnel dies.

**The api doesn't hold a request open.** `POST /api/sessions/:id/ide` sends `ide.open` and returns
202; the api records the latest `ide.status` on the run, and the page polls
`GET /api/sessions/:id/ide` (state, and the URL once the endpoint exists). This covers a long
install without an HTTP timeout.

**agentd, on `ide.open`:**

1. Waits for (or starts) the install.
2. Starts code-server **as `agent`** (uid/gid and home from `run-as-user.ts`), in **its own process
   group**, bound to `127.0.0.1` on a free port, with every setting on the command line and
   `--config` pointing at a root-owned, empty file so an agent-writable `config.yaml` can't change
   them:
   - `--auth none`: sign-in happens at ngrok's edge (§4);
   - `--disable-telemetry`, `--disable-update-check`;
   - `--disable-proxy` (present in 4.139.1, spike): code-server's `/proxy/<port>` would otherwise
     forward to any loopback port, agentd's listeners included;
   - `--disable-workspace-trust`: the workspace is the Drive's own; without it the IDE opens in
     Restricted Mode behind a trust dialog (spike);
   - `--user-data-dir` and `--extensions-dir` under the `agent` home;
   - `/workspace` as the folder to open;
   - default machine settings (`<user-data-dir>/Machine/settings.json`) that turn off VS Code's AI
     Chat panel, which is open by default in 1.139 and wired to nothing here, and telemetry.
3. Starts its own `LocalPreviewProxy`, **in a mode that leaves `Origin` alone** (spike S3: the
   dev-server rewrite of `Origin` to localhost, `preview-proxy.ts:55-59`, makes code-server refuse
   every WebSocket with 403; kept, `Origin` is checked against `X-Forwarded-Host` and the check
   still guards against cross-site WebSocket hijacking), and an ngrok tunnel on `https://ide.<run label>.internal` (a
   name the run's credential can bind, `bind:*.<label>.internal`, and one the preview tool never
   uses, since previews are `p<port>.…`). These live in an `IdeManager` beside the
   `PreviewListener`, not in its `open` map, so the tool's `GET /previews` doesn't list the IDE and
   `DELETE /previews/<port>` (`preview.ts:308-311`) can't close it. The port also goes in the
   listener's `reservedPorts` (`preview.ts:224`).
4. Sends `ide.status {reqId, state: "ready", internalUrl}`.

A second click reuses the running IDE. Run end (`bye`, stop): agentd kills code-server's **process
group** (terminals fork their own children; today agentd only kills pi, `run.ts:1105`), then its
tunnel and proxy.

**code-server's environment** is listed, not inherited: `HOME`, `USER`, `PATH`, `LANG`,
`SHELL=/bin/bash`, and what `git` needs to use the run's git proxy the way pi's does. It does
**not** get pi's `LITELLM_AGENT_KEY`, the preview/browser/inspect tokens, or the Tape's `env`
(`run.ts:636-652`, `:740-741`). (A person in the IDE's terminal can still read pi's environment from
`/proc`, as the same user; the owner is trusted with that, see "Security notes".)

### 4. The public side (api)

- **agentlink** handles `ide.status`. On `ready` it checks `internalUrl` is exactly
  `https://ide.<run label>.internal` and that `reqId` matches an `ide.open` it sent for this run and
  hasn't answered. Only then does it create the endpoint. The kind comes from agentlink's own
  pending request, never from anything the sandbox says. If the link drops or the api restarts
  in between, the pending request is gone: the `ready` is ignored and the page's next click
  re-opens (agentd answers at once with the running IDE).
- **Record:** `Preview.kind?: "ide"` (absent means a dev-server preview, as today). IDE previews
  don't count toward `MAX_OPEN_PREVIEWS_PER_RUN` (`previews.ts:29`), and at most one exists per run.
- **Allowlist:** the floppy's owner (`Session.ownerEmail`) and the deployment's sysops
  (`config.operators`, `config.ts:148`), the same people `canManageSession` lets manage it, **not**
  every `PREVIEW_ALLOW` member. A dev-server preview is a web page; an IDE is a shell.
  - `ownerEmail` is optional (`store/types.ts:19`): with no owner, `POST /ide` answers 409 and the
    button says why.
  - The policy is fixed when the endpoint is made. A change of owner or sysops applies at the next
    open; "Close IDE" plus "Open" re-makes it.
- **No share link:** the share route (`routes/previews.ts:42-55`) and `PreviewService.open` refuse
  `kind: "ide"`. The IDE lives on `ide.<label>.internal`, not a `p<port>` name, so the share
  route's "a secure preview of this port exists" check can never match it.
- Cleanup is the preview code's: the endpoint goes on `stopped`, on run end (`closeRun`), and in the
  sweep.

### 5. Idle and lifetime

The preview proxy counts only page navigations as activity (`preview-proxy.ts:9-11`). code-server is
a single-page app on a WebSocket: after the first load, editing makes no page requests, so a person
typing in the IDE would look idle and the Drive would stop under them.

- The IDE's proxy counts **client-to-server WebSocket traffic** as activity: a minute counts when
  the client sent at least **60 frames or 2 KB** in it. Spike S4 under gVisor: an idle tab, focused
  or in the background, sends 31 to 39 frames and under 740 bytes a minute; scrolling 111 frames, a
  terminal 219, typing 845 (the laptop run agreed). Measured there, not
  from code-server's heartbeat file: that file sits in the agent-writable data dir, so the model
  could touch it; traffic through the proxy can only come from someone past ngrok's sign-in.
- It re-arms idle-stop **without** the preview cap (owner decision): dev-server page loads count
  only within 2 h of the last chat turn (`PREVIEW_IDLE_CAP_MS`, `run.ts:200`, `markPreviewActivity`
  at `run.ts:1058`), but IDE activity counts whenever it happens. A new `markIdeActivity` does what
  `markPreviewActivity` does minus the `previewActivityCounts` check. Like preview activity, it
  never counts as chat activity.
- This is safe to leave uncapped only because the signal can't be faked from inside the sandbox:
  it's traffic that came through ngrok's sign-in, above the keepalive floor. An idle tab stops
  counting; the Drive then idle-stops on its normal timer.
- **The Drive's hard timeout still applies:** 24 h (the GKE claim's `lifecycle.shutdownTime`,
  `gke-sandbox-provider.md` §3.6). A person editing past it loses the Drive at that point, like any
  run. Lifting or extending it for IDE runs is a separate change, not part of this work.

### 6. Working next to the model

- Both edit the same files. pi's edit tool re-reads a file before each edit, and VS Code notices
  files changed on disk; the worst case is a person's unsaved buffer going stale, which VS Code
  flags. No locking in v1.
- Checkpoints are unchanged: whatever is in `/workspace` at checkpoint time is what gets pushed or
  snapshotted, whoever wrote it.
- code-server's settings and extensions live in the `agent` home and are lost when the Drive ends.
  Keeping them across Drives is future work.

### 7. Extensions

code-server installs extensions from Open VSX over 443, which egress allows. The marketplace is on
(owner decision). Extensions run in code-server's extension host as `agent`, so an extension gets
the same access the terminal does, and no more.

## Options considered

| Option | Verdict |
|---|---|
| **A separate IDE template** (more memory, or its own pool) | Not needed: Drives are already 4 GiB (#187), which leaves about 2.8 GiB beside code-server. A second template would need a template-name placeholder in `gke-template.sh`, both templates labelled and checked for image skew in the release, a `browserIde` field on `RunLaunch` and a second pool name in the GKE provider config, and either a second warm pod (about $21.60 a month) or cold starts for IDE Drives. The lever if 4 GiB proves too small. |
| **Separate image with code-server, picked by the Tape** | Set aside. A second image needs a second template and pool: a second warm pod (the default warm schedule is already about $23.40 of the $25/month budget, `gke-sandbox-provider.md` §3.7) or cold starts. It doubles builds and deploy targets, and each template must move in the same release as link, the image-skew failure the GKE spike's S2 hit (`gke-spike.md`, refused 4409). |
| **Download into IDE Drives at start (above)** | **Chosen.** Zero cost to other Tapes; one image, one template, one release path. About 20 s, in parallel with pi's start. |
| Bake into the shared image | Not chosen: every Tape would carry about 350 MB (trimmed) it doesn't use. The spike's S1, which would have measured the cold-start cost, was dropped. |
| Download on first page view (`ide.prepare`) | Dropped: it existed to spare Cloud Run's in-memory filesystem, and Cloud Run is out. |
| Route the IDE through `preview.open` with a `kind` field | Rejected: the frame comes from the sandbox, the model's tool shares the listener, and `preview.ts:260` mints a fresh request id per open, so nothing ties it to the person's click. A separate `ide.*` exchange keyed on agentlink's own request does. |
| Sidecar container in the pod | Needs `/workspace` on a shared `emptyDir`, reserves memory on every run and changes the template. Only worth it if code-server in the agent container misbehaves. |
| A second sandbox for the IDE | No shared storage between pods (no PVCs, §3.8 of the GKE spec), so it can't see the Drive's files. |
| code-server's own password auth | One more secret, readable by `agent` (process environment, files in its home), so the model could read it; and it would sit behind ngrok's sign-in anyway. |

## Security notes

- **The terminal is a shell as `agent`.** That is what the model already has. It can't read
  agentd's secrets (root-only run token, GitHub and ngrok credentials, assignment files), which is
  the property the root/`agent` split exists for. It can read what `agent` can: pi's environment
  (the LiteLLM key) via `/proc`. The people allowed in (owner, sysops) already control that key's
  Drive; this is accepted.
- **What agentd and the api close:** the model can't start the IDE (only `ide.open` from the api),
  can't list or close it (it isn't in the preview listener), can't preview its port (reserved),
  and can't make anything count as the IDE (agentlink matches `ide.status` to its own `ide.open`
  and a fixed internal name).
- **What they don't close, and why that's acceptable:** code-server runs with `--auth none` as the
  same user as the model, so the model can reach it on loopback, or relay it (`socat` from a port of
  its choosing) and `preview` that port. That preview is an ordinary one: `PREVIEW_ALLOW` viewers,
  and the owner could share it. But the model can do exactly that today without an IDE, with any
  home-made web shell (`ttyd`, a ten-line Node server). No design that runs the editor as `agent`
  can prevent it; the IDE adds no capability the model lacks. The mitigation belongs to previews in
  general: the share dialog should warn that a preview can serve anything the Drive runs, including
  a shell (#247, a Drive previews follow-up, not IDE work).
- **Who gets the IDE's own endpoint:** owner and sysops only, checked at ngrok's edge by a policy
  only the api writes. No share links.
- **Origin:** the IDE is on its own `https://<id>.kernal.run` host, cross-site to `app.kernal.one`,
  like every preview. With `Origin` passed through (§3), code-server's own origin check still
  refuses a WebSocket opened from any other site. Webviews render (spike S3, local and gVisor).
- **Supply chain:** pinned version, per-arch SHA-256 checked before the tree is moved into place,
  root-owned.

## Phases

0. **Spike: done** (`docs/reports/browser-ide-spike.md`, #240). It changed §2 (the download is
   222 MB; the Copilot trim), §3 (`Origin` passed through; workspace trust and AI chat off; `SHELL`
   required) and §5 (the 60 frames / 2 KB rule), and confirmed the 4 GiB template is enough.
1. **Tape option and install (api, agentd, web form, CI):** `Guru.browserIde`, `Run.browserIde`,
   `run.spec.ide` (only with previews on), the streamed, verified, Copilot-excluding install at Drive
   start (with a test that the excludes match and the hash still covers the whole body), and the
   scheduled "newer code-server" check.
2. **Start and open (agentd, api):** `ide.open`/`ide.status`, `IdeManager` (code-server as `agent`
   in its own process group, root-owned config, listed environment, own proxy and tunnel, reserved
   port), agentlink's request matching, `Preview.kind`, owner-and-sysop allowlist, share refusal,
   `POST`/`GET /api/sessions/:id/ide`, uncapped WebSocket activity (`markIdeActivity`). Tests: share refused for the IDE;
   `ide.status` with an unknown `reqId`, another run's, or a wrong `internalUrl` is ignored; the
   preview tool's `GET` doesn't list and `DELETE` can't close the IDE; a reconnect mid-open
   re-opens cleanly; the process group dies at run end; no owner answers 409.
3. **Session page (web):** the "Open in VS Code" button when the run has the IDE and the viewer can
   manage the session; installing/starting states from polling; the IDE chip apart from dev-server
   preview chips, with "Close IDE" and no share control.
4. **Live test:** a Playwright step in `packages/web/live` that opens the IDE on a test Tape and
   checks the file tree loads.

## Open decisions

None. The 24 h hard timeout (§5) stays as it is unless the owner asks to change it.

## Risks

- **Memory.** 4 GiB leaves about 2.8 GiB beside code-server's ~1 GB (spike S5, gVisor). A heavy dev
  server or test run can still exhaust it; the Drive then fails like any OOM. The levers are a
  larger `GKE_SANDBOX_MEMORY` for everyone (Autopilot allows up to 6.5 GiB on 1 vCPU) or a separate,
  larger IDE template.
- **Download failures** (GitHub rate limits or outages) leave the IDE unavailable for that Drive;
  the button says so, and the Drive itself is unaffected. Mirroring the tarball to our Artifact
  Registry is the fallback.
- **Idle drift:** with no cap, the floor is the only thing between an idle tab and a Drive that
  never stops. If WebSocket traffic doesn't separate active from idle tabs cleanly, IDE users either
  get stopped mid-edit or keep Drives up until the 24 h timeout. S4 showed a clear gap (idle 31-39
  frames a minute, active 111 or more); if real use proves otherwise, the fallback is a generous cap
  (say 8 h of IDE activity with no chat turn) rather than none.
- **Two editors, one tree:** a person and the model can overwrite each other's changes. VS Code's
  "file changed on disk" prompt is the only guard in v1.
