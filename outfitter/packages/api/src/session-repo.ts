/** `owner/repo`, `https://github.com/owner/repo[.git]`, or `git@github.com:owner/repo.git`. */
export function parseSessionRepo(repo: string): { owner: string; repo: string } | undefined {
  const raw = repo.trim();
  if (!raw) return undefined;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(raw);
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
      const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/").filter(Boolean);
      if (!parts[0] || !parts[1]) return undefined;
      return { owner: decodeURIComponent(parts[0]), repo: decodeURIComponent(parts[1]) };
    } catch {
      return undefined;
    }
  }
  const short = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(raw);
  if (!short?.[1] || !short[2]) return undefined;
  return { owner: short[1], repo: short[2] };
}
