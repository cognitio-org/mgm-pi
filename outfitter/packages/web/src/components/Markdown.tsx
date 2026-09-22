import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Transcript text is model and tool output: untrusted. react-markdown never renders raw HTML (it
// shows it as text), and its default urlTransform drops javascript:/data: links, so nothing in a
// message can run script or restyle the page. GFM adds tables, task lists and strikethrough.

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="md-pre">{children}</pre>,
  code: ({ className, children }) => {
    const lang = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
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
