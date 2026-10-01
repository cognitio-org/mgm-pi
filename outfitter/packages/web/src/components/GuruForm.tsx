import { useState } from "react";
import { api, type Guru, type GuruMeta, type ModelRow } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { SystemErrorDialog, type ApiErrorState } from "./SystemErrorDialog.tsx";
import { SyntaxError } from "./SyntaxError.tsx";

interface EnvRow {
  key: string;
  value: string;
}

interface Props {
  guru?: Guru;
  models: ModelRow[];
  meta: GuruMeta | null;
  /** The signed-in person is a sysop: only they may give a tape operator admin tools. */
  isSysop?: boolean;
  onClose: () => void;
  onSaved: (guru: Guru) => void;
}

function envToRows(env: Record<string, string> | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> | undefined {
  const entries = rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function listToText(list: string[] | undefined): string {
  return (list ?? []).join(", ");
}

function textToList(text: string): string[] | undefined {
  const items = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Create/edit form for a guru (EPIC.md E3.7). Shared by GurusPage for both "New guru" and editing
 * an existing row -- `guru` present means edit (PUT), absent means create (POST). Model/fallback
 * pickers and the env denylist come from GET /api/models and GET /api/gurus/meta respectively
 * (fetched once by GurusPage and passed down, so opening several forms in a session doesn't
 * refetch either). */
export function GuruForm({ guru, models, meta, isSysop = false, onClose, onSaved }: Props) {
  const [name, setName] = useState(guru?.name ?? "");
  const [model, setModel] = useState(guru?.model ?? "");
  const [fallbackModel, setFallbackModel] = useState(guru?.fallbackModel ?? "");
  const [thinking, setThinking] = useState(guru?.thinking ?? "");
  const [systemPrompt, setSystemPrompt] = useState(guru?.systemPrompt ?? "");
  const [appendSystemPrompt, setAppendSystemPrompt] = useState(guru?.appendSystemPrompt ?? "");
  const [tools, setTools] = useState(listToText(guru?.tools));
  const [excludeTools, setExcludeTools] = useState(listToText(guru?.excludeTools));
  const [playwrightBeforeCheckpoint, setPlaywrightBeforeCheckpoint] = useState(guru?.playwrightBeforeCheckpoint === true);
  const [allowExternalHtmlResources, setAllowExternalHtmlResources] = useState(guru?.allowExternalHtmlResources === true);
  const [browserIde, setBrowserIde] = useState(guru?.browserIde === true);
  const [adminTools, setAdminTools] = useState<NonNullable<Guru["adminTools"]>>(guru?.adminTools ?? "off");
  const [memory, setMemory] = useState<NonNullable<Guru["memory"]>>(guru?.memory ?? "off");
  const [agentEngine, setAgentEngine] = useState(guru?.agentEngine === true);
  // Only a sysop turns admin tools on or changes a tape that has them (owner decision, 2026-09-30);
  // the server refuses the rest, so don't let edits pile up.
  const hasAdmin = guru?.adminTools === "manage" || guru?.adminTools === "operator";
  const readOnly = hasAdmin && !isSysop;
  const [branchPrefix, setBranchPrefix] = useState(guru?.branchPrefix ?? "outfitter/");
  const [envRows, setEnvRows] = useState<EnvRow[]>(envToRows(guru?.env).length > 0 ? envToRows(guru?.env) : [{ key: "", value: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  function updateEnvRow(i: number, patch: Partial<EnvRow>) {
    setEnvRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeEnvRow(i: number) {
    setEnvRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setSubmitAttempted(true);
    if (!name.trim() || !model.trim()) return;
    setSubmitting(true);
    const payload = {
      name: name.trim(),
      model: model.trim(),
      fallbackModel: fallbackModel.trim() || undefined,
      thinking: thinking || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      appendSystemPrompt: appendSystemPrompt.trim() || undefined,
      tools: textToList(tools),
      excludeTools: textToList(excludeTools),
      playwrightBeforeCheckpoint,
      allowExternalHtmlResources,
      browserIde,
      adminTools,
      memory,
      agentEngine,
      branchPrefix: branchPrefix.trim() || undefined,
      env: rowsToEnv(envRows),
    };
    try {
      const saved = guru ? await api.updateGuru(guru.id, payload) : await api.createGuru(payload);
      onSaved(saved);
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to save guru"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{guru ? `Edit ${guru.name}` : "New guru"}</h2>
        {apiError && <SystemErrorDialog error={apiError} onResume={() => setApiError(null)} />}
        <form onSubmit={submit}>
          {readOnly && <p className="session-meta">Only a sysop can change this tape: it has admin tools.</p>}
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="form-row">
            <label htmlFor="guru-name">Name</label>
            <input
              id="guru-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              aria-invalid={submitAttempted && !name.trim()}
            />
            {submitAttempted && !name.trim() && <SyntaxError>name cannot be empty.</SyntaxError>}
          </div>

          <ModelPicker id="guru-model" label="Model" models={models} value={model} onChange={setModel} />
          <ModelPicker
            id="guru-fallback-model"
            label="Fallback model (optional)"
            models={models}
            value={fallbackModel}
            onChange={setFallbackModel}
            placeholder="used when the laptop model is offline"
          />

          <div className="form-row">
            <label htmlFor="guru-thinking">Thinking level</label>
            <select id="guru-thinking" value={thinking} onChange={(e) => setThinking(e.target.value)}>
              <option value="">guru default</option>
              {(meta?.thinkingLevels ?? []).map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="guru-system-prompt">System prompt (optional, replaces the default)</label>
            <textarea id="guru-system-prompt" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="guru-append-system-prompt">Append to system prompt (optional)</label>
            <textarea id="guru-append-system-prompt" value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="form-check">
              <input
                type="checkbox"
                checked={allowExternalHtmlResources}
                onChange={(e) => setAllowExternalHtmlResources(e.target.checked)}
              />
              Allow external CSS and JS in HTML previews
            </label>
            <p className="session-meta">
              Off by default. Runs are told whether HTML they write may link external stylesheets and scripts, and
              previews start that way. You can still change one preview in its dialog.
            </p>
          </div>
          <div className="form-row">
            <label className="form-check">
              <input type="checkbox" checked={browserIde} onChange={(e) => setBrowserIde(e.target.checked)} />
              VS Code in the browser
            </label>
            <p className="session-meta">
              Off by default. Lets the floppy&apos;s owner open this Drive&apos;s files in an editor with a terminal.
            </p>
          </div>
          <div className="form-row">
            <label htmlFor="guru-admin-tools">Admin tools</label>
            <select
              id="guru-admin-tools"
              value={adminTools}
              onChange={(e) => setAdminTools(e.target.value as NonNullable<Guru["adminTools"]>)}
              disabled={!isSysop}
            >
              <option value="off">Off</option>
              {(isSysop || adminTools === "manage") && <option value="manage">Manage tapes, environments and sessions</option>}
              {(isSysop || adminTools === "operator") && <option value="operator">Operator (sysop actions too)</option>}
            </select>
            <p className="session-meta">
              Off by default. Runs on this tape can administer Outfitter as the floppy&apos;s owner; deletes wait for the
              owner&apos;s approval on the floppy page. Only a sysop can turn this on or change a tape that has it.
            </p>
          </div>
          <div className="form-row">
            <label htmlFor="guru-memory">Memory</label>
            <select id="guru-memory" value={memory} onChange={(e) => setMemory(e.target.value as NonNullable<Guru["memory"]>)}>
              <option value="off">Off</option>
              <option value="tool">Tool: the agent searches and saves when it decides to</option>
              <option value="auto">Auto: also recalls before each prompt and records the conversation</option>
            </select>
            <p className="session-meta">
              Off by default. Long-term memory in Agent Engine, kept per person across floppies, instead of notes on the
              Drive&apos;s disk. Auto looks up memory on every prompt, which is billed. Only a person can set this.
            </p>
          </div>
          <div className="form-row">
            <label className="form-check">
              <input id="guru-agent-engine" type="checkbox" checked={agentEngine} onChange={(e) => setAgentEngine(e.target.checked)} />
              Agent Engine agents
            </label>
            <p className="session-meta">
              Off by default. Runs on this tape can ask the Agent Engine agents a sysop has listed for help. Answering an
              agent&apos;s review pause always waits for the floppy owner&apos;s approval. Only a person can set this.
            </p>
          </div>

          <div className="form-row">
            <label htmlFor="guru-tools">Tools (comma-separated, empty = all)</label>
            <input id="guru-tools" value={tools} onChange={(e) => setTools(e.target.value)} placeholder="bash, read, edit" />
          </div>
          <div className="form-row">
            <label htmlFor="guru-exclude-tools">Exclude tools (comma-separated)</label>
            <input id="guru-exclude-tools" value={excludeTools} onChange={(e) => setExcludeTools(e.target.value)} />
          </div>

          <div className="form-row">
            <label htmlFor="guru-branch-prefix">Cloud branch prefix</label>
            <input
              id="guru-branch-prefix"
              value={branchPrefix}
              onChange={(e) => setBranchPrefix(e.target.value)}
              placeholder="outfitter/"
            />
            <p className="session-meta">
              A cloud run may push its session branch, and any branch under this prefix. The default is outfitter/.
            </p>
          </div>

          <div className="form-row">
            <label htmlFor="guru-playwright">Playwright before checkpoint</label>
            <select
              id="guru-playwright"
              value={playwrightBeforeCheckpoint ? "on" : "off"}
              onChange={(e) => setPlaywrightBeforeCheckpoint(e.target.value === "on")}
            >
              <option value="off">off</option>
              <option value="on">on</option>
            </select>
            <p className="session-meta">
              Off by default. When on, checkpoint runs a Playwright spec already in the repo against a fresh headless
              Chromium in the Drive, not your Chrome.
            </p>
          </div>

          <div className="form-row">
            <label>Environment variables</label>
            {envRows.map((row, i) => (
              <div className="env-row" key={i}>
                <input
                  value={row.key}
                  onChange={(e) => updateEnvRow(i, { key: e.target.value })}
                  placeholder="KEY"
                  aria-label="Env var name"
                />
                <input
                  value={row.value}
                  onChange={(e) => updateEnvRow(i, { value: e.target.value })}
                  placeholder="value"
                  aria-label="Env var value"
                />
                <button type="button" onClick={() => removeEnvRow(i)} aria-label="Remove env var">
                  &times;
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}>
              Add variable
            </button>
            {meta && (
              <p className="session-meta">
                Not allowed: {meta.envDenylist.join(", ")}
              </p>
            )}
          </div>

          </fieldset>
          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={readOnly || submitting || !name.trim() || !model.trim()}>
              {submitting ? "Saving..." : "Save guru"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
