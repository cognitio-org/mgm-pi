import { useState } from "react";
import { Working } from "../components/Working.tsx";
import { useLocalHosts } from "../hooks/useLocalHosts.ts";
import type { LocalHostModelView, LocalHostView } from "../api/local-hosts.ts";
import {
  formatContext,
  groupHostsByOwner,
  hostStatusClass,
  hostStatusLabel,
  partitionModels,
  yesNo,
} from "../lib/local-hosts.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

const NOT_LOADED_WARNING = "Not loaded. The first request loads the model, which can take a long time.";

export function LocalModelsPage() {
  const { hosts, loaded, error } = useLocalHosts();
  const groups = groupHostsByOwner(hosts);

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.modem.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("modem")}</p>
      </div>
      <p className="session-meta">
        Who is sharing local models, which models, and which are in memory. This page refreshes on its own. There is no
        live request count.
      </p>
      {error && (
        <p className="syntax-error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <p className="empty-state">
          <Working label="Loading modems" size="lg" srOnly={false} />
        </p>
      ) : hosts.length === 0 && !error ? (
        <p className="empty-state">No one is sharing local models yet.</p>
      ) : hosts.length > 0 ? (
        groups.map((group) => (
          <section key={group.email} className="local-host-owner" aria-label={group.email}>
            <h3>
              {group.email}
              {group.hosts.some((h) => h.owner.mine) ? " (you)" : ""}
            </h3>
            {group.hosts.map((host) => (
              <HostCard key={host.id} host={host} />
            ))}
          </section>
        ))
      ) : null}
    </div>
  );
}

function HostCard({ host }: { host: LocalHostView }) {
  const { loaded, notLoaded } = partitionModels(host.models);
  return (
    <section className="panel local-host-card" aria-label={host.hostName}>
      <div className="panel-titlebar">
        <span className="panel-label">{host.hostName}</span>
      </div>
      <div className="panel-body">
        <div className="local-host-meta">
          <span className={`status-pill ${hostStatusClass(host.status)}`}>{hostStatusLabel(host.status)}</span>
          <span title={new Date(host.lastSeenAt).toLocaleString()}>Last heartbeat {relativeTime(host.lastSeenAt)}</span>
          <span>
            Tunnel {host.tunnel.provider}
            {host.tunnel.managed ? "" : " (interim)"}
          </span>
          <span>
            Access group <code>{host.accessGroup}</code>
          </span>
        </div>
        {host.models.length === 0 ? (
          <p className="session-meta">No models reported.</p>
        ) : (
          <>
            <ModelBlock title="Loaded" models={loaded} warn={false} />
            <ModelBlock title="Not loaded" models={notLoaded} warn />
          </>
        )}
      </div>
    </section>
  );
}

function ModelBlock({ title, models, warn }: { title: string; models: LocalHostModelView[]; warn: boolean }) {
  if (models.length === 0) return null;
  return (
    <div className="local-model-block">
      <h4>{title}</h4>
      {warn && <p className="session-meta local-model-warn">{NOT_LOADED_WARNING}</p>}
      {models.map((m) => (
        <ModelRow key={`${m.id}:${m.routerModel ?? ""}`} model={m} />
      ))}
    </div>
  );
}

function ModelRow({ model }: { model: LocalHostModelView }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!model.routerModel) return;
    try {
      await navigator.clipboard.writeText(model.routerModel);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard refused: the name is still on the page
    }
  }
  return (
    <div className="local-model-row">
      <span className="local-model-name">{model.routerModel ?? model.id}</span>
      {model.routerModel && (
        <button type="button" className="copy-chip" onClick={copy} aria-label={`Copy ${model.routerModel}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <span className="session-meta">context {formatContext(model.contextLength)}</span>
      <span className="session-meta">vision {yesNo(model.vision)}</span>
      <span className="session-meta">tools {yesNo(model.toolUse)}</span>
      {!model.shared && <span className="session-meta">not on the shared server</span>}
    </div>
  );
}
