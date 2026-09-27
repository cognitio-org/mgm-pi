// WebMCP fleet tools for the signed-in user. Chrome only exposes
// document.modelContext behind chrome://flags/#enable-webmcp-testing and an
// origin trial. WebMCP is not on by default: if registerTool is missing this
// module does nothing and the existing UI is unchanged.
//
// Registered from the app shell after sign-in, never from the easter-egg games.
// Replaced (the previous AbortSignal is aborted) when the signed-in user changes.
// Current Chrome has no unregisterTool; aborting the registration signal drops
// the tools. A second registerTool of the same name is rejected, so the previous
// registration is aborted before the next one is added.
//
// Tools, each calling the same api client the pages use (same-origin cookies).
// None accept a token, and none call the link origin with a Dongle:
// - list_floppies — Disk Box list (api.sessions)
// - play — New Floppy "Start session" (api.createSession)
// - steer — composer Steer, follow-up text (api.sendMessage behavior "steer")
// - break — Break (api.abort)
// - stop — Stop (api.stop)
// - eject — Eject button's `kernal --teleport <id>` command, no Dongle
// - read_transcript — session transcript (api.entries)
// - archive_floppy / restore_floppy — Archive and Restore (#209). Format is deliberately not a
//   tool: erasing a floppy for good stays a person's click through the confirm dialog.

import { api, type NewSessionInput, type PiEntry, type RunLike, type SessionDetail, type SessionSummary } from "../api/client.ts";

export const WEBMCP_TOOL_NAMES = [
  "list_floppies",
  "play",
  "steer",
  "break",
  "stop",
  "eject",
  "read_transcript",
  "archive_floppy",
  "restore_floppy",
] as const;

export type WebMcpToolName = (typeof WEBMCP_TOOL_NAMES)[number];

/** The command the session page's Eject button copies. No token and no link URL. */
export function teleportCommand(sessionId: string): string {
  return `kernal --teleport ${sessionId}`;
}

interface JsonSchemaProperty {
  type: "string";
  description: string;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

export interface WebMcpTool {
  name: WebMcpToolName;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    /** Real cost or a state change. Chrome confirms with the user before running the tool. */
    consequentialHint?: boolean;
    /** Output can contain agent text. Consumers must not treat it as instructions. */
    untrustedContentHint?: boolean;
  };
  execute: (input: unknown) => Promise<unknown> | unknown;
}

export interface WebMcpModelContext {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => unknown;
}

export interface WebMcpHost {
  modelContext?: WebMcpModelContext | null;
}

/** The page client calls these tools are allowed to make. No token and no link-origin methods. */
export interface WebMcpClient {
  sessions(filter?: { status?: string; guru?: string; runState?: string }): Promise<SessionSummary[]>;
  createSession(input: NewSessionInput): Promise<{ session: SessionDetail; run: RunLike | null }>;
  sendMessage(id: string, text: string, behavior?: "steer" | "followUp"): Promise<{ run: RunLike | null }>;
  abort(id: string): Promise<{ run: RunLike }>;
  stop(id: string): Promise<{ run: RunLike }>;
  entries(id: string, after?: string): Promise<PiEntry[]>;
  archiveSession(id: string): Promise<{ session: SessionDetail }>;
  restoreSession(id: string): Promise<{ session: SessionDetail }>;
}

const CREDENTIAL_KEYS = new Set([
  "token",
  "api_token",
  "apitoken",
  "authorization",
  "dongle",
  "outfitter_token",
  "outfittertoken",
  "bearer",
]);

let activeController: AbortController | null = null;

function readHost(): WebMcpHost | null {
  const root = globalThis as { document?: WebMcpHost };
  return root.document ?? null;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as Promise<unknown>).then === "function";
}

function readInput(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("tool input must be a JSON object");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool input must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const normalized = key.toLowerCase().replace(/-/g, "_");
    if (CREDENTIAL_KEYS.has(normalized) || normalized.endsWith("_token")) {
      throw new Error("Outfitter tools do not accept a token or Dongle; they use the signed-in page.");
    }
  }
  return record;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function copyCommand(command: string): Promise<void> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) return;
    await clipboard.writeText(command);
  } catch {
    // The Eject button ignores a denied clipboard. The command is still the tool result.
  }
}

