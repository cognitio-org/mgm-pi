# Browser IDE: look at and edit a Drive's files in VS Code in the browser

Status: design, not built (epic #245). Builds on Drive previews (`docs/specs/drive-previews.md`, #217, merged
2026-09-27). Owner decisions of 2026-09-28 are folded in; the rest are at the end.

## Problem

A person watching a Drive can read files through the session page's file viewer (agentd `read`,
`diff`), but can't browse the tree freely, edit a file, or run a command next to the model. On the
laptop that's just opening the folder in an editor. In a Drive there is no way in: the GKE sandbox
has no ingress (`deploy/gke/sandbox-template.yaml`, `networkPolicy.ingress: []`) and the Cloud Run
job has no inbound port.

The goal is **VS Code in the browser** (code-server) on the Drive's own `/workspace`, opened from
the session page, with the same safety properties Drive previews already have.

## Decisions (owner, 2026-09-28)

- **Engine:** code-server (Coder's build of VS Code for the browser), not a separate product.
- **A Tape option, off by default.** A Tape that doesn't ask for the IDE starts exactly as it does
  today. The owner's concern: code-server must not slow down Drives that don't use it.
- **One image, installed on demand; no second image.** A separate `outfitter-agent-ide` image was
  considered and set aside (see "Options considered"). The spike (phase 0) measures whether baking
  it into the one image is cheap enough to skip the on-demand install.

## Requirements

1. **No cost to Tapes that don't use it.** No change to their image, startup path, memory or warm
   pool.
2. **Same Drive, same files.** The IDE sees and edits the `/workspace` the model works in, as the
   same Linux user (`agent`), so neither leaves files the other can't write.
3. **Never more access than the session page's owner has.** code-server's terminal is a shell in the
   sandbox. Only the floppy's owner and sysops get in; there is no share link to an IDE.
4. **Nothing the model controls can open, widen or publish the IDE.** The model can't start it on a
   public URL, can't point a preview at it, and can't turn it into a share link.
5. **Works on both providers** (GKE and Cloud Run), since it rides on the preview path, which only
   needs outbound 443.
6. **Bounded lifetime.** The IDE dies with its Drive; an open IDE tab can't keep a Drive billing
   forever.

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

code-server is "a dev server on a loopback port", so the IDE reuses all of it. What's new is: who
starts it (a person, not the model), where the binary comes from, a narrower allowlist, no share
mode, and how activity counts.

## Design

### 1. The Tape option

- `Guru.browserIde?: boolean`, default off, absent on existing Tapes. Same shape as
  `allowExternalHtmlResources` (`store/types.ts:418`, `routes/gurus.ts:109`, `GuruForm.tsx:57`).
- Copied onto the run when its first `run.spec` is built (`agentlink.ts:1117` pattern), so editing
  the Tape mid-run changes nothing for a live Drive.
- Sent to agentd as `run.spec.ide = { version, sha256 }` only when on. Absent: agentd does nothing
  new, and the session page shows no IDE button.
- Label in the Tape form: **"VS Code in the browser"**, with a one-line note: "Lets the floppy's
  owner open this Drive's files in an editor with a terminal."

### 2. Getting code-server into the sandbox

**Default (pending the spike): download on demand, in the background.**

- When `run.spec.ide` is present, agentd starts a **prefetch** right after the spec arrives, in
  parallel with pi's start, at low priority (`nice`), so it doesn't compete with pi on the one vCPU
  for the part of startup the person waits on.
- It fetches the pinned code-server release tarball for the pod's architecture from GitHub releases
  (`https://github.com/coder/code-server/releases/download/v<version>/...linux-amd64.tar.gz`),
  checks it against `sha256` from the run.spec, and unpacks it as **root** into
  `/opt/code-server`. The `agent` user can run it but not replace it.
- Version and checksum live in api config (`IDE_CODE_SERVER_VERSION`, `IDE_CODE_SERVER_SHA256`),
  so a bump is a config change, not an image rebuild. Dependabot can't see it; a scheduled check
  (like the ngrok pin in `image/Dockerfile:149`) flags new releases.
- Egress: TCP 443 to public addresses is already allowed on both providers.
- **UNVERIFIED:** tarball size (about 100 MB compressed, from memory) and download plus unpack
  time in a 1-vCPU sandbox. Spike item S2.

**Alternative, if the spike shows it's cheap: bake it in.** Add code-server to `image/Dockerfile`
under the same pin. The Tape option then only gates the button. Pick this if the measured cold-start
cost of the bigger image is under about a second on both providers (spike item S1), since it removes
the download, its failure modes and its wait.

### 3. Starting the IDE (agentd)

A person clicks **"Open in VS Code"** on the session page. The model never starts it.

- **api → agentd:** a down-frame `ide.open {requestId}`, answered by `ide.result {requestId, url |
  error}`. Same shape as `read`/`read.result`; not seq/ack-replayed.
- **agentd:**
  1. Waits for the prefetch (or starts it, if it failed earlier); answers `installing` with
     progress if the person has to wait.
  2. Starts code-server **as `agent`** (the same uid/gid and home as pi, `run-as-user.ts`), bound to
     `127.0.0.1` on a free port, with:
     - `--auth none`: sign-in happens at ngrok's edge (§4), and a code-server password would be one
       more secret to deliver;
     - `--disable-telemetry`, `--disable-update-check`;
     - `--user-data-dir` and `--extensions-dir` under the `agent` home;
     - `/workspace` as the folder to open.
  3. Adds that port to the preview listener's **reserved ports** (`preview.ts:224`), so the model's
     `preview` tool can't open it.
  4. Opens it through the preview path directly (not the loopback HTTP route) with
     `kind: "ide"`: same proxy, same ngrok runner, and a `preview.open` carrying `kind: "ide"`.
  5. Answers `ide.result` with the URL.
- A second click reuses the running IDE and its preview.
- Run end (`bye`, stop): agentd kills code-server with its other children; the preview closes with
  the run as today.

Environment for code-server: none of agentd's secrets. It gets the same environment pi gets
(`agent` home, `PATH`, git config pointing at the git proxy), so `git` in its terminal behaves as it
does for the model.

### 4. The public side (api)

- `Preview.kind?: "ide"` (absent means a dev-server preview, as today).
- **Allowlist:** an IDE preview's Traffic Policy allows only the floppy's **owner and sysops**
  (`Session.ownerEmail` plus the operators; the same rule as `canManageSession`), not every
  `PREVIEW_ALLOW` member. A dev-server preview is a web page; an IDE is a shell.
- **No share mode:** `routes/previews.ts`'s share route refuses a port whose open preview is
  `kind: "ide"`; `PreviewService.open` refuses `share` with `kind: "ide"`. agentlink already refuses
  `share` from a sandbox.
- agentlink checks that `kind: "ide"` in `preview.open` answers an `ide.open` it sent (matching
  `requestId`), so the model can't label its own dev server an IDE, or the reverse.

### 5. Idle and lifetime

The preview proxy counts only page navigations as activity (`preview-proxy.ts:9-11`). code-server is
a single-page app on a WebSocket: after the first load, editing makes no page requests, so a person
typing in the IDE would look idle and the Drive would stop under them.

- agentd treats **IDE activity** as activity, from code-server's own heartbeat (code-server touches
  a heartbeat file under its data dir while a client is active; **UNVERIFIED**, spike S4), polled
  once a minute.
