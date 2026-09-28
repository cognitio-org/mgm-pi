# Browser IDE spike (phase 0)

Spec: `docs/specs/browser-ide.md`. Issue #240, epic #245. Scripts and raw results:
`deploy/ide/spike/`.

The spike has two halves. The **local half** (this laptop, Docker, 1 CPU / 2 GiB, arm64) is done. The
**GKE half** (gVisor, the production image, amd64) needs the owner to run two scripts, because they
create objects on the production cluster and push a tag to Artifact Registry. Cloud Run is out of
scope: the fleet is moving fully to GKE (owner decision, 2026-09-27).

| Item | Question | Local | GKE |
|---|---|---|---|
| S1 | What does baking code-server into the image cost a cold start? | size only (below) | **pending**, `s1-run.sh` |
| S2 | How long does the on-demand install take? | 21 s, network-bound; unpack 3.6 s CPU | **19.5 s and 19.2 s** under gVisor |
| S3 | Does code-server work through agentd's proxy? | **pass after one proxy change** | **pending** (gVisor), `gke-run.sh` |
| S4 | Can activity be told from an idle tab at the proxy? | **yes**: 30 frames/min idle vs 109+ active | **pending**, `gke-run.sh` |
| S5 | Does it fit in 2 GiB? | 540-725 MiB for code-server with a client | **pending** (next to pi), `gke-run.sh` |

Pinned for the spike: code-server **4.139.1** (VS Code 1.139.1), released 2026-09-26.
SHA-256 (computed from the release assets; the release publishes none):
- amd64: `53029be6c5781b7bca49b815fcc9a2a3fc111813ad8c9965b2c0f0d2985a0674`
- arm64: `0edb4b60d9c4744b2dd14b0911e3c2e6dd8c6f3c13bd58bda23ae744e59e7df1`

## Findings that change the spec

1. **agentd's preview proxy breaks code-server as written.** Every WebSocket upgrade gets 403.
   `LocalPreviewProxy` rewrites `Origin` to `http://localhost:<port>` on upgrades
   (`preview-proxy.ts:55-59`) but passes the public host in `X-Forwarded-Host`; code-server compares
   the two. `origin-probe.mjs` shows it directly:

   | Host | X-Forwarded-Host | Origin | Result |
   |---|---|---|---|
   | localhost | public | localhost (what the proxy sends today) | **403** |
   | localhost | public | public (Origin left alone) | 101 |
   | localhost | none | localhost | 101 |
   | localhost | none | public | 403 |

   **Fix:** the IDE's proxy leaves `Origin` as the browser sent it. That keeps code-server's own
   check against cross-site WebSocket hijacking working (the browser's origin must match the public
   host), which dropping `X-Forwarded-Host` would defeat. Dev-server previews keep today's rewrite.
   The harness runs agentd's proxy source with only that line changed.

2. **The download is 222 MB, not about 100 MB,** and unpacks to 622 MB (`lib/vscode` 488 MB, a
   bundled Node 117 MB). Baking it in nearly doubles the ~680 MB image. With GKE image streaming a
   cold start only fetches the bytes it reads, so an unused code-server costs little after the first
   pull of each tag; S1 measures that first pull.

