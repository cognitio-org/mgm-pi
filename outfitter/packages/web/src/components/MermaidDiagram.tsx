import { useEffect, useId, useRef, useState } from "react";
import { Working } from "./Working.tsx";
import { isSafeMermaidSvg } from "../lib/mermaid-safety.ts";
import { buildMermaidThemeVariables, DEFAULT_THEME_TOKENS, readThemeTokensFromDocument, type ThemeTokens } from "../lib/mermaid-theme.ts";
import { useDebouncedValue } from "../hooks/useDebouncedValue.ts";
import { MermaidEnlargeDialog } from "./MermaidEnlargeDialog.tsx";

// Renders a ```mermaid fenced block from transcript markdown as a diagram (Markdown.tsx's `code`
// component routes here instead of a plain <code> for language "mermaid"). Design notes:
//
// - Lazy: `mermaid` (a large package) is dynamic-import()ed only once this block has scrolled
//   into view, not at module load -- keeps it out of the main bundle and the session-page chunk
//   (docs/reports/mermaid.md has the measured chunk size). The import is cached at module scope
//   so a transcript with several diagrams only fetches it once.
// - Security: source is untrusted model output. mermaid.initialize is called with
//   securityLevel: "strict" (mermaid itself then sanitizes labels, drops click bindings and
//   refuses HTML labels) and startOnLoad: false; the rendered SVG string is independently
//   re-checked by lib/mermaid-safety.ts (real <svg> root, no <script>/on*=/javascript:) before
//   ever reaching dangerouslySetInnerHTML.
// - Streaming: a still-streaming assistant message rewrites `source` on every chunk, and a
//   half-written diagram reliably fails to parse. useDebouncedValue only (re)renders once the
//   text has stopped changing for 500ms.

const MERMAID_DEBOUNCE_MS = 500;

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  mermaidModulePromise ??= import("mermaid");
  return mermaidModulePromise;
}

let initializedForTokensKey: string | null = null;
function tokensKey(tokens: ThemeTokens): string {
  return JSON.stringify(tokens);
}

/** (Re-)configures the shared mermaid instance for the current theme, skipping the call when the
 * tokens haven't actually changed (mermaid.initialize is not cheap to call on every render). */
async function ensureMermaidConfigured(tokens: ThemeTokens): Promise<typeof import("mermaid")> {
  const mod = await loadMermaid();
  const key = tokensKey(tokens);
  if (initializedForTokensKey !== key) {
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // securityLevel: "strict" sanitizes label *content* (strips <script>, event-handler
      // attributes, javascript: URLs) but by itself doesn't stop mermaid from wrapping node/edge
      // labels in <foreignObject><div>...</div></foreignObject> for HTML-based text sizing --
      // that's still "rendering raw HTML inside the SVG" as far as this transcript's trust
      // boundary is concerned, so turn it off outright and always use plain SVG <text>.
      htmlLabels: false,
      theme: "base",
      themeVariables: buildMermaidThemeVariables(tokens),
      fontFamily: tokens.fontMono,
    });
    initializedForTokensKey = key;
  }
  return mod;
}

/** Watches for a theme change (manual data-theme toggle or OS prefers-color-scheme change) and
 * returns fresh tokens each time, so open diagrams re-render in the new palette. */
function useThemeTokens(): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(() => readThemeTokensFromDocument() ?? DEFAULT_THEME_TOKENS);

  useEffect(() => {
    const refresh = () => setTokens(readThemeTokensFromDocument() ?? DEFAULT_THEME_TOKENS);
    refresh();

    const mo = new MutationObserver(refresh);
    if (typeof document !== "undefined") {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }
    const mql = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
    mql?.addEventListener?.("change", refresh);

    return () => {
      mo.disconnect();
      mql?.removeEventListener?.("change", refresh);
    };
  }, []);

  return tokens;
}

type Status = "pending" | "loading" | "ready" | "error";

export function MermaidDiagram({ source }: { source: string }) {
  const rawId = useId().replace(/[:]/g, "");
  const diagramId = `mermaid-${rawId}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>("pending");
  const [svg, setSvg] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const generationRef = useRef(0);
  const themeTokens = useThemeTokens();
  const debouncedSource = useDebouncedValue(source, MERMAID_DEBOUNCE_MS);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      // No IO support (older browser, some test environments) -- just render, same as if it had
      // scrolled into view immediately.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || debouncedSource === undefined) return;
    const generation = ++generationRef.current;
    setStatus("loading");
    setErrorMessage(null);

    (async () => {
      try {
        const mod = await ensureMermaidConfigured(themeTokens);
        if (generation !== generationRef.current) return;
        const { svg: rendered } = await mod.default.render(diagramId, debouncedSource);
        if (generation !== generationRef.current) return;
        if (!isSafeMermaidSvg(rendered)) {
          setStatus("error");
          setErrorMessage("Rendered diagram failed a security check and was not displayed.");
          return;
        }
        setSvg(rendered);
        setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [visible, themeTokens, debouncedSource, diagramId]);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  const sourceBlock = (
    <pre className="md-pre mermaid-source">
      <code>{source}</code>
    </pre>
  );

  return (
    <div className="mermaid-block" ref={containerRef}>
      {status === "ready" && (
        <div className="mermaid-toolbar">
          <button type="button" className="btn mermaid-toolbar-btn" onClick={() => setShowSource((v) => !v)}>
            {showSource ? "Diagram" : "Source"}
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={copySource}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={() => setEnlarged(true)} disabled={showSource}>
            Enlarge
          </button>
        </div>
      )}

      {status === "ready" && showSource && sourceBlock}
      {status === "ready" && !showSource && svg && (
        <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      )}

      {(status === "pending" || status === "loading") && (
        <div className="mermaid-loading">
          <Working label="Drawing diagram…" size="lg" srOnly={false} />
        </div>
      )}

      {status === "error" && (
        <div className="mermaid-error">
          <div className="mermaid-error-note">
            <span className="mermaid-error-badge">diagram error</span>
            {errorMessage && (
              <details className="mermaid-error-details">
                <summary>Details</summary>
                <pre>{errorMessage}</pre>
              </details>
            )}
          </div>
          {sourceBlock}
        </div>
      )}

      {enlarged && svg && <MermaidEnlargeDialog svg={svg} onClose={() => setEnlarged(false)} />}
    </div>
  );
}
