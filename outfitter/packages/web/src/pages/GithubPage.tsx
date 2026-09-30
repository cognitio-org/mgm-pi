// Repositories the GitHub App can reach. The list is one call; open pull requests, the latest
// commit, and the year's commit counts load for the repository you select. Reachable from the
// menu and from the desk.

import { useEffect, useState } from "react";
import { api, type GithubCatalogSnapshot, type GithubRepoDetail, type GithubRepoSummary } from "../api/client.ts";
import { GithubIcon } from "../components/DeskIcons.tsx";
import { GithubGlyph } from "../components/GithubGlyphs.tsx";
import { Working } from "../components/Working.tsx";
import { githubWebUrl } from "../lib/github-link.ts";
import { relativeTime } from "../lib/relative-time.ts";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

function emptyCopy(snap: GithubCatalogSnapshot): string | null {
  if (!snap.configured) {
    if (snap.reason === "misconfigured") return "The GitHub App secrets aren't usable.";
    if (snap.reason === "unavailable") return "GitHub is unavailable.";
    return "The GitHub App isn't set up.";
  }
  if (snap.repos.length > 0) return null;
  if (snap.accounts.length === 0) return "The GitHub App isn't installed on any account yet.";
  return "The GitHub App is installed, and it can't see any repositories yet.";
}

function groups(repos: GithubRepoSummary[]): { account: string; type: string; repos: GithubRepoSummary[] }[] {
  const order: string[] = [];
  const map = new Map<string, GithubRepoSummary[]>();
  for (const repo of repos) {
    const rows = map.get(repo.account);
    if (rows) rows.push(repo);
    else {
      map.set(repo.account, [repo]);
      order.push(repo.account);
    }
  }
  return order.map((account) => ({
    account,
    type: map.get(account)![0].accountType === "Organization" ? "Organization" : "User",
    repos: map.get(account)!,
  }));
}

function Weeks({ weeks }: { weeks: number[] }) {
  const max = Math.max(...weeks, 1);
  const last = weeks.length - 1;
  return (
    <div className="github-weeks" aria-label="Commits over the last year">
      {weeks.map((count, index) => (
        <span
          key={index}
          className={index === last ? "is-now" : undefined}
          style={{ height: `${Math.max(8, Math.round((count / max) * 100))}%` }}
          title={index === last ? `${count} commits, this week` : `${count} commits`}
        />
      ))}
    </div>
  );
}

function Lines({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null || deletions === null) return null;
  return (
    <span className="github-status-diff">
      <span className="github-status-add">+{additions}</span> <span className="github-status-del">−{deletions}</span>
    </span>
  );
}

