import type { ReactNode } from "react";
import type { StartupSummary } from "../api/client.ts";
import type { SessionContextUsage } from "../lib/session-header.ts";
import type { GithubCluster } from "../lib/session-facts.ts";
import type { ScannerColour } from "../lib/session-prefs.ts";
import { GithubChip } from "./GithubChip.tsx";
import { NerdOutPanel } from "./NerdOutPanel.tsx";
import { StartupTime } from "./StartupTime.tsx";

/** A labelled on/off switch, square like the rest of the app. */
function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="details-toggle">
      <span>
        {label}
        <small>{hint}</small>
      </span>
      <button type="button" className="details-switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
    </div>
  );
}

/**
 * #498: the Details tab (docs/design/sessions-redesign-demo.html note 11), which takes over from
 * the status bar and the Nerd out panel: the floppy's model, thinking, tape and spend, its context,
 * the Drive's stats and logs, GitHub, previews and the IDE, and this browser's display choices.
 * The same content opens in the ⋯ sheet on a phone. `chips` is whatever the header doesn't have
 * room for (on a phone: all of the live chips).
 */
export function SessionDetails({
  sessionId,
  runState,
  startup,
  model,
  pendingModel,
  thinking,
  onSwitchModel,
  canSwitchModel,
  guruId,
  onCopyGuruId,
  copiedGuruId,
  cost,
  looseRepo,
  context,
  oomMessage,
  cluster,
  chips,
  thoughtBubbles,
  onThoughtBubbles,
  scannerColour,
  onScannerColour,
}: {
  sessionId: string;
  runState: string | undefined;
  startup: StartupSummary | null | undefined;
  model?: string;
  pendingModel?: string;
  thinking?: string;
  onSwitchModel: () => void;
  canSwitchModel: boolean;
  guruId?: string;
  onCopyGuruId: () => void;
  copiedGuruId: boolean;
  cost?: number;
  looseRepo: string | null;
  context?: SessionContextUsage;
  oomMessage: string | null;
  cluster: GithubCluster | null;
  chips?: ReactNode;
  thoughtBubbles: boolean;
  onThoughtBubbles: (next: boolean) => void;
  scannerColour: ScannerColour;
  onScannerColour: (next: ScannerColour) => void;
}) {
  const percent = context?.percent;
  return (
    <div className="session-details">
      <section className="details-sec" aria-labelledby="details-floppy">
        <h2 id="details-floppy">
          <span>Floppy</span>
          <span className="mono">{sessionId.slice(0, 8)}</span>
        </h2>
        <dl className="details-kv">
          <dt>Model</dt>
          <dd>
            <button type="button" className="details-link mono" onClick={onSwitchModel} disabled={!canSwitchModel} title="Switch model">
              {model ?? "unknown yet"}
            </button>
            {pendingModel ? (
              <span className="details-pending" title="The floppy switches to this model">
                → <span className="mono">{pendingModel}</span>
              </span>
            ) : null}
          </dd>
          {thinking ? (
            <>
              <dt>Thinking</dt>
              <dd className="mono">{thinking}</dd>
            </>
          ) : null}
          {guruId ? (
            <>
              <dt>Tape</dt>
              <dd>
                <span className="mono" title={guruId}>
                  {guruId.slice(0, 8)}
                </span>{" "}
                <button type="button" className="copy-chip" onClick={onCopyGuruId} aria-label="Copy full tape id" title="Copy full tape id">
                  {copiedGuruId ? "✓" : "⧉"}
                </button>
              </dd>
            </>
          ) : null}
          {typeof cost === "number" ? (
            <>
              <dt>Spend</dt>
              <dd className="mono">${cost.toFixed(4)}</dd>
            </>
          ) : null}
          {looseRepo ? (
            <>
              <dt>Repository</dt>
              <dd className="mono" title={looseRepo}>
                {looseRepo}
              </dd>
            </>
          ) : null}
          <dt>Start-up</dt>
          <dd>
            <StartupTime startup={startup} runState={runState} />
          </dd>
        </dl>
      </section>

      <section className="details-sec" aria-labelledby="details-context">
        <h2 id="details-context">
          <span>Context</span>
          {typeof percent === "number" ? <span className="mono">{Math.round(percent)}%</span> : null}
        </h2>
        {context ? (
          <>
            <p className="details-line mono">
              {context.window ? `${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens` : `${context.tokens.toLocaleString()} tokens`}
            </p>
            {typeof percent === "number" && (
              <span
                className={`meter context-meter${percent >= 80 ? " meter-danger" : percent >= 50 ? " meter-warn" : ""}`}
                role="meter"
                aria-label="Context used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
              >
                <span className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
              </span>
            )}
            {oomMessage ? <p className="context-oom-note">{oomMessage}</p> : null}
          </>
        ) : (
          <p className="details-empty">Nothing used yet.</p>
        )}
      </section>

      {(cluster || chips) && (
        <section className="details-sec" aria-labelledby="details-links">
          <h2 id="details-links">
            <span>GitHub, previews, IDE</span>
          </h2>
          <div className="details-chips">
            {cluster ? <GithubChip cluster={cluster} /> : null}
            {chips}
          </div>
        </section>
      )}

      <section className="details-sec" aria-labelledby="details-drive">
        <h2 id="details-drive">
          <span>Drive</span>
        </h2>
        <NerdOutPanel key={sessionId} sessionId={sessionId} runState={runState} startup={startup} embedded />
      </section>

      <section className="details-sec" aria-labelledby="details-display">
        <h2 id="details-display">
          <span>Display</span>
          <span>this browser</span>
        </h2>
        <Switch
          label="Thought bubbles"
          hint="Show thinking open in the transcript while it happens"
          on={thoughtBubbles}
          onChange={onThoughtBubbles}
        />
        <Switch
          label="Phosphor scanner"
          hint={scannerColour === "phosphor" ? "The working scanner glows phosphor green" : "The working scanner glows KITT red"}
          on={scannerColour === "phosphor"}
          onChange={(next) => onScannerColour(next ? "phosphor" : "kitt")}
        />
      </section>
    </div>
  );
}
