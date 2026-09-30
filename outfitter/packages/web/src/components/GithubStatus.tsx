// Live GitHub facts for a Floppy whose repository the App can see: the branch, open pull
// requests, and added/removed lines. Sits in the session status bar beside the GitHub chip,
// which already names the repository, so this cluster does not repeat owner/repo.
// Hidden unless the App can actually see that repository. Each fact has a pixel mark beside
// it. The pull request for this branch is boxed; a draft says "draft". Added lines stay in
// the normal text color; phosphor green is reserved for a tool that is still running.

import { useEffect, useState } from "react";
import { api, type GithubPull, type GithubSessionStatus } from "../api/client.ts";
import { GithubGlyph } from "./GithubGlyphs.tsx";
import { githubWebUrl } from "../lib/github-link.ts";

const POLL_MS = 60_000;
const SHOWN_PULLS = 3;

function diffTitle(diff: NonNullable<GithubSessionStatus["diff"]>): string {
  if (diff.source === "pull") return "Added and removed lines on the pull request for this branch";
  if (diff.partial) return "Compared with the base branch. GitHub returned only part of the files, so this is a lower bound.";
  return "Added and removed lines compared with the base branch";
}

function pullClass(pull: GithubPull, branchNumber: number | undefined): string {
  const classes = ["github-status-pull"];
  if (pull.number === branchNumber) classes.push("is-branch");
  if (pull.draft) classes.push("is-draft");
  return classes.join(" ");
}

function pullTitle(pull: GithubPull, branchNumber: number | undefined): string {
  const notes = [pull.number === branchNumber ? "this branch" : "", pull.draft ? "draft" : ""].filter(Boolean);
  return notes.length > 0 ? `${pull.title} (${notes.join(", ")})` : pull.title;
}

function PullMark({ pull, branchNumber }: { pull: GithubPull; branchNumber: number | undefined }) {
  const title = pullTitle(pull, branchNumber);
  const className = pullClass(pull, branchNumber);
  const href = githubWebUrl(pull.url);
  // Glyphs have no text, so the link's visible label stays "#n" plus "draft" when it is one.
  const body = (
    <>
      <GithubGlyph name="pull" />#{pull.number}
      {pull.draft ? <span className="github-status-draft">draft</span> : null}
    </>
  );
  return href ? (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <span className={className} title={title}>
      {body}
    </span>
  );
}

export function GithubStatusView({ status }: { status: GithubSessionStatus }) {
  if (!status.connected) return null;
  const shown = status.pulls.slice(0, SHOWN_PULLS);
  const rest = status.pulls.slice(SHOWN_PULLS);
  const branchNumber = status.branchPull?.number;
  const ahead = status.diff?.ahead ?? 0;
  const behind = status.diff?.behind ?? 0;
  const baseName = status.baseBranch || "the base branch";
  return (
    <span className="github-status" aria-label="GitHub status">
      {status.branch && (
        // No whitespace text nodes: the branch element's text is only the branch name.
        <span className="github-status-branch" title={`Branch ${status.branch}`}>{[
          <GithubGlyph key="branch" name="branch" />,
          <span key="name" className="github-status-branch-name">{status.branch}</span>,
        ]}</span>
      )}
      {(ahead > 0 || behind > 0) && (
        <span className="github-status-sync">
          {ahead > 0 && (
            <span className="github-status-ahead" title={`${ahead} commits ahead of ${baseName}`}>
              ↑{ahead}
            </span>
          )}
          {behind > 0 && (
            <span className="github-status-behind" title={`${behind} commits behind ${baseName}`}>
              ↓{behind}
            </span>
          )}
        </span>
      )}
      {shown.map((pull) => (
        <PullMark key={pull.number} pull={pull} branchNumber={branchNumber} />
      ))}
      {rest.length > 0 && (
        <span className="github-status-more" title={rest.map((pull) => `#${pull.number} ${pull.title}`).join("\n")}>{`+${rest.length}`}</span>
      )}
      {status.diff && (
        <span className="github-status-diff" title={diffTitle(status.diff)}>
          {status.diff.partial ? <GithubGlyph name="warn" /> : null}
          <span className="github-status-add">+{status.diff.additions}</span>
          <span className="github-status-del">−{status.diff.deletions}</span>
        </span>
      )}
    </span>
  );
}

/** Polls while the Floppy has a repository and the tab is visible. A miss, or a repository
 * the App cannot see, renders nothing. */
export function GithubStatus({ sessionId, repo }: { sessionId: string; repo?: string | null }) {
  const [status, setStatus] = useState<GithubSessionStatus | null>(null);
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = await api.githubStatus(sessionId);
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
    }
    function arm() {
      if (document.visibilityState === "hidden") return;
      timer = setTimeout(() => {
        void load().finally(() => {
          if (!cancelled) arm();
        });
      }, POLL_MS);
    }
    void load();
    arm();
    function onVisible() {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      void load();
      arm();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, repo]);
  if (!status) return null;
  return <GithubStatusView status={status} />;
}