export function GithubPage() {
  const [snap, setSnap] = useState<GithubCatalogSnapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GithubRepoDetail | null>(null);
  const [detailProblem, setDetailProblem] = useState<string | null>(null);

  async function load(fresh = false) {
    setProblem(null);
    try {
      setSnap(await api.githubRepos(fresh));
    } catch (err) {
      setSnap(null);
      setProblem(err instanceof Error ? err.message : "Could not load repositories");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const [owner, name] = selected.split("/");
    if (!owner || !name) return;
    let cancelled = false;
    setDetail(null);
    setDetailProblem(null);
    api
      .githubRepo(owner, name)
      .then((repo) => {
        if (!cancelled) setDetail(repo);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetailProblem(err instanceof Error ? err.message : "Could not load this repository");
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const blank = snap ? emptyCopy(snap) : null;

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.github.one}</h2>
        <p className="page-subtitle">{vocabSubtitle("github")}</p>
      </div>
      {!snap && !problem ? (
        <p className="empty-state">
          <Working label="Loading repositories" size="lg" srOnly={false} />
        </p>
      ) : problem ? (
        <div className="empty-state">
          <p>{problem}</p>
          <button type="button" className="btn" onClick={() => void load(true)}>
            Try again
          </button>
        </div>
      ) : blank ? (
        <div className="empty-state">
          <p>{blank}</p>
          {snap?.reason === "unavailable" && (
            <button type="button" className="btn" onClick={() => void load(true)}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <div className="github-layout">
          <div className="panel">
            <div className="panel-title">
              <span className="panel-label">Repositories</span>
            </div>
            <div className="panel-body github-repo-list">
              {snap?.truncated && <p className="session-meta">Some repositories may be missing.</p>}
              {groups(snap?.repos ?? []).map((group) => (
                <section key={group.account}>
                  <h3>
                    <span>{group.account}</span>
                    <span className="chip github-fact">{group.type}</span>
                  </h3>
                  {group.repos.map((repo) => (
                    <button
                      key={repo.fullName}
                      type="button"
                      className={selected === repo.fullName ? "is-selected" : undefined}
                      aria-pressed={selected === repo.fullName}
                      onClick={() => setSelected(repo.fullName)}
                    >
                      <GithubGlyph name="repo" />
                      <span className="github-repo-name">{repo.name}</span>
                      <span className="github-repo-meta">
                        <span className="chip github-vis">
                          <GithubGlyph name={repo.private ? "lock" : "public"} />
                          {repo.private ? "private" : "public"}
                        </span>
                        {repo.language && <span className="chip github-lang">{repo.language}</span>}
                        {repo.pushedAt && <span className="github-repo-time">{relativeTime(repo.pushedAt)}</span>}
                      </span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-title">
              <span className="panel-label">{detail?.fullName ?? "Repository"}</span>
            </div>
            <div className="panel-body github-detail">
              {!selected && (
                <p className="github-empty-pick">
                  <GithubIcon size={48} />
                  <span>Choose a repository.</span>
                </p>
              )}
              {selected && !detail && !detailProblem && (
                <p className="empty-state">
                  <Working label="Loading repository" size="lg" srOnly={false} />
                </p>
              )}
              {detailProblem && <p className="empty-state">{detailProblem}</p>}
              {detail && <RepoDetail repo={detail} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RepoDetail({ repo }: { repo: GithubRepoDetail }) {
  const home = githubWebUrl(repo.htmlUrl);
  const commitHref = githubWebUrl(repo.lastCommit?.url);
  return (
    <>
      {repo.description && <p className="github-description">{repo.description}</p>}
      <div className="github-facts">
        <span className="chip github-fact">
          <GithubGlyph name={repo.private ? "lock" : "public"} />
          {repo.private ? "private" : "public"}
        </span>
        {repo.language && <span className="chip github-fact">{repo.language}</span>}
        {repo.defaultBranch && (
          <span className="chip github-fact" title="Default branch">
            <GithubGlyph name="branch" />
            {repo.defaultBranch}
          </span>
        )}
        <span className="chip github-fact">
          <GithubGlyph name="pull" />
          {repo.openPulls.length} open
        </span>
        {home && (
          <a className="chip github-fact" href={home} target="_blank" rel="noopener noreferrer">
            Open on GitHub
          </a>
        )}
      </div>
      {repo.lastCommit && (
        <div className="github-commit">
          <GithubGlyph name="commit" />
          <div>
            <div className="session-meta">Last commit</div>
            {commitHref ? (
              <a href={commitHref} target="_blank" rel="noopener noreferrer">
                {repo.lastCommit.message}
              </a>
            ) : (
              <span>{repo.lastCommit.message}</span>
            )}
            {(repo.lastCommit.author || repo.lastCommit.date) && (
              <div className="session-meta">
                {repo.lastCommit.author}
                {repo.lastCommit.author && repo.lastCommit.date ? " · " : ""}
                {repo.lastCommit.date ? relativeTime(repo.lastCommit.date) : ""}
              </div>
            )}
          </div>
        </div>
      )}
      {repo.contributions && "pending" in repo.contributions && <p className="session-meta">GitHub is still counting commits.</p>}
      {repo.contributions && "weeks" in repo.contributions && (
        <div className="github-weeks-wrap">
          <div className="github-weeks-caption">
            <span>Commits over the last year</span>
            <span>now</span>
          </div>
          <Weeks weeks={repo.contributions.weeks} />
        </div>
      )}
      <h3>Open pull requests</h3>
      {repo.openPulls.length === 0 ? (
        <p className="session-meta">No open pull requests.</p>
      ) : (
        <ul className="github-pulls">
          {repo.openPulls.map((pull) => {
            const href = githubWebUrl(pull.url);
            return (
              <li key={pull.number} className={pull.draft ? "is-draft" : undefined}>
                <GithubGlyph name="pull" />
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    #{pull.number}
                  </a>
                ) : (
                  <span>#{pull.number}</span>
                )}
                <span className="github-pull-title">{pull.title}</span>
                {pull.draft && <span className="chip">draft</span>}
                {pull.author && <span className="session-meta">{pull.author}</span>}
                <Lines additions={pull.additions} deletions={pull.deletions} />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
