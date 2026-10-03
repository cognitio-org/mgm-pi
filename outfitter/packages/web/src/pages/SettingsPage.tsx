import { useEffect, useState } from "react";
import { useAppVersion } from "../hooks/useAppVersion.ts";
import {
  api,
  ApiError,
  type FleetSettings,
  type OperatorSettings,
  type OperatorSecretRow,
  type RevokeTokensResult,
  type TokenOwnerMatch,
} from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { SyntaxError } from "../components/SyntaxError.tsx";
import { Working } from "../components/Working.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";
import { ProjectVoiceSpendView } from "../components/VoiceSpend.tsx";
import { AeAgentsPanel } from "../components/AeAgentsPanel.tsx";

/** One managed secret's row: masked value, when it applies, and the Replace/Test/Disable controls
 * (same "no value in URLs, clear the input after save" care as TokensPage.tsx). `replacing` opens
 * an inline input + Test + Save, closed by default so a masked value is the normal view. */
function SecretRowView({ row, onChanged }: { row: OperatorSecretRow; onChanged: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  function startReplacing() {
    setReplacing(true);
    setValue("");
    setTestResult(null);
    setApiError(null);
  }

  function cancelReplacing() {
    setReplacing(false);
    setValue("");
    setTestResult(null);
  }

  async function testValue(explicitValue?: string) {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testOperatorSecret(row.secretName, explicitValue);
      setTestResult(result);
    } catch (err) {
      setApiError(toApiErrorState(err, "Test failed"));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await api.putOperatorSecret(row.secretName, value);
      setValue(""); // never keep the value around once it's saved
      setReplacing(false);
      setTestResult(null);
      onChanged();
    } catch (err) {
      setApiError(toApiErrorState(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  async function disable() {
    try {
      await api.disableOperatorSecret(row.secretName);
      onChanged();
    } catch (err) {
      setApiError(toApiErrorState(err, "Disable failed"));
    }
  }

  return (
    <tr>
      <td data-label="Secret">
        <div>{row.label}</div>
        <div className="session-meta">{row.purpose}</div>
      </td>
      <td data-label="Value">
        {row.set ? (
          <span className="chip" title="Only the last four characters are ever shown">
            {row.masked ? `set (${row.masked})` : "set"}
          </span>
        ) : (
          <span className="note">Not set</span>
        )}
      </td>
      <td data-label="Applies">{row.appliesAt}</td>
      <td data-label="Updated">{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}</td>
      <td data-label="">
        {!replacing ? (
          <div className="toolbar row-actions">
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
          <div className={testResult.ok ? "note" : "error-banner"} role={testResult.ok ? undefined : "alert"}>
            {testResult.ok ? "Connection OK" : `Failed${testResult.detail ? `: ${testResult.detail}` : ""}`}
          </div>
        )}
        {apiError && <SystemErrorDialog error={apiError} onResume={() => setApiError(null)} />}
      </td>
    </tr>
  );
}

/** Mirrors the API's normalizeOwnerMatch (src/tokens.ts) closely enough to catch typos before the
 * request; the server stays the authority and 400s anything this lets through. */
function ownerMatchFrom(mode: "email" | "domain", raw: string): TokenOwnerMatch | { error: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { error: `${mode} cannot be empty.` };
  if (mode === "email") {
    return /^[^@\s]+@[^@\s]+$/.test(value) ? { email: value } : { error: "email must look like name@example.com." };
  }
  const domain = value.startsWith("@") ? value : `@${value}`;
  return /^@[^@\s]+\.[^@\s]+$/.test(domain) ? { domain } : { error: "domain must look like @example.com." };
}

function describeMatch(match: TokenOwnerMatch): string {
  return "email" in match ? match.email : `everyone at ${match.domain}`;
}

/** Offboarding (deploy/README.md Rollback): removing someone from IAP leaves their dongles working
 * on the public link service, so this revokes every active one for an email or a whole @domain.
 * Two clicks -- the first only asks, since there's no undo. */
function RevokeDonglesPanel() {
  const [mode, setMode] = useState<"email" | "domain">("email");
  const [value, setValue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<TokenOwnerMatch | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [result, setResult] = useState<RevokeTokensResult | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  const parsed = ownerMatchFrom(mode, value);
  const invalid = "error" in parsed ? parsed.error : null;

  function ask(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setResult(null);
    if ("error" in parsed) return;
    setPending(parsed);
  }

  async function confirm() {
    if (!pending) return;
    setRevoking(true);
    try {
      const res = await withFloppySound(api.revokeTokensForOwners(pending));
      setResult(res);
      setPending(null);
      setValue("");
      setAttempted(false);
    } catch (err) {
      setApiError(toApiErrorState(err, "Revoke failed"));
    } finally {
      setRevoking(false);
    }
  }

  const many = vocabulary.token.many.toLowerCase();
  const one = vocabulary.token.one.toLowerCase();

  return (
    <div className="panel">
      <h3 className="panel-title"><span className="panel-label">Revoke {vocabulary.token.many}</span></h3>
      <div className="panel-body">
        <p className="session-meta">
          Removing someone from IAP doesn't stop their {many}: the link service accepts them without IAP. Revoke
          them here too. There is no undo; they can make new ones only if they can still reach this app.
        </p>
        {!pending ? (
          <form onSubmit={ask} className="toolbar">
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as "email" | "domain");
                setAttempted(false);
              }}
              aria-label="Revoke by"
            >
              <option value="email">One email</option>
              <option value="domain">Whole domain</option>
            </select>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={mode === "email" ? "name@example.com" : "@example.com"}
                aria-label={mode === "email" ? "Owner email" : "Owner domain"}
                aria-invalid={attempted && !!invalid}
                autoComplete="off"
              />
              {attempted && invalid && <SyntaxError>{invalid}</SyntaxError>}
            </div>
            <button type="submit" className="btn btn-danger">
              Revoke {many}…
            </button>
          </form>
        ) : (
          <div role="alertdialog" aria-label={`Confirm revoking ${many}`}>
            <p>
              Revoke every active {one} for <strong>{describeMatch(pending)}</strong>? Their teleport stops working at
              once.
            </p>
            <div className="toolbar">
              <button type="button" className="btn btn-danger" onClick={confirm} disabled={revoking}>
                {revoking ? <Working label="Revoking" /> : `Yes, revoke`}
              </button>
              <button type="button" className="btn" onClick={() => setPending(null)} disabled={revoking}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {result && (
          <p className="note" role="status">
            {result.revoked.length === 0
              ? `No active ${many} for ${describeMatch(result.match)}.`
              : `Revoked ${result.revoked.length} ${result.revoked.length === 1 ? one : many} for ${result.owners.join(", ")}.`}
          </p>
        )}
        {apiError && <SystemErrorDialog error={apiError} onResume={() => setApiError(null)} />}
      </div>
    </div>
  );
}

/** Fleet settings' Sentry section (api fleet-settings.ts): one switch for every Kernal laptop, Drive
 * and Outfitter service. The DSN stays stored while Sentry is off, so turning it back on is one
 * click. The rate is edited as a percentage; the API stores the fraction. */
function TelemetryPanel({ fleet, onSaved }: { fleet: FleetSettings; onSaved: (fleet: FleetSettings) => void }) {
  const current = fleet.telemetry.sentry;
  const [enabled, setEnabled] = useState(current.enabled);
  const [dsn, setDsn] = useState(current.dsn ?? "");
  const storedPercent = String(Math.round(current.tracesSampleRate * 1000) / 10);
  const [percent, setPercent] = useState(storedPercent);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  const rate = Number(percent) / 100;
  const rateInvalid = percent.trim() === "" || !Number.isFinite(rate) || rate < 0 || rate > 1 ? "A percentage from 0 to 100" : null;
  const dsnInvalid = enabled && !dsn.trim() ? "A DSN is needed to turn Sentry on" : null;
  const dirty = enabled !== current.enabled || dsn.trim() !== (current.dsn ?? "") || percent.trim() !== storedPercent;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setSaved(false);
    if (rateInvalid || dsnInvalid) return;
    setSaving(true);
    try {
      // An untouched percentage sends the stored rate as it is, not its rounded display.
      const tracesSampleRate = percent.trim() === storedPercent ? current.tracesSampleRate : rate;
      const updated = await withFloppySound(api.putFleetSentry({ enabled, dsn: dsn.trim() || undefined, tracesSampleRate }));
      setSaved(true);
      setAttempted(false);
      // Show what was stored ("5.0" saves as 5), so the form is clean again.
      setPercent(String(Math.round(updated.telemetry.sentry.tracesSampleRate * 1000) / 10));
      setDsn(updated.telemetry.sentry.dsn ?? "");
      onSaved(updated);
    } catch (err) {
      setApiError(toApiErrorState(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel">
      <h3 className="panel-title"><span className="panel-label">Sentry</span></h3>
      <div className="panel-body">
        <p className="session-meta">
          Error reports and a sample of traces from every Kernal laptop with a {vocabulary.token.one.toLowerCase()}, every
          Drive and this app. Off sends nothing anywhere. A change reaches the API within a minute, new runs at
          their start, browsers on their next load and laptops on their next Kernal start. A person can still turn
          it off on their own laptop with <code>/sentry off</code>.
        </p>
        <form onSubmit={save}>
          <div className="form-row">
            <label>
              <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }} /> Send errors and
              traces to Sentry
            </label>
          </div>
          <div className="form-row">
            <label htmlFor="sentry-dsn">DSN</label>
            <input
              id="sentry-dsn"
              className="mono"
              value={dsn}
              onChange={(e) => { setDsn(e.target.value); setSaved(false); }}
              placeholder="https://<key>@<org>.ingest.us.sentry.io/<project id>"
              aria-invalid={attempted && !!dsnInvalid}
              autoComplete="off"
              spellCheck={false}
            />
            {attempted && dsnInvalid && <SyntaxError>{dsnInvalid}</SyntaxError>}
          </div>
          <div className="form-row">
            <label htmlFor="sentry-rate">Traces kept (%)</label>
            <input
              id="sentry-rate"
              inputMode="decimal"
              value={percent}
              onChange={(e) => { setPercent(e.target.value); setSaved(false); }}
              aria-invalid={attempted && !!rateInvalid}
              style={{ maxWidth: "8em" }}
            />
            {attempted && rateInvalid && <SyntaxError>{rateInvalid}</SyntaxError>}
          </div>
          <div className="toolbar">
            <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
              {saving ? <Working label="Saving" /> : "Save"}
            </button>
          </div>
        </form>
        {saved && (
          <p className="note" role="status">
            Saved. Sentry is {enabled ? "on" : "off"} for the fleet.
          </p>
        )}
        {fleet.updatedAt && (
          <p className="session-meta">
            Last changed {new Date(fleet.updatedAt).toLocaleString()}
            {fleet.updatedBy ? ` by ${fleet.updatedBy}` : ""}.
          </p>
        )}
        {apiError && <SystemErrorDialog error={apiError} onResume={() => setApiError(null)} />}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { version } = useAppVersion();
  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [pageError, setPageError] = useState<ApiErrorState | null>(null);

  async function load() {
    setLoading(true);
    setPageError(null);
    try {
      const result = await api.operatorSettings();
      setSettings(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setPageError(toApiErrorState(err, "Failed to load settings"));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) return <p className="empty-state">Loading…</p>;
  if (forbidden) return <p className="empty-state">{vocabulary.operator.one} only.</p>;
  if (pageError) return <SystemErrorDialog error={pageError} onRestart={load} onResume={() => setPageError(null)} />;
  if (!settings) return null;

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.settings.one}</h2>
        <p className="page-subtitle">{vocabSubtitle("settings", "one")} &middot; {vocabulary.operator.one} only</p>
      </div>

      {/* A natural two-column key/value list -- already narrow enough at any width, so it keeps
          its plain <table> rendering rather than the stacked-card pattern (which is for tables
          with a header row of column names, not this shape). */}
      <h3>Deployment</h3>
      <div className="table-scroll">
      <table className="data-table">
        <tbody>
          <tr>
            <td>Release</td>
            <td className="mono">{version?.release ?? "not a tagged release"}</td>
          </tr>
          <tr>
            <td>Commit</td>
            <td className="mono">{version?.commit ?? "unknown (dev)"}</td>
          </tr>
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
      </div>

      <h3>Secrets</h3>
      <div className="table-scroll">
      <table className="data-table stack secrets-table">
        <colgroup>
          <col className="col-secret" />
          <col className="col-value" />
          <col className="col-applies" />
          <col className="col-updated" />
          <col className="col-actions" />
        </colgroup>
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

      <h3>Telemetry</h3>
      <TelemetryPanel fleet={settings.fleetSettings} onSaved={(fleetSettings) => setSettings({ ...settings, fleetSettings })} />

      <h3>Access</h3>
      <RevokeDonglesPanel />

      <h3>Voice spend</h3>
      <ProjectVoiceSpendView />

      <h3 id="agent-engine-agents">Agent Engine agents</h3>
      <AeAgentsPanel />
    </div>
  );
}
