import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type Guru, type SessionSummary } from "../api/client.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { runStateNote } from "../lib/retro-errors.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";
import { Working } from "../components/Working.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { FormatFloppyDialog } from "../components/FormatFloppyDialog.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { floppyActions, floppyTitle, vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

const RUN_STATES = ["queued", "provisioning", "running", "idle", "stopping", "stopped", "failed"];

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function FleetPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gurus, setGurus] = useState<Guru[]>([]);
  // The desk's Trash icon deep-links here as /fleet?runState=stopped -- honour it as the initial
  // filter (still a plain client-side filter change afterward, same as the dropdown).
  const [runStateFilter, setRunStateFilter] = useState(() => searchParams.get("runState") ?? "");
  const [guruFilter, setGuruFilter] = useState("");
  // #209: the Disk Box shows floppies in use; the Archive is a second view of the same table. Held
  // in the URL (?archived=only), so the nav link, Back, reload and a format's redirect all agree.
  const showArchived = searchParams.get("archived") === "only";
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [formatting, setFormatting] = useState<SessionSummary | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewSession, setShowNewSession] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [sessionList, guruList] = await Promise.all([
        // Code review M1 (docs/reports/code-review-pr15.md): this dropdown offers run states
        // (queued/running/idle/...), which is `runState`, not `status` (open/closed) -- the two
        // were being conflated, so the filter never matched anything.
        api.sessions({
          runState: runStateFilter || undefined,
          guru: guruFilter || undefined,
          archived: showArchived ? "only" : undefined,
        }),
        api.gurus(),
      ]);
      setSessions(sessionList);
      setGurus(guruList);
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to load fleet"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStateFilter, guruFilter, showArchived]);

  /** Archive or Restore one row, then reload: either way it leaves the current view. */
  async function shelve(session: SessionSummary, action: "archive" | "restore") {
    setBusyIds((ids) => new Set(ids).add(session.id));
    try {
      await withFloppySound(action === "archive" ? api.archiveSession(session.id) : api.restoreSession(session.id));
      await load();
    } catch (err) {
      setApiError(toApiErrorState(err, `Failed to ${action} floppy`));
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(session.id);
        return next;
      });
    }
  }

  const guruName = (id: string) => gurus.find((g) => g.id === id)?.name ?? id;

  return (
    <div>
      <div className="page-heading">
        <h2>{showArchived ? vocabulary.archive.one : vocabulary.sessionList.one}</h2>
        <p className="page-subtitle">{vocabSubtitle(showArchived ? "archive" : "sessionList")}</p>
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
        <select
          value={showArchived ? "archived" : "active"}
          onChange={(e) => {
            const next = new URLSearchParams(searchParams);
            if (e.target.value === "archived") next.set("archived", "only");
            else next.delete("archived");
            setSearchParams(next);
          }}
          aria-label="Show floppies"
          title={showArchived ? vocabulary.archive.hint : undefined}
        >
          <option value="active">{vocabulary.sessionList.one}</option>
          <option value="archived">{vocabulary.archive.one}</option>
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

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}

      {loading ? (
        <p className="empty-state"><Working label="Loading" size="lg" srOnly={false} /></p>
      ) : sessions.length === 0 && (runStateFilter || guruFilter) ? (
        <div className="empty-state">
          <p>No floppies match these filters.</p>
        </div>
      ) : sessions.length === 0 && showArchived ? (
        <div className="empty-state">
          <p>The {vocabulary.archive.one} is empty. Archive a floppy to put it away here.</p>
        </div>
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
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              // A refused run (api agentlink.ts's refuse()) reads as a bare "failed" pill otherwise
              // -- its reason was only ever on the session page. No role="alert": these rows are a
              // list being read, not something that just happened.
              const note = runStateNote(s.runStateReason);
              return (
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
                  {note && <span className="pill-reason">{note}</span>}
                </td>
                <td data-label="Tape">{guruName(s.guru)}</td>
                <td data-label="Repo / branch">{s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : "—"}</td>
                <td data-label="Cost">{formatCost(s.cost)}</td>
                <td data-label="Last activity">{relativeTime(s.updatedAt)}</td>
                <td data-label="" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {s.canManage && (
                    <div className="toolbar row-actions" style={{ margin: 0 }}>
                      {busyIds.has(s.id) ? (
                        <Working label={s.archivedAt ? "Restoring" : "Archiving"} />
                      ) : s.archivedAt ? (
                        <>
                          <button type="button" onClick={() => shelve(s, "restore")} title={floppyActions.restore.hint}>
                            {floppyActions.restore.word}
                          </button>
                          <button type="button" className="btn-danger" onClick={() => setFormatting(s)} title={floppyActions.format.hint}>
                            {floppyActions.format.word}…
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => shelve(s, "archive")} title={floppyActions.archive.hint}>
                          {floppyActions.archive.word}
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {formatting && (
        <FormatFloppyDialog
          sessionId={formatting.id}
          title={floppyTitle(formatting)}
          onCancel={() => setFormatting(null)}
          onError={(error) => {
            setFormatting(null);
            setApiError(error);
          }}
          onFormatted={() => {
            setFormatting(null);
            load();
          }}
        />
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
