import { useState, type FormEvent } from "react";
import { api, type ModelRow, type ModelSwitch } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Working } from "./Working.tsx";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

interface Props {
  sessionId: string;
  /** What pi is on now, from the transcript (deriveSessionHeader); absent before the first reply. */
  current?: string;
  /** The floppy's own choice, if it has one (SessionDetail.modelOverride). */
  modelOverride?: string;
  /** The tape's model, which the floppy runs on without an override. */
  guruModel?: string;
  models: ModelRow[];
  /** A Drive is going, so the switch takes effect now rather than on the next run. */
  live: boolean;
  onSwitched: (result: ModelSwitch) => void;
  onCancel: () => void;
  onError: (error: ApiErrorState) => void;
}

/** Same shape the api accepts (session-model.ts's isModelId). */
const MODEL_ID = /^[^\s/]+\/\S+$/;

/** Switch the floppy's model (PUT /api/sessions/:id/model). The choice stays with the floppy, and a
 * running Drive moves to it before its next reply; "Use tape's model" drops the floppy's choice. */
export function SwitchModelDialog({ sessionId, current, modelOverride, guruModel, models, live, onSwitched, onCancel, onError }: Props) {
  const [value, setValue] = useState(modelOverride ?? current ?? guruModel ?? "");
  const [busy, setBusy] = useState<"switch" | "reset" | null>(null);
  const trimmed = value.trim();
  const valid = MODEL_ID.test(trimmed) && trimmed.length <= 200;

  async function save(model: string | null) {
    setBusy(model === null ? "reset" : "switch");
    try {
      onSwitched(await api.setSessionModel(sessionId, model));
    } catch (err) {
      setBusy(null);
      onError(toApiErrorState(err, "Model switch failed"));
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (valid && !busy) void save(trimmed);
  }

  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="dialog panel switch-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-model-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="panel-titlebar">
          <span className="panel-label" id="switch-model-title">
            Switch model
          </span>
        </div>
        <form className="panel-body" onSubmit={onSubmit}>
          <p>
            {current ? (
              <>
                Now on <span className="mono">{current}</span>.{" "}
              </>
            ) : null}
            {guruModel ? (
              <>
                The tape's model is <span className="mono">{guruModel}</span>.
              </>
            ) : null}
          </p>
          <ModelPicker id="switch-model" label="Model" models={models} value={value} onChange={setValue} />
          <p className="switch-model-note">
            {live
              ? "The running Drive switches now; the conversation carries on with the new model."
              : "Kept with this floppy; the next run starts on it."}
          </p>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!valid || busy !== null}>
              {busy === "switch" ? <Working label="Switching" /> : "Switch"}
            </button>
            {modelOverride && (
              <button type="button" className="btn" onClick={() => void save(null)} disabled={busy !== null}>
                {busy === "reset" ? <Working label="Switching" /> : "Use tape's model"}
              </button>
            )}
            <button type="button" className="btn" onClick={onCancel} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
