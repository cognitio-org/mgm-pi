import { useState } from "react";
import { api, type Guru, ApiError } from "../api/client.ts";

interface Props {
  gurus: Guru[];
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function NewSessionDialog({ gurus, onClose, onCreated }: Props) {
  const [guruId, setGuruId] = useState(gurus[0]?.id ?? "");
  const [repo, setRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!guruId || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { session } = await api.createSession({
        guruId,
        prompt,
        name: name.trim() || undefined,
        repo: repo.trim() || undefined,
        baseBranch: repo.trim() ? baseBranch.trim() || undefined : undefined,
        branch: repo.trim() ? branch.trim() || undefined : undefined,
        model: model.trim() || undefined,
      });
      onCreated(session.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create session");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New session</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="ns-guru">Guru</label>
            <select id="ns-guru" value={guruId} onChange={(e) => setGuruId(e.target.value)} required>
              {gurus.length === 0 && <option value="">No gurus configured</option>}
              {gurus.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="ns-repo">Repository (owner/repo, empty = no repository)</label>
            <input id="ns-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="org/repo" />
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
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || !guruId || !prompt.trim()}>
              {submitting ? "Starting..." : "Start session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
