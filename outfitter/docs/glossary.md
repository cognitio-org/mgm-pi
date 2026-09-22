# Outfitter glossary

Outfitter dresses its UI in a retro C64/GEOS vocabulary. This page maps every term back to what it
actually is, for anyone reading the docs instead of clicking around the app. The same content is
also in-app at `/manual`, alongside a self-playing animated tour and the error-message reference
below.

The source of truth for both is `packages/web/src/lib/glossary.ts` -- keep this file in sync by
hand if that changes.

## Terms

| Label | Plain meaning | Code name |
|---|---|---|
| **Kernal** | The coding agent that does the work, on your laptop (the `kernal` command) or in a cloud Drive. | `agentd` + `pi` |
| **Tape** (Tapes) | A saved agent setup: model, instructions, tools. | Guru |
| **Floppy** (Floppies) | One conversation with an agent, which you can continue later. | Session |
| **Disk Box** | All your floppies. | Fleet / session list |
| **Drive** (Drives) | A cloud sandbox running an agent right now. | Run / Cloud Run execution |
| **▶ Play** | Wake a floppy's drive. | wake |
| **■ Stop** | Stop the drive. | stop |
| **Break** | Interrupt the current turn. | abort |
| **⏏ Eject** | Take the floppy home and continue it in Kernal on your laptop. | teleport |
| **Peripherals** | Model and service providers and their health. | Providers |
| **Dongles** | Your personal access tokens for Kernal on your laptop. | API tokens |
| **Control Panel** | Keys and deployment settings. | Settings |
| **Sysop** | Someone allowed to change keys and settings. | operator |
| **Manual** | The in-app help page (`/manual`) this glossary is drawn from. | Manual / Help |

## How a typical task goes

1. **Pick a Tape** -- choose a saved agent setup (model, instructions, tools) from the Disk Box's
   new-session dialog.
2. **Start a Floppy** -- type what you want done. That's a new conversation, a Floppy, saved in
   your Disk Box.
3. **A Drive wakes up** -- ▶ Play wakes a cloud sandbox: the Kernal runs, works the task, and
   streams its output back.
4. **Steer it, or let it run** -- send follow-ups, answer questions it asks, or hit Break to
   interrupt the current turn.
5. **■ Stop or ⏏ Eject** -- stop the Drive when you're done, or Eject to keep going on your laptop
   with `kernal --teleport`.

## Error messages

Outfitter's error states borrow C64/PET BASIC error text and boot messages. Here's what each one
actually means:

| Message | What it means |
|---|---|
| `KERNAL PANIC` | The page crashed. Your sessions are safe -- reload to get back to the Disk Box. |
| `Sorry, a system error occurred.` | An API call failed. Usually transient -- try the action again. |
| `?FILE NOT FOUND ERROR` | The thing you asked for (a session, a guru, ...) doesn't exist or was removed. |
| `?DEVICE NOT PRESENT ERROR` | A provider is down, or you're offline. |
| `?SYNTAX ERROR` | A form field is invalid -- check what you typed. |
| `?OUT OF MEMORY ERROR` | The context window is nearly full. Start a fresh floppy to keep going. |
| `BREAK` | You interrupted the current turn. |
| `READY.` | Idle and waiting for you -- everything's fine. |
| `LOAD ERROR` | ▶ Play failed -- the drive didn't wake up. Try again in a moment. |

## The animated tour

`/manual` also renders a ~75-second self-playing tour through this vocabulary as an original
pixel-art animation (pure SVG/CSS/React, framed as a C64-style "monitor"). It's fully keyboard
accessible, captions are always real text (not just animation), and it becomes a static
step-by-step storyboard under `prefers-reduced-motion`. See
[`docs/reports/manual-tour.md`](reports/manual-tour.md) for how it was built and how to re-record
`docs/design/tour.webm` / `tour.gif`.
