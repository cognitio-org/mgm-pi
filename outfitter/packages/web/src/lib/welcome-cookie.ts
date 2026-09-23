// A greeting for kernal.one, written by app.kernal.one after GET /api/me. Not a session and not
// a login: the landing page only prints it. The shape matches landing/public/welcome.js.

const TOKEN = /^[\p{L}][\p{L}\p{M}'’.\-]{0,39}$/u;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

function scope(hostname: string, secure: boolean): string {
  const shared = hostname === "kernal.one" || hostname.endsWith(".kernal.one") ? "; Domain=.kernal.one" : "";
  const locked = secure ? "; Secure" : "";
  return `; Path=/; SameSite=Lax${shared}${locked}`;
}

export function welcomeCookieAssignment(name: string, hostname: string, secure: boolean): string | null {
  const clean = name.normalize("NFKC").trim();
  if (!TOKEN.test(clean)) return null;
  return `kernal_welcome=${encodeURIComponent(clean)}${scope(hostname, secure)}; Max-Age=${MAX_AGE_SECONDS}`;
}

/** Deletes a greeting set for this host. Same Path, Domain, and Secure as the write, or the
 *  browser keeps the old cookie. */
export function welcomeCookieClear(hostname: string, secure: boolean): string {
  return `kernal_welcome=${scope(hostname, secure)}; Max-Age=0`;
}
