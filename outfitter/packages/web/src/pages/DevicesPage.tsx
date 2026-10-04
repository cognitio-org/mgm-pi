import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { devicesApi, type DeviceRow } from "../api/devices.ts";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { Working } from "../components/Working.tsx";
import { toApiErrorState } from "../lib/api-error.ts";
import { deviceIp, platformLabel } from "../lib/devices.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

/** #389 CA-1 web (docs/specs/central-auth.md §1.5, §6): the computers where Kernal is signed in
 * with your account, each with Sign out. Replaces the Dongles page in the nav; Dongles still work
 * (and are still made on /tokens) until CA-10 retires them. */
export function DevicesPage() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  async function load() {
    setLoading(true);
    try {
      setDevices(await devicesApi.list());
    } catch (err) {
      setApiError(toApiErrorState(err, `Failed to load ${vocabulary.device.many.toLowerCase()}`));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function signOut(device: DeviceRow) {
    const what = device.kind === "machine" ? `the machine token "${device.name}"` : `Kernal on "${device.name}"`;
    if (!confirm(`Sign out ${what}? It stops working at once and needs kernal login to come back.`)) return;
    setSigningOut(device.id);
    try {
      await devicesApi.revoke(device.id);
      setDevices((current) => current.filter((d) => d.id !== device.id));
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to sign the device out"));
    } finally {
      setSigningOut(null);
    }
  }

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.device.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("device")}</p>
      </div>
      <p className="session-meta">
        Run <code>kernal login</code> on a computer to add it here; you approve it in this browser.
      </p>

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}

      {loading ? (
        <p className="empty-state"><Working label="Loading" size="lg" srOnly={false} /></p>
      ) : devices.length === 0 ? (
        <p className="empty-state">No {vocabulary.device.many.toLowerCase()} signed in yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Platform</th>
              <th>Last seen</th>
              <th>IP</th>
              <th>Router key</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const ip = deviceIp(d);
              return (
                <tr key={d.id}>
                  <td data-label="Name">
                    {d.name}
                    {d.kind === "machine" && <span className="session-meta"> (machine token)</span>}
                  </td>
                  <td data-label="Platform">
                    {platformLabel(d.platform) ?? "—"}
                    {d.kernalVersion && <span className="session-meta"> · {vocabulary.kernal.one} {d.kernalVersion}</span>}
                  </td>
                  <td data-label="Last seen">
                    {d.lastSeenAt ? (
                      <span title={new Date(d.lastSeenAt).toLocaleString()}>{relativeTime(d.lastSeenAt)}</span>
                    ) : (
                      <span title={`signed in ${new Date(d.createdAt).toLocaleString()}`}>not yet</span>
                    )}
                  </td>
                  <td data-label="IP">{ip ? <code>{ip}</code> : "—"}</td>
                  <td data-label="Router key">
                    {d.routerKey ? <span title={d.routerKey.alias}>yes</span> : "no"}
                  </td>
                  <td data-label="">
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={signingOut === d.id}
                      onClick={() => signOut(d)}
                      aria-label={`Sign out ${d.name}`}
                    >
                      {signingOut === d.id ? <Working label="Signing out" /> : "Sign out"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      <section className="panel device-dongles" aria-label={`${vocabulary.token.many} (deprecated)`}>
        <div className="panel-titlebar">
          <span className="panel-label">{vocabulary.token.many} (deprecated)</span>
        </div>
        <div className="panel-body">
          <p>
            A {vocabulary.token.one} is the old pasted <code>OUTFITTER_TOKEN</code>. It still works for now, but{" "}
            <code>kernal login</code> replaces it. A2A keys live there too.
          </p>
          <p>
            <Link to="/tokens" className="btn">Manage {vocabulary.token.many} and A2A keys</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
