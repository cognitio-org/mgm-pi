/**
 * mgm startup banner — replaces pi's built-in header with the user's block letters (MGM for
 * Matthew, TEJ for Matej, initials for anyone else), a provider indicator and the live model line.
 * Recognised users get an entrance animation: letters reveal left to right, then the colours pulse.
 * /builtin-header restores pi's default header.
 *
 * Identity comes from MGM_USER (set by /setup), else git user.email / user.name, else $USER.
 */
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { bannerLines, whoami, animationFrames, type Identity } from "./lib.ts";

const git = (key: string) => { try { return execFileSync("git", ["config", "--get", key], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; } };

export function detectIdentity(): Identity {
  return whoami({ MGM_USER: process.env.MGM_USER, gitEmail: git("user.email"), gitName: git("user.name"), osUser: process.env.USER });
}

export default function (pi: ExtensionAPI) {
  const identity = detectIdentity();
  pi.on("session_start", async (_e, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(`${identity.letters} · mgm`);
    const total = process.env.MGM_NO_ANIMATION ? 0 : animationFrames(identity);
    let frame = total ? 0 : Infinity;
    ctx.ui.setHeader((tui, theme) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      if (total) timer = setInterval(() => { frame++; tui.requestRender(); if (frame >= total) { clearInterval(timer); timer = undefined; frame = Infinity; } }, 45);
      return {
        render(width: number): string[] {
          const m = ctx.model;
          return bannerLines((c, t) => theme.fg(c as any, t), { width, version: VERSION, identity, frame, model: m ? { provider: m.provider, id: m.id } : undefined })
            .map((l) => truncateToWidth(l, width));
        },
        invalidate() {},
        dispose() { if (timer) clearInterval(timer); },
      };
    });
    if (!identity.known) ctx.ui.notify(`Hi ${identity.name}. Run /setup to configure your model connections; set MGM_USER in .env to name yourself.`, "info");
  });

  pi.registerCommand("builtin-header", {
    description: "Restore pi's built-in header",
    handler: async (_a, ctx) => { ctx.ui.setHeader(undefined); ctx.ui.notify("Built-in header restored", "info"); },
  });
}
