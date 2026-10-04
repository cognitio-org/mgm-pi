// #389 CA-1 web (docs/specs/central-auth.md §1.2, §1.9, §6): pure helpers for the approve page and
// the Devices page. Nothing here talks to the api.

/** The user-code alphabet (§1.2): consonants only, so a code never spells a word or mixes up 0/O. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

/** Uppercases and drops everything outside the alphabet, as the api does. */
export function userCodeLetters(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    if (USER_CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** `"bcdf ghjk"` -> `"BCDF-GHJK"`; null unless exactly 8 letters of the alphabet remain. */
export function normalizeUserCode(input: string): string | null {
  const letters = userCodeLetters(input);
  if (letters.length !== USER_CODE_LENGTH) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** What the code field shows while someone types: the letters so far, a dash after the fourth,
 * never more than 8 letters. */
export function formatUserCodeInput(input: string): string {
  const letters = userCodeLetters(input).slice(0, USER_CODE_LENGTH);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same address. */
function canonicalIp(ip: string): string {
  return ip.trim().toLowerCase().replace(/^::ffff:/, "");
}

/** §1.9: true when both addresses are known and differ, so the page warns that the request came
 * from somewhere else. An unknown address on either side never warns. */
export function ipsDiffer(requestIp: string | undefined, approverIp: string | undefined): boolean {
  if (!requestIp?.trim() || !approverIp?.trim()) return false;
  return canonicalIp(requestIp) !== canonicalIp(approverIp);
}

const OS_LABELS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

function archLabel(os: string, arch: string): string {
  if (arch === "arm64") return os === "darwin" ? "Apple silicon" : "ARM";
  if (arch === "x64") return os === "darwin" ? "Intel" : "x86-64";
  return arch;
}

/** Kernal's `process.platform-process.arch` (`darwin-arm64`) in words (`macOS, Apple silicon`);
 * anything unrecognised is shown as sent. */
export function platformLabel(platform: string | undefined): string | undefined {
  if (!platform) return undefined;
  const [os = "", arch] = platform.split("-", 2);
  const osLabel = OS_LABELS[os];
  if (!osLabel) return platform;
  return arch ? `${osLabel}, ${archLabel(os, arch)}` : osLabel;
}

/** "expires in 7 min" / "expires within a minute" / "expired". */
export function codeExpiry(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const m = Math.ceil(ms / 60_000);
  return m <= 1 ? "expires within a minute" : `expires in ${m} min`;
}

export function isExpired(expiresAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t <= now;
}

/** The address a device was last seen from, else the one it signed in from. */
export function deviceIp(row: { lastSeenIp?: string; loginIp?: string }): string | undefined {
  return row.lastSeenIp || row.loginIp || undefined;
}
