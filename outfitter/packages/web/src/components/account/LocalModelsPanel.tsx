import { useState } from "react";
import { Link } from "react-router-dom";
import type { ConfigResponse, SettingsDocView, SettingValue } from "../../api/account.ts";
import { HostRemoveList } from "./HostRemoveList.tsx";
import { useLocalHosts } from "../../hooks/useLocalHosts.ts";
import { accountErrorText, isLocked, isStaleWrite, LOCKED_TEXT, SHARE_MODELS_KEY, sourceLabel } from "../../lib/account.ts";
import { vocabulary } from "../../lib/vocabulary.ts";

interface Props {
  /** The account-wide (user level) document. */
  doc: SettingsDocView;
  effective: ConfigResponse | null;
  /** An operator may remove anyone's host; everyone else only their own. */
  operator?: boolean;
  onSave: (values: Record<string, SettingValue | null>, version: number) => Promise<SettingsDocView>;
  onReload: () => void;
}

/** #389 CA-7 (§7): "share my local models", the account-wide `localHost.shareModels` that the
 * Local Host work (#381/#382) reads. A profile or a device can still override it in its own
 * values. */
export function LocalModelsPanel({ doc, effective, operator = false, onSave, onReload }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const hosts = useLocalHosts();
  const own = doc.values[SHARE_MODELS_KEY];
  const resolved = effective?.values[SHARE_MODELS_KEY];
  const checked = own === true;
  const locked = isLocked(resolved);

  async function toggle() {
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      await onSave({ [SHARE_MODELS_KEY]: !checked }, doc.version);
    } catch (err) {
      if (isStaleWrite(err)) setStale(true);
      else setError(accountErrorText(err, "Couldn't save"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>
        <input type="checkbox" checked={checked} disabled={busy || locked} onChange={toggle} /> Share my local models
      </label>
      <p className="session-meta">
        When on, models you run locally (LM Studio) are offered to others in the fleet through the router while Kernal
        runs on that machine.
        {resolved && resolved.source !== "user" && (
          <>
            {" "}In effect now: <strong>{resolved.value ? "on" : "off"}</strong>, from {sourceLabel(resolved)}.
          </>
        )}
      </p>
      {locked && <p className="session-meta">{LOCKED_TEXT}</p>}
      {stale && (
        <p className="syntax-error" role="alert">
          Changed elsewhere: nothing was saved.{" "}
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
      {error && <p className="syntax-error" role="alert">{error}</p>}
      <p className="session-meta">
        <Link to="/local-models">{vocabulary.modem.many}</Link> shows who is sharing which models, and which are loaded.
        Removing a host takes it off the router. It does not change this switch.
      </p>
      {hosts.error && (
        <p className="syntax-error" role="alert">
          {hosts.error}
        </p>
      )}
      <HostRemoveList hosts={hosts.hosts} operator={operator} onRemoved={hosts.reload} />
    </div>
  );
}
