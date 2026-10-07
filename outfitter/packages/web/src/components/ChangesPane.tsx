import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.ts";
import { BackIcon } from "./SessionIcons.tsx";
import type { AutofixState, ChangedFile, GithubCheck, LastPush } from "../api/client.ts";
import { relativeTime } from "../lib/relative-time.ts";
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
  httpUrl,
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

function NoteForm({ line, onSave, onCancel }: { line: number; onSave: (text: string) => string | null; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = () => setError(onSave(text.trim()));
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
            save();
          }
        }}
      />
      {error && (
        <p className="diff-note-error" role="alert">
          {error}
        </p>
      )}
      <div className="diff-note-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" disabled={!text.trim()} onClick={save}>
          Add note
        </button>
      </div>
    </div>
  );
}

/** One file's patch with line numbers. Any added, removed or context line takes a note. */
/** A diff row's identity across refreshes: which file, which side's numbers. Indexes move when the
 * patch changes; this only matches the same line. */
function rowKey(path: string, row: DiffRow): string {
  return `${path}:${row.kind}:${row.oldLine ?? ""}:${row.newLine ?? ""}`;
}

export function FileDiff({ file, notes }: { file: ChangedFile; notes: DiffNotes }) {
  const [noteAt, setNoteAt] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const rows: DiffRow[] = file.patch && !file.binary && !file.patchOmitted ? parsePatch(file.patch) : [];
  // A refresh that took the line away closes its form.
  const present = noteAt !== null && rows.some((row) => rowKey(file.path, row) === noteAt);
  useEffect(() => {
    if (noteAt !== null && !present) setNoteAt(null);
  }, [noteAt, present]);
  if (file.binary) return <p className="diff-empty">Binary file: no text diff.</p>;
  if (file.patchOmitted) return <p className="diff-empty">This file's diff is too big to show here.</p>;
  if (!file.patch) return <p className="diff-empty">{file.status === "R" ? "Renamed, with no content changes." : "No text changes to show."}</p>;
  return (
    <div className="pane-diff" role="group" aria-label={`Diff of ${file.path}`}>
      {saveWarning && (
        <p className="diff-note-error" role="status">
          {saveWarning}
        </p>
      )}
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
        const key = rowKey(file.path, row);
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
              aria-expanded={noteAt === key}
              aria-label={`${row.kind === "add" ? "Added" : row.kind === "del" ? "Removed" : "Line"} ${line}: ${row.text}. Leave a note`}
              onClick={() => setNoteAt(noteAt === key ? null : key)}
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
            {noteAt === key && (
              <NoteForm
                line={line}
                onCancel={() => setNoteAt(null)}
                onSave={(text) => {
                  const result = notes.add({ path: file.path, line, side, text });
                  // A refusal keeps the form open with the reason; an added note closes it.
                  if (!result.added) return result.message;
                  setNoteAt(null);
                  if (result.message) setSaveWarning(result.message);
                  return null;
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
        {httpUrl(check.detailsUrl) && (
          <a href={httpUrl(check.detailsUrl)!} target="_blank" rel="noopener noreferrer" className="git-link">
            Details ↗
          </a>
        )}
      </div>
    </div>
  );
}

/** #503 Auto-fix CI for this floppy. `onToggle` resolves to an error message, or null once saved. */
export interface AutofixControl {
  state: AutofixState | undefined;
  canManage: boolean;
  /** Archived: the watcher skips it, and the server only lets it be turned off. */
  archived: boolean;
  onToggle: (on: boolean) => Promise<string | null>;
}

/** What the switch says under its label, and whether it can be pressed. Pure for tests. */
export function autofixSwitchView(
  control: AutofixControl,
  now = Date.now(),
): { on: boolean; note: string; disabled: boolean } {
  const { state, canManage, archived } = control;
  const on = state?.on === true;
  if (state?.a2a) return { on, note: "Not available on an A2A task's floppy.", disabled: !on || !canManage };
  if (!canManage) return { on, note: state?.notice ?? "Only the floppy's owner can change this.", disabled: true };
  if (archived)
    return on
      ? { on, note: "Paused while this floppy is archived. You can still turn it off.", disabled: false }
      : { on, note: "Restore this floppy to use Auto-fix.", disabled: true };
  if (on && state?.capped) {
    const at = state.resumesAt ? Date.parse(state.resumesAt) : NaN;
    const when = Number.isNaN(at)
      ? "within a day"
      : `at ${new Date(at).toLocaleString([], { weekday: at - now > 20 * 3600_000 ? "short" : undefined, hour: "2-digit", minute: "2-digit" })}`;
    return { on, note: `Paused: 3 messages in the last 24 hours and CI is still failing. Resumes ${when}; turn it off and on to resume now.`, disabled: false };
  }
  if (state?.notice) return { on, note: state.notice, disabled: false };
  if (on && state?.lastAt && state.lastSha) return { on, note: `Last sent for ${state.lastSha.slice(0, 7)} ${relativeTime(state.lastAt, now)}.`, disabled: false };
  if (on) return { on, note: "On: a failing check on this floppy's pull request goes to the agent (at most 3 a day).", disabled: false };
  return { on, note: "When a check fails, send its log to the agent (at most 3 a day).", disabled: false };
}

function AutofixSwitch({ control }: { control: AutofixControl }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new state (a save, or another floppy) clears an old refusal.
  useEffect(() => setError(null), [control.state]);
  const { on, note, disabled } = autofixSwitchView(control);
  const toggle = async () => {
    setSaving(true);
    setError(null);
    const failed = await control.onToggle(!on);
    setSaving(false);
    setError(failed);
  };
  return (
    <div className="details-toggle">
      <span>
        Auto-fix CI
        <small>{note}</small>
        {error && (
          <small className="git-error" role="alert">
            {error}
          </small>
        )}
      </span>
      <button
        type="button"
        className="details-switch"
        role="switch"
        aria-checked={on}
        aria-label="Auto-fix CI"
        disabled={disabled || saving}
        onClick={() => void toggle()}
      />
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
              {httpUrl(check.detailsUrl) ? (
                <a href={httpUrl(check.detailsUrl)!} target="_blank" rel="noopener noreferrer">
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
          <a href={httpUrl(pr.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="git-link">
            View on GitHub ↗
          </a>
        </div>
      ) : (
        <div className="git-actions">
          <a href={httpUrl(pr.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="git-link">
            View on GitHub ↗
          </a>
        </div>
      )}
      {merge.reason && <p className="details-empty git-merge-why">{merge.reason}</p>}
      {others.length > 0 && (
        <div className="git-others">
          <span className="git-others-label">Other open pull requests</span>
          {others.map((p) => (
            <a key={p.number} href={httpUrl(p.url) ?? undefined} target="_blank" rel="noopener noreferrer" title={p.title}>
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
  autofix,
}: {
  git: SessionGit;
  notes: DiffNotes;
  lastPush: LastPush | null | undefined;
  onCreatePr: () => void;
  autofix?: AutofixControl;
  /** Resolves true once the message was accepted; the notes stay until then. */
  onSendNotes: (text: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sendingNotes, setSendingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
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
              <button type="button" className="btn btn-primary" onClick={() => void git.resolveConflict()} disabled={git.busy !== null}>
                {git.busy === "resolve" ? <Working label="Sending" /> : "Resolve with agent"}
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
        {/* Outside PullRequest: it can be on with no open PR (before one, after a merge), and must stay switchable. */}
        {autofix && <AutofixSwitch control={autofix} />}
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
            {notesError ? (
              <span className="git-notes-error" role="alert">
                {" "}
                · {notesError}
              </span>
            ) : null}
          </span>
          <button type="button" className="btn btn-small" onClick={notes.clear}>
            Discard
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={sendingNotes}
            onClick={async () => {
              const clear = notes.clear;
              setSendingNotes(true);
              setNotesError(null);
              const ok = await onSendNotes(notesMessage(notes.notes)).catch(() => false);
              setSendingNotes(false);
              if (ok) clear();
              else setNotesError("Not sent: your notes are kept. Try again.");
            }}
          >
            {sendingNotes ? <Working label="Sending" /> : "Send to agent"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The phone's full-screen Changes view: a modal over the floppy, back arrow or Esc to return. */
export function ChangesFullView({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, { onEscape: onClose });
  return (
    <div ref={ref} className="changes-full" role="dialog" aria-modal="true" aria-label="Changes">
      <header className="session-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back to the floppy">
          <BackIcon />
        </button>
        <div className="session-head-title">
          <h1>Changes</h1>
          <span className="session-state">{title}</span>
        </div>
      </header>
      <div className="changes-full-body">{children}</div>
    </div>
  );
}
