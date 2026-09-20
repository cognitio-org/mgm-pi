/**
 * /context — what is actually in the context window, and what a compaction would reclaim.
 *
 * The breakdown is measured from the real provider payload (pi's `before_provider_request` hook), so
 * the system prompt, the tool schemas and every message are counted as they are sent rather than
 * guessed from the transcript. Totals come from pi's own usage when the provider has reported one.
 *
 *   /context           panel: proportional bar, per-part tokens, the largest tool schemas, a verdict
 *   /context export    write a self-contained HTML report and open it in the browser
 *   /context off       take the panel down
 *
 *   MGM_REPORT_DIR     where reports are written (default ~/.mgm/reports)
 *   MGM_NO_BROWSER=1   write the report, do not open it
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderPanel, type Seg } from "../connect/lib.ts";
import {
  CATEGORY_LABELS, CATEGORY_ORDER, analysePayload, buildView, mermaidPie, pct, thousands, verdict,
  type Breakdown, type Category, type ContextView,
} from "./lib.ts";
import { htmlReport, legend, svgBar, svgDonut, table, type Slice } from "./report.ts";

/** Terminal theme colours per part, and hex for the HTML report. */
const COLOURS: Record<Category | "free", { theme: string; hex: string }> = {
  system: { theme: "accent", hex: "#4f8ef7" },
  tools: { theme: "borderAccent", hex: "#8b5cf6" },
  user: { theme: "success", hex: "#22c55e" },
  assistant: { theme: "text", hex: "#0ea5e9" },
  thinking: { theme: "muted", hex: "#a3a3a3" },
  toolResults: { theme: "warning", hex: "#f59e0b" },
  images: { theme: "error", hex: "#ef4444" },
  other: { theme: "dim", hex: "#6b7280" },
  free: { theme: "dim", hex: "#2a2d30" },
};

export const reportDir = () => process.env.MGM_REPORT_DIR || join(homedir(), ".mgm", "reports");

/** Open a file with the desktop's own handler; never fatal, and skippable. */
export function openInBrowser(file: string): Promise<boolean> {
  if (process.env.MGM_NO_BROWSER) return Promise.resolve(false);
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open";
  return new Promise((resolve) => execFile(opener, [file], { timeout: 8000 }, (err) => resolve(!err)));
}

/** Panel rows: the bar, then the parts that are actually present, then the shape of the session. */
export function panelRows(view: ContextView, width: number, paint: (color: string, text: string) => string): Seg[][] {
  const inner = Math.max(24, Math.min(width - 6, 90));
  const rows: Seg[][] = [];
  const cells: Seg[] = [];
  let used = 0;
  for (const category of CATEGORY_ORDER) {
    const count = Math.round((view.tokens[category] / view.window) * inner);
    if (count > 0) { cells.push(["█".repeat(count), COLOURS[category].theme]); used += count; }
  }
  cells.push(["░".repeat(Math.max(0, inner - used)), "dim"]);
  rows.push(cells);
  rows.push([[`${thousands(view.total)} of ${thousands(view.window)} tokens `, "text"], [`${pct(view.percent)} used`, view.percent >= 0.85 ? "error" : view.percent >= 0.6 ? "warning" : "success"], [view.estimated ? "  (estimated, no provider total yet)" : "", "dim"]]);
  rows.push([["", null]]);
  for (const category of CATEGORY_ORDER) {
    const count = view.tokens[category];
    if (!count) continue;
    rows.push([["■ ", COLOURS[category].theme], [CATEGORY_LABELS[category].padEnd(16), "muted"], [thousands(count).padStart(8), "text"], [`  ${pct(count / view.window).padStart(5)}`, "dim"]]);
  }
  rows.push([["□ ", "dim"], ["free".padEnd(16), "muted"], [thousands(view.free).padStart(8), "text"]]);
  rows.push([["", null]]);
  rows.push([[`${view.messageCount} messages · ${view.toolCount} tools`, "dim"], [view.model ? `  ${view.model}` : "", "dim"]]);
  if (view.largestTools.length) rows.push([["biggest schemas: ", "muted"], [view.largestTools.map((t) => `${t.name} ${thousands(t.tokens)}`).join(", "), "dim"]]);
  rows.push([["", null]]);
  rows.push([[verdict(view), view.percent >= 0.85 ? "warning" : "text"]]);
  return rows;
}

