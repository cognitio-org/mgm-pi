# Browser IDE spike (phase 0)

Spec: `docs/specs/browser-ide.md`. Issue #240, epic #245. Scripts and raw results:
`deploy/ide/spike/`.

The spike has two halves: **local** (this laptop, Docker, 1 CPU / 2 GiB, arm64) and **GKE**
(gVisor, the production image `c66fd6657b1a`, amd64, 1 vCPU), run by the owner with `gke-run.sh`
three times on 2026-09-28. The spike pods ran at 2 GiB, copied from the GKE spec's original shape;
production Drives have been 4 GiB since #187 (`deploy/config.env`), which the decision below takes
into account. S1 was dropped after that decision. Cloud Run is out of
scope: the fleet is moving fully to GKE (owner decision, 2026-09-27).

| Item | Question | Local | GKE |
|---|---|---|---|
| S1 | What does baking code-server into the image cost a cold start? | size only (below) | **dropped** (decision below) |
| S2 | How long does the on-demand install take? | 21 s, network-bound; unpack 3.6 s CPU | **18.8-23.3 s** (6 installs) |
| S3 | Does code-server work through agentd's proxy? | **pass after one proxy change** | **pass** (below) |
| S4 | Can activity be told from an idle tab at the proxy? | **yes**: 30 frames/min idle vs 109+ active | **yes**: 31-39 idle vs 111+ active |
| S5 | How much memory does code-server need? | 540-725 MiB with a client | **944-1,100 MB RSS**: fits in today's 4 GiB Drives |

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

2. **The download is 222 MB, not about 100 MB,** and unpacks to 670 MB on amd64 (arm64: 217 MB and
   641 MB; the `du -h` figures used below, 622 MiB with `lib/vscode` 488 and a bundled Node 117, are
   arm64 in binary units). Baking it in would nearly double the ~680 MB image.

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

**GKE (three `gke-run.sh` runs, two installs each):** 19.5, 19.2, 23.3, 20.1, 18.8 and 19.1 s
(download from GitHub, checksum, unpack; 670 MB unpacked on amd64). code-server listens **1.1-1.5 s** after
launch, with 250 MB RSS before any client. About 20 s is therefore the wait on a first
"Open in VS Code" if nothing downloaded ahead.

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

**Under gVisor (GKE).** `kubectl port-forward` can't reach a gVisor pod's loopback, so the harness
runs inside the pod with the image's Playwright and full Chromium, sharing the pod's one vCPU with
code-server. That contention made the harness's fixed waits flaky, so the evidence is taken across
runs 2 and 3 plus the files each run left in the pod:

| Check | Result under gVisor |
|---|---|
| Load, file tree | pass (both runs) |
| Bundled ripgrep (`rg --files` as `agent`) | pass: 97 files in 197 ms (4 ms locally) |
| Quick Open | pass (run 3). Run 2's editor checks failed only where they opened files through Quick Open with a 30 s wait |
| Edit and save | works: the marker was on line 1 of `readme.md`, owned by `agent`, after the check. The check read the file 1.5 s after Ctrl+S, before the save landed |
| Terminal | pass (run 2); in run 3, `t.txt` held `from-terminal agent`, owned by `agent`, after the check |
| File watcher | pass (both runs) |
| Webview (Markdown preview) | pass (run 3) |
| Open VSX: CLI install, UI search | pass (run 2); run 3's harness hung on the UI search with Chromium's renderer at 800 MB |

Raw: `s3-results-gke-run2.json`, `harness-gke-run3.log`, `gke-pod-run2.jsonl`, `gke-pod-run3.jsonl`.

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
- **Under gVisor (GKE run 2, `s4-results-gke-run2.jsonl`), the same shape:**

  | Phase | Frames/min | Bytes/min |
  |---|---|---|
  | Idle, focused tab | 39 | 738 |
  | Idle, tab in the background | 31 | 423 |
  | Idle, right after typing | 50 | 11,010 |
  | Scrolling and reading | 111 | 2,839 |
  | Terminal | 219 | 5,922 |
  | Typing | 845 | 58,819 |

  Idle never passed 39 frames or 740 bytes a minute, so the 60 frames / 2 KB rule holds with room.
  The harness ran in the pod rather than through ngrok; ngrok forwards the same client frames.
- No page requests happened after the first load (`pageRequests` 0 in every phase), which is why the
  dev-server rule (page loads) can't be reused.

## S5: memory (local)

In Docker, 1 CPU / 2 GiB, one browser tab, two extensions (built-in Markdown, YAML), a terminal:

