import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
type ConfirmRequest = { id: string; method: "confirm"; title: string; message: string; source?: string };
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

/** Sysop tools (#287): the api marks its own admin-approval cards; agentlink strips the marker from
 * pi's events, so the model can't make a card that looks like one of these. */
export const OUTFITTER_SOURCE = "outfitter";

/** A new card's buttons wake after this long, so a click meant for the previous card can't land on
 * the next one (the model can time a harmless question just before a real approval). */
export const ARM_DELAY_MS = 1000;

/** Someone is in the middle of typing elsewhere (a draft in the composer): don't pull focus away. */
function typingElsewhere(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim() !== "";
  return el instanceof HTMLElement && el.isContentEditable;
}

/** #498: the question docks above the composer as a card (docs/design/sessions-redesign-demo.html
 * note 9), with keys for the common answer: Enter for the primary button, Esc to deny or cancel.
 * The keys only answer while focus is inside the card, so a keypress meant for the page never
 * approves anything; when the card arms it takes focus, unless the person is mid-draft elsewhere.
 * Keys wait for the same arm delay as the buttons. */
export function UiRequestPanel({ request, onRespond }: Props) {
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    setInputValue("");
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [request.id]);
  const busy = sending || !armed;
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The answers Enter and Esc give, when this kind of card has them.
  const confirmLike = isConfirm(request);
  const keyAnswers = useRef<{ enter?: () => unknown; escape?: () => unknown }>({});
  keyAnswers.current = confirmLike
    ? { enter: () => respond(true), escape: () => respond(false) }
    : isInput(request)
      ? { enter: () => respond(inputValue) }
      : {};

  // Once armed, bring focus to the card (its text field, for an input question).
  useEffect(() => {
    if (!armed || typingElsewhere()) return;
    const card = cardRef.current;
    (card?.querySelector<HTMLElement>("input") ?? card)?.focus();
  }, [armed, request.id]);

  function onCardKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (busy || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    // Enter on one of the card's buttons is that button's own click.
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement) return;
    const answer = event.key === "Enter" ? keyAnswers.current.enter : keyAnswers.current.escape;
    if (!answer) return;
    event.preventDefault();
    event.stopPropagation();
    void answer();
  }

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
      <div className="ui-request" ref={cardRef} tabIndex={-1} onKeyDown={onCardKey} role="group" aria-label="Question from the agent">
        <div className="ui-request-head">
          <span className="lamp lamp-needsYou" aria-hidden="true" />
          Needs you
        </div>
        <strong>{request.title}</strong>
        <div className="ui-request-actions">
          {request.options.map((opt) => (
            <button key={opt} className="btn" disabled={busy} onClick={() => respond(opt)}>
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (isConfirm(request) && request.source === OUTFITTER_SOURCE) {
    return (
      <div className="ui-request ui-request-outfitter" role="alertdialog" aria-label="Outfitter approval" ref={cardRef} tabIndex={-1} onKeyDown={onCardKey}>
        <div className="ui-request-head">
          <span className="lamp lamp-needsYou" aria-hidden="true" />
          <small className="ui-request-source">Outfitter asks you (not the agent)</small>
        </div>
        <strong>{request.title}</strong>
        <p>{request.message}</p>
        <div className="ui-request-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => respond(true)}>
            Allow
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => respond(false)}>
            Deny
          </button>
          <KeyHints primary="allow" secondary="deny" />
        </div>
      </div>
    );
  }

  if (isConfirm(request)) {
    return (
      <div className="ui-request" ref={cardRef} tabIndex={-1} onKeyDown={onCardKey} role="group" aria-label="Question from the agent">
        <div className="ui-request-head">
          <span className="lamp lamp-needsYou" aria-hidden="true" />
          Needs you
        </div>
        <strong>{request.title}</strong>
        <p>{request.message}</p>
        <div className="ui-request-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => respond(true)}>
            Confirm
          </button>
          <button className="btn" disabled={busy} onClick={() => respond(false)}>
            Cancel
          </button>
          <KeyHints primary="confirm" secondary="cancel" />
        </div>
      </div>
    );
  }

  if (isInput(request)) {
    return (
      <div className="ui-request" ref={cardRef} tabIndex={-1} onKeyDown={onCardKey} role="group" aria-label="Question from the agent">
        <div className="ui-request-head">
          <span className="lamp lamp-needsYou" aria-hidden="true" />
          Needs you
        </div>
        <strong>{request.title}</strong>
        <div className="ui-request-actions">
          <input
            aria-label={request.title}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={typeof request.placeholder === "string" ? request.placeholder : undefined}
            disabled={busy}
          />
          <button className="btn btn-primary" disabled={busy} onClick={() => respond(inputValue)}>
            Submit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ui-request" ref={cardRef} tabIndex={-1} onKeyDown={onCardKey}>
      <strong>{request.method}</strong> (unsupported prompt type)
      <pre>{JSON.stringify(request, null, 2)}</pre>
    </div>
  );
}

function KeyHints({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <span className="ui-request-keys" aria-hidden="true">
      <kbd>↵</kbd> {primary} · <kbd>esc</kbd> {secondary}
    </span>
  );
}
