import { isValidElement, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isLongDocument, readingOpening } from "../lib/reading.ts";
import { HtmlFence } from "./HtmlFence.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { MermaidDiagram } from "./MermaidDiagram.tsx";
import { ReadingDialog } from "./ReadingDialog.tsx";
import { isHtmlFence } from "../lib/html-fence.ts";
import { codeChildrenToSource, fenceLanguage, isMermaidFence } from "../lib/mermaid-fence.ts";

// Transcript text is model and tool output: untrusted. react-markdown never renders raw HTML (it
// shows it as text). javascript: URLs stay dropped. http(s) images are not loaded — only a data:
// image renders, and it opens in ImageViewer. A long message shows an opening plus Read.
//
// A ```mermaid fence is drawn as a diagram, and a ```html fence stays source with a Render
// button that opens a sandboxed preview (HtmlFence.tsx). `pre` skips its usual wrapper for
// both, because those components draw their own box. See MermaidDiagram.tsx for the diagram
// pipeline and its security notes.

// defaultUrlTransform strips every data: URL. Allow it on img src only, so a data: link still dies.
const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img" && /^data:/i.test(url.trim())) return url;
  return defaultUrlTransform(url);
};

function imageSourceKind(src: string | undefined): "data" | "remote" | "plain" {
  const value = src?.trim() ?? "";
  if (/^data:/i.test(value)) return "data";
  if (/^https?:/i.test(value)) return "remote";
  return "plain";
}

function remoteImageLabel(alt: string | undefined): string {
  const text = alt?.trim();
  return text ? text : "image";
}

function DataImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="md-image" onClick={() => setOpen(true)}>
        <img src={src} alt={alt} />
      </button>
      {open ? createPortal(<ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const kind = imageSourceKind(src);
  if (kind !== "data") {
    const label = kind === "remote" ? remoteImageLabel(alt) : (alt ?? "");
    return <span className="md-image-text">{label}</span>;
  }
  return <DataImage src={src?.trim() ?? ""} alt={alt ?? ""} />;
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // `children` here is the element for the `code` override below (not yet rendered), so check
  // its language class rather than its component type.
  pre: ({ children }) =>
    isValidElement<{ className?: string }>(children) &&
    (isMermaidFence(children.props.className) || isHtmlFence(children.props.className)) ? (
      <>{children}</>
    ) : (
      <pre className="md-pre">{children}</pre>
    ),
  code: ({ className, children }) => {
    if (isMermaidFence(className)) return <MermaidDiagram source={codeChildrenToSource(children)} />;
    if (isHtmlFence(className)) return <HtmlFence source={codeChildrenToSource(children)} />;
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
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

export function Markdown({ text, reading = true }: { text: string; reading?: boolean }) {
  const [open, setOpen] = useState(false);
  if (reading && isLongDocument(text)) {
    return (
      <div className="md">
        <p className="md-opening">{readingOpening(text)}</p>
        <button type="button" className="btn mermaid-toolbar-btn md-read" onClick={() => setOpen(true)}>
          Read
        </button>
        {open ? <ReadingDialog text={text} onClose={() => setOpen(false)} /> : null}
      </div>
    );
  }
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
