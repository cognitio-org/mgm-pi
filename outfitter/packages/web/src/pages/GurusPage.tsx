import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Guru, type GuruMeta, type ModelRow } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { GuruForm } from "../components/GuruForm.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

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
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  const [editing, setEditing] = useState<Guru | "new" | null>(null);
  const [sessionFor, setSessionFor] = useState<Guru | null>(null);
  const [isSysop, setIsSysop] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [guruList, modelList, guruMeta, me] = await Promise.all([api.gurus(), api.models(), api.guruMeta(), api.me().catch((err) => {
        console.warn("GET /api/me failed; treating this person as not a sysop", err);
        return null;
      })]);
      setIsSysop(me?.operator === true);
      setGurus(guruList);
      setModels(modelList);
      setMeta(guruMeta);
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to load gurus"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(guru: Guru) {
    if (!confirm(`Delete guru "${guru.name}"?`)) return;
    try {
      await api.deleteGuru(guru.id);
      await load();
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to delete guru"));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <div className="page-heading" style={{ marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>{vocabulary.guru.many}</h2>
          <p className="page-subtitle">{vocabSubtitle("guru")}</p>
        </div>
        <button style={{ marginLeft: "auto" }} onClick={() => setEditing("new")}>
          New {vocabulary.guru.one}
        </button>
      </div>

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}

      {loading ? (
        <p className="empty-state">Loading...</p>
      ) : gurus.length === 0 ? (
        <p className="empty-state">No {vocabulary.guru.many.toLowerCase()} yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table stack">
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
                <td data-label="Name">{g.name}</td>
                <td className="mono" data-label="Model">{g.model}</td>
                <td data-label="Thinking">{g.thinking ?? "—"}</td>
                <td data-label="Updated">{new Date(g.updatedAt).toLocaleString()}</td>
                <td data-label="">
                  <div className="toolbar row-actions" style={{ margin: 0 }}>
                    <button type="button" onClick={() => setSessionFor(g)} title={vocabulary.newSession.hint}>
                      {vocabulary.newSession.one}
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
        </div>
      )}

      {editing && (
        <GuruForm
          guru={editing === "new" ? undefined : editing}
          models={models}
          meta={meta}
          isSysop={isSysop}
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
