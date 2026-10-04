import { useEffect, useState } from "react";
import { accountApi, type ProviderKeyRow } from "../../api/account.ts";
import { accountErrorText, PROVIDERS, providerKeyProblem } from "../../lib/account.ts";
import { SyntaxError } from "../SyntaxError.tsx";
import { Working } from "../Working.tsx";

/** #389 CA-7 (§4, §7): personal provider keys, write-only. The page only ever shows a key's last
 * four characters and when it was set; a typed value goes to the api once and the field clears. */
export function ProviderKeysPanel() {
  const [rows, setRows] = useState<ProviderKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await accountApi.providerKeys());
    } catch (err) {
      setError(accountErrorText(err, "Couldn't load your keys"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <p className="session-meta">
        Your own keys for providers the router doesn't cover. Kernal receives them when it starts on a signed-in
        device and keeps them in memory only. Nobody, you included, can read a key back here.
      </p>
      {error && <p className="syntax-error" role="alert">{error}</p>}
      {!rows ? (
        <p className="empty-state"><Working label="Loading" srOnly={false} /></p>
      ) : (
        <div className="table-scroll">
          <table className="data-table stack">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Key</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((p) => (
                <ProviderKeyRowView
                  key={p.id}
                  provider={p}
                  row={rows.find((r) => r.provider === p.id)}
                  onChanged={load}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProviderKeyRowView({
  provider,
  row,
  onChanged,
  onError,
}: {
  provider: (typeof PROVIDERS)[number];
  row: ProviderKeyRow | undefined;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = providerKeyProblem(value);

  function close() {
    setEditing(false);
    setValue("");
    setAttempted(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (problem) return;
    setBusy(true);
    onError(null);
    try {
      await accountApi.setProviderKey(provider.id, value);
      close();
      await onChanged();
    } catch (err) {
      onError(accountErrorText(err, `Couldn't save the ${provider.label} key`));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove your ${provider.label} key?`)) return;
    setBusy(true);
    onError(null);
    try {
      await accountApi.deleteProviderKey(provider.id);
      await onChanged();
    } catch (err) {
      onError(accountErrorText(err, `Couldn't remove the ${provider.label} key`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td data-label="Provider">
        {provider.label}
        <div className="session-meta">
          <code>{provider.env}</code>
        </div>
      </td>
      <td data-label="Key">
        {row ? (
          <>
            <code className="masked">…{row.last4}</code>{" "}
            <span className="session-meta">set {new Date(row.setAt).toLocaleDateString()}</span>
          </>
        ) : (
          <span className="session-meta">not set</span>
        )}
      </td>
      <td data-label="">
        {editing ? (
          <form onSubmit={save} style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="password"
              // Not a sign-in form: keep browser and extension password managers from offering to
              // save the key (Chromium and Safari ignore "off" on a password field).
              autoComplete="new-password"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={`${provider.label} key`}
              aria-invalid={attempted && !!problem}
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Working label="Saving" /> : "Save"}
            </button>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            {attempted && problem && <SyntaxError>{problem}</SyntaxError>}
          </form>
        ) : (
          <span style={{ display: "inline-flex", gap: "0.4rem" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              {row ? "Replace" : "Set"}
            </button>
            {row && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
                Remove
              </button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
