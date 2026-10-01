import { useEffect, useState } from "react";
import { api, ApiError, type AeAgent } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { SystemErrorDialog, type ApiErrorState } from "./SystemErrorDialog.tsx";
import { SyntaxError } from "./SyntaxError.tsx";
import { Working } from "./Working.tsx";

/** Mirrors the API's AE_AGENT_ID (routes/agent-engine.ts) to catch typos before the request; the
 * server stays the authority. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface Draft {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
}

const EMPTY: Draft = { id: "", workspaceId: "", name: "", description: "" };

/** The first problem with a draft, or null. `editing` skips the id, which can't change. */
export function draftError(d: Draft, editing: boolean): string | null {
  if (!editing && !AGENT_ID.test(d.id)) return "Id must be a lowercase slug: letters, digits, - and _ (up to 48).";
  if (!WORKSPACE_ID.test(d.workspaceId.trim())) return "Workspace id is required (the Agent Engine workspace that hosts the agent).";
  if (!d.name.trim() || d.name.trim().length > 80) return "Name is required, up to 80 characters.";
  if (d.description.length > 500) return "Description is up to 500 characters.";
  return null;
}

function AgentForm({ initial, editing, onSave, onCancel }: { initial: Draft; editing: boolean; onSave: (d: Draft) => Promise<boolean | void>; onCancel?: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const invalid = draftError(draft, editing);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (invalid) return;
    setSaving(true);
    try {
      const ok = await onSave({ ...draft, workspaceId: draft.workspaceId.trim(), name: draft.name.trim(), description: draft.description.trim() });
      if (ok !== false && !editing) {
        setDraft(EMPTY);
        setAttempted(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={editing ? `Edit ${initial.id}` : "Add an Agent Engine agent"}>
      {!editing && (
        <div className="form-row">
          <input value={draft.id} onChange={set("id")} placeholder="id, e.g. researcher" aria-label="Agent id" autoComplete="off" />
        </div>
      )}
      <div className="form-row">
        <input value={draft.workspaceId} onChange={set("workspaceId")} placeholder="Agent Engine workspace id" aria-label="Workspace id" autoComplete="off" />
      </div>
      <div className="form-row">
        <input value={draft.name} onChange={set("name")} placeholder="Name" aria-label="Name" autoComplete="off" />
      </div>
      <div className="form-row">
        <textarea value={draft.description} onChange={set("description")} placeholder="What it does (agents read this to choose one)" aria-label="Description" rows={2} />
      </div>
      {attempted && invalid && <SyntaxError>{invalid}</SyntaxError>}
      <div className="toolbar">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? <Working label="Saving" /> : editing ? "Save" : "Add agent"}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function AgentRow({ agent, onChanged, onError }: { agent: AeAgent; onChanged: () => void; onError: (e: ApiErrorState) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError(toApiErrorState(err, what));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={4}>
          <AgentForm
            initial={{ id: agent.id, workspaceId: agent.workspaceId, name: agent.name, description: agent.description }}
            editing
            onCancel={() => setEditing(false)}
            onSave={(d) =>
              act("Save failed", async () => {
                await api.updateAeAgent(agent.id, { workspaceId: d.workspaceId, name: d.name, description: d.description });
                setEditing(false);
              })
            }
          />
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td data-label="Agent">
        <div>
          {agent.name} <span className="mono session-meta">{agent.id}</span>
        </div>
        {agent.description && <div className="session-meta">{agent.description}</div>}
      </td>
      <td data-label="Workspace" className="mono">
        {agent.workspaceId}
      </td>
      <td data-label="State">
        <span className="chip">{agent.enabled ? "enabled" : "disabled"}</span>
      </td>
      <td data-label="">
        {!confirming ? (
          <div className="toolbar row-actions">
            <button type="button" onClick={() => act(agent.enabled ? "Disable failed" : "Enable failed", () => api.updateAeAgent(agent.id, { enabled: !agent.enabled }))} disabled={busy}>
              {agent.enabled ? "Disable" : "Enable"}
            </button>
            <button type="button" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </button>
            <button type="button" className="danger" onClick={() => setConfirming(true)} disabled={busy}>
              Remove
            </button>
          </div>
        ) : (
          <div className="toolbar row-actions" role="alertdialog" aria-label={`Confirm removing ${agent.id}`}>
            <button type="button" className="danger" onClick={() => act("Remove failed", () => api.deleteAeAgent(agent.id))} disabled={busy}>
              Yes, remove
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * Settings → Agent Engine agents (E9 §4): the agents a Drive's agent_engine tool may call. Drives
 * call only enabled entries here; nothing is discovered from Agent Engine. Sysops only, and only
 * from this page (a Dongle can't change it).
 */
export function AeAgentsPanel() {
  const [agents, setAgents] = useState<AeAgent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);

  async function load() {
    try {
      setAgents((await api.listAeAgents()).agents);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function add(d: Draft): Promise<boolean> {
    try {
      await api.createAeAgent({ id: d.id, workspaceId: d.workspaceId, name: d.name, description: d.description, enabled: true });
      await load();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setApiError(toApiErrorState(err, "That id or workspace is already listed"));
      else setApiError(toApiErrorState(err, "Add failed"));
      return false;
    }
  }

  return (
    <div className="panel">
      <h3 className="panel-title">
        <span className="panel-label">Allowlist</span>
      </h3>
      <div className="panel-body">
        <p className="session-meta">
          Atlas Agent Engine agents that a Drive's <code>agent_engine</code> tool may call, for tapes with Agent Engine turned on. Only enabled entries are
          callable. Their replies reach the Drive as untrusted text, and answering an agent's review pause always asks the session's owner first. Calls need
          the agents project configured on the link service (<code>AGENT_ENGINE_AGENTS_PROJECT_ID</code>).
        </p>
        {failed && <p className="error-banner" role="alert">Couldn't load the Agent Engine agents.</p>}
        {!agents && !failed && <p className="session-meta">Loading…</p>}
        {agents && agents.length === 0 && <p className="note">No agents listed yet.</p>}
        {agents && agents.length > 0 && (
          <div className="table-scroll">
            <table className="data-table stack">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Workspace</th>
                  <th>State</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <AgentRow key={a.id} agent={a} onChanged={load} onError={setApiError} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AgentForm initial={EMPTY} editing={false} onSave={add} />
        {apiError && <SystemErrorDialog error={apiError} onResume={() => setApiError(null)} />}
      </div>
    </div>
  );
}