3. **Workspace Trust and the AI Chat panel get in the way.** 4.139 opens in Restricted Mode with a
   trust dialog, and the Chat panel is open by default (it took the harness's keystrokes). The IDE
   should start with `--disable-workspace-trust` (the workspace is the Drive's own) and default
   machine settings that turn off AI features and the secondary side bar
   (`machine-settings.json`: `chat.disableAIFeatures`, `workbench.secondarySideBar.defaultVisibility`,
   `workbench.startupEditor: none`, telemetry off).

4. **code-server writes `~/.config/code-server/config.yaml` with a generated password** on any start,
   even `--version`, unless `--config` points elsewhere. With `--config` at a root-owned empty file
   (spec §3) nothing is written to the agent's home: confirmed.

5. **code-server's heartbeat file isn't an activity signal.** It's touched about once a minute while
   a client is connected, idle or not (S4 table), which confirms the spec's choice to measure at the
   proxy.

6. **Webviews need a secure context** (`crypto.subtle`). Production serves the IDE over HTTPS, so
   this only matters for local testing; the harness tells Chromium to treat its test origin as
   secure.

7. **`SHELL` must be in code-server's environment.** The `agent` user's login shell is
   `/usr/sbin/nologin` (`image/Dockerfile:172`); without `SHELL=/bin/bash`, every terminal VS Code
   opens exits at once. The spec's listed environment has it; this makes it required, not cosmetic.

8. **`kubectl port-forward` doesn't reach a gVisor pod's loopback** (first GKE run: the forward
   accepted and returned an empty reply). Irrelevant to the design, which reaches code-server through
   ngrok from inside the pod, but it means the GKE harness runs inside the pod.

9. **The install script's temp dir came out `0700`,** so `agent` couldn't run code-server; fixed
   (`chmod 755` after the move).

## S2: install time (local)

`install.sh`: stream the tarball through `sha256sum` into `tar`, unpack into a temp dir, move into
place only on a checksum match. A wrong checksum leaves nothing behind (tested).

| Run | Seconds |
|---|---|
| Streamed install, 3 runs (laptop network) | 20.3, 21.9, 21.6 |
| Plain download of the same file, no unpack | 21.5 |
| Unpack only, from a local file, 1 CPU (3 runs) | 3.6 each (2.8 s user, 0.8 s sys) |

The laptop's network sets the local time. In the cloud, the download from GitHub should be much
faster, and the unpack slower: startup-trim measured cloud vCPUs at about 3.5× this laptop, so about
12 s before any gVisor filesystem overhead. The page cache from unpacking counts toward the pod's
memory figure (825 MB right after an install in the production-like test container), reclaimable on
GKE's disk-backed ephemeral storage.

code-server starts listening **0.4 s** after launch.

**GKE (first `gke-run.sh`, 2026-09-28, image `c66fd6657b1a`, amd64, gVisor, 1 vCPU):** two installs
of **19.5 s and 19.2 s** (download from GitHub, checksum, unpack; 670 MB on disk), and code-server
listening **1.1 s** after launch, with 250 MB RSS before any client. That is the wait on a first
"Open in VS Code" if nothing prefetched.

## S3: through the proxy (local)

`harness.mjs`: Chromium → a counting relay → agentd's `LocalPreviewProxy` (Origin kept) →
code-server, with `ide-test.kernal.run` mapped to 127.0.0.1 so the headers match production.
code-server ran as `agent` with the spec's flags (`--auth none --disable-proxy --config
/etc/code-server.yaml`, a listed environment, its own process group).

| Check | Result |
|---|---|
| Workbench loads, file tree shows | pass |
| Edit and save; the file stays owned by `agent` | pass |
| Terminal: a bash prompt as `agent` in `/workspace`; a command's output lands in the workspace | pass |
| File watcher: a file the model writes appears in the tree | pass |
| Webview: the Markdown preview renders, workspace images included | pass |
| Open VSX: CLI install of `redhat.vscode-yaml`; UI search finds Prettier | pass |

Raw: `s3-results-local.json`. Screenshots were used to debug the harness; none are kept.

## S4: activity at the proxy (local)

Client-to-server WebSocket frames and bytes at the relay, 2 minutes per phase, one tab
(`s4-results-local.jsonl`):

| Phase | Frames/min | Bytes/min |
|---|---|---|
| Idle, focused tab | 33 | 573 |
| Idle, tab in the background | 30 | 352 |
| Idle, the 2 minutes right after typing | 46 | 11,523 |
| Scrolling and reading | 109 | 2,797 |
| Terminal: a command every 3 s | 210 | 5,812 |
| Typing | 1,408 | 59,969 |

- An idle tab, focused or not, settles at about 30 frames and under 600 bytes a minute: keepalives.
- Everything a person does is at least 3× that. Scrolling counts too, which matters: reading code is
  using the IDE.
- The minute after typing still carries traffic (language features, git status). That just extends
  activity by a minute.
- **Proposed rule:** a minute counts as activity when the client sent **at least 60 frames or 2 KB**
  in it. Only traffic through the proxy counts, which only comes from past ngrok's sign-in.
- No page requests happened after the first load (`pageRequests` 0 in every phase), which is why the
  dev-server rule (page loads) can't be reused.

## S5: memory (local)

In Docker, 1 CPU / 2 GiB, one browser tab, two extensions (built-in Markdown, YAML), a terminal:

| State | Container memory | code-server RSS (sum) |
|---|---|---|
| code-server running, no client | 260 MiB | 150-170 MiB |
| Client connected, idle | 540-585 MiB | 640-670 MiB |
| While typing | 725 MiB | 820 MiB |

(Summed RSS double-counts shared pages, so it can exceed the container figure.) That leaves roughly
1.3 GiB for pi, agentd and a dev server. The GKE run measures it next to the real image.

## GKE half: how to run it

Both scripts use `~/.kube/outfitter` and gcloud configuration `outfitter`, read the live
`outfitter-agent` template only to copy its image (`c66fd6657b1a` when written), and delete what
they create on exit. `DRY_RUN=1` prints the objects and changes nothing.

```sh
cd outfitter/deploy/ide/spike
export CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
./gke-run.sh        # S2, S3 under gVisor, S4, S5: ~20 min; one claim in outfitter-sandboxes
./s1-run.sh 5       # S1: pushes outfitter-agent:ide-spike-s1-<time>, 5 cold claims per image
```

- `gke-run.sh` creates a ConfigMap, the `ide-spike` SandboxTemplate and pool (replicas 0), and one
  claim. The pod clones a public repo, installs code-server twice (timed), starts it on
  127.0.0.1:8080 and logs memory every 15 s. The script port-forwards to it and runs the harness.
  If port-forward to a gVisor pod doesn't work, the script stops there with the install and memory
  figures already in `gke-pod.jsonl`.
- `s1-run.sh` builds `Dockerfile.s1` (the production image plus the unpacked amd64 tarball, via
  `ADD`, so no emulation) and pushes it, then runs `deploy/gke/spike/s4_measure.py` against the
  production image and the baked one. The first baked round is its tag's first pull.

## Open

- Pick download or bake-in when S1 and S2 are in (spec §2). Bake-in looks better than the spec
  assumed: warm-pool pods are replaced on each release and pay the first pull where nobody waits,
  and streaming spares cold starts the unused bytes. If S1 confirms that, the on-demand install,
  `ide.prepare`, and its failure modes go away.
- Confirm the S4 floor through ngrok and under gVisor.
