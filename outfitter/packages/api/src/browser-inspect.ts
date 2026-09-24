// DevTools inspect on the shared tab. Console text only.
// Cookie and Authorization header values are stripped before a result is stored or sent.
// There is no network-header field and no transcript entry.

export const INSPECT_MESSAGE_LIMIT = 40;
export const INSPECT_TEXT_MAX = 500;

/** What the share owner can report. `skipped`, `no_share`, and `rejected` come from the API. */
export const BROWSER_INSPECT_RESULT_ERRORS = [
  "denied",
  "not_shared",
  "tab_gone",
  "permission_denied",
  "debugger_attached",
] as const;
export type BrowserInspectResultError = (typeof BROWSER_INSPECT_RESULT_ERRORS)[number];

const ELEMENT_DESCRIPTION = /^[a-z][a-z0-9-]*(?:#[A-Za-z_][A-Za-z0-9_-]{0,63})?(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,8}$/;

/** Same replacement as chrome/extension/inspect.js. */
export function redactHeaderText(text: string): string {
  return text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
    "$1: [redacted]",
  );
}

/** `{}` or an empty body. A tab id, a script, or anything else is refused. */
export function parseBrowserInspectCreate(body: unknown): true | undefined {
  if (body === undefined || body === null) return true;
  if (typeof body !== "object" || Array.isArray(body)) return undefined;
  if (Object.keys(body).length !== 0) return undefined;
  return true;
}

export interface BrowserInspectSuccess {
  ok: true;
  messages: string[];
  element: string | null;
}

export function parseBrowserInspectResult(
  body: unknown,
): BrowserInspectSuccess | { ok: false; error: BrowserInspectResultError } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") {
    if (!(BROWSER_INSPECT_RESULT_ERRORS as readonly string[]).includes(record.error)) return undefined;
    return { ok: false, error: record.error as BrowserInspectResultError };
  }
  if (!Array.isArray(record.messages)) return undefined;
  if (record.messages.length > INSPECT_MESSAGE_LIMIT) return undefined;
  const messages: string[] = [];
  for (const line of record.messages) {
    if (typeof line !== "string") return undefined;
    const text = redactHeaderText(line).replace(/\u0000/g, "").trim().slice(0, INSPECT_TEXT_MAX);
    if (text) messages.push(text);
  }
  let element: string | null = null;
  if (record.element !== undefined && record.element !== null) {
    if (typeof record.element !== "string") return undefined;
    const trimmed = record.element.trim();
    if (!ELEMENT_DESCRIPTION.test(trimmed)) return undefined;
    element = trimmed;
  }
  return { ok: true, messages, element };
}
