// Retro-hardware labels for every user-facing noun in the UI. UI text only -- routes, API paths,
// data field names, and code identifiers are unchanged everywhere else in the app (grep for
// `guruId`, `/api/gurus`, `sessionId`, etc. still finds the real names). See
// docs/design/README.md's vocabulary table for the full label/meaning/code-name mapping.
//
// Each entry carries `one`/`many` (the display word) and a plain-language `hint`, used as a page
// subtitle ("Tapes · agent configurations") and as a tooltip (`title` attribute) on nav items,
// desk icons, and buttons that act on that noun.

export interface VocabEntry {
  one: string;
  many: string;
  hint: string;
}

export const vocabulary = {
  guru: { one: "Tape", many: "Tapes", hint: "reusable agent configurations: model, prompt, tools" },
  github: { one: "GitHub", many: "GitHub", hint: "repositories the GitHub App can reach" },
  session: {
    one: "Floppy",
    many: "Floppies",
    hint: "a conversation with an agent you can continue later",
  },
  sessionList: { one: "Disk Box", many: "Disk Box", hint: "all your floppies" },
  newSession: { one: "New Floppy", many: "New Floppies", hint: "start a new conversation with a tape" },
  drive: { one: "Drive", many: "Drives", hint: "cloud sandboxes running agents right now" },
  provider: { one: "Peripheral", many: "Peripherals", hint: "model and service providers, and their health" },
  token: { one: "Dongle", many: "Dongles", hint: "personal access tokens for Kernal teleport" },
  // #389 central sign-in and settings (docs/specs/central-auth.md §6-§7).
  device: { one: "Device", many: "Devices", hint: "computers where Kernal is signed in with your account" },
  account: { one: "Account", many: "Account", hint: "your Kernal settings: profiles, keys, local models and spend" },
  profile: { one: "Profile", many: "Profiles", hint: "named sets of Kernal settings, picked with kernal --profile" },
  settings: { one: "Control Panel", many: "Control Panel", hint: "keys and deployment settings" },
  operator: { one: "Sysop", many: "Sysops", hint: "can change keys and deployment settings" },
  help: { one: "Manual", many: "Manual", hint: "what Outfitter is" },
  trash: { one: "Trash", many: "Trash", hint: "stopped floppies" },
  archive: { one: "Archive", many: "Archive", hint: "floppies put away: hidden and read-only until restored" },
  desk: { one: "Desk", many: "Desk", hint: "the Outfitter desktop" },
  kernal: {
    one: "Kernal",
    many: "Kernal",
    hint: "the coding agent that runs sessions, on your laptop or in a cloud Drive",
  },
} as const satisfies Record<string, VocabEntry>;

export type VocabKey = keyof typeof vocabulary;

/** `"Tapes · reusable agent configurations: model, prompt, tools"` -- the page-subtitle format
 * used under a page's <h1>/<h2>. */
export function vocabSubtitle(key: VocabKey, form: "one" | "many" = "many"): string {
  const entry = vocabulary[key];
  return `${entry[form]} · ${entry.hint}`;
}

/** Tape-deck transport labels: glyph + word, with a tooltip. `send` is deliberately absent --
 * the brief keeps "Send" as-is for the composer. */
export const transport = {
  wake: { glyph: "▶", word: "Play", hint: "wake this floppy and start the run" },
  stop: { glyph: "■", word: "Stop", hint: "stop this floppy's run" },
  abort: {
    glyph: "",
    word: "Break",
    hint: "interrupt the current turn, like the C64 RUN/STOP key",
  },
  eject: {
    glyph: "⏏",
    word: "Eject",
    hint: "continue this floppy on your laptop with Kernal",
  },
} as const;

/** What the owner (or a sysop) can do with a whole floppy, as opposed to its drive (transport). */
export const floppyActions = {
  archive: { word: "Archive", hint: "put this floppy away: it stops, hides from the Disk Box and turns read-only" },
  restore: { word: "Restore", hint: "take this floppy out of the archive so it can run again" },
  format: { word: "Format", hint: "erase this archived floppy for good, like formatting a real disk" },
} as const;

/** A floppy's display title: its name, or "Floppy" and the first 8 characters of its id. */
export function floppyTitle(session: { id: string; name?: string }): string {
  return session.name ?? `Floppy ${session.id.slice(0, 8)}`;
}

export function transportLabel(key: keyof typeof transport): string {
  const t = transport[key];
  return t.glyph ? `${t.glyph} ${t.word}` : t.word;
}
