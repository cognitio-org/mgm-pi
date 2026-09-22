import { useState } from "react";
import { Working } from "./Working.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";

// Shape from @earendil-works/pi-coding-agent's RpcExtensionUIRequest (modes/rpc/rpc-types.d.ts).
// Only the interactive methods (select/confirm/input) need a response; notify/setStatus/setWidget/
// setTitle/set_editor_text are display-only and don't block the run, so they're not surfaced here
// (protocol.md persists only extension_ui_request on Run.pendingUiRequest at all, and only while a
// response is outstanding).
export interface RawUiRequest {
  id: string;
  method: string;
  [key: string]: unknown;
}

type SelectRequest = { id: string; method: "select"; title: string; options: string[] };
type ConfirmRequest = { id: string; method: "confirm"; title: string; message: string };
type InputRequest = { id: string; method: "input"; title: string; placeholder?: string };

function isSelect(r: RawUiRequest): r is SelectRequest {
  return r.method === "select" && Array.isArray(r.options);
}
function isConfirm(r: RawUiRequest): r is ConfirmRequest {
  return r.method === "confirm" && typeof r.message === "string";
}
function isInput(r: RawUiRequest): r is InputRequest {
  return r.method === "input";
}

interface Props {
  request: RawUiRequest;
  onRespond: (id: string, value: unknown) => Promise<void>;
}

export function UiRequestPanel({ request, onRespond }: Props) {
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);

  async function respond(value: unknown) {
    setSending(true);
    try {
      await withFloppySound(onRespond(request.id, value));
    } finally {
      setSending(false);
    }
  }

  if (isSelect(request)) {
    return (
      <div className="ui-request">
        <strong>{request.title}</strong>
        <div className="composer-row" style={{ marginTop: "0.5rem", flexWrap: "wrap" }}>
          {request.options.map((opt) => (
            <button key={opt} className="btn" disabled={sending} onClick={() => respond(opt)}>
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (isConfirm(request)) {
    return (
      <div className="ui-request">
        <strong>{request.title}</strong>
        <p>{request.message}</p>
        <div className="composer-row">
          <button className="btn btn-primary" disabled={sending} onClick={() => respond(true)}>
            Confirm
          </button>
          <button className="btn" disabled={sending} onClick={() => respond(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (isInput(request)) {
    return (
      <div className="ui-request">
        <strong>{request.title}</strong>
        <div className="composer-row" style={{ marginTop: "0.5rem" }}>
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={typeof request.placeholder === "string" ? request.placeholder : undefined}
            disabled={sending}
          />
          <button className="btn btn-primary" disabled={sending} onClick={() => respond(inputValue)}>
            Submit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ui-request">
      <strong>{request.method}</strong> (unsupported prompt type)
      <pre>{JSON.stringify(request, null, 2)}</pre>
    </div>
  );
}
