import { useState } from "react";
import { localHostsApi, type LocalHostView } from "../../api/local-hosts.ts";
import { accountErrorText } from "../../lib/account.ts";
import { hostStatusClass, hostStatusLabel } from "../../lib/local-hosts.ts";

interface Props {
  hosts: LocalHostView[];
  /** When false, only the viewer's own hosts get a Remove button. */
  operator: boolean;
  onRemoved: () => void;
}

/** Compact remove rows for Account and the Control Panel. Not the Modems catalogue:
 * name, owner, status, and DELETE. */
export function HostRemoveList({ hosts, operator, onRemoved }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = hosts.filter((h) => operator || h.owner.mine);
  if (rows.length === 0) return null;

  async function remove(h: LocalHostView) {
    const whose = h.owner.mine ? "your" : `${h.owner.email}'s`;
    if (!confirm(`Remove ${whose} host ${h.hostName}? The router stops offering its models. If that computer is still sharing, its next heartbeat brings it back.`)) return;
    setBusy(h.id);
    setError(null);
    try {
      await localHostsApi.remove(h.id);
      onRemoved();
    } catch (err) {
      setError(accountErrorText(err, "Couldn't remove that host"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="table-scroll">
        <table className="data-table stack">
          <thead>
            <tr>
              <th>Host</th>
              <th>Owner</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id}>
                <td data-label="Host">{h.hostName}</td>
                <td data-label="Owner">{h.owner.mine ? "you" : h.owner.email}</td>
                <td data-label="Status">
                  <span className={`status-pill ${hostStatusClass(h.status)}`}>{hostStatusLabel(h.status)}</span>
                </td>
                <td data-label="">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy === h.id}
                    onClick={() => remove(h)}
                    aria-label={`Remove ${h.hostName}`}
                  >
                    {busy === h.id ? "Removing…" : "Remove"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p className="syntax-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
