// Long assistant prose opens in ReadingDialog instead of filling the transcript. A heading is the
// dialog title, not the opening paragraph.

const LONG_DOCUMENT_CHARS = 1200;
const OPENING_CHARS = 320;

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

function blocksOf(text: string): string[][] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))
    .filter((lines) => lines.length > 0);
}

function clipOpening(text: string): string {
  if (text.length <= OPENING_CHARS) return text;
  return `${text.slice(0, OPENING_CHARS).trimEnd()}…`;
}

/** First prose paragraph, clipped to ~320 characters. Heading-only text falls back to the title. */
export function readingOpening(text: string): string {
  const blocks = blocksOf(text);
  const prose = blocks.find((lines) => lines.some((line) => !isHeadingLine(line)));
  if (!prose) {
    const title = readingTitle(text);
    return title === "Reading" ? "" : title;
  }
  return clipOpening(prose.filter((line) => !isHeadingLine(line)).join(" "));
}
