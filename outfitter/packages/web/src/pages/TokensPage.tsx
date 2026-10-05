import { useEffect, useState } from "react";
import { api, type Guru, type TokenRecord } from "../api/client.ts";
import { a2aTapeProblem, expiresIn, normalizeA2ARepo } from "../lib/a2a-keys.ts";
import { Working } from "../components/Working.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { SyntaxError } from "../components/SyntaxError.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";
import { VoiceSpendView } from "../components/VoiceSpend.tsx";

/** E9: what an Agent Engine agent (integrations/agent-engine) needs to reach Outfitter's A2A server. */
function a2aEnvLines(linkOrigin: string, token: string): string {
  const api = linkOrigin || "<ask your operator for the link URL>";
  return [`OUTFITTER_A2A_URL=${api}`, `OUTFITTER_A2A_KEY=${token}`].join("\n");
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {
    // clipboard unavailable (no permission, non-secure context) -- nothing more we can do here.
  });
}

/** #399 CA-10: Dongles are retired. This page lists and revokes the ones that still exist (they
 * keep working until they expire or are revoked) and makes A2A keys only; Kernal signs in with
 * `kernal login` (the Devices page). */
export function TokensPage() {
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [linkOrigin, setLinkOrigin] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createAttempted, setCreateAttempted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  const [justCreated, setJustCreated] = useState<{ token: string; record: TokenRecord } | null>(null);
  // E9 §5.2: an A2A key, with the tapes and repositories its tasks may use (the only kind made here).
  const [tapes, setTapes] = useState<Guru[] | null>(null);
  const [chosenTapes, setChosenTapes] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [repoInput, setRepoInput] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [maxConcurrent, setMaxConcurrent] = useState(2);

  async function load() {
    setLoading(true);
    try {
      const [list, me] = await Promise.all([api.listTokens(), api.me()]);
      setTokens(list);
      setLinkOrigin(me.linkOrigin ?? "");
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to load tokens"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (tapes) return;
    api
      .gurus()
      .then(setTapes)
      .catch((err) => setApiError(toApiErrorState(err, "Failed to load tapes")));
  }, [tapes]);

  function toggleTape(id: string) {
    setChosenTapes((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  function addRepo() {
    const repo = normalizeA2ARepo(repoInput);
    if (!repo) {
      setRepoError("use owner/name");
      return;
    }
    setRepoError(null);
    setRepoInput("");
    setRepos((current) => (current.some((r) => r.toLowerCase() === repo.toLowerCase()) ? current : [...current, repo]));
  }

  const a2aIncomplete = chosenTapes.length === 0;

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    setCreateAttempted(true);
    if (!name.trim() || a2aIncomplete) return;
    // A repository typed but not added yet is meant too; one that isn't owner/name stops here.
    let scopeRepos = repos;
    if (repoInput.trim()) {
      const typed = normalizeA2ARepo(repoInput);
      if (!typed) {
        setRepoError("use owner/name, or clear the field");
        return;
      }
      if (!repos.some((r) => r.toLowerCase() === typed.toLowerCase())) scopeRepos = [...repos, typed];
      setRepoInput("");
    }
    setCreating(true);
    try {
      const result = await withFloppySound(api.createToken(name.trim(), { tapes: chosenTapes, repos: scopeRepos, maxConcurrent }));
      setJustCreated(result);
      setName("");
      setCreateAttempted(false);
      setChosenTapes([]);
      setRepos([]);
      await load();
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to create token"));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.revokeToken(id);
      await load();
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to revoke token"));
    }
  }

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.token.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("token")}</p>
      </div>
      <p className="session-meta">
        {vocabulary.token.many} are retired: Kernal signs in with <code>kernal login</code> (see Devices), and no new{" "}
        {vocabulary.token.one} can be made. One you already have keeps working until it expires or you revoke it here.
      </p>
      <p className="session-meta">
        An <strong>A2A key</strong> lets another agent (an Agent Engine agent, any A2A client) start coding tasks on
        the link service's <code>/a2a</code>, as you, on the tapes and repositories you pick here, each on its own{" "}
        <code>outfitter/a2a-*</code> branch. It works nowhere else. Its tapes need an explicit tools list, no
        environment variables, and a LiteLLM key of their own (never the shared one). Revoking it stops its tasks and
        Drives. Anything you or a teammate write in an A2A session can reach that caller's later answers.
      </p>

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}

      {justCreated && (
        <div className="dialog panel" style={{ maxWidth: "none", marginBottom: "1rem" }}>
          <h3 className="panel-title"><span className="panel-label">"{justCreated.record.name}" created</span></h3>
          <div className="panel-body">
          <p>Copy this token now — it will not be shown again.</p>
          <div className="form-row">
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <code className="masked" style={{ wordBreak: "break-all" }}>{justCreated.token}</code>
              <button type="button" className="btn" onClick={() => copyToClipboard(justCreated.token)}>
                Copy token
              </button>
            </div>
          </div>
          <p>Give these to the agent (for Agent Engine, as its two secrets):</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{a2aEnvLines(linkOrigin, justCreated.token)}</pre>
          {!linkOrigin && (
            <p className="session-meta">
              This deployment hasn't set OUTFITTER_LINK_ORIGIN yet — ask your operator for the link URL.
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => copyToClipboard(a2aEnvLines(linkOrigin, justCreated.token))}>
              Copy env lines
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setJustCreated(null)}>
              Done
            </button>
          </div>
          </div>
        </div>
      )}

      <form onSubmit={createToken}>
        <div className="toolbar toolbar-with-error">
          <div className="form-row" style={{ marginBottom: 0 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="agent-engine"
              aria-label="Token name"
              aria-invalid={createAttempted && !name.trim()}
            />
            {createAttempted && !name.trim() && <SyntaxError>name cannot be empty.</SyntaxError>}
          </div>
          <button type="submit" className="btn btn-primary" disabled={creating || !name.trim() || a2aIncomplete}>
            {creating ? <Working label="Creating" /> : "Create A2A key"}
          </button>
        </div>
        <A2AScopeFields
          tapes={tapes}
          chosenTapes={chosenTapes}
          onToggleTape={toggleTape}
          repos={repos}
          repoInput={repoInput}
          repoError={repoError}
          onRepoInput={setRepoInput}
          onAddRepo={addRepo}
          onRemoveRepo={(repo) => setRepos((current) => current.filter((r) => r !== repo))}
          maxConcurrent={maxConcurrent}
          onMaxConcurrent={setMaxConcurrent}
        />
      </form>

      {loading ? (
        <p className="empty-state"><Working label="Loading" size="lg" srOnly={false} /></p>
      ) : tokens.length === 0 ? (
        <p className="empty-state">No {vocabulary.token.many.toLowerCase()} yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td data-label="Name">{t.name}</td>
                <td data-label="Kind">{kindLabel(t)}</td>
                <td data-label="Prefix">
                  <code className="masked">{t.prefix}…</code>
                </td>
                <td data-label="Created">{new Date(t.createdAt).toLocaleString()}</td>
                <td data-label="Last used">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}</td>
                <td data-label="Expires">
                  {!t.expiresAt ? (
                    "—"
                  ) : Date.parse(t.expiresAt) <= Date.now() ? (
                    <span className="status-pill stopped">expired</span>
                  ) : (
                    <span title={new Date(t.expiresAt).toLocaleDateString()}>{expiresIn(t.expiresAt)}</span>
                  )}
                </td>
                <td data-label="">
                  <button type="button" className="btn btn-danger" onClick={() => revoke(t.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* #257: the one per-person page, so your voice spend lives here too (also in the mic's menu). */}
      <h3>Voice spend</h3>
      <VoiceSpendView />
    </div>
  );
}

function kindLabel(t: TokenRecord): string {
  if (t.kind !== "a2a") return `${vocabulary.token.one} (retired)`;
  if (!t.a2a) return "A2A key";
  const repos = t.a2a.repos.length > 0 ? t.a2a.repos.join(", ") : "no repository";
  return `A2A key · ${t.a2a.tapes.join(", ")} · ${repos}`;
}

interface A2AScopeFieldsProps {
  tapes: Guru[] | null;
  chosenTapes: string[];
  onToggleTape: (id: string) => void;
  repos: string[];
  repoInput: string;
  repoError: string | null;
  onRepoInput: (value: string) => void;
  onAddRepo: () => void;
  onRemoveRepo: (repo: string) => void;
  maxConcurrent: number;
  onMaxConcurrent: (n: number) => void;
}

/** The tape and repository pickers for a new A2A key. A tape the api would refuse is shown
 * disabled with the reason. */
function A2AScopeFields(props: A2AScopeFieldsProps) {
  return (
    <fieldset className="panel" aria-label="A2A key scope" style={{ marginBottom: "1rem" }}>
      <div className="panel-body">
        <div className="form-row">
          <span className="panel-label">Tapes</span>
          {!props.tapes ? (
            <Working label="Loading tapes" />
          ) : (
            <ul style={{ listStyle: "none", paddingLeft: 0 }}>
              {props.tapes.map((tape) => {
                const problem = a2aTapeProblem(tape);
                return (
                  <li key={tape.id}>
                    <label title={problem ? `Can't be used over A2A: it ${problem}` : undefined}>
                      <input
                        type="checkbox"
                        checked={props.chosenTapes.includes(tape.id)}
                        disabled={!!problem}
                        onChange={() => props.onToggleTape(tape.id)}
                      />{" "}
                      {tape.name} <code>{tape.id}</code>
                      {problem && <span className="session-meta"> ({problem})</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="session-meta">
            The first tape you tick is the default. Tapes with admin tools, Agent Engine, automatic memory or merging can't be used.
          </p>
        </div>
        <div className="form-row">
          <span className="panel-label">Repositories</span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              value={props.repoInput}
              onChange={(e) => props.onRepoInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  props.onAddRepo();
                }
              }}
              placeholder="owner/name"
              aria-label="Repository"
              aria-invalid={!!props.repoError}
            />
            <button type="button" className="btn" onClick={props.onAddRepo}>
              Add
            </button>
          </div>
          {props.repoError && <SyntaxError>{props.repoError}</SyntaxError>}
          {props.repos.length === 0 ? (
            <p className="session-meta">None: its tasks run without a repository.</p>
          ) : (
            <ul style={{ listStyle: "none", paddingLeft: 0 }}>
              {props.repos.map((repo) => (
                <li key={repo}>
                  <code>{repo}</code>{" "}
                  <button type="button" className="btn" onClick={() => props.onRemoveRepo(repo)} aria-label={`Remove ${repo}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>
            Tasks at once{" "}
            <input
              type="number"
              min={1}
              max={10}
              value={props.maxConcurrent}
              onChange={(e) => props.onMaxConcurrent(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            />
          </label>
        </div>
      </div>
    </fieldset>
  );
}
