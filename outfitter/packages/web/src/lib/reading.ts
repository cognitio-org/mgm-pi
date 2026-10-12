// A long message scrolls in its own box in the transcript and can pop out into ReadingDialog; its
// first heading is the dialog title.

const LONG_DOCUMENT_CHARS = 1200;

function isHeadingLine(line: string): boolean {
  return /^#{1,6} /.test(line);
}

/** True when trimmed text is at least 1200 characters, or the text has two or more ATX headings. */
export function isLongDocument(text: string): boolean {
  if (text.trim().length >= LONG_DOCUMENT_CHARS) return true;
  let headings = 0;
  for (const line of text.split("\n")) {
    if (isHeadingLine(line)) {
      headings += 1;
      if (headings >= 2) return true;
    }
  }
  return false;
}

function atxTitle(line: string): string | null {
  const match = /^(#{1,6}) (.*)$/.exec(line.replace(/\r$/, ""));
  if (!match) return null;
  return match[2].replace(/\s+#+\s*$/, "").trim();
}

/** First ATX heading with the marks stripped, or "Reading". */
export function readingTitle(text: string): string {
  for (const line of text.split("\n")) {
    const title = atxTitle(line);
    if (title === null) continue;
    return title || "Reading";
  }
  return "Reading";
}
