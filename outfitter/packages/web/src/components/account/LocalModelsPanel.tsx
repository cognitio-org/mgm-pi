import { useState } from "react";
import type { ConfigResponse, SettingsDocView, SettingValue } from "../../api/account.ts";
import { accountErrorText, isLocked, isStaleWrite, LOCKED_TEXT, SHARE_MODELS_KEY, sourceLabel } from "../../lib/account.ts";

interface Props {
  /** The account-wide (user level) document. */
  doc: SettingsDocView;
  effective: ConfigResponse | null;
  onSave: (values: Record<string, SettingValue | null>, version: number) => Promise<SettingsDocView>;
  onReload: () => void;
}

/** #389 CA-7 (§7): "share my local models", the account-wide `localHost.shareModels` that the
 * Local Host work (#381/#382) reads. A profile or a device can still override it in its own
 * values. */
export function LocalModelsPanel({ doc, effective, onSave, onReload }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
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
    </div>
  );
}
