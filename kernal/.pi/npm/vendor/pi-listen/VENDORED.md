# Vendored: pi-listen

Kernal's fork of [`@codexstar/pi-listen`](https://github.com/codexstar69/pi-listen) 7.2.2 (MIT, © its
authors; `LICENSE` is theirs and stays). Upstream has been unmaintained since 2026-05-01. The owner's
decision (#250) was to vendor it and improve it here, rather than switch to a young fork.

- **Loaded:** as a local package, `./npm/vendor/pi-listen` in `kernal/.pi/settings.json`. It lives
  under `.pi/npm` so its dynamic `import("sherpa-onnx-node")` resolves from `.pi/npm/node_modules`,
  where `sherpa-onnx-node` is an optional dependency of `.pi/npm/package.json`.
- **Version:** `7.2.2-kernal.N`, where N counts kernal's changes.
- **Changes from upstream:** the first commit is upstream 7.2.2 verbatim. Kernal's changes are listed
  below; each is marked `// kernal:` in the code.
- **Tests:** `kernal/tests/pi-listen-vendored.test.ts`.

## Kernal's changes

The decisions live in `extensions/voice/kernal.ts` as small pure functions, which the call sites use
and the tests check.

| # | Change | Where | Upstream |
|---|---|---|---|
| 1 | **Hold Space no longer locks on:** a Space repeat while recording re-arms the gap-based release timer (`rearmReleaseOnRepeat`, never during warmup, where an expiry would falsely cancel). Once a hold's recording has started, the timer is armed (`armAfterRecordingStart`), so letting go right around the start is caught too. Terminals that send Kitty repeat events but no release events, some Linux terminals and some Ghostty setups, kept recording forever. Warp and Terminal.app weren't affected. | `voice.ts` Kitty repeat branch, the three recording-start handlers | #13 |
| 2 | **No spoken replies without a UI** (`autoSpeakAllowed`): `pi -p`, subagents and scripted runs no longer read replies aloud on the host. | `voice.ts` `maybeSpeakNew`, `turn_end` | — |
| 3 | **No always-on stream log** (`streamLogPath`): only with `PI_VOICE_DEBUG`, in the OS temp dir. Upstream appended to `/tmp/pi-listen-stream.log` on every stream, with no size limit. | `voice.ts`, `voice/tts-playback.ts` | — |
| 4 | **Project voice settings merge over the global ones** (`mergeVoiceBlocks`), key by key, instead of replacing them. A project that sets only its language keeps your backend, model and Deepgram key. The merged config stays the project's (its scope is never the global block's), and a project save writes only what differs from the global settings (`projectOnlyKeys`), so global changes still reach the project. | `voice/config.ts` | — |
| 5 | **`/voice on` no longer advertises spoken commands** ("undo", "clear", "new line", "period") that were never implemented. | `voice.ts` | — |
| 6 | **The version banner** in the debug log says 7.2.2-kernal instead of 7.1.3. | `voice.ts` | — |
| 7 | **Linux playback:** ffplay gets `-ac 1` below ffmpeg 5.1 and `-ch_layout mono` from 5.1 (`ffplayChannelArgs`). Ubuntu 22.04's 4.4 rejected `-ch_layout` and ffplay exited 1; this was checked in `ubuntu:22.04` and `ubuntu:24.04`. WAV playback also uses aplay when paplay isn't installed (`linuxFilePlayer`). | `voice/tts-playback.ts` | #6 |

Not changed: in RPC mode the final Deepgram transcript is still only applied when the editor has text
(`getEditorText()` is always "" there). Nothing kernal runs uses pi-listen under RPC; Outfitter's
voice is in the browser.
