// Subscriptions page (docs/specs/subscriptions.md §2-§4). One card per vendor. Modes and
// subscriptions.prefer go through the config API; secrets go through the subscription-secret
// routes and are never read back. The device delivery route is not called from the browser.

import { useEffect, useState, type ReactNode } from "react";
import { accountApi, type ConfigResponse, type SettingsDocView, type SubscriptionSecretView } from "../api/account.ts";
import { ApiError } from "../api/client.ts";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { SyntaxError } from "../components/SyntaxError.tsx";
import { Working } from "../components/Working.tsx";
import { accountErrorText, formatValue, isStaleWrite, LOCKED_TEXT, sourceLabel } from "../lib/account.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

const VENDOR_IDS = ["claude", "grok", "codex", "gemini"] as const;
type VendorId = (typeof VENDOR_IDS)[number];
type SubscriptionMode = "off" | "sandboxed" | "full";

const MODES: SubscriptionMode[] = ["off", "sandboxed", "full"];
const PREFER_DEFAULT = "claude,grok,codex,gemini";
const PREFER_PROBLEM = "comma-separated vendor ids: claude, grok, codex, gemini — no spaces or duplicates";

/** Printable ASCII, no whitespace. Claude setup-tokens are one line (subscriptions.md §3). */
const CLAUDE_TOKEN = /^[\x21-\x7e]+$/;
const FILE_MAX_BYTES = 262144;

interface Vendor {
  id: VendorId;
  label: string;
  /** File paste (auth.json / ACP profile) rather than a one-line token. */
  multiline: boolean;
  hint: ReactNode;
  laptopAvailability: string;
  cloudAvailability: string;
}

const VENDORS: readonly Vendor[] = [
  {
    id: "claude",
    label: "Claude",
    multiline: false,
    hint: (
      <>
        A setup-token from <code>claude setup-token</code>, or <code>kernal subscriptions connect claude</code> on a
        signed-in computer.
      </>
    ),
    laptopAvailability: "Ready (one-shot worker)",
    cloudAvailability: "Pending #473 (sandbox container runtime)",
  },
  {
    id: "grok",
    label: "Grok",
    multiline: true,
    hint: (
      <>
        The contents of <code>~/.grok/auth.json</code>.
      </>
    ),
    laptopAvailability: "In progress (secret stored)",
    cloudAvailability: "Planned",
  },
  {
    id: "codex",
    label: "Codex",
    multiline: true,
    hint: (
      <>
        The contents of <code>~/.codex/auth.json</code>.
      </>
    ),
    laptopAvailability: "In progress (secret stored)",
    cloudAvailability: "Planned",
  },
  {
    id: "gemini",
    label: "Antigravity",
    multiline: true,
    hint: <>The ACP profile, stored now and used when that worker lands.</>,
    laptopAvailability: "In progress (secret stored)",
    cloudAvailability: "Planned",
  },
];

function isMode(value: unknown): value is SubscriptionMode {
  return value === "off" || value === "sandboxed" || value === "full";
}

/** The list view only. A response that also carries `value` must not be kept. */
function secretView(row: SubscriptionSecretView): SubscriptionSecretView {
  return { vendor: row.vendor, last4: row.last4, setAt: row.setAt, version: row.version };
}

function shownMode(vendor: VendorId, doc: SettingsDocView, effective: ConfigResponse | null): SubscriptionMode {
  const own = doc.values[`subscriptions.${vendor}`];
  if (isMode(own)) return own;
  const eff = effective?.values[`subscriptions.${vendor}`]?.value;
  if (isMode(eff)) return eff;
  return "off";
}

function shownPrefer(doc: SettingsDocView, effective: ConfigResponse | null): string {
  const own = doc.values["subscriptions.prefer"];
  if (typeof own === "string" && own.length > 0) return own;
  const eff = effective?.values["subscriptions.prefer"]?.value;
  if (typeof eff === "string" && eff.length > 0) return eff;
  return PREFER_DEFAULT;
}

/** §2: comma-separated vendor ids, no spaces, no duplicates. A subset is allowed. Empty is not. */
function preferProblem(raw: string): string | null {
  if (raw.length === 0) return "name at least one of claude, grok, codex, gemini";
  const parts = raw.split(",");
  const allowed = new Set<string>(VENDOR_IDS);
  if (parts.length === 0 || new Set(parts).size !== parts.length || parts.some((part) => !allowed.has(part))) return PREFER_PROBLEM;
  return null;
}

function secretProblem(vendor: VendorId, value: string): string | null {
  if (vendor === "claude") {
    if (value.length < 20) return "a setup-token is at least 20 characters";
    if (value.length > 4096) return "a setup-token is at most 4096 characters";
    if (!CLAUDE_TOKEN.test(value)) return "printable characters only, no spaces";
    return null;
  }
  if (value.length < 1) return "paste the file";
  if (value.includes("\0")) return "the file can't contain a NUL byte";
  if (new TextEncoder().encode(value).byteLength > FILE_MAX_BYTES) return "the file is at most 256 KiB";
  return null;
}

