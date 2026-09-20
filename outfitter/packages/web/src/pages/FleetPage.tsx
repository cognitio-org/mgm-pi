import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Guru, type SessionSummary, ApiError } from "../api/client.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";

const RUN_STATES = ["queued", "provisioning", "running", "idle", "stopping", "stopped", "failed"];

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function FleetPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gurus, setGurus] = useState<Guru[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [guruFilter, setGuruFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewSession, setShowNewSession] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sessionList, guruList] = await Promise.all([
        api.sessions({ status: statusFilter || undefined, guru: guruFilter || undefined }),
        api.gurus(),
      ]);
      setSessions(sessionList);
      setGurus(guruList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load fleet");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, guruFilter]);

  const guruName = (id: string) => gurus.find((g) => g.id === id)?.name ?? id;

  return (
    <div>
      <div className="toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by run state">
          <option value="">All statuses</option>
          {RUN_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={guruFilter} onChange={(e) => setGuruFilter(e.target.value)} aria-label="Filter by guru">
          <option value="">All gurus</option>
          {gurus.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button style={{ marginLeft: "auto" }} onClick={() => setShowNewSession(true)}>
          New session
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p className="empty-state">Loading...</p>
      ) : sessions.length === 0 ? (
        <p className="empty-state">No sessions yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Guru</th>
              <th>Repo / branch</th>
              <th>Cost</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} onClick={() => navigate(`/sessions/${s.id}`)} style={{ cursor: "pointer" }}>
                <td>{s.name ?? s.id.slice(0, 8)}</td>
                <td>
                  <StatusPill state={s.runState} />
                </td>
                <td>{guruName(s.guru)}</td>
                <td>{s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : "—"}</td>
                <td>{formatCost(s.cost)}</td>
                <td>{relativeTime(s.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNewSession && (
        <NewSessionDialog
          gurus={gurus}
          onClose={() => setShowNewSession(false)}
          onCreated={(id) => {
            setShowNewSession(false);
            navigate(`/sessions/${id}`);
          }}
        />
      )}
    </div>
  );
}
