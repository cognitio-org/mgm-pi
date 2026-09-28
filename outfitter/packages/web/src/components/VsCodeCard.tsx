import type { ReactNode } from "react";
import { useIde, startingLabel } from "./IdeProvider.tsx";
import { VsCodeIcon } from "./VsCodeIcon.tsx";
import { Working } from "./Working.tsx";

/**
 * #273: the chat's chip for the model's `vscode` tool (the person asked it to open VS Code). It shows
 * the Drive's IDE as it is now, from the same IdeProvider as the status-bar chip: on its way, a link
 * once ready, or a button to open it again. The model never had the link; this page gets it from the
 * api, which gives it only to the floppy's owner and sysops. Everyone else sees a plain note.
 */
export function VsCodeCard({ live = true }: { live?: boolean }) {
  const c = useIde();
  const shell = (body: ReactNode, extra = "") => (
    <div className={`vscode-card${extra ? ` ${extra}` : ""}`}>
      <VsCodeIcon size={22} />
      <div className="vscode-card-body">{body}</div>
    </div>
  );

  if (!c) return shell(<span className="vscode-card-title">VS Code</span>);
  // An earlier ask in this conversation: only the latest card is live, so an old one doesn't offer
  // to reopen what the owner closed since.
  if (!live) return shell(<span className="vscode-card-note">VS Code was opened here earlier.</span>, "is-quiet");
  if (!c.loaded) return shell(<span className="vscode-card-title">VS Code</span>);
  if (c.forbidden) return shell(<span className="vscode-card-note">VS Code was opened for this floppy's owner.</span>, "is-quiet");
  if (!c.ide?.available) return shell(<span className="vscode-card-note">VS Code isn't available: the Drive isn't running.</span>, "is-quiet");

  const { ide, busy, starting, stale, openable, ready } = c;
  if (ready) {
    return (
      <a className="vscode-card is-link" href={ide.url} target="_blank" rel="noopener noreferrer">
        <VsCodeIcon size={22} />
        <span className="vscode-card-body">
          <span className="vscode-card-title">
            Open VS Code <span aria-hidden="true">↗</span>
          </span>
          <span className="vscode-card-note">This Drive's files and a terminal. Only you and sysops can open it.</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </span>
      </a>
    );
  }
  if (starting || busy === "open") {
    return shell(
      <>
        <span className="vscode-card-title">VS Code</span>
        <Working label={startingLabel(busy === "open" && !starting ? "requested" : ide.state)} srOnly={false} />
      </>,
    );
  }
  const failed = ide.state === "error" || ide.state === "stopped";
  return shell(
    <>
      <span className="vscode-card-title">VS Code</span>
      {(failed || stale) && (
        <span className="vscode-card-note">
          {stale ? "It's taking a while." : ide.state === "stopped" ? "It stopped." : "It didn't start."}
          {failed && ide.detail ? ` ${ide.detail}` : ""}
        </span>
      )}
      <button type="button" className="chip-btn ide-open-btn" onClick={() => void c.open()} disabled={!openable}>
        {stale || failed ? "Try again" : "Open in VS Code"}
      </button>
    </>,
  );
}