function formatSetAt(setAt: string): string {
  const date = new Date(setAt);
  if (Number.isNaN(date.getTime())) return setAt;
  return date.toLocaleDateString();
}

export function SubscriptionsPage() {
  const [userDoc, setUserDoc] = useState<SettingsDocView | null>(null);
  const [effective, setEffective] = useState<ConfigResponse | null>(null);
  const [secrets, setSecrets] = useState<SubscriptionSecretView[] | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [prefer, setPrefer] = useState(PREFER_DEFAULT);
  const [preferBase, setPreferBase] = useState(PREFER_DEFAULT);
  const [settingsBusy, setSettingsBusy] = useState<null | "prefer" | VendorId>(null);

  async function load() {
    setApiError(null);
    try {
      const [doc, config, rows] = await Promise.all([accountApi.userDoc(), accountApi.config(), accountApi.subscriptionSecrets()]);
      setUserDoc(doc);
      setEffective(config);
      setSecrets(rows.map(secretView));
      const order = shownPrefer(doc, config);
      setPrefer(order);
      setPreferBase(order);
    } catch (err) {
      setApiError(toApiErrorState(err, `Failed to load ${vocabulary.subscription.many.toLowerCase()}`));
    }
  }

  async function reloadEffective() {
    try {
      setEffective(await accountApi.config());
    } catch {
      // keep the last answer; the controls still show the account-wide values
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function refreshUserDoc() {
    try {
      setUserDoc(await accountApi.userDoc());
    } catch {
      // the error text already says to reload
    }
  }

  async function setMode(vendor: VendorId, mode: SubscriptionMode) {
    if (!userDoc || settingsBusy) return;
    if (mode === shownMode(vendor, userDoc, effective)) return;
    setSettingsBusy(vendor);
    setActionError(null);
    try {
      setUserDoc(await accountApi.putUserDoc({ [`subscriptions.${vendor}`]: mode }, userDoc.version));
      await reloadEffective();
    } catch (err) {
      setActionError(accountErrorText(err, `Couldn't save subscriptions.${vendor}`));
      if (isStaleWrite(err)) await refreshUserDoc();
    } finally {
      setSettingsBusy(null);
    }
  }

  async function savePrefer(e: React.FormEvent) {
    e.preventDefault();
    if (!userDoc || settingsBusy) return;
    const problem = preferProblem(prefer);
    if (problem || prefer === preferBase) return;
    setSettingsBusy("prefer");
    setActionError(null);
    try {
      setUserDoc(await accountApi.putUserDoc({ "subscriptions.prefer": prefer }, userDoc.version));
      setPreferBase(prefer);
      await reloadEffective();
    } catch (err) {
      setActionError(accountErrorText(err, "Couldn't save the order"));
      if (isStaleWrite(err)) await refreshUserDoc();
    } finally {
      setSettingsBusy(null);
    }
  }

  async function reloadSecrets() {
    setSecrets((await accountApi.subscriptionSecrets()).map(secretView));
  }

  const preferIssue = preferProblem(prefer);
  const preferResolved = effective?.values["subscriptions.prefer"];

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.subscription.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("subscription")}</p>
      </div>

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}
      {actionError && (
        <p className="syntax-error" role="alert">
          {actionError}
        </p>
      )}

      {!userDoc || !secrets ? (
        <p className="empty-state">
          <Working label="Loading" size="lg" srOnly={false} />
        </p>
      ) : (
        <>
          <p className="session-meta">
            Your Claude, Grok, Codex, and Antigravity logins. Kernal spends them before the metered router. A typed
            secret is sent once. Nobody, you included, can read a secret back here.
          </p>

          {VENDORS.map((vendor) => (
            <SubscriptionCard
              key={vendor.id}
              vendor={vendor}
              row={secrets.find((row) => row.vendor === vendor.id)}
              mode={shownMode(vendor.id, userDoc, effective)}
              locked={!!effective?.values[`subscriptions.${vendor.id}`]?.locked}
              resolved={effective?.values[`subscriptions.${vendor.id}`]}
              busy={settingsBusy !== null}
              onMode={(mode) => setMode(vendor.id, mode)}
              onChanged={reloadSecrets}
              onError={setActionError}
            />
          ))}

          <section className="account-section" aria-labelledby="subscriptions-prefer">
            <h3 id="subscriptions-prefer">Order</h3>
            <p className="session-meta">
              <code>subscriptions.prefer</code> is the order Kernal walks when a plan window is spent. A shorter list
              means only those, in that order.
            </p>
            <form onSubmit={savePrefer} aria-label="Subscription order">
              <div className="form-row">
                <label htmlFor="subscriptions-prefer-value">
                  <code>subscriptions.prefer</code>
                </label>
                <input
                  id="subscriptions-prefer-value"
                  aria-label="subscriptions.prefer"
                  value={prefer}
                  disabled={settingsBusy !== null || !!preferResolved?.locked}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setPrefer(e.target.value)}
                />
                {preferResolved?.locked && <div className="session-meta">{LOCKED_TEXT}</div>}
                {preferIssue && prefer !== preferBase && <SyntaxError>{preferIssue}</SyntaxError>}
                {preferResolved && (
                  <div className="session-meta">
                    in effect: {formatValue(preferResolved.value)}{" "}
                    <span className="pill account-source" data-source={preferResolved.source}>
                      {sourceLabel(preferResolved)}
                    </span>
                  </div>
                )}
              </div>
              <div className="form-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={settingsBusy !== null || prefer === preferBase || !!preferIssue}
                >
                  {settingsBusy === "prefer" ? <Working label="Saving" /> : "Save"}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

function SubscriptionCard({
  vendor,
  row,
  mode,
  locked,
  resolved,
  busy,
  onMode,
  onChanged,
  onError,
}: {
  vendor: Vendor;
  row: SubscriptionSecretView | undefined;
  mode: SubscriptionMode;
  locked: boolean;
  resolved: ConfigResponse["values"][string] | undefined;
  busy: boolean;
  onMode: (mode: SubscriptionMode) => void;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = secretProblem(vendor.id, value);
  const fieldId = `secret-${vendor.id}`;

  function clear() {
    setValue("");
    setAttempted(false);
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (problem || saving) return;
    setSaving(true);
    onError(null);
    try {
      await accountApi.setSubscriptionSecret(vendor.id, value, row?.version);
      clear();
      await onChanged();
    } catch (err) {
      onError(accountErrorText(err, `Couldn't save the ${vendor.label} login`));
      if (err instanceof ApiError && err.status === 409) {
        try {
          await onChanged();
        } catch {
          // the message already says to reload
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${vendor.label}? Kernal stops using this login.`)) return;
    setSaving(true);
    onError(null);
    try {
      await accountApi.deleteSubscriptionSecret(vendor.id);
      clear();
      await onChanged();
    } catch (err) {
      onError(accountErrorText(err, `Couldn't disconnect ${vendor.label}`));
    } finally {
      setSaving(false);
    }
  }

  const ignore = {
    "data-1p-ignore": "",
    "data-lpignore": "true",
    "data-bwignore": "true",
    "data-form-type": "other",
  };

  return (
    <section className="panel account-section" aria-label={vendor.label}>
      <h3 className="panel-title">
        <span className="panel-label">{vendor.label}</span>
      </h3>
      <div className="panel-body">
        <p>
          {row ? (
            <>
              connected <code className="masked">…{row.last4}</code>{" "}
              <span className="session-meta">set {formatSetAt(row.setAt)}</span>
            </>
          ) : (
            <span className="session-meta">not connected</span>
          )}
        </p>

        <div className="subscription-env-status" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", margin: "0.4rem 0" }}>
          <span className="pill session-meta" title="Local laptop support">
            💻 Laptop: {vendor.laptopAvailability}
          </span>
          <span className="pill session-meta" title="Cloud drive support">
            ☁ Cloud Drives: {vendor.cloudAvailability}
          </span>
        </div>

        <div className="form-row">
          <label htmlFor={`subscriptions-${vendor.id}`}>
            Mode <code>subscriptions.{vendor.id}</code>
          </label>
          <select
            id={`subscriptions-${vendor.id}`}
            name={`subscriptions.${vendor.id}`}
            aria-label={`${vendor.label} mode`}
            value={mode}
            disabled={locked || busy || saving}
            onChange={(e) => {
              if (isMode(e.target.value)) onMode(e.target.value);
            }}
          >
            {MODES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          {locked && <div className="session-meta">{LOCKED_TEXT}</div>}
          {resolved && (
            <div className="session-meta">
              in effect: {formatValue(resolved.value)}{" "}
              <span className="pill account-source" data-source={resolved.source}>
                {sourceLabel(resolved)}
              </span>
            </div>
          )}
        </div>

        <form onSubmit={connect}>
          <div className="form-row">
            <label htmlFor={fieldId}>{vendor.hint}</label>
            {vendor.multiline ? (
              <textarea
                id={fieldId}
                aria-label={`${vendor.label} secret`}
                autoComplete="off"
                spellCheck={false}
                value={value}
                disabled={saving}
                onChange={(e) => setValue(e.target.value)}
                {...ignore}
              />
            ) : (
              <input
                id={fieldId}
                type="password"
                aria-label={`${vendor.label} secret`}
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                disabled={saving}
                onChange={(e) => setValue(e.target.value)}
                {...ignore}
              />
            )}
            {attempted && problem && <SyntaxError>{problem}</SyntaxError>}
          </div>
          <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <Working label="Saving" /> : "Connect"}
            </button>
            {row && (
              <button type="button" className="btn btn-danger" disabled={saving} onClick={disconnect}>
                Disconnect
              </button>
            )}
          </span>
        </form>
      </div>
    </section>
  );
}
