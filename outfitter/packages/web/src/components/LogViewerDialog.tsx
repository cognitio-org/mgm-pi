import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type SandboxLogLine } from "../api/client.ts";
import {
  filterLines,
  formatClock,
  linesToText,
  mergeNewer,
  severityTag,
  telemetryMessage,
  type LogLevel,
} from "../lib/nerd-out.ts";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';
/** While the run is live and Follow is on, the newest page is re-read this often. The api caches a
 * page for 20 s, so faster would only re-read its cache. */
export const FOLLOW_MS = 20_000;
/** Within this many pixels of the bottom counts as "at the bottom": new lines keep it there. */
const STICK_PX = 24;

const LEVELS: { id: LogLevel; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Every line" },
  { id: "warn", label: "Wrn+", title: "Warnings and errors" },
  { id: "error", label: "Err", title: "Errors only" },
];

/** One line. Memoized: a refresh or a filter keystroke re-renders only the rows that changed.
 * Plain text children only -- React escapes them, and these lines are the sandbox's own words. */
const LogRow = memo(function LogRow({ line }: { line: SandboxLogLine }) {
  const sev = severityTag(line.severity);
  return (
    <div className={`log-row log-row-${sev.tone}`}>
      <time className="log-time" dateTime={line.time} title={line.time}>
        {formatClock(line.time)}
      </time>
      <span className={`log-sev log-sev-${sev.tone}`} title={line.severity}>
        {sev.tag}
      </span>
      <span className="log-msg">{line.message}</span>
    </div>
  );
});

/**
 * agentd's log for one run, in a dialog of its own (#198). Nothing is fetched until it opens. The
 * newest page loads first, shown oldest at the top and scrolled to the bottom; "Load earlier" pages
 * back. While the run is live, Follow re-reads the newest page. Filtering is by text and level, on
 * the lines already loaded.
 */
