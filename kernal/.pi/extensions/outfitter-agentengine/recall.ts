/**
 * Recall (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §3.3, §3.5): before each prompt, ask
 * Outfitter for memories relevant to it (`memory.context`) and put them in the system prompt's
 * `memory` section. The one implementation for both sides: on a laptop over the Dongle's HTTP
 * transport (laptop.ts), in a Drive over agentd's admin socket for a `memory: auto` tape (index.ts;
 * agentd sets OUTFITTER_MEMORY_RECALL=1).
 *
 * - The query is redacted before it leaves (the API redacts again before embedding).
 * - At most RECALL_TIMEOUT_MS, then the turn goes on without memory. Any failure is skipped
 *   silently: recall must never hold up or break a prompt.
 * - `sections.memory` replaces last turn's block (pi rebuilds the prompt from sections every turn).
 *   When an earlier handler forced the whole prompt, the block is appended to that instead.
 * - The text is untrusted: the API frames it as notes that may be wrong, never instructions, and
 *   this side makes sure it can't close the `<memory>` tag it sits in.
 */
import { redact } from "../_shared/redact.ts";
import type { AdminTransport, LaptopContext } from "../outfitter-admin/transport.ts";

export const RECALL_TIMEOUT_MS = 3_000;
const MAX_QUERY = 2_000;
const MAX_SECTION = 8_000;

export type PromptOptions = { sections?: Record<string, string>; forceSystemPrompt?: string; [key: string]: unknown };

/** The recalled text as it may sit inside `<memory>`: no tag that could close or reopen it, capped. */
export function memoryBlock(text: string): string {
  const safe = text.replace(/<\s*\/?\s*memory\b[^>]*>?/gi, "[memory tag]").trim();
  return safe.length <= MAX_SECTION ? safe : `${safe.slice(0, MAX_SECTION - 1)}…`;
}

/** Puts `text` into this turn's prompt (see the module doc). Empty text changes nothing. */
export function applyMemory(options: PromptOptions | undefined, text: string | undefined): void {
  if (!options || !text?.trim()) return;
  const block = memoryBlock(text);
  if (!block) return;
  options.sections ??= {};
  options.sections.memory = block;
  if (typeof options.forceSystemPrompt === "string") {
    options.forceSystemPrompt = `${options.forceSystemPrompt}\n\n<memory>\n${block}\n</memory>`;
  }
}

/** The prompt as a recall query, or "" for none: redacted here before it leaves (the API redacts
 * again before embedding), then cut. */
export function recallQuery(prompt: unknown): string {
  return typeof prompt === "string" ? redact(prompt.trim()).slice(0, MAX_QUERY) : "";
}

/**
 * One `memory.context` call, answered within `timeoutMs` or not at all. Resolves to the recalled
 * text, or undefined on a refusal, a failure or the timeout (the onError hook hears why). Never
 * rejects. `laptop`: the laptop's context (a Drive's identity is its session).
 */
export async function requestRecall(
  transport: AdminTransport,
  query: string,
  laptop: LaptopContext | undefined,
  opts: { timeoutMs?: number; onError?: (error: string) => void } = {},
): Promise<string | undefined> {
  const ms = opts.timeoutMs ?? RECALL_TIMEOUT_MS;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve(undefined);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const call = transport
      .call("memory.context", { query }, { ...(laptop ? { laptop } : {}), signal: abort.signal })
      .then((reply) => {
        if (reply.ok) return reply.text;
        opts.onError?.(reply.error);
        return undefined;
      })
      .catch(() => undefined);
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recall before each prompt on `pi`. `laptop` gives a laptop call its context (none: no recall that
 * turn); a Drive passes no `laptop`. `onError` hears a refusal, with the turn's ctx.
 */
export function registerRecall(
  pi: { on(event: "before_agent_start", handler: (event: any, ctx: any) => Promise<void>): void },
  transport: AdminTransport,
  opts: { laptop?: (ctx: any) => Promise<LaptopContext | undefined>; timeoutMs?: number; onError?: (error: string, ctx: any) => void } = {},
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const query = recallQuery(event?.prompt);
      if (!query) return;
      const laptop = opts.laptop ? await opts.laptop(ctx) : undefined;
      if (opts.laptop && !laptop) return;
      const text = await requestRecall(transport, query, laptop, { timeoutMs: opts.timeoutMs, onError: (error) => opts.onError?.(error, ctx) });
      applyMemory(event?.systemPromptOptions, text);
    } catch {
      // Recall is best effort: the prompt goes on without it.
    }
  });
}
