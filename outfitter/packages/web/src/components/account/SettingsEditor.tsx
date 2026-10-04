import { useEffect, useState } from "react";
import type { ConfigResponse, SettingDecl, SettingsDocView, SettingValue } from "../../api/account.ts";
import {
  accountErrorText,
  changedValues,
  draftFromValue,
  formatValue,
  isLocked,
  isStaleWrite,
  LOCKED_TEXT,
  sourceLabel,
} from "../../lib/account.ts";
import { SyntaxError } from "../SyntaxError.tsx";
import { Working } from "../Working.tsx";

interface Props {
  /** What this editor is for, for screen readers: "Account-wide settings", "Profile work". */
  label: string;
  /** The keys this level may set (lib/account.ts editableDecls). */
  decls: SettingDecl[];
  doc: SettingsDocView;
  /** GET /api/config for the same profile: the effective value and its source per key. */
  effective: ConfigResponse | null;
  onSave: (values: Record<string, SettingValue | null>, version: number) => Promise<SettingsDocView>;
  /** Fetch the document (and its effective values) again, after a 409 or on request. */
  onReload: () => void;
}

/** #389 CA-7 (§7): one level's own values (user or a profile) as a form generated from the schema,
 * beside the effective value and where it comes from. A field left empty inherits. A save sends
 * only the changed keys with If-Match; a 409 says "changed elsewhere" and never overwrites. Values
 * a higher level locks are read-only, "set by your Sysop". */
export function SettingsEditor({ label, decls, doc, effective, onSave, onReload }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => draftsFor(decls, doc));
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [attempted, setAttempted] = useState(false);

  // A new document (another profile, or a reload after a 409) starts from its stored values.
  const declKeys = decls.map((d) => d.key).join(",");
  useEffect(() => {
    setDrafts(draftsFor(decls, doc));
    setStale(false);
    setError(null);
    setAttempted(false);
  }, [doc.id, doc.version, declKeys]);

  const { values, problems } = changedValues(decls, doc.values, drafts);
  const dirty = Object.keys(values).length > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setSaved(false);
    if (Object.keys(problems).length > 0 || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(values, doc.version);
      setSaved(true);
    } catch (err) {
      if (isStaleWrite(err)) setStale(true);
      else setError(accountErrorText(err, "Couldn't save the settings"));
    } finally {
      setSaving(false);
    }
  }

  function setDraft(key: string, value: string) {
    setSaved(false);
    setDrafts((current) => ({ ...current, [key]: value }));
  }

  return (
    <form onSubmit={save} aria-label={label}>
      {stale && (
        <p className="syntax-error" role="alert">
          Changed elsewhere: these values were edited somewhere else since you opened them. Nothing was saved.{" "}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStale(false);
              onReload();
            }}
          >
            Reload
          </button>
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table stack account-settings">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Set here</th>
              <th>In effect</th>
            </tr>
          </thead>
          <tbody>
            {decls.map((decl) => {
              const resolved = effective?.values[decl.key];
              const locked = isLocked(resolved);
              const problem = attempted ? problems[decl.key] : undefined;
              return (
                <tr key={decl.key}>
                  <td data-label="Setting">
                    <code>{decl.key}</code>
                    <div className="session-meta">{decl.description}</div>
                  </td>
                  <td data-label="Set here">
                    <ValueField
                      decl={decl}
                      value={drafts[decl.key] ?? ""}
                      disabled={locked || saving}
                      onChange={(v) => setDraft(decl.key, v)}
                    />
                    {locked && <div className="session-meta">{LOCKED_TEXT}</div>}
                    {problem && <SyntaxError>{problem}</SyntaxError>}
                  </td>
                  <td data-label="In effect">
                    {resolved ? (
                      <>
                        <span>{formatValue(resolved.value)}</span>{" "}
                        <span className="pill account-source" data-source={resolved.source}>
                          {sourceLabel(resolved)}
                        </span>
                      </>
                    ) : (
                      <span className="session-meta">not set</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="syntax-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving || stale || !dirty}>
          {saving ? <Working label="Saving" /> : "Save"}
        </button>
        <button type="button" className="btn" disabled={saving || !dirty} onClick={() => setDrafts(draftsFor(decls, doc))}>
          Discard changes
        </button>
        {saved && !dirty && <span className="session-meta">Saved.</span>}
      </div>
    </form>
  );
}

function draftsFor(decls: SettingDecl[], doc: SettingsDocView): Record<string, string> {
  return Object.fromEntries(decls.map((d) => [d.key, draftFromValue(doc.values[d.key])]));
}

/** The control for one key's type; "" is always "not set here" (inherit). */
function ValueField({
  decl,
  value,
  disabled,
  onChange,
}: {
  decl: SettingDecl;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const aria = `${decl.key} value`;
  if (decl.type === "boolean") {
    return (
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
        <option value="">not set</option>
        <option value="true">on</option>
        <option value="false">off</option>
      </select>
    );
  }
  if (decl.type === "enum") {
    return (
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
        <option value="">not set</option>
        {(decl.values ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={decl.type === "number" ? "number" : decl.type === "url" ? "url" : "text"}
      min={decl.min}
      max={decl.max}
      step={decl.type === "number" ? "any" : undefined}
      value={value}
      disabled={disabled}
      placeholder={decl.default !== undefined ? `default: ${formatValue(decl.default)}` : "not set"}
      onChange={(e) => onChange(e.target.value)}
      aria-label={aria}
    />
  );
}
