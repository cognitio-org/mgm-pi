// Pure helpers for detecting a ```mermaid fenced block inside Markdown.tsx's react-markdown
// `code` component override, kept out of that file (and out of any React import) so they're
// trivial to unit test -- see test/mermaid-fence.test.ts.

/** react-markdown's `code` component gets a `className` of `language-<lang>` for a fenced block
 * (and no className for inline code); same regex Markdown.tsx already uses for syntax labelling. */
export function fenceLanguage(className: string | null | undefined): string | undefined {
  return /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
}

export function isMermaidFence(className: string | null | undefined): boolean {
  return fenceLanguage(className) === "mermaid";
}

/** react-markdown passes a fenced block's code as `children`, which can be a string or an array
 * of strings/nodes; join and drop exactly one trailing newline (the one before the closing
 * fence), same normalization react-markdown's own <code> text otherwise carries implicitly. */
export function codeChildrenToSource(children: unknown): string {
  const text = Array.isArray(children) ? children.map((c) => (typeof c === "string" ? c : "")).join("") : String(children ?? "");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
