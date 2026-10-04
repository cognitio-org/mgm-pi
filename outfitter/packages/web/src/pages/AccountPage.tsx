import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.ts";
import { accountApi, type ConfigResponse, type SettingDecl, type SettingsDocView, type SettingValue } from "../api/account.ts";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { Working } from "../components/Working.tsx";
import { SettingsEditor } from "../components/account/SettingsEditor.tsx";
import { ProfilesPanel } from "../components/account/ProfilesPanel.tsx";
import { ProviderKeysPanel } from "../components/account/ProviderKeysPanel.tsx";
import { LocalModelsPanel } from "../components/account/LocalModelsPanel.tsx";
import { SpendPanel } from "../components/account/SpendPanel.tsx";
import { toApiErrorState } from "../lib/api-error.ts";
import { editableDecls, formatValue, LOCKED_TEXT, SHARE_MODELS_KEY, sourceLabel } from "../lib/account.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

/** #389 CA-7 (docs/specs/central-auth.md §7): account settings: account-wide values, profiles,
 * the values the fleet sets, personal provider keys, local model sharing and spend. Every editor
 * is generated from GET /api/config/schema; GET /api/config says what is in effect and why. */
export function AccountPage() {
  const [schema, setSchema] = useState<SettingDecl[] | null>(null);
  const [userDoc, setUserDoc] = useState<SettingsDocView | null>(null);
  const [effective, setEffective] = useState<ConfigResponse | null>(null);
  const [operator, setOperator] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  async function load() {
    setApiError(null);
    try {
      const [s, doc, config, me] = await Promise.all([
        accountApi.schema(),
        accountApi.userDoc(),
        accountApi.config(),
        api.me().catch(() => ({ operator: false })),
      ]);
      setSchema(s.settings);
      setUserDoc(doc);
      setEffective(config);
      setOperator(!!me.operator);
    } catch (err) {
      setApiError(toApiErrorState(err, `Failed to load your ${vocabulary.account.one.toLowerCase()}`));
    }
  }

  /** The effective values may move after any write (a default profile, an account-wide value). */
  async function reloadEffective() {
    try {
      setEffective(await accountApi.config());
    } catch {
      // keep the last answer; the editors still show their own values
    }
  }

  async function reloadUser() {
    try {
      const [doc] = await Promise.all([accountApi.userDoc(), reloadEffective()]);
      setUserDoc(doc);
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to reload"));
    }
  }

  async function saveUser(values: Record<string, SettingValue | null>, version: number) {
    const doc = await accountApi.putUserDoc(values, version);
    setUserDoc(doc);
    await reloadEffective();
    return doc;
  }

  useEffect(() => {
    load();
  }, []);

  // The share toggle has its own panel, so the account-wide editor leaves it out.
  const userDecls = useMemo(() => (schema ? editableDecls(schema, "user").filter((d) => d.key !== SHARE_MODELS_KEY) : []), [schema]);
  const profileDecls = useMemo(() => (schema ? editableDecls(schema, "profile") : []), [schema]);
  // Keys only the fleet may set (the router key limits, for one) are listed at their default too:
  // nobody below the fleet can change them, so the default is the fleet's value.
  const fleetOnly = (key: string) => {
    const decl = schema?.find((d) => d.key === key);
    return !!decl && decl.levels.length > 0 && decl.levels.every((l) => l === "fleet" || l === "group");
  };
  const fleetValues = useMemo(
    () =>
      effective
        ? Object.entries(effective.values).filter(([key, v]) => v.source === "fleet" || v.source === "group" || (v.source === "default" && fleetOnly(key)))
        : [],
    [effective, schema],
  );
  const describe = (key: string) => schema?.find((d) => d.key === key)?.description;

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.account.one}</h2>
        <p className="page-subtitle">{vocabSubtitle("account", "one")}</p>
      </div>

      {apiError && <SystemErrorDialog error={apiError} onRestart={load} onResume={() => setApiError(null)} />}

      {!schema || !userDoc ? (
        <p className="empty-state"><Working label="Loading" size="lg" srOnly={false} /></p>
      ) : (
        <>
          <p className="session-meta">
            Signed in as <strong>{effective?.account.email}</strong>. Run <code>kernal login</code> on a computer to use
            these settings there; <code>kernal --profile &lt;name&gt;</code> picks a {vocabulary.profile.one.toLowerCase()}.
            A value set on a computer itself still wins over these, unless your {vocabulary.operator.one} locked it.
          </p>

          <section className="account-section" aria-labelledby="account-wide">
            <h3 id="account-wide">Account-wide settings</h3>
            <p className="session-meta">Used everywhere you're signed in, unless a {vocabulary.profile.one.toLowerCase()} sets its own.</p>
            <SettingsEditor
              label="Account-wide settings"
              decls={userDecls}
              doc={userDoc}
              effective={effective}
              onSave={saveUser}
              onReload={reloadUser}
            />
          </section>

          <section className="account-section" aria-labelledby="account-profiles">
            <h3 id="account-profiles">{vocabulary.profile.many}</h3>
            <p className="session-meta">{vocabulary.profile.hint}. The default one applies when no profile is named.</p>
            <ProfilesPanel decls={profileDecls} onChanged={reloadEffective} />
          </section>

          <section className="account-section" aria-labelledby="account-fleet">
            <h3 id="account-fleet">From the fleet</h3>
            {fleetValues.length === 0 ? (
              <p className="session-meta">Your {vocabulary.operator.one} sets nothing that applies to you right now.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table stack" aria-label="Fleet values">
                  <thead>
                    <tr>
                      <th>Setting</th>
                      <th>Value</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {fleetValues.map(([key, v]) => (
                      <tr key={key}>
                        <td data-label="Setting">
                          <code>{key}</code>
                          {describe(key) && <div className="session-meta">{describe(key)}</div>}
                        </td>
                        <td data-label="Value">
                          {formatValue(v.value)}{" "}
                          <span className="pill account-source" data-source={v.source}>
                            {sourceLabel(v)}
                          </span>
                        </td>
                        <td data-label="" className="session-meta">
                          {v.locked || fleetOnly(key) ? LOCKED_TEXT : "a default: you can set your own"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="account-section" aria-labelledby="account-keys">
            <h3 id="account-keys">Personal keys</h3>
            <ProviderKeysPanel />
          </section>

          <section className="account-section" aria-labelledby="account-local">
            <h3 id="account-local">Local models</h3>
            <LocalModelsPanel doc={userDoc} effective={effective} onSave={saveUser} onReload={reloadUser} />
          </section>

          <section className="account-section" aria-labelledby="account-spend">
            <h3 id="account-spend">Spend</h3>
            <SpendPanel operator={operator} />
          </section>
        </>
      )}
    </div>
  );
}
