# Browser IDE: look at and edit a Drive's files in VS Code in the browser

Status: design, not built (epic #245). Builds on Drive previews (`docs/specs/drive-previews.md`,
#217, merged 2026-09-27). Owner decisions of 2026-09-28 are folded in.

## Problem

A person watching a Drive can read files through the session page's file viewer (agentd `read`,
`diff`), but can't browse the tree freely, edit a file, or run a command next to the model. On the
laptop that's just opening the folder in an editor. In a Drive there is no way in: the GKE sandbox
has no ingress (`deploy/gke/sandbox-template.yaml:27-28`, `networkPolicy.ingress: []`) and the
Cloud Run job has no inbound port.

The goal is **VS Code in the browser** (code-server) on the Drive's own `/workspace`, opened from
the session page, with the same safety properties Drive previews already have.

## Decisions (owner, 2026-09-28)

- **Engine:** code-server (Coder's build of VS Code for the browser), not a separate product.
- **A Tape option, off by default.** A Tape that doesn't ask for the IDE starts exactly as it does
  today. The owner's concern: code-server must not slow down Drives that don't use it.
- **One image, installed on demand; no second image.** A separate `outfitter-agent-ide` image was
  considered and set aside (see "Options considered"). The spike (phase 0) measures whether baking
  it into the one image is cheap enough to skip the on-demand install.
- **Who:** the floppy's owner and sysops (admins) open the IDE; nobody else, and no share links.
- **Idle:** editing keeps a Drive running for as long as someone keeps editing. IDE activity is not
  capped by time since the last chat turn. An open but untouched tab doesn't count (§5).
- **Extensions:** allowed, from Open VSX.

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
5. **Works on both providers** (GKE and Cloud Run), since it rides on the preview path, which only
   needs outbound 443.
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

**Default (pending the spike): download on demand.**

- **When:** not at Drive start. The api sends `ide.prepare` when the floppy's owner or a sysop opens
  the session page of a running IDE Drive, and `ide.open` (§3) starts it too if it hasn't run. A
  Drive nobody opens the IDE on never downloads anything. That matters on Cloud Run, where the
  writable filesystem is in memory and counts against the 2 GiB.
- **What:** the pinned code-server release for the pod's architecture
  (`https://github.com/coder/code-server/releases/download/v<version>/code-server-<version>-linux-<arch>.tar.gz`).
- **How:** as root, niced, streamed straight into `tar` (no tarball on disk) through a hashing
  stream; the unpacked tree lands in a temp dir and is renamed to `/opt/code-server` only if the
  SHA-256 of the stream matches `run.spec.ide.artifacts[arch]`. Root-owned: `agent` can run it but
  not replace it. One attempt at a time; a failure is reported and the next `ide.prepare`/`ide.open`
  retries.
- **Pin:** version and per-arch checksums live in api config (`IDE_CODE_SERVER_VERSION`,
  `IDE_CODE_SERVER_SHA256_AMD64`, `_ARM64`), so a bump is a config change, not an image rebuild.
  Dependabot can't see it; phase 1 adds a small scheduled CI job that opens an issue when a newer
  code-server release exists (nothing like it exists for the ngrok pin yet, `Dockerfile:149-155` just
  says "bump deliberately").
- **Egress:** TCP 443 to public addresses is already allowed on both providers.
- **Size (spike, 4.139.1):** 222 MB compressed, 622 MB unpacked. Unpacking takes 3.6 s of CPU on
  the laptop (about 12 s expected on a cloud vCPU); the cloud download time is spike S2's GKE run.
- **Checksums are ours:** the release publishes none, so the pin records SHA-256s we compute when we
  bump it (`docs/reports/browser-ide-spike.md`).

**Alternative, if the spike shows it's cheap: bake it in.** Add code-server to `image/Dockerfile`
under the same pin. The Tape option then only gates the button, and `ide.prepare` goes away. Pick
this if the measured cold-start cost of the bigger image is under about a second on both providers
(spike S1).

### 3. Starting the IDE (agentd)

A person clicks **"Open in VS Code"** on the session page. The model never starts it.

**Frames** (not seq/ack-replayed, like `read`, which correlates on `reqId`, `protocol.ts:407`):

- down `ide.prepare {}`: start the install if it hasn't run. No answer.
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
  the client sent at least **60 frames or 2 KB** in it. Spike S4 (local): an idle tab, focused or in
  the background, sends about 30 frames and under 600 bytes a minute; scrolling 109 frames, a
  terminal 210, typing 1,400. To be confirmed through ngrok and gVisor. Measured there, not
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
- **The Drive's hard timeout still applies.** Every run has one: 24 h (Cloud Run
  `--task-timeout=24h`; GKE claim `lifecycle.shutdownTime`, `gke-sandbox-provider.md` §3.6). A person
  editing past it loses the Drive at that point, like any run. Lifting or extending it for IDE runs
  is a separate change to both providers, not part of this work.

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
| **Separate image with code-server, picked by the Tape** | Set aside. A warm pool belongs to one SandboxTemplate, so a second image needs a second pool: the default warm schedule is about $23.40 of the $25/month budget (`gke-sandbox-provider.md` §3.7), or IDE Tapes always start cold. It doubles builds and deploy targets (a second SandboxTemplate and a second Cloud Run job), and each must move in the same release as link, the image-skew failure spike S2 hit (`gke-spike.md`, refused 4409). And image size costs less than it looks: warm pods have already pulled it, a cached node starts in about 3 s (spike S4), and image streaming fetches only bytes a pod reads. |
| **Download on demand (above)** | **Default.** Zero cost to Tapes without it, and to IDE Drives nobody opens the IDE on; one image, one pool, one release path. Costs a download on first open, mostly hidden by `ide.prepare` on page load. |
| **Bake into the one image** | Chosen instead if spike S1 shows under about 1 s of extra cold start on both providers. Simplest; the Tape option then gates only the button. |
| Prefetch at Drive start | Rejected: every IDE-Tape Drive pays the download and, on Cloud Run, a few hundred MB of in-memory filesystem, whether or not anyone opens the IDE. |
| Route the IDE through `preview.open` with a `kind` field | Rejected: the frame comes from the sandbox, the model's tool shares the listener, and `preview.ts:260` mints a fresh request id per open, so nothing ties it to the person's click. A separate `ide.*` exchange keyed on agentlink's own request does. |
| Sidecar container in the pod | Needs `/workspace` on a shared `emptyDir`, reserves memory on every run, changes the template, and sidecars on Cloud Run jobs are unverified. Only worth it if code-server in the agent container misbehaves. |
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
  like every preview. code-server's webviews run on the same host; **UNVERIFIED** that they work
  through the proxy's `Host`/`Origin` rewriting (`preview-proxy.ts:55-59`), spike S3.
