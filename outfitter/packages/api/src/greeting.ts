// The name the browser may store so kernal.one can say hello on a later visit. It is not a
// credential: the landing page (public/welcome.js) checks the same shape again before showing it,
// and a forged cookie only changes that one line.

const TOKEN = /^[\p{L}][\p{L}\p{M}'’.\-]{0,39}$/u;

function firstToken(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/)[0];
}

function fromEmail(email: string | null | undefined): string | undefined {
  const local = (email ?? "").split("@")[0] ?? "";
  const word = local.split(/[+.]/)[0] ?? "";
  if (!/^[A-Za-z][A-Za-z'.-]{1,39}$/.test(word)) return undefined;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** The person's given name when their user row has one, otherwise a readable piece of their
 *  sign-in address. Undefined when neither is safe to put in a cookie. */
export function greetingName(user: { name?: string | null; email?: string | null }): string | undefined {
  const recorded = firstToken(user.name);
  if (recorded && TOKEN.test(recorded)) return recorded;
  return fromEmail(user.email);
}
