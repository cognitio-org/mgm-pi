import { useState } from "react";
import { HtmlPreviewDialog } from "./HtmlPreviewDialog.tsx";

// A ```html fence. The source stays a code block. Render opens HtmlPreviewDialog.

export function HtmlFence({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="html-fence">
      <div className="html-fence-toolbar">
        <button type="button" className="btn mermaid-toolbar-btn" onClick={() => setOpen(true)}>
          Render
        </button>
      </div>
      <pre className="md-pre">
        <code className="language-html" data-lang="html">
          {source}
        </code>
      </pre>
      {open && <HtmlPreviewDialog source={source} onClose={() => setOpen(false)} />}
    </div>
  );
}
