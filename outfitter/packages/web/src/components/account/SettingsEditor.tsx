import { useEffect, useRef, useState } from "react";
import { accountApi, type ConfigResponse, type ModelOptions, type SettingDecl, type SettingsDocView, type SettingValue } from "../../api/account.ts";
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
import { choicesFor, isModelSetting, PROVIDER_KEY, PROVIDER_LABELS } from "../../lib/model-choices.ts";
import { SyntaxError } from "../SyntaxError.tsx";
import { ModelField } from "./ModelField.tsx";
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
  /** The profile these values belong to, for the model dropdowns' curated OpenRouter list (#458). */
  profile?: string;
}

/** #389 CA-7 (§7): one level's own values (user or a profile) as a form generated from the schema,
 * beside the effective value and where it comes from. A field left empty inherits. A save sends
 * only the changed keys with If-Match; a 409 says "changed elsewhere" and never overwrites. Values
 * a higher level locks are read-only, "set by your Sysop". */
export function SettingsEditor({ label, decls, doc, effective, onSave, onReload, profile }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => draftsFor(decls, doc));
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [models, setModels] = useState<ModelOptions | null>(null);

  // #458: the model dropdowns' options, when this level has a model-valued key. A failure leaves
  // them as free-text boxes.
  const wantsModels = decls.some((d) => isModelSetting(d.key));
  useEffect(() => {
    if (!wantsModels) return;
    let cancelled = false;
    accountApi
      .modelOptions(profile)
      .then((m) => !cancelled && setModels(m))
      .catch(() => !cancelled && setModels(null));
    return () => {
      cancelled = true;
    };
  }, [wantsModels, profile]);

  // The stored values the drafts were last based on, to tell a person's edits from them.
  const declKeys = decls.map((d) => d.key).join(",");
  const base = useRef({ id: doc.id, declKeys, drafts: draftsFor(decls, doc) });
  useEffect(() => {
    const fresh = draftsFor(decls, doc);
    const prev = base.current;
    base.current = { id: doc.id, declKeys, drafts: fresh };
    if (prev.id !== doc.id || prev.declKeys !== declKeys) {
      // A new document (another profile) starts from its stored values.
      setDrafts(fresh);
      setStale(false);
      setError(null);
      setAttempted(false);
      return;
    }
    // The same document saved somewhere else on the page (the share toggle, a profile action):
    // keys the person changed keep their drafts, the rest follow the new stored values.
    setDrafts((current) =>
      Object.fromEntries(decls.map((d) => [d.key, current[d.key] !== prev.drafts[d.key] ? current[d.key] : fresh[d.key]])),
    );
  }, [doc.id, doc.version, declKeys]);

  /** Starts over from `from`'s stored values: after this editor's own save, Reload or Discard. */
  function resetTo(from: SettingsDocView) {
    const fresh = draftsFor(decls, from);
    base.current = { id: from.id, declKeys, drafts: fresh };
    setDrafts(fresh);
  }

  const { values, problems } = changedValues(decls, doc.values, drafts);
  // The provider model.default's list follows: this form's choice, else the one in effect.
  const provider = drafts[PROVIDER_KEY] || String(effective?.values[PROVIDER_KEY]?.value ?? decls.find((d) => d.key === PROVIDER_KEY)?.default ?? "litellm");
  const dirty = Object.keys(values).length > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setSaved(false);
    if (Object.keys(problems).length > 0 || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      resetTo(await onSave(values, doc.version));
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
              setError(null);
              setAttempted(false);
              resetTo(doc);
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
                    {isModelSetting(decl.key) ? (
                      <ModelField
                        settingKey={decl.key}
                        value={drafts[decl.key] ?? ""}
                        disabled={locked || saving}
                        onChange={(v) => setDraft(decl.key, v)}
                        set={choicesFor(decl.key, provider, models)}
                        placeholder={placeholderFor(decl)}
                      />
                    ) : (
                      <ValueField
                        decl={decl}
                        value={drafts[decl.key] ?? ""}
                        disabled={locked || saving}
                        onChange={(v) => setDraft(decl.key, v)}
                      />
                    )}
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
        <button type="button" className="btn" disabled={saving || !dirty} onClick={() => resetTo(doc)}>
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

function placeholderFor(decl: SettingDecl): string {
  return decl.default !== undefined ? `default: ${formatValue(decl.default)}` : "not set";
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
            {decl.key === PROVIDER_KEY && PROVIDER_LABELS[v] ? `${v}: ${PROVIDER_LABELS[v]}` : v}
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
      placeholder={placeholderFor(decl)}
      onChange={(e) => onChange(e.target.value)}
      aria-label={aria}
    />
  );
}
