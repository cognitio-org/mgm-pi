import { useEffect, useState } from "react";
import { api, type TokenRecord, ApiError } from "../api/client.ts";

function envLines(linkOrigin: string, token: string): string {
  const api = linkOrigin || "<ask your operator for the link URL>";
  return [`export OUTFITTER_API=${api}`, `export OUTFITTER_TOKEN=${token}`, "export MGM_TELEPORT_STORE=outfitter"].join(
    "\n",
  );
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {
    // clipboard unavailable (no permission, non-secure context) -- nothing more we can do here.
  });
}

export function TokensPage() {
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [linkOrigin, setLinkOrigin] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ token: string; record: TokenRecord } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [list, me] = await Promise.all([api.listTokens(), api.me()]);
      setTokens(list);
      setLinkOrigin(me.linkOrigin ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api.createToken(name.trim());
      setJustCreated(result);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.revokeToken(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke token");
    }
  }

  return (
    <div>
      <h2>Personal API tokens</h2>
      <p className="session-meta">
        Used by <code>mgm --teleport</code> (and <code>/teleport</code>) to talk to the Outfitter link service from
        your laptop. Each token acts as you; revoke it if it leaks.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {justCreated && (
        <div className="dialog" style={{ maxWidth: "none", marginBottom: "1rem" }}>
          <h3>"{justCreated.record.name}" created</h3>
          <p>Copy this token now — it will not be shown again.</p>
          <div className="form-row">
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <code style={{ wordBreak: "break-all" }}>{justCreated.token}</code>
              <button type="button" onClick={() => copyToClipboard(justCreated.token)}>
                Copy token
              </button>
            </div>
          </div>
          <p>Set these in your shell:</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{envLines(linkOrigin, justCreated.token)}</pre>
          {!linkOrigin && (
            <p className="session-meta">
              This deployment hasn't set OUTFITTER_LINK_ORIGIN yet — ask your operator for the link URL.
            </p>
          )}
          <div className="form-actions">
            <button type="button" onClick={() => copyToClipboard(envLines(linkOrigin, justCreated.token))}>
              Copy env lines
            </button>
            <button type="button" onClick={() => setJustCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <form onSubmit={createToken} className="toolbar">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="laptop"
          aria-label="Token name"
        />
        <button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating..." : "Create token"}
        </button>
      </form>

      {loading ? (
        <p className="empty-state">Loading...</p>
      ) : tokens.length === 0 ? (
        <p className="empty-state">No tokens yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.prefix}…</code>
                </td>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}</td>
                <td>
                  <button type="button" onClick={() => revoke(t.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
