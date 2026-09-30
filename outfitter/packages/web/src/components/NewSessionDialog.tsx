import { useEffect, useState } from "react";
import { api, type Guru } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { Working } from "./Working.tsx";
import { SystemErrorDialog, type ApiErrorState } from "./SystemErrorDialog.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { RepoField } from "./RepoField.tsx";

interface Props {
  gurus: Guru[];
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  /** Preselects the guru dropdown -- used by the Gurus page's "New session with this guru" button
   * (EPIC.md E3.7). Falls back to the first guru, same as before, when omitted or not found. */
  initialGuruId?: string;
}

/** Bug 4 (docs/reports/cloud-fixes.md): the dialog used to pick `guruId` once, from `useState`'s
 * initializer -- if it opened before `gurus` had loaded (gurus=[]), guruId stayed "" forever. The
 * <select> has no empty option once gurus arrives, so the browser silently shows its first
 * <option> while React's own state (and the Start button's `disabled={!guruId}`) never catches up.
 * Pure so "stay valid as gurus loads" is testable without mounting the dialog: keeps `current` when
 * it's still a real guru (don't clobber a deliberate pick), otherwise re-derives from
 * `initialGuruId` or the first guru, exactly like the original one-shot initializer did. */
export function resolveGuruId(current: string, gurus: Guru[], initialGuruId?: string): string {
  if (gurus.some((g) => g.id === current)) return current;
  if (initialGuruId && gurus.some((g) => g.id === initialGuruId)) return initialGuruId;
  return gurus[0]?.id ?? "";
}

export function NewSessionDialog({ gurus, onClose, onCreated, initialGuruId }: Props) {
  const [guruId, setGuruId] = useState(() => resolveGuruId("", gurus, initialGuruId));

  // Keeps guruId valid as `gurus` finishes loading (or changes) after the dialog is already open --
  // see resolveGuruId's doc comment above.
  useEffect(() => {
    setGuruId((current) => resolveGuruId(current, gurus, initialGuruId));
  }, [gurus, initialGuruId]);
  const [repo, setRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!guruId || !prompt.trim()) return;
    setSubmitting(true);
    try {
      const { session } = await withFloppySound(
        api.createSession({
          guruId,
          prompt,
          name: name.trim() || undefined,
          repo: repo.trim() || undefined,
          baseBranch: repo.trim() ? baseBranch.trim() || undefined : undefined,
          branch: repo.trim() ? branch.trim() || undefined : undefined,
          model: model.trim() || undefined,
        }),
      );
      onCreated(session.id);
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to create session"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ns-title">
        <h2 id="ns-title" className="panel-title">
          <span className="panel-label">New Floppy</span>
        </h2>
        <div className="panel-body">
        {apiError && <SystemErrorDialog error={apiError} onResume={() => setApiError(null)} />}
        <form onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="ns-guru">Tape</label>
            <select id="ns-guru" value={guruId} onChange={(e) => setGuruId(e.target.value)} required>
              {gurus.length === 0 && <option value="">No tapes configured</option>}
              {gurus.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="ns-repo">Repository</label>
            <RepoField id="ns-repo" value={repo} onChange={setRepo} />
          </div>
          {repo.trim() && (
            <>
              <div className="form-row">
                <label htmlFor="ns-base">Base branch</label>
                <input id="ns-base" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
              </div>
              <div className="form-row">
                <label htmlFor="ns-branch">Branch</label>
                <input id="ns-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="auto-generated if empty" />
              </div>
            </>
          )}
          <div className="form-row">
            <label htmlFor="ns-name">Name (optional)</label>
            <input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="ns-model">Model override (optional)</label>
            <input id="ns-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="guru default" />
          </div>
          <div className="form-row">
            <label htmlFor="ns-prompt">Prompt</label>
            <textarea id="ns-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting || !guruId || !prompt.trim()}>
              {submitting ? <Working label="Starting" /> : "Start session"}
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
}
