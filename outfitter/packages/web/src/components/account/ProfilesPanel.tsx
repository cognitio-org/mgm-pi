import { useEffect, useState } from "react";
import { accountApi, type ConfigResponse, type SettingDecl, type SettingsDocView } from "../../api/account.ts";
import { accountErrorText, isStaleWrite, PROFILE_NAME_RE } from "../../lib/account.ts";
import { vocabulary } from "../../lib/vocabulary.ts";
import { SyntaxError } from "../SyntaxError.tsx";
import { Working } from "../Working.tsx";
import { SettingsEditor } from "./SettingsEditor.tsx";

const NAME_RULE = "lowercase letters, digits and dashes, starting with a letter or digit, at most 32";

/** #389 CA-7 (§7): the person's profiles: list, create (optionally copying one), rename, make
 * default, delete, and each profile's own values in the schema editor. `onChanged` tells the page
 * when the default (and so the account-wide effective values) may have moved. */
export function ProfilesPanel({ decls, onChanged }: { decls: SettingDecl[]; onChanged: () => void }) {
  const [profiles, setProfiles] = useState<SettingsDocView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [effective, setEffective] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [createAttempted, setCreateAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);

  async function load(keep?: string | null) {
    try {
      const list = await accountApi.profiles();
      setProfiles(list);
      const want = keep !== undefined ? keep : selected;
      setSelected(want && list.some((p) => p.name === want) ? want : (list.find((p) => p.isDefault)?.name ?? list[0]?.name ?? null));
    } catch (err) {
      setError(accountErrorText(err, `Couldn't load ${vocabulary.profile.many.toLowerCase()}`));
    }
  }

  useEffect(() => {
    load();
  }, []);

  // The effective values for the profile being edited.
  useEffect(() => {
    if (!selected) {
      setEffective(null);
      return;
    }
    let cancelled = false;
    accountApi
      .config(selected)
      .then((c) => !cancelled && setEffective(c))
      .catch(() => !cancelled && setEffective(null));
    return () => {
      cancelled = true;
    };
  }, [selected, profiles]);

  /** Runs one change; a 409 reloads the list rather than overwrite, and says so. */
  async function run(action: () => Promise<unknown>, fallback: string, keep?: string | null): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load(keep);
      onChanged();
      return true;
    } catch (err) {
      setError(accountErrorText(err, fallback));
      if (isStaleWrite(err)) await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const nameProblem = !newName.trim()
    ? "name cannot be empty"
    : !PROFILE_NAME_RE.test(newName.trim())
      ? NAME_RULE
      : null;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreateAttempted(true);
    if (nameProblem) return;
    const name = newName.trim();
    const ok = await run(() => accountApi.createProfile(name, copyFrom || undefined), `Couldn't create the ${vocabulary.profile.one.toLowerCase()}`, name);
    if (!ok) return;
    setNewName("");
    setCopyFrom("");
    setCreateAttempted(false);
  }

  async function rename(p: SettingsDocView) {
    if (!renaming || !p.name) return;
    const to = renaming.to.trim();
    if (!PROFILE_NAME_RE.test(to) || to === p.name) return;
    if (await run(() => accountApi.patchProfile(p.name!, { rename: to }, p.version), "Couldn't rename it", to)) setRenaming(null);
  }

  async function remove(p: SettingsDocView) {
    if (!p.name || !confirm(`Delete ${vocabulary.profile.one.toLowerCase()} "${p.name}"?`)) return;
    await run(() => accountApi.deleteProfile(p.name!, p.version), "Couldn't delete it", selected === p.name ? null : selected);
  }

  const current = profiles?.find((p) => p.name === selected) ?? null;

  return (
    <div>
      {error && <p className="syntax-error" role="alert">{error}</p>}
      {!profiles ? (
        <p className="empty-state"><Working label="Loading" srOnly={false} /></p>
      ) : profiles.length === 0 ? (
        <p className="session-meta">
          No {vocabulary.profile.many.toLowerCase()} yet: Kernal uses your account-wide settings. Make one to switch
          sets with <code>kernal --profile &lt;name&gt;</code>.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data-table stack">
            <thead>
              <tr>
                <th>Name</th>
                <th>Values</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} aria-current={p.name === selected ? "true" : undefined}>
                  <td data-label="Name">
                    {renaming && renaming.from === p.name ? (
                      <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                        <input
                          value={renaming.to}
                          onChange={(e) => setRenaming({ from: p.name!, to: e.target.value })}
                          aria-label={`New name for ${p.name}`}
                          aria-invalid={!PROFILE_NAME_RE.test(renaming.to.trim())}
                        />
                        <button type="button" className="btn btn-primary" disabled={busy || !PROFILE_NAME_RE.test(renaming.to.trim())} onClick={() => rename(p)}>
                          Save name
                        </button>
                        <button type="button" className="btn" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <>
                        <code>{p.name}</code> {p.isDefault && <span className="pill">default</span>}
                      </>
                    )}
                  </td>
                  <td data-label="Values">{Object.keys(p.values).length}</td>
                  <td data-label="Updated">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "—"}</td>
                  <td data-label="">
                    <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
                      <button type="button" className="btn" disabled={p.name === selected} onClick={() => setSelected(p.name ?? null)}>
                        Edit
                      </button>
                      {!p.isDefault && (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => run(() => accountApi.patchProfile(p.name!, { isDefault: true }, p.version), "Couldn't make it the default")}
                        >
                          Make default
                        </button>
                      )}
                      <button type="button" className="btn" disabled={busy} onClick={() => setRenaming({ from: p.name!, to: p.name! })}>
                        Rename
                      </button>
                      <button type="button" className="btn btn-danger" disabled={busy} onClick={() => remove(p)}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={create} className="toolbar toolbar-with-error" aria-label={`New ${vocabulary.profile.one.toLowerCase()}`}>
        <div className="form-row" style={{ marginBottom: 0 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="work"
            aria-label={`New ${vocabulary.profile.one.toLowerCase()} name`}
            aria-invalid={createAttempted && !!nameProblem}
          />
          {createAttempted && nameProblem && <SyntaxError>{nameProblem}</SyntaxError>}
        </div>
        {profiles && profiles.length > 0 && (
          <div className="form-row" style={{ marginBottom: 0 }}>
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} aria-label="Copy values from">
              <option value="">start empty</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.name}>
                  copy {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Working label="Working" /> : `Create ${vocabulary.profile.one.toLowerCase()}`}
        </button>
      </form>

      {current && current.name && (
        <>
          <h4>
            {vocabulary.profile.one} <code>{current.name}</code>
          </h4>
          <SettingsEditor
            label={`${vocabulary.profile.one} ${current.name}`}
            decls={decls}
            doc={current}
            effective={effective}
            onSave={async (values, version) => {
              const doc = await accountApi.putProfileDoc(current.name!, values, version);
              setProfiles((list) => list?.map((p) => (p.id === doc.id ? doc : p)) ?? list);
              onChanged();
              return doc;
            }}
            onReload={() => load()}
            profile={current.name}
          />
        </>
      )}
    </div>
  );
}