export function LogViewerDialog({
  sessionId,
  runId,
  live,
  onClose,
}: {
  sessionId: string;
  runId: string;
  /** The run is still going: offer Follow. */
  live: boolean;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<readonly SandboxLogLine[]>([]);
  const [olderToken, setOlderToken] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [level, setLevel] = useState<LogLevel>("all");
  const [wrap, setWrap] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 700px)").matches);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /** What the next layout pass does to the scroll position: keep the view still after lines were
   * added above it, or go to the bottom. */
  const scrollIntent = useRef<{ kind: "bottom" } | { kind: "keep"; fromBottom: number } | null>(null);

  const atBottom = () => {
    const el = bodyRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  // First page. A run switch remounts the dialog (keyed by run), so this runs once per run.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    api
      .sandboxLogs(sessionId, runId)
      .then((page) => {
        if (cancelled) return;
        scrollIntent.current = { kind: "bottom" };
        setLines(page.lines);
        setOlderToken(page.nextPageToken);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(telemetryMessage(err, "Logs"));
      })
      .finally(() => {
        if (cancelled) return;
        setBusy(false);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, runId]);

  const refresh = useCallback(async () => {
    try {
      const page = await api.sandboxLogs(sessionId, runId);
      const stick = atBottom();
      setLines((held) => {
        const next = mergeNewer(held, page.lines);
        if (next !== held && stick) scrollIntent.current = { kind: "bottom" };
        return next;
      });
      // A first page that was empty had no token; one may exist now.
      setOlderToken((token) => token ?? page.nextPageToken);
      setError(null);
    } catch (err) {
      setError(telemetryMessage(err, "Logs"));
    }
  }, [sessionId, runId]);

  useEffect(() => {
    if (!live || !follow || !loaded) return;
    const timer = setInterval(() => void refresh(), FOLLOW_MS);
    return () => clearInterval(timer);
  }, [live, follow, loaded, refresh]);

  async function loadEarlier() {
    if (!olderToken || busy) return;
    setBusy(true);
    try {
      const page = await api.sandboxLogs(sessionId, runId, olderToken);
      const el = bodyRef.current;
      scrollIntent.current = { kind: "keep", fromBottom: el ? el.scrollHeight - el.scrollTop : 0 };
      setLines((held) => [...page.lines, ...held]);
      setOlderToken(page.nextPageToken);
      setError(null);
    } catch (err) {
      setError(telemetryMessage(err, "Logs"));
    } finally {
      setBusy(false);
    }
  }

  useLayoutEffect(() => {
    const intent = scrollIntent.current;
    const el = bodyRef.current;
    if (!intent || !el) return;
    scrollIntent.current = null;
    el.scrollTop = intent.kind === "bottom" ? el.scrollHeight : el.scrollHeight - intent.fromBottom;
  }, [lines]);

  // Focus, Escape, a Tab cycle inside the dialog, and "/" to jump to the filter.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      e.preventDefault();
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey) (index <= 0 ? last : focusable[index - 1]!).focus();
      else (index < 0 || index >= focusable.length - 1 ? first : focusable[index + 1]!).focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

  const shown = filterLines(lines, text, level);
  const filtered = shown.length !== lines.length;
  // Keys from the line itself, not its index: lines added above (Load earlier) or hidden by a
  // filter must not make every row below re-render. Repeats of one line get a count.
  const seen = new Map<string, number>();
  const keys = shown.map((l) => {
    const base = `${l.time}|${l.severity}|${l.message}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}|${n}` : base;
  });

  async function copyShown() {
    try {
      await navigator.clipboard.writeText(linesToText(shown));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  return (
    <div className="dialog-backdrop log-viewer-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog panel log-viewer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Drive log, run ${runId.slice(0, 8)}`}
      >
        <div className="panel-titlebar log-viewer-titlebar">
          <span className="panel-label">Drive log</span>
          <span className="log-viewer-run mono" title={runId}>
            run {runId.slice(0, 8)}
          </span>
          <button type="button" className="btn btn-small log-viewer-close" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
        <div className="log-viewer-tools">
          <input
            ref={filterRef}
            type="search"
            className="log-viewer-filter"
            placeholder="Filter  ( / )"
            aria-label="Filter lines"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="log-viewer-levels" role="group" aria-label="Level">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`btn btn-small${level === l.id ? " active" : ""}`}
                aria-pressed={level === l.id}
                title={l.title}
                onClick={() => setLevel(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <label className="log-viewer-check">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
          </label>
          {live && (
            <label className="log-viewer-check" title={`Re-read the newest lines every ${FOLLOW_MS / 1000} s`}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
            </label>
          )}
          <button type="button" className="btn btn-small" onClick={() => void refresh()} disabled={!loaded}>
            Refresh
          </button>
          <button type="button" className="btn btn-small" onClick={copyShown} disabled={shown.length === 0}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="log-viewer-untrusted">
          <span aria-hidden="true">!</span> Written by the drive itself: lines can include the model's own output and
          aren't verified. Shown as plain text.
        </p>
        <div ref={bodyRef} className={`log-viewer-body${wrap ? " is-wrapped" : ""}`} tabIndex={0} aria-label="Log lines">
          {olderToken ? (
            <button type="button" className="log-viewer-earlier" onClick={loadEarlier} disabled={busy}>
              {busy ? "Loading…" : "▲ Load earlier"}
            </button>
          ) : (
            loaded && lines.length > 0 && <p className="log-viewer-edge">-- start of the run's log --</p>
          )}
          {!loaded && <p className="log-viewer-edge">LOADING…</p>}
          {loaded && lines.length === 0 && !error && (
            <p className="log-viewer-edge">No lines yet. New lines can take a minute to reach Cloud Logging.</p>
          )}
          {shown.map((line, i) => (
            <LogRow key={keys[i]} line={line} />
          ))}
        </div>
        <div className="log-viewer-status" role="status">
          {error ? (
            <span className="log-viewer-error">{error}</span>
          ) : (
            <span>
              {filtered ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}
              {olderToken ? " · more above" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
