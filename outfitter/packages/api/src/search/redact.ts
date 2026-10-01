// Secret-shaped strings out of text before it is indexed (Sysop tools, #289). Indexed text is sent
// to MongoDB's embedding service and comes back in search results, so tokens a tool printed must not
// ride along. Pattern-based and deliberately broad: a false positive costs a word in a snippet.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\boutf_[A-Za-z0-9_-]{8,}/g, // Outfitter Dongles
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
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, // any URI with a user:password (agentd's logger does the same)
  /(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi,
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
