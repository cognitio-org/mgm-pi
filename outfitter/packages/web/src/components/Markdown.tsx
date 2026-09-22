import { isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram.tsx";
import { codeChildrenToSource, fenceLanguage, isMermaidFence } from "../lib/mermaid-fence.ts";

// Transcript text is model and tool output: untrusted. react-markdown never renders raw HTML (it
// shows it as text), and its default urlTransform drops javascript:/data: links, so nothing in a
// message can run script or restyle the page. GFM adds tables, task lists and strikethrough.
//
// A ```mermaid fence is the one exception to "code fences render as code": `code` routes it to
// MermaidDiagram instead, and `pre` skips its usual <pre class="md-pre"> wrapper for that one
// case so the diagram gets its own box rather than looking like a code block that contains a
// diagram. See MermaidDiagram.tsx for the render pipeline and its security notes.

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => (isValidElement(children) && children.type === MermaidDiagram ? <>{children}</> : <pre className="md-pre">{children}</pre>),
  code: ({ className, children }) => {
    if (isMermaidFence(className)) return <MermaidDiagram source={codeChildrenToSource(children)} />;
    const lang = fenceLanguage(className);
    // Fenced blocks carry a language-* class; inline code does not (react-markdown 10 no longer
    // passes an `inline` flag). A fence without a language is still inside <pre>, which styles it.
    return lang ? (
      <code className={className} data-lang={lang}>
        {children}
      </code>
    ) : (
      <code className={className}>{children}</code>
    );
  },
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
