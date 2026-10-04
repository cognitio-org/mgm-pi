// Outfitter Manual glossary: the UI's own retro vocabulary (Kernal, Tapes, Floppies, Drives, ...)
// mapped to plain meanings and the underlying code names, plus the retro error messages users hit
// and what they mean. Used by src/pages/ManualPage.tsx (table on desktop, cards on mobile) and by
// docs/glossary.md (kept in sync by hand -- see docs/reports/manual-tour.md).
//
// NOTE for whoever lands src/lib/vocabulary.ts (the desk/GEOS rework happening alongside this
// branch): this file is intentionally shaped so it can grow a lookup into that module later --
// each GlossaryTerm's `label`/`meaning` are plain strings today, but read from vocabulary.ts's
// term map instead of being hardcoded here once it exists (e.g. `label: vocab.kernal.label`) so
// the two vocabularies never drift apart. Nothing here imports vocabulary.ts yet since it doesn't
// exist on this branch.

export interface GlossaryTerm {
  /** Stable id, also used for anchors (#glossary-<id>). */
  id: string;
  /** The retro UI label, as shown in the app. */
  label: string;
  /** Plain-English meaning -- what it actually is. */
  meaning: string;
  /** The underlying code name / concept a developer would recognize. */
  codeName: string;
  /** A short pixel-glyph shown next to the label in the table/cards (kept ASCII/Unicode, no new
   * icon assets -- consistent with the status-pill glyphs already in the theme). */
  glyph: string;
  /** Optional in-app route this term links to. */
  linkTo?: string;
}

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  {
    id: "kernal",
    label: "Kernal",
    meaning: "The coding agent that does the work, on your laptop (the kernal command) or in a cloud Drive.",
    codeName: "agentd + pi",
    glyph: "▣", // ▣
  },
  {
    id: "tape",
    label: "Tape (Tapes)",
    meaning: "A saved agent setup: model, instructions, tools.",
    codeName: "Guru",
    glyph: "▬", // ▬
    linkTo: "/gurus",
  },
  {
    id: "floppy",
    label: "Floppy (Floppies)",
    meaning: "One conversation with an agent, which you can continue later.",
    codeName: "Session",
    glyph: "▢", // ▢
  },
  {
    id: "disk-box",
    label: "Disk Box",
    meaning: "All your floppies.",
    codeName: "Fleet / session list",
    glyph: "▦", // ▦
    linkTo: "/",
  },
  {
    id: "drive",
    label: "Drive (Drives)",
    meaning: "A cloud sandbox running an agent right now.",
    codeName: "Run / Cloud Run execution",
    glyph: "◉", // ◉
  },
  {
    id: "play",
    label: "▶ Play",
    meaning: "Wake a floppy's drive.",
    codeName: "wake",
    glyph: "▶", // ▶
  },
  {
    id: "stop",
    label: "■ Stop",
    meaning: "Stop the drive.",
    codeName: "stop",
    glyph: "■", // ■
  },
  {
    id: "break",
    label: "Break",
    meaning: "Interrupt the current turn.",
    codeName: "abort",
    glyph: "✗", // ✗
  },
  {
    id: "eject",
    label: "⏏ Eject",
    meaning: "Take the floppy home and continue it in Kernal on your laptop.",
    codeName: "teleport",
    glyph: "⏏", // ⏏
  },
  {
    id: "archive",
    label: "Archive",
    meaning: "Put a floppy away: its drive stops, it leaves the Disk Box and it can't run until you restore it.",
    codeName: "archive / restore",
    glyph: "▤", // ▤
  },
  {
    id: "format",
    label: "Format",
    meaning: "Erase an archived floppy for good: its conversation, messages and captures. There is no undo.",
    codeName: "delete session",
    glyph: "⌫", // ⌫
  },
  {
    id: "peripherals",
    label: "Peripherals",
    meaning: "Model and service providers and their health.",
    codeName: "Providers",
    glyph: "≡", // ≡ (modem-ish stacked lines)
    linkTo: "/providers",
  },
  {
    id: "dongles",
    label: "Dongles",
    meaning: "Your personal access tokens for Kernal on your laptop.",
    codeName: "API tokens",
    glyph: "‖", // ‖ (key-like)
    linkTo: "/tokens",
  },
  {
    id: "devices",
    label: "Devices",
    meaning: "The computers where Kernal is signed in with your account (kernal login). Sign one out here.",
    codeName: "device login (device-code flow)",
    glyph: "▣", // ▣
    linkTo: "/devices",
  },
  {
    id: "account",
    label: "Account",
    meaning: "Your Kernal settings: profiles, personal provider keys, local model sharing and router spend.",
    codeName: "central settings",
    glyph: "☰", // ☰
    linkTo: "/account",
  },
  {
    id: "profiles",
    label: "Profiles",
    meaning: "Named sets of Kernal settings, such as work and personal, picked per Kernal with --profile.",
    codeName: "settings profiles",
    glyph: "◫", // ◫
    linkTo: "/account",
  },
  {
    id: "github",
    label: "GitHub",
    meaning: "Repositories the GitHub App can reach, with their latest commit and open pull requests.",
    codeName: "GitHub App catalog",
    glyph: "⎇", // ⎇
    linkTo: "/github",
  },
  {
    id: "control-panel",
    label: "Control Panel",
    meaning: "Keys and deployment settings.",
    codeName: "Settings",
    glyph: "⚙", // ⚙
    linkTo: "/settings",
  },
  {
    id: "sysop",
    label: "Sysop",
    meaning: "Someone allowed to change keys and settings.",
    codeName: "operator",
    glyph: "☺", // ☺
  },
  {
    id: "manual",
    label: "Manual",
    meaning: "This page.",
    codeName: "Manual / Help",
    glyph: "ℹ", // ℹ
    linkTo: "/manual",
  },
];

