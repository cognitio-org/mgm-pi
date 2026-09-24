import { useContext, useState } from "react";
import { HtmlPreviewDialog } from "./HtmlPreviewDialog.tsx";
import { HtmlPreviewAccessContext } from "../lib/html-preview-access.ts";

// A ```html fence. The source stays a code block. Render opens HtmlPreviewDialog, starting from
// the session's preview access (HtmlPreviewAccessContext).

export function HtmlFence({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const initialAccess = useContext(HtmlPreviewAccessContext);
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
      {open && <HtmlPreviewDialog source={source} initialAccess={initialAccess} onClose={() => setOpen(false)} />}
    </div>
  );
}
