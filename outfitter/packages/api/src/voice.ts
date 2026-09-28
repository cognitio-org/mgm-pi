// Web voice (#252, epic #256): mints short-lived Deepgram tokens so the browser can stream a mic
// straight to wss://api.deepgram.com/v1/listen without ever seeing the key. The key is a Member key
// with usage:read in the same Deepgram project as kernal's bundle key (which is usage-only and can't
// call /v1/auth/grant); it lives in Secret Manager as outfitter-deepgram-key (deploy/service.sh).

import { createHash } from "node:crypto";

export const VOICE_ENGINES = ["deepgram", "builtin"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

export const AFTER_SPEAKING = ["send", "review"] as const;
export type AfterSpeaking = (typeof AFTER_SPEAKING)[number];

/** A person's voice preferences (User.voice). Owner decision on #251: "send" is the default. */
export interface VoicePrefs {
  afterSpeaking: AfterSpeaking;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = { afterSpeaking: "send" };

export interface VoiceToken {
  token: string;
  expiresAt: string;
  model: string;
  language: string;
  /** Deepgram usage tag the browser must put on every stream, so #257 can read a person's spend
   * back with GET /v1/projects/<id>/usage?tag=. */
  tag: string;
}

export type MintResult =
  | { ok: true; token: VoiceToken }
  | { ok: false; reason: "disabled" | "rate_limited" | "upstream"; retryAfterSeconds?: number; detail?: string };

export interface VoiceServiceOptions {
  apiKey: string;
  model: string;
  language: string;
  /** How long a token may be used to open a socket. The socket outlives it. */
  ttlSeconds: number;
  /** Tokens one person may mint per minute. */
  perMinute: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const WINDOW_MS = 60_000;

/** The usage tag for a person: a hash, so Deepgram's usage records never hold an email address.
 * Stable across deploys; #257 recomputes it from the signed-in email to read that person's usage. */
export function voiceTag(email: string): string {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `outfitter-user-${digest}`;
}

export class VoiceService {
  private readonly opts: VoiceServiceOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Mint times per person within the last minute. Per process: Cloud Run may run a few instances,
   * so the real ceiling is perMinute times that, which is fine for a guard against a runaway client. */
  private readonly recent = new Map<string, number[]>();

  constructor(opts: VoiceServiceOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.apiKey !== "";
  }

  async mint(email: string): Promise<MintResult> {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    const key = email.trim().toLowerCase();
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= this.opts.perMinute) {
      this.recent.set(key, times);
      return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.ceil((times[0] + WINDOW_MS - now) / 1000) };
    }
    times.push(now);
    this.recent.set(key, times);

    let res: Response;
    try {
      res = await this.fetchImpl(GRANT_URL, {
        method: "POST",
        headers: { Authorization: `Token ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl_seconds: this.opts.ttlSeconds }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, reason: "upstream", detail: err instanceof Error ? err.message : String(err) };
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; err_msg?: unknown };
    if (!res.ok || typeof body.access_token !== "string") {
      const msg = typeof body.err_msg === "string" ? body.err_msg : "";
      return { ok: false, reason: "upstream", detail: `deepgram ${res.status}${msg ? `: ${msg}` : ""}` };
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : this.opts.ttlSeconds;
    return {
      ok: true,
      token: {
        token: body.access_token,
        expiresAt: new Date(now + expiresIn * 1000).toISOString(),
        model: this.opts.model,
        language: this.opts.language,
        tag: voiceTag(email),
      },
    };
  }
}
