import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type Guru, type SessionSummary, ApiError } from "../api/client.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";
import { Working } from "../components/Working.tsx";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

const RUN_STATES = ["queued", "provisioning", "running", "idle", "stopping", "stopped", "failed"];

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function FleetPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gurus, setGurus] = useState<Guru[]>([]);
  // The desk's Trash icon deep-links here as /fleet?runState=stopped -- honour it as the initial
  // filter (still a plain client-side filter change afterward, same as the dropdown).
  const [runStateFilter, setRunStateFilter] = useState(() => searchParams.get("runState") ?? "");
  const [guruFilter, setGuruFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewSession, setShowNewSession] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sessionList, guruList] = await Promise.all([
        // Code review M1 (docs/reports/code-review-pr15.md): this dropdown offers run states
        // (queued/running/idle/...), which is `runState`, not `status` (open/closed) -- the two
        // were being conflated, so the filter never matched anything.
        api.sessions({ runState: runStateFilter || undefined, guru: guruFilter || undefined }),
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
  }, [runStateFilter, guruFilter]);

  const guruName = (id: string) => gurus.find((g) => g.id === id)?.name ?? id;

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.sessionList.one}</h2>
        <p className="page-subtitle">{vocabSubtitle("sessionList")}</p>
      </div>
      <div className="toolbar">
        <select
          value={runStateFilter}
          onChange={(e) => setRunStateFilter(e.target.value)}
          aria-label="Filter by run state"
        >
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
        <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setShowNewSession(true)} title={vocabulary.newSession.hint}>
          + {vocabulary.newSession.one}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p className="empty-state"><Working label="Loading" size="lg" srOnly={false} /></p>
      ) : sessions.length === 0 ? (
        <div className="empty-state dither">
          <p>No floppies yet. Start one to see it here.</p>
          <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
            + {vocabulary.newSession.one}
          </button>
        </div>
      ) : (
        <div className="table-scroll">
        <table className="data-table stack">
          <thead>
            <tr>
              <th>Floppy</th>
              <th>Status</th>
              <th>Tape</th>
              <th>Repo / branch</th>
              <th>Cost</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.id}
                onClick={() => navigate(`/sessions/${s.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate(`/sessions/${s.id}`);
                }}
                tabIndex={0}
                role="link"
                style={{ cursor: "pointer" }}
              >
                <td data-label="Floppy">{s.name ?? s.id.slice(0, 8)}</td>
                <td data-label="Status">
                  <StatusPill state={s.runState} />
                </td>
                <td data-label="Tape">{guruName(s.guru)}</td>
                <td data-label="Repo / branch">{s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : "—"}</td>
                <td data-label="Cost">{formatCost(s.cost)}</td>
                <td data-label="Last activity">{relativeTime(s.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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
