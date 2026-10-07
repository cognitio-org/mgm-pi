/**
 * The access rules a shared model server gets when Outfitter has not sent its own (#380; #383
 * replaces them with a per-host policy only the api writes). One ngrok traffic policy, JSON (which
 * is valid YAML), that rate-limits per client, then refuses a request without the bearer token, then
 * one for a path outside the allow-list. The guard proxy (proxy.ts) applies the same rules again on
 * the laptop, so a policy that is wrong or missing does not open LM Studio's management API.
 *
 * Values are spliced into CEL expressions, so they are checked against strict patterns first: a
 * path or token that could close the quoted string is a credentials error, never an expression.
 */
import { DEFAULT_ALLOW_PATHS, DEFAULT_RATE_LIMIT, TunnelError, type RateLimit } from "./types.ts";

const PATH_RE = /^\/[A-Za-z0-9._\/-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._~+\/=-]{16,512}$/;

export function checkAllowPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new TunnelError("credentials", "the path allow-list is empty");
  for (const p of paths) {
    if (!PATH_RE.test(p) || p.includes("..") || p.includes("//")) throw new TunnelError("credentials", `not an allowed path: ${JSON.stringify(p)}`);
  }
  return [...paths];
}

export function checkRateLimit(r: RateLimit): RateLimit {
  const ok = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
  if (!ok(r.requests, 1_000_000) || !ok(r.windowSeconds, 86_400)) {
    throw new TunnelError("credentials", `not a rate limit: ${r.requests} requests per ${r.windowSeconds} s`);
  }
  return { requests: r.requests, windowSeconds: r.windowSeconds };
}

export function checkBearerToken(token: string): string {
  if (!TOKEN_RE.test(token)) throw new TunnelError("credentials", "the bearer token must be 16-512 URL-safe characters");
  return token;
}

const json404 = JSON.stringify({ error: { message: "not found", type: "not_found" } });

/** The built-in policy for ngrok's `--traffic-policy-file`. */
export function ngrokTrafficPolicy(opts: { allowPaths?: readonly string[]; rateLimit?: RateLimit; bearerToken?: string } = {}): string {
  const paths = checkAllowPaths(opts.allowPaths ?? DEFAULT_ALLOW_PATHS);
  const limit = checkRateLimit(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
  const rules: unknown[] = [
    {
      actions: [{
        type: "rate-limit",
        config: {
          name: "kernal-local-host",
          algorithm: "sliding_window",
          capacity: limit.requests,
          rate: `${limit.windowSeconds}s`,
          bucket_key: ["conn.client_ip"],
        },
      }],
    },
  ];
  if (opts.bearerToken !== undefined) {
    const token = checkBearerToken(opts.bearerToken);
    rules.push({
      expressions: [`!('authorization' in req.headers) || req.headers['authorization'][0] != 'Bearer ${token}'`],
      actions: [{ type: "deny", config: { status_code: 401 } }],
    });
  }
  rules.push({
    expressions: [`!(req.url.path in [${paths.map((p) => `'${p}'`).join(", ")}])`],
    actions: [{ type: "custom-response", config: { status_code: 404, headers: { "content-type": "application/json" }, body: json404 } }],
  });
  return JSON.stringify({ on_http_request: rules });
}
