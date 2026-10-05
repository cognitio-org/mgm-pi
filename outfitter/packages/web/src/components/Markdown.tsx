import { isValidElement, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isLongDocument } from "../lib/reading.ts";
import { HtmlFence } from "./HtmlFence.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { MermaidDiagram } from "./MermaidDiagram.tsx";
import { ReadingDialog } from "./ReadingDialog.tsx";
import { isHtmlFence } from "../lib/html-fence.ts";
import { codeChildrenToSource, fenceLanguage, isMermaidFence } from "../lib/mermaid-fence.ts";

// Transcript text is model and tool output: untrusted. react-markdown never renders raw HTML (it
// shows it as text). javascript: URLs stay dropped. http(s) images are not loaded — only a data:
// image renders, and it opens in ImageViewer. A long message scrolls in place, with a pop-out.
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

/** Pixel "pop out" glyph for the reading view: a window with an arrow leaving its corner. */
function PopOutGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      <g fill="currentColor">
        <rect x="1" y="4" width="2" height="11" />
        <rect x="1" y="13" width="11" height="2" />
        <rect x="10" y="10" width="2" height="5" />
        <rect x="1" y="4" width="6" height="2" />
        <rect x="9" y="1" width="6" height="2" />
        <rect x="13" y="1" width="2" height="6" />
        <rect x="11" y="3" width="2" height="2" />
        <rect x="9" y="5" width="2" height="2" />
        <rect x="7" y="7" width="2" height="2" />
      </g>
    </svg>
  );
}

export function Markdown({ text, reading = true }: { text: string; reading?: boolean }) {
  const [open, setOpen] = useState(false);
  const body = (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
      {text}
    </ReactMarkdown>
  );
  // A long message renders in full, formatted, inside a height-capped scroll box; a small corner
  // button opens the same text in ReadingDialog for a long read.
  if (reading && isLongDocument(text)) {
    return (
      <div className="md-long">
        <button
          type="button"
          className="md-read"
          aria-label="Open in reading view"
          title="Open in reading view"
          onClick={() => setOpen(true)}
        >
          <PopOutGlyph />
        </button>
        <div className="md md-scroll" tabIndex={0} role="region" aria-label="Long message">
          {body}
        </div>
        {open ? <ReadingDialog text={text} onClose={() => setOpen(false)} /> : null}
      </div>
    );
  }
  return <div className="md">{body}</div>;
}
