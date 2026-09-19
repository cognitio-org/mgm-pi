/**
 * MGM startup banner — replaces pi's built-in header with block-letter "MGM", a provider
 * indicator and the live model line. /builtin-header restores pi's default header.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { bannerLines } from "./lib.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle("MGM · pi");
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const m = ctx.model;
        return bannerLines((c, t) => theme.fg(c as any, t), { width, version: VERSION, model: m ? { provider: m.provider, id: m.id } : undefined })
          .map((l) => truncateToWidth(l, width));
      },
      invalidate() {},
    }));
  });

  pi.registerCommand("builtin-header", {
    description: "Restore pi's built-in header",
    handler: async (_a, ctx) => { ctx.ui.setHeader(undefined); ctx.ui.notify("Built-in header restored", "info"); },
  });
}
