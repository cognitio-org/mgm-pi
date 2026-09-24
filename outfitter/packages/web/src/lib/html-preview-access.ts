import { createContext } from "react";
import type { PiEntry } from "../api/client.ts";
import type { Beat } from "./beats.ts";
import type { PreviewAccess } from "./html-preview.ts";

// Where an HTML preview starts (#132). SessionPage provides one value per transcript beat: the
// access of the run that wrote it (#147), so a page written to link external CSS and JS is not
// blank on opening, and a sealed run's page stays sealed after a later run was allowed more.
// Anywhere else (the Composer's Markdown preview, a transcript outside a session) stays sealed.
// The dialog's checkbox only overrides one opening; it never writes back here.

export const HtmlPreviewAccessContext = createContext<PreviewAccess>("sealed");

export function previewAccessFor(allowExternalHtmlResources: boolean | undefined): PreviewAccess {
  return allowExternalHtmlResources === true ? "external" : "sealed";
}

/** The entry a beat's text came from. View ids are the entry id, or `<entry id>#<block>` for one
 * block of a message (entry-view.ts). */
export function beatEntryId(beat: Beat): string {
  const viewId = beat.kind === "user" || beat.kind === "passthrough" ? beat.view.id : beat.kind === "assistant" ? beat.proseId : beat.id;
  const hash = viewId.indexOf("#");
  return hash === -1 ? viewId : viewId.slice(0, hash);
}

/**
 * Preview access per entry id. An entry the api stamped with its run (`outfitterRunId`) takes that
 * run's recorded value from `accessByRun`. Anything else takes `fallback` (the session's value):
 * entries the api wrote itself, entries stored before runs were recorded on them, and runs that
 * never recorded a value.
 */
export function previewAccessByEntry(
  entries: PiEntry[],
  accessByRun: Record<string, boolean> | undefined,
  fallback: PreviewAccess,
): (entryId: string) => PreviewAccess {
  const byEntry = new Map<string, PreviewAccess>();
  for (const entry of entries) {
    const runId = typeof entry.outfitterRunId === "string" ? entry.outfitterRunId : undefined;
    const allow = runId ? accessByRun?.[runId] : undefined;
    if (allow !== undefined) byEntry.set(entry.id, previewAccessFor(allow));
  }
  return (entryId) => byEntry.get(entryId) ?? fallback;
}
