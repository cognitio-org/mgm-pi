import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client.ts";
import { devicesApi, type PendingDevice } from "../api/devices.ts";
import { DeviceRequestCard } from "../components/devices/DeviceRequestCard.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { SyntaxError } from "../components/SyntaxError.tsx";
import { Working } from "../components/Working.tsx";
import { toApiErrorState } from "../lib/api-error.ts";
import { formatUserCodeInput, isFramed, normalizeUserCode } from "../lib/devices.ts";
import { vocabulary } from "../lib/vocabulary.ts";

type Phase =
  | { kind: "enter"; notice?: string }
  | { kind: "loading"; code: string }
  | { kind: "review"; pending: PendingDevice; approverIp?: string }
  | { kind: "done"; status: "approved" | "denied"; deviceName: string };

/** #389 CA-1 web (docs/specs/central-auth.md §1.5, §1.9, §6): /device, where a person approves a
 * `kernal login` code. A `?code=` link only fills the code in and looks it up; nothing is approved
 * until the person clicks Approve. Inside a frame the page only asks to be opened directly
 * (see isFramed): no lookup, no request card, no Approve. */
export function DeviceApprovePage() {
  const [framed] = useState(() => isFramed());
  return framed ? <FramedNotice /> : <DeviceApproveForm />;
}

function FramedNotice() {
  return (
    <div className="device-approve">
      <div className="page-heading">
        <h2>Sign in a {vocabulary.kernal.one}</h2>
      </div>
      <p className="device-warning" role="alert">
        Open this page directly: a sign-in can't be approved from inside another page.{" "}
        <a href={window.location.href} target="_blank" rel="noopener noreferrer">
          Open it in a new tab
        </a>
      </p>
    </div>
  );
}

function DeviceApproveForm() {
  const [params] = useSearchParams();
  const initial = params.get("code") ?? "";
  const [input, setInput] = useState(formatUserCodeInput(initial));
  const [attempted, setAttempted] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "enter" });
  const [deciding, setDeciding] = useState<"approve" | "deny" | null>(null);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  // Only the newest lookup may change the page (a slow answer for an older code is dropped).
  const seq = useRef(0);

  async function lookup(code: string) {
    const id = ++seq.current;
    setPhase({ kind: "loading", code });
    try {
      const [pending, approverIp] = await Promise.all([devicesApi.pending(code), devicesApi.myIp()]);
      if (id === seq.current) setPhase({ kind: "review", pending, approverIp });
    } catch (err) {
      if (id !== seq.current) return;
      if (err instanceof ApiError && err.status === 404) {
        setPhase({
          kind: "enter",
          notice: `No sign-in is waiting for ${code}. Codes last 10 minutes and work once: check it, or run kernal login again.`,
        });
      } else {
        setPhase({ kind: "enter" });
        setApiError(toApiErrorState(err, "Failed to look up the code"));
      }
    }
  }

  useEffect(() => {
    const code = normalizeUserCode(initial);
    if (code) void lookup(code);
    // Only the code the page was opened with; later codes come from the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    const code = normalizeUserCode(input);
    if (code) void lookup(code);
  }

  async function decide(approve: boolean) {
    if (phase.kind !== "review" || isFramed()) return;
    const { pending } = phase;
    setDeciding(approve ? "approve" : "deny");
    try {
      const result = await devicesApi.decide(pending.userCode, approve);
      setPhase({ kind: "done", status: result.status, deviceName: pending.deviceName });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setPhase({
          kind: "enter",
          notice: `${pending.userCode} was already answered or has expired. Run kernal login again for a new code.`,
        });
      } else {
        setApiError(toApiErrorState(err, approve ? "Failed to approve" : "Failed to deny"));
      }
    } finally {
      setDeciding(null);
    }
  }

  function startOver() {
    seq.current++;
    setInput("");
    setAttempted(false);
    setPhase({ kind: "enter" });
  }

  const inputCode = normalizeUserCode(input);

  return (
    <div className="device-approve">
      <div className="page-heading">
        <h2>Sign in a {vocabulary.kernal.one}</h2>
        <p className="page-subtitle">Approve a <code>kernal login</code> from one of your computers</p>
      </div>

      {apiError && (
        <SystemErrorDialog
          error={apiError}
          onRestart={phase.kind === "review" ? undefined : () => {
            setApiError(null);
            const code = normalizeUserCode(input);
            if (code) void lookup(code);
          }}
          onResume={() => setApiError(null)}
        />
      )}

      {phase.kind === "enter" && (
        <form onSubmit={submit} className="device-code-form">
          {phase.notice && (
            <p className="device-warning" role="alert">
              {phase.notice}
            </p>
          )}
          <p className="session-meta">
            Enter the code <code>kernal login</code> printed in your terminal.
          </p>
          <div className="toolbar toolbar-with-error">
            <div className="form-row" style={{ marginBottom: 0 }}>
              <input
                className="device-code-input"
                value={input}
                onChange={(e) => setInput(formatUserCodeInput(e.target.value))}
                placeholder="XXXX-XXXX"
                aria-label="Code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                aria-invalid={attempted && !inputCode}
              />
              {attempted && !inputCode && <SyntaxError>the code is 8 letters, like BCDF-GHJK.</SyntaxError>}
            </div>
            <button type="submit" className="btn btn-primary">
              Continue
            </button>
          </div>
        </form>
      )}

      {phase.kind === "loading" && (
        <p className="empty-state">
          <Working label={`Looking up ${phase.code}`} size="lg" srOnly={false} />
        </p>
      )}

      {phase.kind === "review" && (
        <>
          <DeviceRequestCard pending={phase.pending} approverIp={phase.approverIp} deciding={deciding} onDecide={decide} />
          <p className="session-meta">
            <button type="button" className="btn" onClick={startOver} disabled={deciding !== null}>
              Enter a different code
            </button>
          </p>
        </>
      )}

      {phase.kind === "done" && (
        <div className="panel device-done" role="status">
          <div className="panel-body">
            {phase.status === "approved" ? (
              <>
                <p>
                  <strong>{phase.deviceName}</strong> is approved.
                </p>
                <p>You can close this tab; {vocabulary.kernal.one} is signed in.</p>
              </>
            ) : (
              <p>
                Denied. {vocabulary.kernal.one} on <strong>{phase.deviceName}</strong> was not signed in.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