function fleetTools(client: WebMcpClient): WebMcpTool[] {
  return [
    {
      name: "list_floppies",
      description:
        "Use when you need the signed-in user's Floppies, the same list as the Disk Box. Optional run_state and guru narrow it the way that page's filters do. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          run_state: {
            type: "string",
            description: "Optional run state filter (queued, provisioning, running, idle, stopping, stopped, failed).",
          },
          guru: { type: "string", description: "Optional tape id, the Disk Box guru filter." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input) {
        const record = readInput(input);
        const filter: { runState?: string; guru?: string } = {};
        const runState = optionalString(record, "run_state");
        const guru = optionalString(record, "guru");
        if (runState) filter.runState = runState;
        if (guru) filter.guru = guru;
        return client.sessions(filter);
      },
    },
    {
      name: "play",
      description:
        "Use when starting a new Floppy the signed-in user could start from New Floppy (Start session). Requires a tape id and a prompt, the same fields as that form. Does not wake an existing Floppy by id and does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          guru_id: { type: "string", description: "Tape id (guruId) the New Floppy form would submit." },
          prompt: { type: "string", description: "Opening prompt." },
          name: { type: "string", description: "Optional Floppy name." },
          repo: { type: "string", description: "Optional owner/repo. Omit for no repository." },
          base_branch: { type: "string", description: "Optional base branch. Sent only when repo is set." },
          branch: { type: "string", description: "Optional branch. Sent only when repo is set." },
          model: { type: "string", description: "Optional model override." },
        },
        required: ["guru_id", "prompt"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        const record = readInput(input);
        const guruId = requiredString(record, "guru_id").trim();
        const prompt = requiredString(record, "prompt");
        const repo = optionalString(record, "repo");
        const body: NewSessionInput = { guruId, prompt };
        const name = optionalString(record, "name");
        const model = optionalString(record, "model");
        if (name) body.name = name;
        if (model) body.model = model;
        if (repo) {
          body.repo = repo;
          const baseBranch = optionalString(record, "base_branch");
          const branch = optionalString(record, "branch");
          if (baseBranch) body.baseBranch = baseBranch;
          if (branch) body.branch = branch;
        }
        return client.createSession(body);
      },
    },
    {
      name: "steer",
      description:
        "Use when sending follow-up text to a Floppy the signed-in user can steer, the same as the session composer's Steer. Requires session_id and text. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
          text: { type: "string", description: "Follow-up text." },
        },
        required: ["session_id", "text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        const record = readInput(input);
        const sessionId = requiredString(record, "session_id").trim();
        const text = requiredString(record, "text");
        return client.sendMessage(sessionId, text, "steer");
      },
    },
    {
      name: "break",
      description:
        "Use when interrupting the current turn of a Floppy, the same as Break (abort). Requires session_id. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        const record = readInput(input);
        return client.abort(requiredString(record, "session_id").trim());
      },
    },
    {
      name: "stop",
      description:
        "Use when stopping a Floppy's run, the same as Stop. Requires session_id. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        const record = readInput(input);
        return client.stop(requiredString(record, "session_id").trim());
      },
    },
    {
      name: "eject",
      description:
        "Use when the signed-in user wants to continue a Floppy on their laptop, the same as Eject. Returns the kernal --teleport command the button copies. Does not create a Dongle, accept a token, or call the link origin.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const record = readInput(input);
        const sessionId = requiredString(record, "session_id").trim();
        const command = teleportCommand(sessionId);
        await copyCommand(command);
        return { command };
      },
    },
    {
      name: "read_transcript",
      description:
        "Use when you need a Floppy's transcript, the same entries the session page loads. Requires session_id. Optional after is the cursor api.entries already accepts. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
          after: { type: "string", description: "Optional entry cursor. Omit to read from the start." },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input) {
        const record = readInput(input);
        return client.entries(requiredString(record, "session_id").trim(), optionalString(record, "after"));
      },
    },
    {
      name: "archive_floppy",
      description:
        "Use when putting a Floppy away, the same as Archive: its drive stops, it leaves list_floppies and it can't run until restored. Only its owner or a Sysop may. Requires session_id. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        const record = readInput(input);
        return client.archiveSession(requiredString(record, "session_id").trim());
      },
    },
    {
      name: "restore_floppy",
      description:
        "Use when taking a Floppy out of the archive, the same as Restore. Only its owner or a Sysop may. Requires session_id. Does not accept a token.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Floppy id." },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input) {
        const record = readInput(input);
        return client.restoreSession(requiredString(record, "session_id").trim());
      },
    },
  ];
}

/**
 * Register the seven fleet tools for `email`, or drop them when `email` is empty.
 * No-ops (and does not throw) when `document.modelContext.registerTool` is missing.
 * Returns a function that aborts this registration. A later call aborts the previous one.
 * `client` defaults to the page's api client; tests pass a fake.
 */
export function registerWebMcpTools(
  email: string | null | undefined,
  host?: WebMcpHost | null,
  client: WebMcpClient = api,
): () => void {
  activeController?.abort();
  activeController = null;

  if (!email) return () => {};

  const target = host === undefined ? readHost() : host;
  const modelContext = target?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") return () => {};

  const controller = new AbortController();
  activeController = controller;
  for (const tool of fleetTools(client)) {
    try {
      const pending = modelContext.registerTool(tool, { signal: controller.signal });
      if (isPromise(pending)) void pending.catch(() => {});
    } catch {
      // One rejected name (usually a duplicate) must not break the page.
    }
  }

  return () => {
    if (activeController !== controller) return;
    controller.abort();
    activeController = null;
  };
}
