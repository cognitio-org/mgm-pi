import { createContext } from "react";
import type { PreviewAccess } from "./html-preview.ts";

// Where an HTML preview starts (#132). SessionPage provides the run's own value, the one its
// prompt told the agent, so a page written to link external CSS and JS is not blank on opening.
// Anywhere else (the Composer's Markdown preview, a transcript outside a session) stays sealed.
// The dialog's checkbox only overrides one opening; it never writes back here.

export const HtmlPreviewAccessContext = createContext<PreviewAccess>("sealed");

export function previewAccessFor(allowExternalHtmlResources: boolean | undefined): PreviewAccess {
  return allowExternalHtmlResources === true ? "external" : "sealed";
}