| State | Container memory | code-server RSS (sum) |
|---|---|---|
| code-server running, no client | 260 MiB | 150-170 MiB |
| Client connected, idle | 540-585 MiB | 640-670 MiB |
| While typing | 725 MiB | 820 MiB |

(Summed RSS double-counts shared pages, so it can exceed the container figure.)

**Under gVisor (GKE, 52 + 91 samples every 15 s):** code-server's summed RSS was **944-1,100 MB**
with a client connected (250 MB with none), against 640-820 MB locally. The pod-wide figure
(1.4-1.57 GB) also counts the in-pod test Chromium (its renderer alone reached 800 MB), which a real
IDE session doesn't have: the person's browser is on their own machine.

On the spike's 2 GiB pods that would leave under 1 GiB for pi, agentd and the model's commands. But
**production Drives are 4 GiB** (since #187, after 2 GiB left ~1.8 GiB and builds were OOM-killed),
which leaves about **2.8 GiB** beside code-server: more than the agent had when the OOMs happened.

## GKE half: how to run it

Both scripts use `~/.kube/outfitter` and gcloud configuration `outfitter`, read the live
`outfitter-agent` template only to copy its image (`c66fd6657b1a` when written), and delete what
they create on exit. `DRY_RUN=1` prints the objects and changes nothing.

```sh
cd outfitter/deploy/ide/spike
./gke-run.sh        # S2, S3 under gVisor, S4, S5: ~20 min; one claim in outfitter-sandboxes
./s1-run.sh 5       # S1 (never run; dropped): pushes a spike tag, 5 cold claims per image
```

- `gke-run.sh` creates a ConfigMap (the scripts, the harness, agentd's `preview-proxy.ts`), the
  `ide-spike` SandboxTemplate and pool (replicas 0), and one claim. The pod clones a public repo,
  installs code-server twice (timed), starts it on 127.0.0.1:8080, logs memory every 15 s, and runs
  the harness itself with the image's Playwright and full Chromium. The script splits the pod's log
  into `gke-pod.jsonl`, `s3-results-gke.json` and `s4-results-gke.jsonl`.
- `s1-run.sh` builds `Dockerfile.s1` (the production image plus the unpacked amd64 tarball, via
  `ADD`, so no emulation) and pushes it, then runs `deploy/gke/spike/s4_measure.py` against the
  production image and the baked one. The first baked round is its tag's first pull.

## Trimming code-server

The release bundles GitHub Copilot: `lib/vscode/extensions/copilot` (158 MB) and
`lib/vscode/node_modules/@github` (114 MB, the Copilot SDK with ripgrep builds for two
architectures). That's 272 MiB of the 622 (arm64, `du -h`), for features the IDE turns off.

Removed (local test, arm64): **355 MiB unpacked by `du -h`** (622 − 272 = 350; the difference is
`du`'s per-directory block rounding), **112 MB compressed** (from 217 MB). All nine S3 checks
still pass and code-server's logs show no errors about the missing modules. Memory doesn't change
(the extension host doesn't load Copilot with AI features off), so trimming is about size only.

## Decision

**Memory.** The first write-up of this section assumed 2 GiB Drives and offered four options,
three of them about more memory for the IDE (a 3 GiB template for everyone, a separate cold 3 GiB IDE
template, a separate warm one). The owner first chose the separate cold template; the review of this
PR then found production Drives are already 4 GiB (#187), so a 3 GiB IDE template would have had
*less* memory than every other Drive.

**Decision (owner, 2026-09-28): IDE Drives use today's 4 GiB template and warm pool.** code-server
leaves about 2.8 GiB for everything else; no second template, no cold starts, no extra cost. A
separate, larger IDE template stays the lever if real use shows 4 GiB isn't enough.

**Image.** With one template, baking code-server into the image would put about 350 MB (trimmed) on
every Tape, and a separate IDE image means a second template after all. So IDE Drives download it at
Drive start (Copilot excluded on unpack), about 20 s in parallel with pi's start. **S1 was dropped**
before it ran; `s1-run.sh` and `Dockerfile.s1` stay for the record. (Earlier text in this report
about bake-in being the likely choice is historical.)

## Outcome

Folded into `docs/specs/browser-ide.md`: the memory and image decisions, §2 (download at Drive
start, Copilot excluded on unpack), §3 (`Origin` passed through, workspace trust and AI chat off,
`SHELL` required) and §5 (60 frames or 2 KB a minute). Phase 1 (#241) is next.
