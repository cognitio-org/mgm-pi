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
  /\b((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/)[^\s:@/]+:[^\s@/]+@/g, // URIs with a password
  /(authorization:\s*(?:bearer|basic)\s+)[^\s"']+/gi,
  /((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)["']?\s*[:=]\s*)(["'])[^"'\n]{4,}\2/gi, // quoted, may hold spaces
  /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: string) => (typeof prefix === "string" && match.startsWith(prefix) && prefix.length < match.length ? `${prefix}[redacted]` : "[redacted]"));
  }
  return out;
}