- It feeds the same `markPreviewActivity` path (`run.ts:1058`), so the existing cap still applies:
  activity counts only within 2 h of the last chat turn (`PREVIEW_IDLE_CAP_MS`, `run.ts:200`).
  Open decision 2 asks whether an IDE session should get a longer cap.
- Never a keep-alive from an open but unused tab: the heartbeat reflects real client activity.

### 6. Working next to the model

- Both edit the same files. pi's edit tool re-reads a file before each edit, and VS Code notices
  files changed on disk; the worst case is a person's unsaved buffer going stale, which VS Code
  flags. No locking in v1.
- The session page could show "someone has the IDE open" to the model later; not in v1.
- Checkpoints are unchanged: whatever is in `/workspace` at checkpoint time is what gets pushed or
  snapshotted, whoever wrote it.
- code-server's settings and extensions live in the `agent` home and are lost when the Drive ends.
  Keeping them across Drives is future work.

### 7. Extensions

code-server installs extensions from Open VSX over 443, which egress allows. v1 leaves the
marketplace on (open decision 3).

## Options considered

| Option | Verdict |
|---|---|
| **Separate image with code-server, picked by the Tape** | Set aside. A warm pool belongs to one SandboxTemplate, so a second image needs a second pool: the default warm schedule is about $23.40 of the $25/month budget (`gke-sandbox-provider.md` §3.7), or IDE Tapes always start cold. It doubles builds and deploy targets (a second SandboxTemplate and a second Cloud Run job), and each must move in the same release as link, the image-skew failure spike S2 hit (`gke-spike.md`, refused 4409). And image size costs less than it looks: warm pods have already pulled it, a cached node starts in about 3 s (spike S4), and image streaming fetches only bytes a pod reads. |
| **Download on demand (above)** | **Default.** Zero cost to Tapes without it; one image, one pool, one release path. Costs a download on first open, hidden by the background prefetch. |
| **Bake into the one image** | Chosen instead if spike S1 shows under about 1 s of extra cold start on both providers. Simplest; the Tape option then gates only the button. |
| Sidecar container in the pod | Needs `/workspace` on a shared `emptyDir`, reserves memory on every run, changes the template, and sidecars on Cloud Run jobs are unverified. Only worth it if code-server in the agent container misbehaves. |
| A second sandbox for the IDE | No shared storage between pods (no PVCs, §3.8 of the GKE spec), so it can't see the Drive's files. |
| code-server's own password auth | One more secret, and it would sit behind ngrok's Google sign-in anyway. |

