// Detects a ```html / ```htm fence in Markdown.tsx's `code` override. Same shape as
// lib/mermaid-fence.ts, kept separate so a diagram and a preview do not share a helper
// they would both have to grow.

import { fenceLanguage } from "./mermaid-fence.ts";

export function isHtmlFence(className: string | null | undefined): boolean {
  const lang = fenceLanguage(className);
  return lang === "html" || lang === "htm";
}
