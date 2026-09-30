---
name: outfitter-admin
description: Administer Outfitter with the outfitter_* and session_* tools - build or edit a tape, manage environments, debug a Drive from past sessions, draft a tape from them.
---

# Outfitter admin

Outfitter runs Kernal agents in the cloud. Its words: a **Tape** is a saved agent setup (code and API
name: guru), a **Floppy** is a session, a **Drive** is one run of it, a **Dongle** is a personal API
token, a **Sysop** is an operator. Use the tools below, never curl or the web API. If they aren't
available, this tape has admin tools off, or no Dongle (OUTFITTER_API and OUTFITTER_TOKEN) is set:
say so and stop.

## Tools

- `outfitter_tapes` — list, get, meta, create, update, delete. `meta` first: it lists valid models,
  thinking levels and env names a tape may not set. `update` returns only what changed.
- `outfitter_environments` — list, get, create, update (repo, base branch, env presets).
- `outfitter_sessions` — list, get: tape, owner, repo, status, run state, cost.
- `session_search` — find sessions by words (cloud default), or by meaning with `mode: hybrid`
  (it falls back to words when the embedding limit is hit); on a laptop, also local sessions. Hits carry `[entryId]`s.
- `session_transcript` — read one session. Start with `view: outline`; then `around: <entryId>` from a
  hit, or `view: text` and `from:` to page. `toolOutput: full` only when you need a whole result.

Ids: a unique prefix of 4+ characters (8+ for sessions), or the 8-character id the tools print. Results
are short on purpose; ask for more (limit, around, from) rather than guessing.

## Build a tape

1. Ask what the tape is for: its job, the repo if any, what it must never do, which model family.
2. `outfitter_tapes meta` (filter models with `models: "claude"` and the like). Pick one model id
   exactly as listed, and a thinking level.
3. Draft `systemPrompt` (or `appendSystemPrompt` to keep pi's default prompt): the role, the steps it
   should follow, what done looks like, the limits. Short and specific beats long.
4. `outfitter_tapes create` with a slug `id` (e.g. `pr-reviewer`), `fields: {name, model, thinking,
   appendSystemPrompt, tools?, excludeTools?, env?}`. Show the user the tape before creating it.
5. Test it only when the user wants: they start a floppy on it from the web UI, or you read one they
   ran with `session_search` / `session_transcript`. Adjust with `outfitter_tapes update`.

## Debug a Drive

1. `session_search` for the symptom: an exact error string with the default text mode, a description
   with `mode: hybrid`. Narrow with `tape`, `owner: "me"`, `since: "7d"`.
2. `session_transcript` on the best hit, `view: outline`: failed tool calls show as `✗`.
3. `around: <entryId>` with `view: text` to read the few entries around the failure.
4. Say what failed, the evidence (entry ids), and the fix. Change nothing without the user's go-ahead.

## Draft a tape from past sessions

1. `session_search` for sessions that did the job well; read two or three outlines.
2. Pull out the steps that worked, the checks that caught problems, and the user's corrections.
3. Turn them into the tape's prompt (Build a tape, step 3), and show it before creating.

## Rules

- **Approvals.** Deleting anything, and changing a tape that has admin tools, needs the person's yes:
  in a Drive a card on the floppy page (it can take minutes, or be declined; don't retry a decline),
  on a laptop a prompt in the terminal. Admin tools on a tape (`adminTools`) are set only in the web
  UI, by a person.
- **Secrets never go through these tools.** A key or token belongs in the web UI (Sysop settings,
  or the tape's env there); never ask for one in chat or put one in a tool argument.
- **Developing Outfitter or Kernal itself** is ordinary work on its repo: a branch, commits, a pull
  request. Never deploy, never push an `outfitter-v*` tag, never publish a Kernal release; those are
  the owner's.
- A write that failed with "may have been applied" did reach Outfitter: check with list or get before
  trying again.
