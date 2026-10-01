/**
 * The markers of a tape being played on a laptop (#354): kernal-tape/cli.ts writes them, bin/kernal
 * exports them (KERNAL_TAPE*, and clears them again on the next start), and every extension that
 * changes for a tape reads them here (outfitter-agentengine, kernal-html-preview, kernal-tape), so
 * none of them imports another's module for it.
 */
import type { MemoryMode } from "../outfitter-agentengine/laptop.ts";

/** File-name safe, and what Outfitter's tape ids look like (slugs and UUIDs). */
export const TAPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface Playing {
  id: string;
  hash: string;
  memory: MemoryMode;
  agentEngine: boolean;
}

/** The markers for a pi process playing `tape` in version `hash`. No tape env: values never reach
 * a laptop. */
export function tapeMarkers(tape: { id: string; memory?: "tool" | "auto"; agentEngine?: true; allowExternalHtmlResources?: boolean }, hash: string): Record<string, string> {
  return {
    KERNAL_TAPE: tape.id,
    KERNAL_TAPE_HASH: hash,
    KERNAL_TAPE_MEMORY: tape.memory ?? "off",
    KERNAL_TAPE_AGENT_ENGINE: tape.agentEngine ? "1" : "0",
    KERNAL_TAPE_HTML: tape.allowExternalHtmlResources === true ? "external" : "sealed",
  };
}

/** The tape this pi process plays, if any. */
export function playing(env: NodeJS.ProcessEnv = process.env): Playing | undefined {
  const id = env.KERNAL_TAPE?.trim();
  if (!id || !TAPE_ID.test(id)) return undefined;
  const memory = env.KERNAL_TAPE_MEMORY === "tool" || env.KERNAL_TAPE_MEMORY === "auto" ? env.KERNAL_TAPE_MEMORY : "off";
  return { id, hash: env.KERNAL_TAPE_HASH ?? "", memory, agentEngine: env.KERNAL_TAPE_AGENT_ENGINE === "1" };
}

/** Whether the tape being played allows external HTML resources in previews; undefined without a
 * tape or its marker (the person's own setting decides). */
export function playingHtmlExternal(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const html = env.KERNAL_TAPE ? env.KERNAL_TAPE_HTML : undefined;
  return html === "external" ? true : html === "sealed" ? false : undefined;
}