export interface ErrorMeaning {
  id: string;
  /** The message exactly as the UI shows it. */
  message: string;
  /** What it actually means and, where useful, what to do about it. */
  meaning: string;
}

export const ERROR_MESSAGES: ErrorMeaning[] = [
  {
    id: "kernal-panic",
    message: "KERNAL PANIC",
    meaning: "The page crashed. Your sessions are safe -- reload to get back to the Disk Box.",
  },
  {
    id: "system-error",
    message: "Sorry, a system error occurred.",
    meaning: "An API call failed. Usually transient -- try the action again.",
  },
  {
    id: "file-not-found",
    message: "?FILE NOT FOUND ERROR",
    meaning: "The thing you asked for (a session, a guru, ...) doesn't exist or was removed.",
  },
  {
    id: "device-not-present",
    message: "?DEVICE NOT PRESENT ERROR",
    meaning: "A provider is down, or you're offline.",
  },
  {
    id: "syntax-error",
    message: "?SYNTAX ERROR",
    meaning: "A form field is invalid -- check what you typed.",
  },
  {
    id: "out-of-memory",
    message: "?OUT OF MEMORY ERROR",
    meaning: "The context window is nearly full. Start a fresh floppy to keep going.",
  },
  {
    id: "break",
    message: "BREAK",
    meaning: "You interrupted the current turn.",
  },
  {
    id: "ready",
    message: "READY.",
    meaning: "Idle and waiting for you -- everything's fine.",
  },
  {
    id: "load-error",
    message: "LOAD ERROR",
    meaning: "▶ Play failed -- the drive didn't wake up. Try again in a moment.",
  },
];

/** How a typical task goes, in five short steps -- shown on the Manual page below the glossary. */
export interface TaskStep {
  id: string;
  title: string;
  detail: string;
}

export const TYPICAL_TASK_STEPS: TaskStep[] = [
  {
    id: "pick-tape",
    title: "Pick a Tape",
    detail: "Choose a saved agent setup (model, instructions, tools) from the Disk Box's new-session dialog.",
  },
  {
    id: "start-floppy",
    title: "Start a Floppy",
    detail: "Type what you want done. That's a new conversation -- a Floppy -- saved in your Disk Box.",
  },
  {
    id: "drive-wakes",
    title: "A Drive wakes up",
    detail: "▶ Play wakes a cloud sandbox: the Kernal runs, works the task, and streams its output back.",
  },
  {
    id: "steer-or-wait",
    title: "Steer it, or let it run",
    detail: "Send follow-ups, answer questions it asks, or hit Break to interrupt the current turn.",
  },
  {
    id: "stop-or-eject",
    title: "■ Stop or ⏏ Eject",
    detail: "Stop the Drive when you're done, or Eject to keep going on your laptop with kernal --teleport.",
  },
];