/** The same numbers as a self-contained page. */
export function buildReport(view: ContextView, project: string): string {
  const slices: Slice[] = CATEGORY_ORDER.filter((c) => view.tokens[c] > 0)
    .map((c) => ({ label: CATEGORY_LABELS[c], value: view.tokens[c], color: COLOURS[c].hex }));
  const withFree: Slice[] = [...slices, { label: "free", value: view.free, color: "#d1d5db" }];
  return htmlReport({
    title: "Context window",
    subtitle: `${project}${view.model ? ` · ${view.model}` : ""} · ${thousands(view.total)} of ${thousands(view.window)} tokens (${pct(view.percent)})`,
    verdict: verdict(view),
    sections: [
      { title: "Composition", html: `${svgBar(withFree)}<div class="split">${svgDonut(withFree)}${legend(withFree, view.window)}</div>` },
      { title: "Session", html: table(["", "count"], [["messages", view.messageCount], ["tool schemas", view.toolCount], ["reclaimable by compaction", thousands(view.reclaimable ?? 0)], ["compaction triggers at", view.compactAt ? thousands(view.compactAt) : "—"]]) },
      ...(view.largestTools.length ? [{ title: "Largest tool schemas", html: table(["tool", "tokens"], view.largestTools.map((t) => [t.name, thousands(t.tokens)])) }] : []),
    ],
    mermaid: mermaidPie(view),
  });
}

export default function (pi: ExtensionAPI) {
  let latest: { breakdown: Breakdown; model?: string } | undefined;

  // Observe only: the payload is measured and handed back untouched.
  pi.on("before_provider_request", async (event: any, ctx) => {
    try {
      const payload = event?.payload;
      if (payload && typeof payload === "object") latest = { breakdown: analysePayload(payload), model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined };
    } catch {}
    return undefined;
  });

  const view = (ctx: ExtensionCommandContext): ContextView | undefined => {
    if (!latest) return undefined;
    const usage = ctx.getContextUsage?.();
    return buildView({
      breakdown: latest.breakdown,
      reportedTotal: usage?.tokens ?? null,
      window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 128_000,
      model: latest.model,
      compactPercent: 0.85,
    });
  };

  pi.registerCommand("context", {
    description: "What is in the context window: composition, biggest tool schemas, what compaction would reclaim (`export` writes an HTML report)",
    getArgumentCompletions: (prefix) => ["export", "off"].filter((o) => o.startsWith(prefix.trim())).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "off") { ctx.ui.setWidget("context", undefined); return; }
      const current = view(ctx);
      if (!current) { ctx.ui.notify("Nothing measured yet: ask the model something first, then /context reads the request that was actually sent.", "warning"); return; }

      if (sub === "export") {
        const dir = reportDir();
        const file = join(dir, `context-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, buildReport(current, ctx.cwd));
        } catch (e: any) { ctx.ui.notify(`Could not write the report: ${e?.message ?? e}`, "error"); return; }
        const opened = await openInBrowser(file);
        ctx.ui.notify(`${opened ? "Opened" : "Wrote"} ${file}${opened ? "" : " (set MGM_NO_BROWSER=0 or open it yourself)"}`, "info");
        return;
      }
      if (sub && sub !== "") { ctx.ui.notify(`Unknown /context option "${sub}". Try: export, off`, "error"); return; }

      if (!ctx.hasUI) { ctx.ui.notify(`${thousands(current.total)}/${thousands(current.window)} tokens (${pct(current.percent)}). ${verdict(current)}`, "info"); return; }
      ctx.ui.setWidget("context", (_tui, theme) => ({
        render: (width: number) => renderPanel(panelRows(current, width, (c, t) => theme.fg(c as any, t)), width, (c, t) => theme.fg(c as any, t), " context window ").map((l) => truncateToWidth(l, width)),
        invalidate() {},
      }), { placement: "aboveEditor" });
      ctx.ui.setStatus("context", `◧ ${pct(current.percent)}`);
    },
  });
}