- **Supply chain:** pinned version, per-arch SHA-256 checked before the tree is moved into place,
  root-owned.

## Phases

0. **Spike** (no merge needed; a report under `docs/reports/browser-ide-spike.md`):
   - **S1** image cost: build the image with code-server baked in; measure cold start on GKE (node
     with the image cached, and a new tag's first pull) and on Cloud Run, against today's image.
   - **S2** download cost: stream, verify and unpack the tarball in a real 1-vCPU Drive; time it,
     with and without pi busy.
   - **S3** through the preview pieces: code-server behind `LocalPreviewProxy` and an ngrok cloud
     endpoint with Google sign-in; editor, terminal, file watcher, webviews, and Open VSX installs
     work under gVisor. Check `--disable-proxy` and `--config` in the pinned version.
   - **S4** activity: client-to-server WebSocket traffic of an active versus an idle tab; pick the
     floor.
   - **S5** memory: code-server plus pi plus a dev server inside 2 GiB, and the unpacked tree's
     in-memory cost on Cloud Run.
   - Outcome: download or bake in (§2), and any change to §3-§5.
1. **Tape option and install (api, agentd, web form, CI):** `Guru.browserIde`, `Run.browserIde`,
   `run.spec.ide` (only with previews on), `ide.prepare`, the streamed verified install (or the
   Dockerfile change), and the scheduled "newer code-server" check.
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

None left from the design; the spike may raise new ones. The 24 h hard timeout (§5) stays as it is
unless the owner asks to change it.

## Risks

- **Memory.** code-server's server and extension host plus pi in 2 GiB may be tight, and on Cloud
  Run the unpacked tree lives in memory too; S5 decides whether IDE Tapes need a bigger shape
  (which would be a template change on GKE after all).
- **Download failures** (GitHub rate limits or outages) leave the IDE unavailable for that Drive;
  the button says so, and the Drive itself is unaffected. Mirroring the tarball to our Artifact
  Registry is the fallback.
- **Idle drift:** with no cap, the floor is the only thing between an idle tab and a Drive that
  never stops. If WebSocket traffic doesn't separate active from idle tabs cleanly, IDE users either
  get stopped mid-edit or keep Drives up until the 24 h timeout; S4 decides, and the fallback is a
  generous cap (say 8 h of IDE activity with no chat turn) rather than none.
- **Two editors, one tree:** a person and the model can overwrite each other's changes. VS Code's
  "file changed on disk" prompt is the only guard in v1.
