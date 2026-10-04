// Secret-shaped strings out of text before it leaves the Drive for Sentry (#424: agent spans'
// prompts, responses and tool input and output, and log lines). A copy of the api's
// packages/api/src/search/redact.ts (byte-identical to Kernal's _shared/redact.ts) plus the two
// patterns the api's sentry.ts adds to it (Kernal's kda_/kdr_/kdc_ device tokens, a bare bearer
// token): agentd is built and shipped on its own (image/Dockerfile's agentd-builder), so it can't
// import across packages. A pattern added there goes here too. Pattern-based and deliberately
// broad: a false positive costs a word. The run's own secrets (its GitHub and LiteLLM keys) are
// matched exactly besides, by the callers (agent-trace.ts, and logger.ts's registry for log lines).

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\boutf_[A-Za-z0-9_-]{8,}/g, // Outfitter Dongles
  /\bkd[acr]_[A-Za-z0-9_-]{16,}/g, // Kernal device access/refresh tokens and device codes (#389)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g, // Anthropic, OpenAI, OpenRouter, LiteLLM keys
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\brk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, // any URI with a user:password (logger.ts does the same)
  /(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, // a bearer token without its header name
  /((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)["']?\s*[:=]\s*)(["'])[^"'\n]{4,}\2/gi, // quoted, may hold spaces
  // Also with a prefix, as env vars have one (VOYAGE_API_KEY=, NGROK_AUTHTOKEN=): \b doesn't fire after `_`.
  /(?<![A-Za-z0-9])((?:[A-Za-z0-9]+_)*(?:api[_-]?key|secret|password|passwd|token|authtoken|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
  /\bpa-[A-Za-z0-9_-]{30,}/g, // Voyage AI keys
  // E9 PR5: env-style names ending in a bare `_KEY` (`OUTFITTER_LITELLM_KEY=`), which the prefixed
  // pattern above doesn't list. The prefix is required, so a lone `key=` isn't caught.
  /(?<![A-Za-z0-9])([A-Za-z0-9]+_(?:[A-Za-z0-9]+_)*key["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: string) => (typeof prefix === "string" && match.startsWith(prefix) && prefix.length < match.length ? `${prefix}[redacted]` : "[redacted]"));
  }
  return out;
}
