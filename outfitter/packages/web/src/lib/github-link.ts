/** An https://github.com link, or null. The page never follows a lookalike host. */
export function githubWebUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.toString();
  } catch {
    return null;
  }
  return null;
}
