/**
 * Cloudflare Tunnel (#386, the secondary goal of epic #378): not built yet. Registered so `auto`,
 * the `localHost.tunnel` choice and the UI (#385) already know the name. It always reports
 * unavailable and refuses to start, which `auto` treats like any provider that cannot run here.
 */
import { TunnelError, type TunnelProvider } from "./types.ts";

export const CLOUDFLARE_UNAVAILABLE = "Cloudflare Tunnel is not supported yet (#386)";

export function cloudflareProvider(): TunnelProvider {
  return {
    id: "cloudflare",
    async status() {
      return { provider: "cloudflare", available: false, reason: CLOUDFLARE_UNAVAILABLE };
    },
    async start() {
      throw new TunnelError("unavailable", CLOUDFLARE_UNAVAILABLE);
    },
  };
}
