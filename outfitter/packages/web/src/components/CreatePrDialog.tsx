import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CreatePrOutcome } from "../hooks/useSessionGit.ts";
import { Working } from "./Working.tsx";

/**
 * #502 (docs/design/sessions-redesign-demo.html note 18): open the branch's pull request. The title
 * starts as the floppy's; an empty body uses the repository's PR template (the api fills it in).
 * The api's refusals (a PR already open, no commits, the branch not pushed) show here, not as a bomb.
 */
export function CreatePrDialog({
  defaultTitle,
  repo,
  branch,
  base,
  onSubmit,
  onClose,
}: {
  defaultTitle: string;
  repo: string | null;
  branch: string | null;
  base: string | null;
  onSubmit: (input: { title: string; body?: string; draft: boolean }) => Promise<CreatePrOutcome>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; url?: string } | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const id = useId();

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await onSubmit({ title: title.trim(), ...(body.trim() ? { body } : {}), draft });
    setBusy(false);
    if (outcome.ok) onClose();
    else setError({ text: outcome.error ?? "The pull request wasn't opened.", url: outcome.url });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="dialog panel create-pr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`} className="panel-title">
          <span className="panel-label">Create pull request</span>
        </h2>
        <div className="panel-body">
          <form onSubmit={submit}>
            <p className="create-pr-where mono">
              {repo ?? "repository"} · {branch ?? "branch"} → {base ?? "base"}
            </p>
            <div className="form-row">
              <label htmlFor={`${id}-t`}>Title</label>
              <input id={`${id}-t`} ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="form-row">
              <label htmlFor={`${id}-b`}>Description</label>
              <textarea
                id={`${id}-b`}
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Leave empty to use the repository's pull request template."
              />
            </div>
            <label className="create-pr-draft">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Open as draft
            </label>
            {error && (
              <p className="create-pr-error" role="alert">
                {error.text}
                {error.url ? (
                  <>
                    {" "}
                    <a href={error.url} target="_blank" rel="noopener noreferrer">
                      Open it on GitHub
                    </a>
                  </>
                ) : null}
              </p>
            )}
            <div className="form-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
                {busy ? <Working label="Opening" /> : "Create PR"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
