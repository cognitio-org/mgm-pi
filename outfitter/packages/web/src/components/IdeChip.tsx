import { useEffect, useId, useRef, useState } from "react";
import { useIde, startingLabel } from "./IdeProvider.tsx";
import { VsCodeIcon } from "./VsCodeIcon.tsx";
import { Working } from "./Working.tsx";

/**
 * #243: the browser IDE (docs/specs/browser-ide.md) in the session's status bar, beside the preview
 * chips. State and actions come from IdeProvider (one poller, shared with the chat's VsCodeCard).
 * Only the floppy's owner or a sysop sees it (the api answers 403 to anyone else), and only on a
 * Drive whose Tape has "VS Code in the browser". "Open in VS Code" asks the Drive to start it; the
 * same button stays in place, busy, while it installs and starts, then becomes a link to the IDE
 * (behind Google sign-in, for the owner and sysops only) with "Close", which ends the public address
 * while code-server keeps running. There is no share control: the IDE is a shell.
 *
 * The link isn't opened automatically: the IDE is ready 20-30 s after the click, and a browser
 * blocks a new tab that doesn't come straight from one. A screen reader hears when it's ready.
 */
export function IdeChip() {
  const c = useIde();
  const [announce, setAnnounce] = useState("");
  const openRef = useRef<HTMLButtonElement | null>(null);
  const focusOpen = useRef(false);
  const noteId = useId();
  const ready = Boolean(c?.ready);

  // Tell a screen reader when it's ready, since the busy region it heard goes away.
  useEffect(() => {
    setAnnounce(ready ? "VS Code is ready. Open it from the VS Code link." : "");
  }, [ready]);

  // After Close, keep focus on the chip: the button that had it is gone.
  useEffect(() => {
    if (focusOpen.current && !ready) {
      focusOpen.current = false;
      openRef.current?.focus();
    }
  });

  if (!c?.ide?.available || c.forbidden) return null;
  const { ide, busy, starting, stale, openable } = c;

  const liveRegion = (
    <span className="sr-only" aria-live="polite">
      {announce}
    </span>
  );

  if (ready) {
    return (
      <span className="preview-cluster ide-cluster">
        <a
          className="preview-chip ide-chip"
          href={ide.url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this Drive's files in VS Code. Only the floppy's owner and sysops can open it; they sign in with Google."
        >
          <VsCodeIcon size={14} />
          VS Code<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <button
          type="button"
          className="chip-btn"
          onClick={async () => {
            // Set before the await, so the render that swaps the link for the button finds it.
            focusOpen.current = true;
            if (!(await c.close())) focusOpen.current = false;
          }}
          disabled={busy !== null}
          aria-label="Close VS Code's address"
        >
          {busy === "close" ? <Working label="Closing" /> : "Close"}
        </button>
        {liveRegion}
      </span>
    );
  }

  // One button through open → installing → starting, so focus stays on it; busy while it works.
  const working = busy === "open" || starting;
  const failed = ide.state === "error" || ide.state === "stopped";
  const note = stale
    ? "VS Code is taking a while. Try again?"
    : failed
      ? `${ide.state === "stopped" ? "VS Code stopped" : "VS Code didn't start"}${ide.detail ? `: ${ide.detail}` : ""}`
      : undefined;
  return (
    <span className="preview-cluster ide-cluster">
      <button
        ref={openRef}
        type="button"
        className="chip-btn ide-open-btn"
        onClick={() => void c.open()}
        // Real `disabled` only when the Drive can't take it; while working it stays focusable.
        disabled={!openable}
        aria-disabled={working || undefined}
        aria-busy={working || undefined}
        aria-describedby={note ? noteId : undefined}
        title={openable ? "Open this Drive's files in VS Code in the browser, with a terminal. Only the floppy's owner and sysops can open it." : "The Drive has to be running first."}
      >
        {working ? (
          <Working label={startingLabel(busy === "open" && !starting ? "requested" : ide.state)} srOnly={false} />
        ) : (
          <>
            <VsCodeIcon size={14} />
            {stale ? "Try again" : "Open in VS Code"}
          </>
        )}
      </button>
      {note && (
        <span className="ide-note" id={noteId} title={note}>
          {note}
        </span>
      )}
      {liveRegion}
    </span>
  );
}