## Security notes

- **The terminal is a shell as `agent`.** That is what the model already has. It can't read
  agentd's secrets (root-only run token, GitHub and ngrok credentials, assignment files), which is
  the property the root/`agent` split exists for.
- **Who gets that shell:** owner and sysops only, checked at ngrok's edge by a policy only the api
  writes. No share links.
- **The model can't reach the IDE's public side:** it can't start code-server through agentd (only
  `ide.open` from the api does), can't preview the IDE's port (reserved), and can't claim
  `kind: "ide"` (agentlink matches it to its own request).
- **The model can reach code-server on loopback,** as the same user. That gives it nothing it
  doesn't already have.
- **Origin:** the IDE is on its own `https://<id>.kernal.run` host, cross-site to `app.kernal.one`,
  like every preview. code-server's webviews run on the same host; **UNVERIFIED** that they work
  through the proxy's `Host`/`Origin` rewriting (`preview-proxy.ts:55-59`), spike S3.
- **Supply chain:** pinned version, SHA-256 checked before unpacking, unpacked root-owned.

## Phases

0. **Spike** (no merge needed; a report under `docs/reports/browser-ide-spike.md`):
   - **S1** image cost: build the image with code-server baked in; measure cold start on GKE (node
     with the image cached, and a new tag's first pull) and on Cloud Run, against today's image.
   - **S2** download cost: fetch, verify and unpack the tarball in a real 1-vCPU Drive, while pi
     starts; time both.
   - **S3** through the preview path: code-server behind `LocalPreviewProxy` and an ngrok cloud
     endpoint with Google sign-in; editor, terminal, file watcher, webviews, and Open VSX installs
     work under gVisor.
   - **S4** activity: confirm the heartbeat file's behaviour, and that an idle tab stops touching it.
   - **S5** memory: code-server plus pi plus a dev server inside 2 GiB; watch for OOM.
   - Outcome: download or bake in (§2), and any change to §3-§5.
1. **Tape option and install (api, agentd, web form):** `Guru.browserIde`, `Run.browserIde`,
   `run.spec.ide`, the prefetch or the Dockerfile change.
2. **Start and open (agentd, api):** `ide.open`/`ide.result`, running code-server as `agent`,
   reserved port, `Preview.kind`, owner-and-sysop allowlist, share refusal, activity.
3. **Session page (web):** the "Open in VS Code" button when the run has the IDE, an installing
   state, and the IDE chip apart from dev-server previews, with no share control.
4. **Live test:** a Playwright step in `web/live` that opens the IDE on a test Tape and checks the
   file tree loads.

## Open decisions

1. **Allowlist:** owner and sysops only (proposed), or everyone in `PREVIEW_ALLOW` like dev-server
   previews?
2. **Idle cap for the IDE:** keep the 2 h-after-last-chat cap (proposed for v1), or let IDE
   activity keep a Drive up on its own, up to the 24 h hard timeout?
3. **Extensions:** Open VSX on (proposed), or off in v1?

## Risks

- **Memory.** code-server's server and extension host plus pi in 2 GiB may be tight; S5 decides
  whether IDE Tapes need a bigger shape (which would be a template change on GKE after all).
- **Download failures** (GitHub rate limits or outages) leave the IDE unavailable for that Drive;
  the button says so, and the Drive itself is unaffected. Mirroring the tarball to our Artifact
  Registry is the fallback.
- **Idle drift:** if the heartbeat doesn't behave as expected, IDE users either get stopped
  mid-edit or keep Drives up; S4 decides.
- **Two editors, one tree:** a person and the model can overwrite each other's changes. VS Code's
  "file changed on disk" prompt is the only guard in v1.
