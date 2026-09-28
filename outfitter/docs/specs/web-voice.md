# Web voice: talk to a guru from the session page

Status: phases 1–3 built and live since `outfitter-v2026.09.28.2`; phase 4 (spoken replies) planned.
Epic #256. Owner decisions of 2026-09-28 (#251) are folded in.

- **Phase 1** (#252, PR #258): `POST /api/voice/token`, voice preferences, the per-floppy engine,
  and the Deepgram key on the web role.
- **Phase 2** (#253, PR #260): the mic in the Composer.
- **Spend** (#257, PR #261): each person's Deepgram spend, the sysop table, an optional cap.
- **Phase 3** (#254, PR #262): the live suite uses the mic against real Deepgram after each deploy.
- **Phase 4** (#255): spoken replies. Planned below, not started.

## Problem

On the laptop, kernal has voice input through the pi extension pi-listen: hold Space, talk, and the
transcript lands in the prompt. In Outfitter, the guru runs in a sandbox as `pi --mode rpc` under
agentd, with no microphone and no terminal. pi-listen records from the mic of the machine pi runs on
(SoX or ffmpeg) and reads keys from a raw TTY, and it has no way to take audio from anywhere else. So
the image leaves it out (`image/Dockerfile`, `image/render-settings.sh`), and the web app had no way
to talk to a guru.

## Decisions (owner, 2026-09-28)

1. **Engine:** Deepgram by default, with a per-floppy toggle to the browser's built-in speech
   recognition. We support Chrome and Safari only, and both have it.
2. **Key:** the same Deepgram project, and so the same bill, as kernal's bundle key, but a second,
   Member-level key with `usage:read`, held only in Secret Manager. The bundle key is usage-only:
   Deepgram refuses it for `/v1/auth/grant` and for the usage API (checked 2026-09-28). It also ships
   in every bundle, so it must not gain those rights.
3. **Spend:** each person sees their Deepgram spend today, this week and this month (required). A
   per-person cap is a nice-to-have.
4. **After speaking:** a per-person option, **Send** by default (the transcript is sent when
   recording stops), or **Review** (it stays in the Composer).
5. **Mic control:** one button with two behaviours. A quick press latches it on until the next press;
   press and hold talks until release. A keyboard shortcut does the same.
6. **Spoken replies:** the next phase, planned now (below).

## How it works

```
browser (session page)                          outfitter-api (web role)           Deepgram
  mic button / ⌥Space ──POST /api/voice/token──▶ mints a 30 s token with the ──▶ /v1/auth/grant
                       ◀── {token, model, tag} ── Member key (Secret Manager)
  getUserMedia → MediaRecorder (webm/opus, Safari mp4)
        └──────── wss://api.deepgram.com/v1/listen?model=nova-3&…&tag=<person> ──────────▶
        ◀─────────────────────── interim and final transcripts ───────────────────────────
  transcript → Composer → POST /api/sessions/:id/messages (after speaking = send)
```

- **Nothing new reaches the sandbox.** A transcript goes out through the same `/messages` route as
  typed text. There are no changes to agentd, pi, the image or the mailbox.
- **The key never reaches the browser.** The api mints a 30 s token; it only has to be valid while
  the socket opens, and the stream carries on after it expires. The browser passes it as the WebSocket
  subprotocol `["bearer", token]`.
- **Not proxied.** The browser talks to Deepgram directly. A browser WebSocket through IAP is untested,
  and this is Deepgram's documented browser pattern.
- **Every stream is tagged** `outfitter-user-<first 16 hex of sha256(lowercased email)>`, so Deepgram
  records usage per person without ever seeing an address. That tag is what spend reads back.

### The mic (`packages/web/src/components/VoiceControl.tsx`, `hooks/useVoice.ts`)

- **Gesture:** one state machine for the button and the keyboard (`lib/voice-gesture.ts`). A press
  under 300 ms latches the mic on; a longer one is a hold that stops on release. Recording starts on
  the press itself, so the first word of a hold isn't lost while the gesture is being worked out.
- **Shortcut:** ⌥/Alt+Space, anywhere on the session page except another text field.
  - A hold ends when either key goes up, or when the window loses focus.
  - Esc cancels at any stage, including while the last words are still arriving, and restores the
    draft as it was.
- **While live:**
  - the transcript appears after whatever was typed;
  - the box is read-only and Send is held off;
  - the button turns green with a level ring (a CSS variable written directly, no re-renders).
- **After speaking = send:** sends through the page's own path, with the send mode picked in the
  Composer. A transcript that may be missing its end is never auto-sent: after a dropped connection,
  or a stop that never heard back within 4 s (3 s for built-in). It stays in the box with a note.
- **Engines** (`lib/voice-engines.ts`):
  - **Deepgram** fetches the token and opens the mic in parallel. Audio is queued until the socket
    opens, CloseStream is sent once after the last chunk, and it waits for the final results. A
    refused handshake, or no answer within 8 s, counts as `upstream`.
  - **Built-in** uses `SpeechRecognition` (`webkitSpeechRecognition` in Chrome), continuous with
    interim results. Chrome's auto-end after a silence is restarted without losing what was already
    said.
  - **Fallback:** when Deepgram is off here, rate-limited, at the cap, or refusing, the mic uses
    built-in and says why. A refused mic doesn't fall back.
- **Timing:** each start gets an id. A start that was cancelled, or that outlived the page, cancels
  whatever the engine hands back, so a recording can't stream on with no UI. A press while the
  previous recording is still starting or finishing is ignored.
- **Settings menu (▾):**
  - engine for this floppy, stored on `Session.voiceEngine`;
  - after speaking, stored on `User.voice`;
  - the spend line;
  - a hint.

  Menu items are grouped under labels, arrow keys and Home/End move between them, and Esc puts focus
  back on the ▾.

### API (`packages/api/src/voice.ts`, `voice-usage.ts`, `routes/voice.ts`)

`docs/protocol.md` ("Web voice") has the full shapes.

| Route | What |
|---|---|
| `POST /api/voice/token` | `{token, expiresAt, model, language, tag}`. 404 `voice_disabled` (no key), 429 `voice_rate_limited` (20 a minute per person, per instance), 403 `voice_cap_reached`, 502 `voice_upstream`. Responses are `no-store`. |
| `GET /api/me/voice` | `{deepgram, model, language, prefs: {afterSpeaking}}` |
| `PUT /api/me/voice` | `{afterSpeaking: "send"\|"review"}` → `{prefs}` |
| `PUT /api/sessions/:id/voice` | `{engine: "deepgram"\|"builtin"}` |
| `GET /api/me/voice/spend` | today, week and month: `{minutes, ttsCharacters, usd}`; `{available: false}` without the key and `DEEPGRAM_PROJECT_ID`; 502 `voice_usage_upstream` |
| `GET /api/operator/voice/spend` | sysops: the month per person, the untagged use, the total (same `available` and 502) |

The routes are on the web role only; link registers none of them.

### Spend and the cap

- **Source:** Deepgram's usage API, by tag. One call for a person (`/usage?tag=`), one for the sysop
  table (`/usage/breakdown?grouping=tags`). Cached 60 s per instance; failures aren't cached.
- **Reporting lag:** usage showed new streams within a minute or two when checked, so there is no
  browser-reported estimate to reconcile (the original plan had one).
- **Periods:** UTC days, ISO weeks from Monday and calendar months, which is how Deepgram buckets
  usage.
- **Dollars:** Deepgram reports units, so dollars come from `VOICE_STT_USD_PER_MINUTE` (default
  0.0077) and `VOICE_TTS_USD_PER_1K_CHARS` (default 0.03). Those are Deepgram's regular pay-as-you-go
  list prices; a plan discount or promotion (nova-3 streaming was $0.0048 in 2026-09) makes the real
  bill lower.
- **Where it shows:**
  - the mic's menu, when Deepgram is on: "$0.02 today · $0.08 week · $0.46 month";
  - the Tokens page (the one per-person page): a table;
  - Settings (sysops): per person, then "Laptop (kernal, untagged)" (pi-listen shares the project and
    tags nothing), then the total.
- **Cap:** `VOICE_MONTHLY_CAP_USD`, default 0 (off). It's a soft cap:
  - checked when a stream starts, and compared in cents;
  - against usage up to a minute or two old, so one long session can run past it;
  - if usage can't be read within 1.5 s, the token is minted anyway, so a usage outage never takes
    the mic away;
  - it needs `DEEPGRAM_PROJECT_ID` as well as the key: without the project, spend reads
    `available: false` and the cap isn't checked.

### Deploy

- **Secret:** `outfitter-deepgram-key` in Secret Manager (a Member key with `usage:read`, created
  2026-09-28), mounted as `DEEPGRAM_API_KEY` on the web role only (`deploy/service.sh`).
- **Project:** `DEEPGRAM_PROJECT_ID` in `deploy/config.env`. It isn't secret.
- **Rates and cap:** the `VOICE_*` variables above aren't set by the deploy; their code defaults apply
  unless someone adds them.
- **Unset key:** Deepgram voice is off, and the mic offers only built-in speech. Unset project id:
  voice works, but spend and the cap are off.

## Tests

- **API:**
  - `test/voice.test.ts`: the token paths, preferences, the engine, role registration, and Mongo
    upserts against a real mongod;
  - `test/voice-usage.test.ts`: periods, bucketing, pricing, the cache, the breakdown, both spend
    routes and the cap, including a hanging usage read and the cents comparison;
  - the deploy env test: web gets the key and project id, link doesn't.
- **Web:**
  - `test/voice-gesture.test.ts`;
  - `test/voice-engines.test.ts`: both engines against fake `MediaRecorder`, `WebSocket` and
    `SpeechRecognition`;
  - `test/voice-control.test.tsx`: the Composer end to end, with an engine fake that resolves on
    demand for the timing cases;
  - `test/voice-spend.test.tsx`.
- **Live, after every deploy** (`packages/web/live/voice.mjs`, inside the lifecycle test):
  - Chrome's fake mic plays a sentence generated by espeak-ng, in a separate job with no permissions.
  - On the floppy the test already made, it sets Review through the menu (the open page reads that
    setting once, so the API can't change it for this page), then checks a hold, tap-tap, a ⌥Space
    hold after typed text, Esc, and the spend line.
  - It fails if anything POSTs a message. In CI a skip fails too (`E2E_EXPECT_DEEPGRAM=1`).

## Known limits

- **Browsers:** Chrome and Safari only. Firefox has no `SpeechRecognition`; Deepgram would work there,
  but it's unsupported and untested.
- **Built-in speech** isn't live-tested, because Chrome's fake mic doesn't feed `SpeechRecognition`.
  It has unit tests only. It sends audio to Google (Chrome) or Apple (Safari).
- **Windows:** ⌥/Alt+Space opens the system window menu, which a page may not be able to prevent.
  The button always works.
- **Safari's mp4 recording path** has never run against real Deepgram. Deepgram accepts mp4/aac by
  its container header.
- **The cap is soft** (above). The rate limit is per Cloud Run instance.
- **Laptop use isn't attributed to anyone:** kernal's pi-listen tags nothing, so it shows only as
  "untagged".

## Phase 4: spoken replies (#255, planned)

Mirrors voice input:

- **Engine:** Deepgram Aura by default, with a per-floppy toggle to the browser's built-in
  `speechSynthesis`.
- **Auth:** the same 30 s token from `POST /api/voice/token` (grant tokens also cover `/v1/speak`).
  The Aura WebSocket (`wss://api.deepgram.com/v1/speak`) runs straight from the browser for low
  latency, with REST `POST /v1/speak` as the fallback. Every request carries the person's tag, so TTS
  characters count toward the spend above (`ttsCharacters`, already priced).
- **What's spoken:** only the assistant's reply text, taken from the SSE stream, sentence by sentence
  as it arrives. Code blocks, links and markdown are stripped (pi-listen's `tts-text-filter.ts` is the
  model); tool output and thinking are skipped.
- **Controls:**
  - a speaker toggle per floppy, next to the existing sound toggle (off by default);
  - Esc or the mic stops playback;
  - playback mutes while the mic is live, and pressing the mic interrupts speech;
  - voice and speed live in the voice menu.
- **Autoplay:** browsers need a user gesture before audio plays. Turning the toggle on counts as one,
  so the AudioContext is created and resumed there.
- **Tests:**
  - unit: the text filter, the sentence chunker, the mic interrupting speech;
  - live: turn the speaker on and assert an Aura request is made and audio starts. The sound itself
    isn't checked.

Open for the owner:
- the default Aura voice;
- whether after speaking = Send plus the speaker toggle should make a hands-free mode: speak, it
  sends, the reply is read, and the mic reopens.

## The laptop side

kernal keeps pi-listen: hold Space, or toggle with ctrl+shift+v in terminals that report it. Its
`kernal-voice` extension seeds an offline model when there's no Deepgram key. PR #263 (in review for
#248 and #249) fixes the docs and has it take that seed back out once a key exists. pi-listen findings that don't block anything are tracked
in #250.
