/**
 * The tunnel registry (#380 LH-2): the providers by name, the `localHost.tunnel` choice
 * (`auto | ngrok | cloudflare`), and openTunnel(), which puts the guard proxy in front of the model
 * server and points the chosen provider at it. The background service (#381) calls openTunnel();
 * nothing here runs on import.
 *
 * `auto` takes the first provider, in AUTO_ORDER, that has credentials and whose runtime is
 * available here. Naming a provider skips the choice but not the checks. Nothing selectable is a
 * result with every provider's reason, never an exception, so the service can show it and retry.
 *
 * Credentials come from Outfitter (#383). Until then interimCredentialsFromEnv() reads today's
 * `.env` names (tunnel.sh's domain and bearer token, plus NGROK_AUTHTOKEN): the caller passes the
 * env it loaded, and nothing here reads a credential file, ngrok's own config included.
 */
import { cloudflareProvider } from "./cloudflare.ts";
import { ngrokProvider } from "./ngrok.ts";
import { startGuardProxy, type GuardStats } from "./proxy.ts";
import {
  DEFAULT_ALLOW_PATHS, TunnelError,
  type NgrokCredentials, type ProviderStatus, type RateLimit, type Tunnel, type TunnelChoice, type TunnelCredentials,
  type TunnelHealth, type TunnelProvider, type TunnelProviderId,
} from "./types.ts";

export * from "./types.ts";

export const AUTO_ORDER: readonly TunnelProviderId[] = ["ngrok", "cloudflare"];

export type ProviderRegistry = Readonly<Record<TunnelProviderId, TunnelProvider>>;

export function defaultProviders(): ProviderRegistry {
  return { ngrok: ngrokProvider(), cloudflare: cloudflareProvider() };
}

/** A setting's value as a choice; anything unknown is `auto`. */
export function parseTunnelChoice(value: unknown): TunnelChoice {
  return value === "ngrok" || value === "cloudflare" || value === "auto" ? value : "auto";
}

export type Selection =
  | { ok: true; provider: TunnelProvider; credentials: TunnelCredentials; status: ProviderStatus; statuses: ProviderStatus[] }
  | { ok: false; reason: string; statuses: ProviderStatus[] };

/** Picks the provider for `choice`. Never throws: a provider whose status() fails counts as unavailable. */
export async function selectProvider(choice: TunnelChoice, credentials: readonly TunnelCredentials[], providers: ProviderRegistry = defaultProviders()): Promise<Selection> {
  const ids = choice === "auto" ? AUTO_ORDER : [choice];
  const statuses: ProviderStatus[] = [];
  for (const id of ids) {
    const provider = providers[id];
    const creds = credentials.find((c) => c.provider === id);
    let status: ProviderStatus;
    try {
      status = await provider.status(creds);
    } catch (e: any) {
      status = { provider: id, available: false, reason: `status check failed: ${e?.message ?? e}` };
    }
    if (status.available && !creds) status = { ...status, available: false, reason: `no ${id} credentials` };
    statuses.push(status);
    if (status.available && creds) return { ok: true, provider, credentials: creds, status, statuses };
  }
  const why = statuses.map((s) => `${s.provider}: ${s.reason ?? "unavailable"}`).join("; ");
  return { ok: false, reason: choice === "auto" ? `no tunnel provider can run here (${why})` : why, statuses };
}

export interface OpenTunnelOptions {
  choice: TunnelChoice;
  credentials: readonly TunnelCredentials[];
  /** The model server, e.g. `http://127.0.0.1:1234`. */
  localUrl: string;
  allowPaths?: readonly string[];
  rateLimit?: RateLimit;
  keepAliveMs?: number;
  providers?: ProviderRegistry;
  onDown?: (reason: string) => void;
  onLog?: (line: string) => void;
}

export interface LocalHostTunnel extends Tunnel {
  /** The guard proxy's counters: requests forwarded and refused, keep-alives written. */
  guard(): GuardStats;
}

/**
 * Starts the guard proxy on a free loopback port, then the selected provider pointed at it. Throws
 * TunnelError: kind "unavailable" when no provider can run (the message lists why, per provider).
 */
export async function openTunnel(opts: OpenTunnelOptions): Promise<LocalHostTunnel> {
  const sel = await selectProvider(opts.choice, opts.credentials, opts.providers);
  if (!sel.ok) throw new TunnelError("unavailable", sel.reason);
  const allowPaths = opts.allowPaths ?? DEFAULT_ALLOW_PATHS;
  const bearerToken = sel.credentials.provider === "ngrok" ? sel.credentials.bearerToken : undefined;
  const guard = await startGuardProxy({ upstream: opts.localUrl, allowPaths, rateLimit: opts.rateLimit, bearerToken, keepAliveMs: opts.keepAliveMs, onLog: opts.onLog });
  let tunnel: Tunnel;
  try {
    tunnel = await sel.provider.start({ localUrl: guard.url, credentials: sel.credentials, allowPaths, rateLimit: opts.rateLimit, onDown: opts.onDown, onLog: opts.onLog });
  } catch (err) {
    await guard.close();
    throw err;
  }
  let stopping: Promise<void> | undefined;
  return {
    provider: tunnel.provider,
    get publicUrl() { return tunnel.publicUrl; },
    health: (): TunnelHealth => tunnel.health(),
    guard: () => guard.stats(),
    stop: () => (stopping ??= (async () => {
      try { await tunnel.stop(); } finally { await guard.close(); }
    })()),
  };
}

/** Today's `.env` values as ngrok credentials, until Outfitter provisions them (#383): NGROK_AUTHTOKEN,
 * TUNNEL_DOMAIN_LMSTUDIO (a bare domain, as tunnel.sh takes it) and LOCAL_TUNNEL_TOKEN. */
export function interimCredentialsFromEnv(e: Readonly<Record<string, string | undefined>>): NgrokCredentials | undefined {
  const authtoken = e.NGROK_AUTHTOKEN?.trim();
  if (!authtoken) return undefined;
  const domain = e.TUNNEL_DOMAIN_LMSTUDIO?.trim();
  const bearer = e.LOCAL_TUNNEL_TOKEN?.trim();
  return {
    provider: "ngrok",
    authtoken,
    ...(domain ? { url: /^https?:\/\//.test(domain) ? domain : `https://${domain}` } : {}),
    ...(bearer ? { bearerToken: bearer } : {}),
  };
}
