import { useEffect, useState } from "react";
import { connectionsApi, type Connection, type ConnectionsResponse } from "../api/connections.ts";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { Working } from "../components/Working.tsx";
import { toApiErrorState } from "../lib/api-error.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

const STATE_LABEL: Record<Connection["state"], { text: string; pill: string }> = {
  connected: { text: "Connected", pill: "up" },
  reconnect_required: { text: "Reconnect needed", pill: "down" },
  not_connected: { text: "Not connected", pill: "idle" },
};

/** MO-5 (#487, docs/specs/mcp-connections.md §4): the router's OAuth MCP servers and this person's
 * grant for each. Connect and Reconnect open the router's own connect page in a new tab (the router
 * runs the OAuth dance and keeps the tokens); Disconnect goes through the api. */
export function ConnectionsPage() {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await connectionsApi.list());
    } catch (err) {
      setApiError(toApiErrorState(err, `Failed to load ${vocabulary.connection.many.toLowerCase()}`));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function disconnect(c: Connection) {
    if (!confirm(`Disconnect ${c.label}? Your Drives and Kernal lose its tools until you connect it again.`)) return;
    setDisconnecting(c.name);
    try {
      await connectionsApi.disconnect(c.name);
      await load();
    } catch (err) {
      setApiError(toApiErrorState(err, `Failed to disconnect ${c.label}`));
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.connection.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("connection")}</p>
      </div>
      <p className="session-meta">
        Connecting opens the router in a new tab. Come back and press Refresh when you're done.{" "}
        <button type="button" className="btn btn-small" onClick={load} disabled={loading}>Refresh</button>
      </p>

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}

      {loading && !data ? (
        <p className="empty-state"><Working label="Loading" size="lg" srOnly={false} /></p>
      ) : !data || data.connections.length === 0 ? (
        <p className="empty-state">No {vocabulary.connection.many.toLowerCase()} available.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table stack">
            <thead>
              <tr>
                <th>Server</th>
                <th>State</th>
                <th>Since</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((c) => {
                const state = STATE_LABEL[c.state];
                const since = c.state === "reconnect_required" ? c.reconnectRequiredAt : c.connectedAt;
                return (
                  <tr key={c.name}>
                    <td data-label="Server">{c.label}</td>
                    <td data-label="State">
                      <span className={`pill ${state.pill}`}>{state.text}</span>
                    </td>
                    <td data-label="Since">
                      {since ? <span title={new Date(since).toLocaleString()}>{relativeTime(since)}</span> : "—"}
                    </td>
                    <td data-label="">
                      {c.state !== "connected" && (
                        <a className="btn" href={data.connectUrl} target="_blank" rel="noopener noreferrer">
                          {c.state === "reconnect_required" ? "Reconnect" : "Connect"}
                        </a>
                      )}{" "}
                      {c.state !== "not_connected" && (
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={disconnecting === c.name}
                          onClick={() => disconnect(c)}
                          aria-label={`Disconnect ${c.label}`}
                        >
                          {disconnecting === c.name ? <Working label="Disconnecting" /> : "Disconnect"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
