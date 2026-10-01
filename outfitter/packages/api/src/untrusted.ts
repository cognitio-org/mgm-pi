// Characters a person can't see but a model reads (E9.9 review H1), for untrusted text that is shown
// to a person or put into a prompt: controls (newline and tab are kept where it matters), format
// characters (zero-width, bidi, soft hyphen), private use, Unicode tags (the "ASCII smuggling"
// range), variation selectors, line and paragraph separators.

const CLASS = "[\\p{Cc}\\p{Cf}\\p{Co}\\u{E0000}-\\u{E007F}\\u{FE00}-\\u{FE0F}\\u{E0100}-\\u{E01EF}\\u{2028}\\u{2029}]";

/** Global, for `replace`. */
export const HIDDEN = new RegExp(CLASS, "gu");
/** Non-global twin, for `test` (no `lastIndex` to carry between calls). */
export const HIDDEN_ONE = new RegExp(CLASS, "u");

/** Whether `text` holds a hidden character other than newline and tab. */
export function hasHidden(text: string): boolean {
  return HIDDEN_ONE.test(text.replace(/[\n\t]/g, ""));
}

/** `text` without hidden characters; newline and tab stay unless `keepNlTab` is false. */
export function stripHidden(text: string, keepNlTab = true): string {
  return text.replace(HIDDEN, (c) => (keepNlTab && (c === "\n" || c === "\t") ? c : ""));
}
