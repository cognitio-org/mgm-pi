import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type LaptopApproval } from "../api/client.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { ARM_DELAY_MS } from "./UiRequestPanel.tsx";

// E9.9: the approval widget. A laptop's Kernal can't ask the person in its own TUI for anything
// that reaches other people (its agent could answer that itself), so it asks here instead: a small
// badge in the corner of every page while the signed-in person has pending asks, opening to one
// compact card per ask with Approve / Deny. Nothing else: no page, settings or history. All text is
// rendered as React text (escaped); the api already stripped control characters and capped it.

/** How often the widget looks for asks while the tab is visible (and on focus). */
export const POLL_MS = 10_000;
/** Characters of an ask's content shown before "Show all". */
export const CLIP = 280;

/** `laptop:<pi session id>` -> its first 8 characters, the way Kernal's /session shows it. */
export function shortSession(id: string): string {
  return id.replace(/^laptop:/, "").slice(0, 8);
}

interface Props {
  pollMs?: number;
  load?: () => Promise<{ approvals: LaptopApproval[] }>;
  decide?: (id: string, approve: boolean) => Promise<unknown>;
}

export function LaptopApprovals({ pollMs = POLL_MS, load = api.laptopApprovals, decide = api.decideLaptopApproval }: Props) {
  const [items, setItems] = useState<LaptopApproval[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A token or signed-out page can't have asks: stop asking.
  const off = useRef(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (off.current) return;
    const id = ++seq.current;
    try {
      const { approvals } = await load();
      if (id === seq.current) setItems(Array.isArray(approvals) ? approvals : []);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        off.current = true;
        setItems([]);
      }
      // Anything else is a blip: keep what is shown, try again on the next tick.
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    };
    const timer = setInterval(tick, pollMs);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, pollMs]);

  useEffect(() => {
    if (!items.length) setOpen(false);
  }, [items.length]);

  if (!items.length) return null;

  async function answer(id: string, approve: boolean) {
    setError(null);
    try {
      await decide(id, approve);
      setItems((xs) => xs.filter((x) => x.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    void refresh();
  }

  const label = `${items.length} laptop request${items.length === 1 ? "" : "s"} to approve`;
  return (
    <div className="laptop-approvals" aria-live="polite">
      {open && (
        <div className="laptop-approvals-panel" role="dialog" aria-label="Laptop approvals">
          {items.map((a) => (
            <ApprovalCard key={a.id} approval={a} onAnswer={answer} />
          ))}
          {error && (
            <p className="laptop-approvals-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <button type="button" className="btn laptop-approvals-badge" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        Approve <span className="laptop-approvals-count">{items.length}</span>
      </button>
    </div>
  );
}

function ApprovalCard({ approval, onAnswer }: { approval: LaptopApproval; onAnswer: (id: string, approve: boolean) => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [approval.id]);

  const long = approval.summary.length > CLIP;
  const text = full || !long ? approval.summary : `${approval.summary.slice(0, CLIP - 1)}…`;
  const busy = sending || !armed;
  const where = [`laptop ${shortSession(approval.origin.laptopSessionId)}`, approval.origin.repo, relativeTime(approval.createdAt)].filter(Boolean).join(" · ");

  async function respond(approve: boolean) {
    setSending(true);
    try {
      await onAnswer(approval.id, approve);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="ui-request ui-request-outfitter laptop-approval" role="alertdialog" aria-label={approval.title}>
      <small className="ui-request-source">Outfitter asks you (not the agent)</small>
      <strong>{approval.title}</strong>
      <pre className="laptop-approval-text">{text}</pre>
      {long && (
        <button type="button" className="laptop-approval-more" onClick={() => setFull((v) => !v)}>
          {full ? "Show less" : "Show all"}
        </button>
      )}
      <small className="laptop-approval-where" title={approval.origin.laptopSessionId}>
        {where}
      </small>
      <div className="composer-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => respond(true)}>
          Approve
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => respond(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
