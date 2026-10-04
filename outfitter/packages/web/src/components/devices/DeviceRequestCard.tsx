import { useEffect, useState } from "react";
import type { PendingDevice } from "../../api/devices.ts";
import { codeExpiry, ipsDiffer, isExpired, platformLabel } from "../../lib/devices.ts";
import { vocabulary } from "../../lib/vocabulary.ts";
import { ARM_DELAY_MS } from "../UiRequestPanel.tsx";
import { Working } from "../Working.tsx";

interface Props {
  pending: PendingDevice;
  /** The approver's own address, when the api tells us (§1.9); undefined skips the warning. */
  approverIp?: string;
  /** Which answer is on its way, if any. */
  deciding: "approve" | "deny" | null;
  onDecide: (approve: boolean) => void;
  now?: () => number;
}

/** #389 CA-1 web (docs/specs/central-auth.md §1.9, §6): one `kernal login` request, named clearly
 * enough that a person can tell whether it is theirs: device, platform, Kernal version, the
 * address it came from and when. Approve wakes only after a short delay (as the laptop approvals
 * do), so a prefilled link can't slide the button under a click that was meant for something
 * else. All text is React text (escaped). */
export function DeviceRequestCard({ pending, approverIp, deciding, onDecide, now = Date.now }: Props) {
  const [armed, setArmed] = useState(false);
  const [clock, setClock] = useState(now());

  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending.userCode]);

  useEffect(() => {
    const timer = setInterval(() => setClock(now()), 5_000);
    return () => clearInterval(timer);
  }, [now]);

  const expired = isExpired(pending.expiresAt, clock);
  const otherPlace = ipsDiffer(pending.requestIp, approverIp);
  const platform = platformLabel(pending.platform);
  const busy = deciding !== null;

  return (
    <section className="panel device-request" aria-label={`Sign-in request from ${pending.deviceName}`}>
      <div className="panel-titlebar">
        <span className="panel-label">Code {pending.userCode}</span>
      </div>
      <div className="panel-body">
        <p>
          A {vocabulary.kernal.one} on <strong>{pending.deviceName}</strong> asks to sign in as you. Approve only if
          you just ran <code>kernal login</code> there and it shows the same code.
        </p>
        <dl className="device-facts">
          <dt>{vocabulary.device.one}</dt>
          <dd>{pending.deviceName}</dd>
          {platform && (
            <>
              <dt>Platform</dt>
              <dd>{platform}</dd>
            </>
          )}
          {pending.kernalVersion && (
            <>
              <dt>{vocabulary.kernal.one} version</dt>
              <dd>{pending.kernalVersion}</dd>
            </>
          )}
          <dt>Requested from</dt>
          <dd>{pending.requestIp ? <code>{pending.requestIp}</code> : "unknown address"}</dd>
          <dt>Requested</dt>
          <dd>
            {new Date(pending.requestedAt).toLocaleString()} ·{" "}
            <span className={expired ? "device-expired" : undefined}>{codeExpiry(pending.expiresAt, clock)}</span>
          </dd>
        </dl>
        {otherPlace && (
          <p className="device-warning" role="alert">
            This request came from <code>{pending.requestIp}</code>, but you are at <code>{approverIp}</code>. If you
            didn't start it on another computer or network yourself, someone may be trying to get you to sign
            their {vocabulary.kernal.one} in as you: choose Deny.
          </p>
        )}
        {expired ? (
          <p className="device-warning" role="alert">
            This code has expired. Run <code>kernal login</code> again for a new one.
          </p>
        ) : (
          <div className="form-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => onDecide(false)}>
              {deciding === "deny" ? <Working label="Denying" /> : "Deny"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!armed || busy}
              aria-disabled={!armed || busy}
              onClick={() => onDecide(true)}
            >
              {deciding === "approve" ? <Working label="Approving" /> : "Approve"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
