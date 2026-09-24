// Click and type on the shared tab. A CSS selector only: this does not accept JavaScript.
// The extension's action.js uses the same limits. Keep them together.

export const BROWSER_ACTION_KINDS = ["click", "type"] as const;
export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

/** What the share owner can report. `skipped` and `no_share` come from the API, not this body. */
export const BROWSER_ACTION_RESULT_ERRORS = [
  "denied",
  "not_found",
  "permission_denied",
  "tab_gone",
  "not_editable",
  "not_shared",
] as const;
export type BrowserActionResultError = (typeof BROWSER_ACTION_RESULT_ERRORS)[number];

const SELECTOR_MAX = 500;
const TEXT_MAX = 8000;

export interface BrowserActionBody {
  kind: BrowserActionKind;
  selector: string;
  text?: string;
}

export function selectorOk(selector: string): boolean {
  if (selector.length === 0 || selector.length > SELECTOR_MAX) return false;
  if (/[\u0000-\u001f\u007f<{}`;]/.test(selector)) return false;
  if (/javascript\s*:/i.test(selector)) return false;
  if (/eval\s*\(/i.test(selector) || /function\s*\(/i.test(selector)) return false;
  if (selector.includes("=>")) return false;
  if (/url\s*\(/i.test(selector) || /expression\s*\(/i.test(selector)) return false;
  return true;
}

/** `{kind:"click", selector}` or `{kind:"type", selector, text}`. Anything else is refused. */
export function parseBrowserAction(body: unknown): BrowserActionBody | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.kind !== "click" && record.kind !== "type") return undefined;
  if (typeof record.selector !== "string") return undefined;
  const selector = record.selector.trim();
  if (!selectorOk(selector)) return undefined;
  if (record.kind === "click") {
    if (keys.some((key) => key !== "kind" && key !== "selector")) return undefined;
    return { kind: "click", selector };
  }
  if (!keys.every((key) => key === "kind" || key === "selector" || key === "text")) return undefined;
  if (typeof record.text !== "string" || record.text.length > TEXT_MAX || record.text.includes("\u0000")) return undefined;
  return { kind: "type", selector, text: record.text };
}

export function parseBrowserActionResult(
  body: unknown,
): { ok: true } | { ok: false; error: BrowserActionResultError } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (record.ok === true) {
    if ("error" in record) return undefined;
    return { ok: true };
  }
  if (typeof record.error !== "string") return undefined;
  if (!(BROWSER_ACTION_RESULT_ERRORS as readonly string[]).includes(record.error)) return undefined;
  return { ok: false, error: record.error as BrowserActionResultError };
}

export function isBrowserActionKind(value: unknown): value is BrowserActionKind {
  return value === "click" || value === "type";
}
