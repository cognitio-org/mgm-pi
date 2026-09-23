// A greeting for kernal.one, written by app.kernal.one after GET /api/me. Not a session and not
// a login: the landing page only prints it. The shape matches landing/public/welcome.js.

const TOKEN = /^[\p{L}][\p{L}\p{M}'’.\-]{0,39}$/u;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export function welcomeCookieAssignment(name: string, hostname: string, secure: boolean): string | null {
  const clean = name.trim();
  if (!TOKEN.test(clean)) return null;
  const shared = hostname === "kernal.one" || hostname.endsWith(".kernal.one") ? "; Domain=.kernal.one" : "";
  const locked = secure ? "; Secure" : "";
  return `kernal_welcome=${encodeURIComponent(clean)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${shared}${locked}`;
}
