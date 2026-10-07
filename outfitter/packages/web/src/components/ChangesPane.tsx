import { useEffect, useId, useState } from "react";
import type { ChangedFile, GithubCheck, LastPush } from "../api/client.ts";
import type { DiffNotes } from "../hooks/useDiffNotes.ts";
import type { SessionGit } from "../hooks/useSessionGit.ts";
import {
  changesNoneCopy,
  checkDuration,
  checkSummary,
  conflictedFiles,
  hasBranchChanges,
  mergeState,
  notesMessage,
  parsePatch,
  pushedLine,
  rowLine,
  type DiffRow,
} from "../lib/git-view.ts";
import { Working } from "./Working.tsx";

const REVIEW_WORDS: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
  none: "No review yet",
};

const CHECK_GLYPH: Record<GithubCheck["state"], string> = { pass: "✓", fail: "✗", running: "◌", skipped: "–" };

const STATUS_WORD: Record<ChangedFile["status"], string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
};

function NoteForm({ line, onSave, onCancel }: { line: number; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const id = useId();
  return (
    <div className="diff-note-form">
      <label htmlFor={id} className="sr-only">
        Note for the agent about line {line}
      </label>
      <textarea
        id={id}
        rows={2}
        autoFocus
        value={text}
        placeholder={`Note for the agent about line ${line}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
            e.preventDefault();
            onSave(text.trim());
          }
        }}
      />
      <div className="diff-note-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          Add note
        </button>
      </div>
    </div>
  );
}

/** One file's patch with line numbers. Any added, removed or context line takes a note. */
export function FileDiff({ file, notes }: { file: ChangedFile; notes: DiffNotes }) {
  const [noteAt, setNoteAt] = useState<number | null>(null);
  if (file.binary) return <p className="diff-empty">Binary file: no text diff.</p>;
  if (file.patchOmitted) return <p className="diff-empty">This file's diff is too big to show here.</p>;
  if (!file.patch) return <p className="diff-empty">{file.status === "R" ? "Renamed, with no content changes." : "No text changes to show."}</p>;
  const rows: DiffRow[] = parsePatch(file.patch);
  return (
    <div className="pane-diff" role="group" aria-label={`Diff of ${file.path}`}>
      {rows.map((row, i) => {
        if (row.kind === "hunk" || row.kind === "meta")
          return (
            <div key={i} className={`diff-row is-${row.kind}`}>
              <span className="diff-ln" />
              <span className="diff-ln" />
              <span className="diff-text">{row.text}</span>
            </div>
          );
        const line = rowLine(row)!;
        const side = row.kind === "del" ? "old" : "new";
        const here = notes.notes
          .map((n, index) => ({ n, index }))
          .filter(({ n }) => n.path === file.path && n.line === line && n.side === side);
        const mark = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
        return (
          <div key={i}>
            <button
              type="button"
              className={`diff-row is-${row.kind}`}
              aria-expanded={noteAt === i}
              aria-label={`${row.kind === "add" ? "Added" : row.kind === "del" ? "Removed" : "Line"} ${line}: ${row.text}. Leave a note`}
              onClick={() => setNoteAt(noteAt === i ? null : i)}
            >
              <span className="diff-ln">{row.oldLine ?? ""}</span>
              <span className="diff-ln">{row.newLine ?? ""}</span>
              <span className="diff-text">
                <span className="diff-mark" aria-hidden="true">
                  {mark}
                </span>
                {row.text}
              </span>
            </button>
            {here.map(({ n, index }) => (
              <div key={index} className="diff-note">
                <span className="diff-note-who">Your note</span>
                <span>{n.text}</span>
                <button type="button" className="btn btn-small" onClick={() => notes.remove(index)} aria-label={`Remove the note on line ${line}`}>
                  ×
                </button>
              </div>
            ))}
            {noteAt === i && (
              <NoteForm
                line={line}
                onCancel={() => setNoteAt(null)}
                onSave={(text) => {
                  notes.add({ path: file.path, line, side, text });
                  setNoteAt(null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FailingCheck({ check, git }: { check: GithubCheck; git: SessionGit }) {
  const log = git.logs[check.id];
  const { loadLog } = git;
  useEffect(() => {
    if (check.hasLog && !log) loadLog(check.id);
  }, [check.id, check.hasLog, log, loadLog]);
  return (
    <div className="git-callout is-fail">
      <strong>{check.name} failed</strong>
      {check.hasLog ? (
        log?.state === "ready" ? (
          <pre className="git-log">{log.log.log || "(the log is empty)"}</pre>
        ) : log?.state === "error" ? (
          <p className="git-callout-note">The log couldn't be read: {log.message}</p>
        ) : (
          <Working label="Reading the log" srOnly={false} />
        )
      ) : (
        <p className="git-callout-note">No log from GitHub for this check{check.detailsUrl ? "; its details are on GitHub" : ""}.</p>
      )}
      <div className="git-actions">
        <button type="button" className="btn btn-primary" onClick={() => void git.fixCi()} disabled={git.busy !== null}>
          {git.busy === "fix-ci" ? <Working label="Sending" /> : "Fix CI"}
        </button>
        <button type="button" className="btn" onClick={() => void git.rerun()} disabled={git.busy !== null}>
          {git.busy === "rerun" ? <Working label="Re-running" /> : "Re-run"}
        </button>
        {check.detailsUrl && (
          <a href={check.detailsUrl} target="_blank" rel="noopener noreferrer" className="git-link">
            Details ↗
          </a>
        )}
      </div>
    </div>
  );
}

function PullRequest({ git, onCreatePr }: { git: SessionGit; onCreatePr: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const status = git.status;
  const pr = status?.pr ?? null;
  const changes = git.changes;
  const base = pr?.base ?? changes?.base ?? status?.baseBranch ?? "the base branch";
  // A different head than the one confirmed against: ask again.
  const head = pr?.headSha ?? null;
  useEffect(() => setConfirming(false), [head]);

  if (!pr) {
    if (git.mergedPr)
      return (
        <p className="details-empty">
          #{git.mergedPr.number} merged into {base}.
        </p>
      );
    if (status?.prError) return <p className="details-empty">The pull request couldn't be read: {status.prError}</p>;
    return hasBranchChanges(status, changes) ? (
      <>
        <p className="details-empty">No pull request yet.</p>
        <div className="git-actions">
          <button type="button" className="btn btn-primary" onClick={onCreatePr} disabled={git.busy !== null}>
            Create PR
          </button>
        </div>
      </>
    ) : (
      <p className="details-empty">Nothing to open a pull request with yet: the branch matches {base}.</p>
    );
  }

  const summary = checkSummary(pr);
  const failing = pr.checks.find((c) => c.state === "fail");
  const merge = mergeState(status);
  const others = (status?.pulls ?? []).filter((p) => p.number !== pr.number);
  return (
    <>
      <p className="git-pr-title">{pr.title}</p>
      <p className="git-pr-sub mono">
        #{pr.number} · {pr.draft ? "draft · " : ""}
        {REVIEW_WORDS[pr.review] ?? pr.review}
        {summary ? <span className={`git-st-${summary.tone}`}> · {summary.text}</span> : null}
      </p>
      {pr.checksError && <p className="details-empty">The checks couldn't be read: {pr.checksError}</p>}
      {pr.checks.length > 0 && (
        <ul className="git-checks" aria-label="Checks">
          {pr.checks.map((check) => (
            <li key={check.id} className={`git-check is-${check.state}`}>
              <span className={`git-st-${check.state === "pass" ? "pass" : check.state === "fail" ? "fail" : "run"}`} aria-hidden="true">
                {CHECK_GLYPH[check.state]}
              </span>
              {check.detailsUrl ? (
                <a href={check.detailsUrl} target="_blank" rel="noopener noreferrer">
                  {check.name}
                </a>
              ) : (
                <span>{check.name}</span>
              )}
              <span className="git-check-time">
                <span className="sr-only">{check.state}, </span>
                {checkDuration(check)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {failing && <FailingCheck check={failing} git={git} />}
      <div className="details-toggle">
        <span>
          Auto-fix CI
          <small>When a check fails, send its log to the agent. Coming soon (#503).</small>
        </span>
        <button type="button" className="details-switch" role="switch" aria-checked={false} aria-label="Auto-fix CI, coming soon" disabled />
      </div>
      {merge.offered ? (
        <div className="git-actions">
          {confirming ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void git.merge().then(() => setConfirming(false))} disabled={!merge.enabled || git.busy !== null}>
                {git.busy === "merge" ? <Working label="Merging" /> : `Squash and merge into ${base}`}
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={git.busy === "merge"}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={!merge.enabled || git.busy !== null} title={merge.reason ?? undefined}>
              Merge…
            </button>
          )}
          <a href={pr.url} target="_blank" rel="noopener noreferrer" className="git-link">
            View on GitHub ↗
          </a>
        </div>
      ) : (
        <div className="git-actions">
          <a href={pr.url} target="_blank" rel="noopener noreferrer" className="git-link">
            View on GitHub ↗
          </a>
        </div>
      )}
      {merge.reason && <p className="details-empty git-merge-why">{merge.reason}</p>}
      {others.length > 0 && (
        <div className="git-others">
          <span className="git-others-label">Other open pull requests</span>
          {others.map((p) => (
            <a key={p.number} href={p.url} target="_blank" rel="noopener noreferrer" title={p.title}>
              #{p.number}
              {p.draft ? " draft" : ""} {p.title}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * #502: the Changes tab (docs/design/sessions-redesign-demo.html notes 16-20): the branch against
 * its base and what's been pushed, Sync and conflicts, the pull request with its checks, Fix CI,
 * Re-run and Merge, and every changed file with its diff, where a click on a line leaves a note
 * for the agent. The same content fills the phone's full-screen Changes view.
 */
export function ChangesPane({
  git,
  notes,
  lastPush,
  onCreatePr,
  onSendNotes,
}: {
  git: SessionGit;
  notes: DiffNotes;
  lastPush: LastPush | null | undefined;
  onCreatePr: () => void;
  onSendNotes: (text: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const { status, changes } = git;
  const branch = changes?.branch ?? status?.branch ?? null;
  const base = changes?.base ?? status?.baseBranch ?? null;
  const ahead = changes?.ahead ?? status?.diff?.ahead;
  const behind = changes?.behind ?? status?.diff?.behind ?? 0;
  const conflicts = conflictedFiles(changes);
  const conflict = git.syncConflict || conflicts.length > 0 || status?.pr?.mergeableState === "dirty";
  const files = changes?.files ?? [];
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const push = lastPush ?? changes?.pushed ?? null;

  if (!changes && !status) {
    return git.changesError ? <p className="details-empty pane-pad">{git.changesError}</p> : <p className="details-empty pane-pad">LOADING…</p>;
  }
  if (changes?.source === "none" && changes.reason === "no-repository") {
    return <p className="details-empty pane-pad">{changesNoneCopy("no-repository")}</p>;
  }

  return (
    <div className="changes-pane">
      {git.notice && (
        <div className={`git-notice is-${git.notice.tone}`} role={git.notice.tone === "error" ? "alert" : "status"}>
          <span>{git.notice.text}</span>
          <button type="button" className="btn btn-small" onClick={git.clearNotice} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <section className="details-sec" aria-labelledby="changes-branch">
        <h2 id="changes-branch">
          <span>Branch</span>
          {ahead !== undefined ? (
            <span>
              {ahead} ahead · {behind} behind
            </span>
          ) : null}
        </h2>
        <p className="details-line mono git-branch-line">
          {branch ?? "no branch yet"}
          {base ? ` → ${base}` : ""}
        </p>
        <p className="details-line mono git-pushed">
          {pushedLine(push)}
          {changes?.source === "drive" ? " · showing the Drive's working tree" : changes?.source === "github" ? " · showing the pushed branch" : ""}
        </p>
        {conflict ? (
          <div className="git-callout is-fail">
            <strong>Merge conflict with {base ?? "the base branch"}</strong>
            {conflicts.length > 0 && <span className="mono">{conflicts.map((f) => f.path).join(", ")}</span>}
            <div className="git-actions">
              <button type="button" className="btn btn-primary" onClick={git.resolveConflict}>
                Resolve with agent
              </button>
            </div>
          </div>
        ) : behind > 0 && base ? (
          <div className="git-callout is-warn">
            <span>
              {behind} commit{behind === 1 ? "" : "s"} behind {base}.
            </span>
            <div className="git-actions">
              <button type="button" className="btn" onClick={() => void git.sync()} disabled={git.busy !== null}>
                {git.busy === "sync" ? <Working label="Syncing" /> : `Sync with ${base}`}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="details-sec" aria-labelledby="changes-pr">
        <h2 id="changes-pr">
          <span>Pull request</span>
        </h2>
        <PullRequest git={git} onCreatePr={onCreatePr} />
      </section>

      <section aria-labelledby="changes-files">
        <div className="details-sec git-files-head">
          <h2 id="changes-files">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"} changed
            </span>
            {files.length > 0 && (
              <span>
                <span className="git-add">+{adds}</span> <span className="git-del">−{dels}</span>
              </span>
            )}
          </h2>
          {changes?.source === "none" ? (
            <p className="details-empty">{changesNoneCopy(changes.reason)}</p>
          ) : files.length === 0 ? (
            <p className="details-empty">No changes{base ? ` against ${base}` : ""}.</p>
          ) : (
            <p className="details-empty">Click a line to leave a note for the agent.</p>
          )}
          {changes?.truncated && <p className="details-empty">The diff is too big to show in full: some files or lines are left out.</p>}
          {git.changesError && changes && <p className="details-empty">Couldn't refresh: {git.changesError}</p>}
        </div>
        {files.map((file) => {
          const isOpen = open.has(file.path);
          return (
            <div key={file.path} className="git-file">
              <button
                type="button"
                className="git-file-row"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
              >
                <span className="flow-caret" aria-hidden="true">
                  ›
                </span>
                <span className={`git-file-st is-${file.status}`} title={STATUS_WORD[file.status]}>
                  {file.status}
                  <span className="sr-only"> {STATUS_WORD[file.status]}</span>
                </span>
                <span className="git-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                  {file.oldPath ? `${file.oldPath} → ` : ""}
                  {file.path}
                </span>
                <span className="git-file-stat">
                  <span className="git-add">+{file.additions}</span> <span className="git-del">−{file.deletions}</span>
                </span>
              </button>
              {isOpen && <FileDiff file={file} notes={notes} />}
            </div>
          );
        })}
      </section>

      {notes.notes.length > 0 && (
        <div className="git-notes-bar" role="region" aria-label="Notes on the diff">
          <span>
            {notes.notes.length} note{notes.notes.length === 1 ? "" : "s"} on the diff
          </span>
          <button type="button" className="btn btn-small" onClick={notes.clear}>
            Discard
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => {
              onSendNotes(notesMessage(notes.notes));
              notes.clear();
            }}
          >
            Send to agent
          </button>
        </div>
      )}
    </div>
  );
}
