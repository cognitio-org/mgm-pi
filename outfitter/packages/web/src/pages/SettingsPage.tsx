import { useEffect, useState } from "react";
import { api, ApiError, type OperatorSettings, type OperatorSecretRow } from "../api/client.ts";

/** One managed secret's row: masked value, when it applies, and the Replace/Test/Disable controls
 * (same "no value in URLs, clear the input after save" care as TokensPage.tsx). `replacing` opens
 * an inline input + Test + Save, closed by default so a masked value is the normal view. */
function SecretRowView({ row, onChanged }: { row: OperatorSecretRow; onChanged: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startReplacing() {
    setReplacing(true);
    setValue("");
    setTestResult(null);
    setError(null);
  }

  function cancelReplacing() {
    setReplacing(false);
    setValue("");
    setTestResult(null);
  }

  async function testValue(explicitValue?: string) {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.testOperatorSecret(row.secretName, explicitValue);
      setTestResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.putOperatorSecret(row.secretName, value);
      setValue(""); // never keep the value around once it's saved
      setReplacing(false);
      setTestResult(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function disable() {
    setError(null);
    try {
      await api.disableOperatorSecret(row.secretName);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Disable failed");
    }
  }

  return (
    <tr>
      <td>
        <div>{row.label}</div>
        <div className="session-meta">{row.purpose}</div>
      </td>
      <td>
        {row.set ? (
          <span className="chip" title="Only the last four characters are ever shown">
            {row.masked ? `set (${row.masked})` : "set"}
          </span>
        ) : (
          <span className="note">Not set</span>
        )}
      </td>
      <td>{row.appliesAt}</td>
      <td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}</td>
      <td>
        {!replacing ? (
          <div className="toolbar">
            <button type="button" onClick={startReplacing}>
              {row.set ? "Replace" : "Add"}
            </button>
            {row.set && (
              <button type="button" onClick={() => testValue(undefined)} disabled={testing}>
                {testing ? "Testing…" : "Test stored"}
              </button>
            )}
            {row.set && (
              <button type="button" className="danger" onClick={disable}>
                Disable
              </button>
            )}
          </div>
        ) : (
          <div className="form-row">
            <input
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setTestResult(null);
              }}
              placeholder="New value"
              aria-label={`New value for ${row.label}`}
              autoComplete="off"
            />
            <div className="toolbar">
              <button type="button" onClick={() => testValue(value)} disabled={testing || !value.trim()}>
                {testing ? "Testing…" : "Test"}
              </button>
              <button type="button" onClick={save} disabled={saving || !value.trim()}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={cancelReplacing}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {testResult && (
          <div className={testResult.ok ? "note" : "error-banner"}>
            {testResult.ok ? "Connection OK" : `Failed${testResult.detail ? `: ${testResult.detail}` : ""}`}
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
      </td>
    </tr>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.operatorSettings();
      setSettings(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to load settings");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) return <p className="empty-state">Loading…</p>;
  if (forbidden) return <p className="empty-state">Operator role required</p>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!settings) return null;

  return (
    <div>
      <h2>Operator settings</h2>

      <h3>Deployment</h3>
      <table className="data-table">
        <tbody>
          <tr>
            <td>LiteLLM base URL</td>
            <td>{settings.litellmBaseUrl}</td>
          </tr>
          <tr>
            <td>Sandbox provider</td>
            <td>{settings.sandboxProvider}</td>
          </tr>
          <tr>
            <td>Cloud Run job</td>
            <td>{settings.cloudRunJob}</td>
          </tr>
          <tr>
            <td>Laptop tunnel domain</td>
            <td>{settings.tunnelDomain || "—"}</td>
          </tr>
          <tr>
            <td>Operators</td>
            <td>{settings.operators.length > 0 ? settings.operators.join(", ") : "—"}</td>
          </tr>
        </tbody>
      </table>

      <h3>Secrets</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Secret</th>
            <th>Value</th>
            <th>Applies</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {settings.secrets.map((row) => (
            <SecretRowView key={row.secretName} row={row} onChanged={load} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
