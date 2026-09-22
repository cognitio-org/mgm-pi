import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type Guru, type GuruMeta, type ModelRow } from "../api/client.ts";
import { GuruForm } from "../components/GuruForm.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";

/** E3.7: list gurus, create/edit, delete (with the guard the API enforces: no referencing
 * sessions, and the `default` guru is never deletable), and "New session with this guru" which
 * opens the existing NewSessionDialog preselected. Org-shared, same as the fleet -- any signed-in
 * user can create/edit/delete any guru (EPIC.md's "Session visibility" decision applies the same
 * way here: no per-user ownership on gurus either). */
export function GurusPage() {
  const navigate = useNavigate();
  const [gurus, setGurus] = useState<Guru[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [meta, setMeta] = useState<GuruMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Guru | "new" | null>(null);
  const [sessionFor, setSessionFor] = useState<Guru | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [guruList, modelList, guruMeta] = await Promise.all([api.gurus(), api.models(), api.guruMeta()]);
      setGurus(guruList);
      setModels(modelList);
      setMeta(guruMeta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load gurus");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(guru: Guru) {
    if (!confirm(`Delete guru "${guru.name}"?`)) return;
    setError(null);
    try {
      await api.deleteGuru(guru.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete guru");
    }
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Gurus</h2>
        <button style={{ marginLeft: "auto" }} onClick={() => setEditing("new")}>
          New guru
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p className="empty-state">Loading...</p>
      ) : gurus.length === 0 ? (
        <p className="empty-state">No gurus yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Model</th>
              <th>Thinking</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {gurus.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td className="mono">{g.model}</td>
                <td>{g.thinking ?? "—"}</td>
                <td>{new Date(g.updatedAt).toLocaleString()}</td>
                <td>
                  <div className="toolbar" style={{ margin: 0 }}>
                    <button type="button" onClick={() => setSessionFor(g)}>
                      New session
                    </button>
                    <button type="button" onClick={() => setEditing(g)}>
                      Edit
                    </button>
                    <button type="button" onClick={() => remove(g)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <GuruForm
          guru={editing === "new" ? undefined : editing}
          models={models}
          meta={meta}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {sessionFor && (
        <NewSessionDialog
          gurus={gurus}
          initialGuruId={sessionFor.id}
          onClose={() => setSessionFor(null)}
          onCreated={(id) => {
            setSessionFor(null);
            navigate(`/sessions/${id}`);
          }}
        />
      )}
    </div>
  );
}
